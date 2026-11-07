---
name: zcode-executor
description: Hand a fully-specified development task to the local ZCode (GLM) agent, which makes the changes in an isolated worktree; verify with git diff and tests. Use when the user says 「让 zcode 去做」, 「派给 zcode」, 「派给执行端」 ("tell zcode to do it", "hand the task to zcode", "dispatch it to the executor"), or when the current session owns planning and actual code changes should go to zcode. Also for off-peak sends (when the user opts in), checking zcode session status, steering a running turn, and answering pending permission requests or questions.
---

# Dispatch tasks to zcode

You are the planning hub; zcode is the executor. You write what to build into a task file, zcode makes the changes in an isolated worktree (git worktree), and you verify with objective evidence. The command is `zcode-executor`; the command blocks below can be copied and run verbatim after replacing the placeholders.
In a terminal, first run `command -v zcode-executor` to check: if it is on PATH, use the command blocks as written. If it is not found, resolve it per host:
- The Claude Code plugin puts it on PATH at install time; in bare-skill setups it lives two levels up from this skill's directory at `bin/zcode-executor` (`<plugin root>/bin/zcode-executor`) — call it by absolute path;
- Running from a local checkout: the absolute path to the repo's `bin/` (example: `/Volumes/MacData/projects/zcode-executor/bin/zcode-executor doctor`);
- Or `npm install -g zcode-executor`, or simply `npx zcode-executor …`.

## Working mode: the main agent orchestrates, original sessions stay in the loop

- The main agent owns the task file, scheduling, and final evidence-based acceptance; implementation and rework go to the executor session, code review and re-review to a separate review session. Record the executor id, review id, and worktree path for each task; the review session is read-only.
- **Rework → the original executor session; re-review after rework → the original review session.** Write the review findings, reproduction evidence, and pass criteria into a rework task file and resend with `--task` after the original executor turn ends; hand the latest diff, test results, and rework task file back to the original review session and confirm each finding is closed. The main agent's evidence-based acceptance does not replace review, and it does not take over the fixing itself. Create new sessions only when the original ones are truly unrecoverable, and hand over the context above.
- **After a send, do independent work first; wait only when there is truly nothing else to do.** By default `send` runs without `--wait`; start `follow` as a background task and record the job id. Meanwhile plan the next step, prepare the acceptance checklist, or sort out follow-up tasks — do not touch the files the executor is editing and do not consume artifacts that are not finished yet. Handle results when the completion or pending notification arrives; collect all results before delivering. Do not replace background waiting with repeated `status` calls or sleep loops.

## Iron rules

1. **The task file is the contract; the message is only a doorbell.** Put the entire task content into the task file — a send body that just says "execute tasks/T-xxx.md" is enough.
   zcode is a full agent with its own judgment; a free-form paragraph makes it re-interpret the task on its own, while the task file is what you reconcile against afterwards.
   That is why `send` must carry `--task`: without a task file, model review cannot see what you authorized, out-of-scope judgment has no basis, and nearly everything goes to a human.
   Model review reads the task file content **at the moment of the send** (a snapshot is taken when the item is queued): editing the file afterwards is invisible to review — send again with `--task` for the change to count.
2. **Accept on `git diff` and tests, not on what it says.** The reply that comes back at the end of a turn is the executor's own account. To judge whether the work is right,
   always go back to the main repo for the diff, run the tests in the worktree, and read the produced files.
3. **If three or four sends to the same session still fail, go back and fix the task file.** The problem is usually an unclear task description, not something more sends can fix.
   How: write `tasks/T-xxx-fix.md` describing what is missing, then send to the same session again (it has the context; rework rides on it).
4. **Triage pending items first; never approve out-of-scope work on the user's behalf.** Check the task file, the authorization the user has already given, and the specific action: if you can confirm it and the rules let the main agent handle it, answer per the "exit code 5" section; if it is out of scope, you cannot confirm it, or higher-level instructions require a human, hand it to the user with your reasoning. A pending item is by itself neither a danger signal nor grounds for approval; this skill does not override the host's approval restrictions.
5. **Jev is enabled only through configuration, and only as a pre-screen.** A non-blank `review.jev.apiKey` enables the early-pass layer; a pass ends the review, while flag/error/skip falls back to
   the original ZCode `fast` + `review.thought` (default `low`) fast screen, and only a non-passing or unparseable result goes to slow review; a failed original fast-screen call still goes to a human.
   Omitted action bodies, missing valid intent, or truncated required input cause a local skip with no HTTP request; command complexity alone is not a reason to skip. Without a key the original chain stays,
   there is no environment-variable fallback and no mode/shadow setting; `review.enabled:false` turns off all model review.

## Full walk-through of one task

```bash
# 1. Write the task file first (template: templates/task.md)
#    Acceptance criteria must be machine-checkable: which command to run, which file to look at, what output to expect
#    Split tasks sensibly: one task file does one independently acceptable thing; for work that will touch many files
#    or run long tests, split it into several task files sent serially (send the next only after the previous passes) — do not cram it into one
#    The turn timeout defaults to 1 hour (--timeout 3600): for longer tasks, pass a longer --timeout manually at send time;
#    a timeout cancels the current turn and resending wastes quota

# 2. Create the worktree for the repo (one per repo; branch per task)
WT=~/.zcode-executor/worktrees/<repo-name>
git -C <main-repo-abs-path> worktree add "$WT" -b task/T-xxx    # first time: install dependencies once inside $WT

# 3. Create the session: this only registers locally at zero tokens and returns a local id (x_ prefix); the zcode session is created on the first send
zcode-executor new --cwd "$WT" --title T-xxx --tier fast --json

# Before the first dispatch in each conversation: zcode-executor quota (zero quota), tell the user per the "off-peak sends" section, then send normally
# 4. Send without blocking (--task is mandatory), then start follow <id> as a background task; do independent work per the "working mode" section
#    tasks/T-xxx.md in the message is a relative path zcode reads itself inside the worktree, so the task file must live in $WT;
#    --task is the authorization basis model review looks at — use an absolute path
zcode-executor send <id> "execute tasks/T-xxx.md" --task "$WT/tasks/T-xxx.md"

# 5. After the completion notification, hand the work to a separate review session; the main agent checks the objective evidence.
#    zcode does not commit; changes stay in the worktree's working area — stage untracked files first, then look at the diff
git -C "$WT" add -A && git -C "$WT" diff --cached --stat && git -C "$WT" diff --cached
git -C "$WT" <test command>
#    To also see how the review went: the executor.gate lines in $ZCODE_EXECUTOR_HOME/runs/<id>/events.jsonl

# 6. Passed: commit inside $WT (git -C "$WT" commit -m "T-xxx: …"), then merge back in the main repo (next section).
#    Failed: git -C "$WT" reset to unstage, write tasks/T-xxx-fix.md, send to the original executor session; after it finishes, hand back to the original review session for re-review
```

A send returns immediately by default and the background runner keeps working; start `follow` with the host's background-task facility (`run_in_background: true`) and record the returned job id.
Wait for that background task only when the next step truly depends on the result and there is no independent work; `send --wait` is the optional blocking variant and returns exit code 5 when pending.

## Always use `git -C <absolute path>`, never rely on cd

The main repo and the worktree are two directories. Once a Bash invocation has `cd`-ed somewhere, a later `git merge` or `git checkout -b`
can run in a repo other than the one you think. A pitfall that actually happened: after running tests in the worktree, the following merge landed in the worktree
(HEAD was already that branch, so self-merging changed nothing), the main repo's main never moved, and the next task's branch — cut from main — was missing the previous task's code.

```bash
git -C <main-repo-abs-path> merge --ff-only task/T-xxx      # merge into main: in the main repo
git -C <main-repo-abs-path> log --oneline -1                # before cutting a new branch, check main already has the previous task
git -C "$WT" checkout -b task/T-yyy main              # cut a new branch: in the worktree
```

## Model tiers, thought levels, and the Jev pre-screen

Pick the ZCode model by tier, never by model name — a model swap then needs no habit change. `models` shows which model each tier currently gets. Jev only adds an optional pre-screen; it does not change the executor session's `--tier`, and the original ZCode fast screen and slow review stay in place.

| Work | Tier |
| --- | --- |
| Mechanical changes (renames, moving code, adding tests from an explicit list) | `--tier fast` |
| Regular implementation (features with clear acceptance criteria) | `--tier fast` |
| Hard work (design trade-offs, hard-to-reproduce bugs, unfamiliar code) | `--tier strong` |

- **Thought level defaults to `high`; leave it alone.** Do not lower it for Flash-class models — measured results are worse.
- Provider preference: an account-based individual Coding Plan first (the key from being signed in to the App), then an account-based team plan, then a Coding Plan in `config.json`. When the same model exists under several providers the plugin picks correctly by itself; to override, set `preferredProvider` in the plugin config (e.g. `account:bigmodel-team-coding-plan`).
- Model and thought level are fixed when the session is created and every later send to that session reuses them. For hard work do not reuse a previously created fast session; open a new one.
- **Once the original zcode session's context passes 1M tokens, switch to a new session for sends.** The longer the session, the larger the fixed overhead per send and the lower the execution efficiency;
  context accumulated in an old session is mostly noise for a new task. New tasks always get a new session (with a new worktree when needed) and receive the task file plus any necessary diff.

To optionally enable the Jev pre-screen, edit `~/.zcode-executor/config.json`; **never** put a real key in command arguments, environment variables, the task file, chat messages, or files in the repo:

```json
{
  "review": {
    "jev": {
      "apiKey": "jev_REPLACE_WITH_YOUR_KEY"
    }
  }
}
```

After saving, run:

```bash
chmod 600 ~/.zcode-executor/config.json
```

A config file containing a key must be owned by the current UID, be a regular non-symlink file, and be no looser than `0600`; otherwise commands report a configuration error. Delete `apiKey` or leave it all-whitespace to use only the original ZCode chain; do not look for a Jev environment variable or a mode/shadow switch. `doctor` shows the review pipeline for a newly started runner, without calling Jev online and without showing the key: `review.pipeline` is `['jev','zcode-fast','zcode-slow']` with a key, the last two without one, `[]` when disabled, and `null` on a configuration error. The legacy `fastScreen` field does not mean the original fast screen was replaced.

## Exit codes and what to do

| Code | Meaning | What you should do |
| --- | --- | --- |
| 0 | Turn finished | Go verify; do not just trust its claim of completion |
| 1 | Usage error, or zcode cannot start (including ZCode App older than 3.12) | Read the error; for environment problems run `zcode-executor doctor` (a self-check that spends no quota). When it exits 1, see which step failed: only if it is step ⑤ (the off-peak interface changed) can normal dispatching continue as usual |
| 2 | Refused: outside the whitelist, session not in the registry, illegal tier or thought level; an off-peak send was refused | The error says why; handle it by the cause and never retry as-is; for off-peak see the "off-peak sends" section |
| 3 | `send --wait` timed out (default 3600 seconds, change with `--timeout`); **the current turn is cancelled**, the session survives | Just send again to continue; a `follow` timeout cancels nothing — the onlooker simply left at its deadline |
| 4 | Turn failed: an error, aborted, hit the output cap | Read the reason; if the cap was hit, split the task smaller and resend |
| 5 | Pending, waiting for a human: a permission request or a question | See the next section; do not try to route around it |

## Exit code 5: the two pending cases

Pending items never expire; the session stays where it is, waiting for a human. `send --wait` returns 5 immediately and prints the pending content; when running in the background, check with `status <id>`.

**Permission request** (the executor wants to perform an action and waits for your permission):

1. Read the full tool name, arguments, target paths, and pending reason, and judge the actual impact against the task file and the user's authorization; when evidence is thin, do read-only checks first.
2. **You may confirm yourself**: the action is clearly within the authorization, hits no hard rule, and higher-level instructions allow autonomous answering → state your reasoning and run `zcode-executor approve <id>` (this time only); it clearly violates the task constraints and autonomous denial is allowed → `zcode-executor deny <id>`, and hand the reason back to the original executor session so it adjusts its approach.
3. **A human must decide**: out of scope (e.g. writing outside the worktree), newly added permissions or irreversible effects without authorization, insufficient evidence, or higher-level instructions explicitly require escalation → repeat the tool name, arguments, and reason verbatim, with your suggestion and the unconfirmed points (in Claude Code use AskUserQuestion; DSH uses the host's escalation); only after a decision, `approve` / `deny`. Never route around a restriction by editing the task file, closing the request, or switching commands.

   Be extra careful when the rule is `self-modify-approval`: the executor is touching zcode-executor's own data directory (both the pending requests and the answers live there) or invoking the `zcode-executor` command. Normal work never needs either; tell the user verbatim what it wants to do, and do not explain it away as harmless.

**Answer-binding limitation (applies to approve / deny / answer)**: the current CLI re-reads the pending state and offers no expected-requestId/CAS parameter; reading twice or claiming a single operator does not prevent a crossed answer. Perform the answer only when verified external serialization covers the whole span from "checking the current request" to "the CLI reads it"; otherwise keep the item pending and report this limitation, and ask the user to coordinate safe handling — a human saying "allow" does not remove the race by itself. Never invent parameters or write answer.json directly.

**Question** (the executor asks you a question; it wants an answer, not a permission):

1. First check whether the task file already answers it; if you can answer, do not bother the user: `zcode-executor answer <id> <value…>`.
   With options, give values by index, value, or label, comma-separated for multi-select; without options it is free text.
2. If you cannot answer, ask the human, and send the answer back the same way with `answer`.

## Steer, follow, cancel

```bash
zcode-executor send <id> "change of direction: only do A first" --steer   # steer into a running turn without interrupting it
zcode-executor follow <id> [--stream]                     # follow the background runner; returns as soon as a new result lands
zcode-executor status <id>                                # read-only snapshot: phase, recent tools, queue, how long pending
zcode-executor cancel <id>                                # stop: deny any pending request, then stop the turn and stop taking from the queue
```

- **`--steer` steers, it does not interrupt.** The message is handed to the running turn without interrupting it; to interrupt, `cancel` first and resend.
  A steer takes effect at the next tool boundary; with no boundary it is queued until after the turn ends.
- **Start `follow` as a background task** (`run_in_background`) — you are called back automatically when it exits. Do not wrap it in a foreground timeout and wait:
  the timeout only cuts off you, the onlooker, while the turn keeps running, and you may easily mistake that for a hang.
- To ask "where is it" at any time, use `status`: read-only, zero quota, non-blocking. phase values: `running` is running, `pending` is waiting for a human,
  `idle` means the runner is alive but the queue is empty, `exited` means the runner finished and exited normally (read it together with "last: done" — not a problem), and `stale` means the runner died mid-run — that one most needs a human.
  The `[phase]` on each `list` line uses the same vocabulary; no running / pending means no session is actively working.
- To watch while it runs, add `--stream` to `send` / `follow`: tool-call summaries and the forming reply are printed to stderr.

## Off-peak sends and start-plan sends

Before using off-peak (`--offpeak`) or Start Plan (`--start-plan`) quota, read `references/offpeak-and-start-plan.md`:
when to mention off-peak, the `quota` talking points, the full commands for taking tickets / queueing / resuming, the exit-code-2 ticket-refusal table, and the cron health check are all there.

## Two session ids

- Commands always take the **local id** (`x_` prefix, the one `new` returns).
- zcode's own `sess_…` id only exists after the first turn; it is shown next to the local id only in `list` and the `--json` output of the commands, for reconciliation — never type it into a command.

## Things not to do

- **Do not open a running session in the ZCode App.** Both sides write the same sqlite with no cross-process locking; they will stomp on each other.
- **Do not dispatch work outside the worktree.** The `new` cwd whitelist defaults to `~/.zcode-executor/worktrees/` only —
  that is a protection, not an obstacle; two agents editing the same files will overwrite each other.
- **Never report "zcode says it's fixed" as acceptance.** Acceptance only accepts `git diff` and test results (iron rule 2).
- Do not send a fourth round. Three or four failed rounds mean: fix the task file (iron rule 3).
- **Never put credentials in the task file.** The task file enters model review as the authorization basis; when Jev is enabled and passes the local evidence checks, the redacted task contract and action summary are sent to TypeSafe; if required content is truncated, the call is skipped locally.
- **Never configure the Jev key via shell arguments or environment variables.** The only entry point is `review.jev.apiKey`, protected by `0600`; examples always use placeholder values.

## Command cheat sheet

```bash
zcode-executor doctor [--json]                  # zero-quota self-check: zcode, config, handshake, tiers, the new runner's review pipeline, the off-peak interface (step ⑤ goes online and leaves one self-check session per run)
zcode-executor doctor --offpeak [--json]        # checks only the off-peak interface (leaves one self-check session too); only exit code 1 (the interface changed) needs action
zcode-executor quota [--json]                   # how many off-peak tickets this tool took today and whether the server allows one now; zero quota, takes no ticket
zcode-executor models [--json]                  # available models, thought levels, why disabled, automatic tier assignment
zcode-executor list [--project <keyword>] [--json]  # sessions in the registry: local id, sess_, last outcome, whether pending
zcode-executor new --cwd <abs path> [--title T] [--tier fast|strong] [--thought <level>] [--deny "Tool…"] [--provider id] [--json]
zcode-executor send <id> <text|-> [--task file] [--wait] [--steer] [--timeout sec] [--stream] [--json]
zcode-executor send <id> <text|-> --offpeak [--task file] [--wait] [--timeout sec] [--stream] [--json]  # off-peak send: takes a ticket on the spot
zcode-executor send <id> --offpeak --resume [--wait] [--stream] [--json]  # continues an off-peak send left unfinished
zcode-executor send <id> <text|-> --start-plan [--task file] [--wait] [--timeout sec] [--stream] [--json]  # Start Plan quota
zcode-executor follow <id> [--timeout sec] [--stream] [--json]
zcode-executor status <id> [--tools N] [--json]  # running / idle / pending / ended abnormally, recent tool calls, queue length
zcode-executor cancel <id>                       # stop: deny any pending request first, then stop taking from the queue
zcode-executor approve <id>                      # answer a pending permission request; allow is allow_once only
zcode-executor deny <id>                         # answer a pending permission request with a denial
zcode-executor answer <id> <value…>              # answer a pending question: by index/value/label, comma-separated for multi-select
```

- The watch pane shows each session's progress live (replies, tools, pending items and queueing): in Claude Code the user types `/zcode` to open it (it opens by itself when you send,
  with a status-line summary and toasts on key changes); the DSH right sidebar has a "zcode tasks" tab. The pane is view-only — never answer through it; pending items are still handled in the conversation per the rules above.
  Behind it is the read-only `zcode-executor watch --json`, which you do not need to run yourself.

- A body of `-` reads the text from stdin, so long text does not fight the shell's quoting:

  ```bash
  zcode-executor send <id> - --task "$WT/tasks/T-xxx.md" <<'EOF'
  execute tasks/T-xxx.md; self-check against the acceptance criteria item by item before stopping
  EOF
  ```

- `--deny` removes the named tools from the tool registry when the session is created. **If the task does not need the executor online, pass `--deny "WebFetch WebSearch"`** to shrink the network-capable surface.
  This removes only those two tools; Bash, js and MCP tools can still reach the network — for a real network cutoff, restrict it at the system or container level.
- Credential variables from your own environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, etc.) are not passed to the executor.
  When a task needs GitHub credentials, rely on the machine's already-logged-in `gh` / git credential helper, not environment variables.
- `--json` emits machine-readable structures for scripted processing; every `id` in the output is a local id.
- The cwd is resolved to its real path before being stored in the registry (macOS `/tmp/x` becomes `/private/tmp/x`); `list --project` matches the resolved path.
- Data directory `~/.zcode-executor/` (override with `ZCODE_EXECUTOR_HOME`): `sessions.json` is the registry; `runs/<id>/` holds `events.jsonl` (zcode events and gate decisions), `last.json`, `pending.json`, `offpeak.json` (for off-peak sends), and `runner.log`.
