# Off-peak sends and start-plan sends (zcode-executor detailed reference)

SKILL.md's "off-peak sends" section holds the entry pointer; the full details follow. Read this whenever either send type is involved.

## Off-peak sends

An off-peak send runs the turn on the Coding Plan subscription's free off-peak capacity, using no plan quota; the price is taking a ticket and queueing first, with the start time decided by the server and impossible to predict.
Acceptance, rework, and pending items work exactly like a normal send. Older versions lack this feature: if `send` reports `unknown flag --offpeak`, fall back to a normal send.

**When to use it**: dispatching defaults to normal sends; whether to go off-peak is the user's informed choice.

- Before the first dispatch in each conversation, run `zcode-executor quota` once (zero quota, takes no ticket) and tell the user in one sentence: this one goes as a normal send;
  it could also go as an off-peak send (the Coding Plan subscription's free capacity; the start time is decided by the server and cannot be predicted); this tool has already used N today
  (about 3 a day; App usage does not count toward it), and whether a ticket can be taken right now (if not, give the earliest retry time).
- After saying that, **continue straight into the normal send; do not stop and wait for an answer**. If the user replies that they want off-peak: normal sends already dispatched are left unchanged; for later new tasks, follow "How to use it" —
  open another session and send `--offpeak`; for rework in the original session, wait for the previous send to finish, then send `--offpeak`.
- Send `--offpeak` only after the user explicitly chooses off-peak. Rework also defaults to a normal send; off-peak is only ever offered as an option.
- When `quota`'s verdict is not "ok":
  - "not applicable" (not signed in, team plan): do not raise the off-peak option again in this conversation;
  - the output says the interface changed (exit code 1): handle it per the "the off-peak API may have changed" row in the table below;
  - any other exit code 1 (the reason is on stderr, e.g. an old version that does not know the quota command) or "temporarily unavailable": tell the user "off-peak status cannot be checked right now" and send normally as usual.
- Later dispatches in the same conversation skip `quota` and skip mentioning off-peak; run it again only when the user asks about off-peak, or right before sending `--offpeak`.

**How to use it**: an off-peak send requires an idle session (no runner, empty queue). For a new task, open a dedicated session with its own worktree;
for rework the previous send has already finished, so just send `send <id> … --offpeak` in the original session, keeping the context. One worktree pairs with exactly one session.

```bash
WT2=~/.zcode-executor/worktrees/<repo-name>-offpeak
git -C <main-repo-abs-path> worktree add "$WT2" -b task/T-xxx     # put the task file inside $WT2
zcode-executor new --cwd "$WT2" --title T-xxx-offpeak --tier fast --json
zcode-executor send <id> "execute tasks/T-xxx.md" --task "$WT2/tasks/T-xxx.md" --offpeak   # returns immediately: "ticket taken, queued at position N"
zcode-executor status <id>    # shows the queue position, and whether it is running or finished
```

- The send returns immediately after taking the ticket, and the queue wait can be long: to wait for the result, start `follow` as a background task (`run_in_background`) and do not pass `--wait` with the off-peak send.
- Free tickets: about 3 a day, reset at local midnight (measured 2026-09-28); one off-peak send can burn through all 3 at worst; do not take tickets repeatedly just to probe.
- The turn `--timeout` (default 3600 seconds) starts when the turn starts and includes pending time: for an off-peak turn that will wait for human review, give a wider `--timeout`.
- An expired or invalidated ticket is retaken automatically by the runner, at most 3 tickets; exhausting them ends with exit code 4. On exit code 4, run `status <id>` first:
  if the "off-peak: send … not settled, runner is gone" line is there, use `--resume` (below); if not, treat it like any failed turn, with the changes left in the worktree.
- Pending: answer as soon as you can (see SKILL.md's "exit code 5" section); an off-peak turn can also require review. A ticket runs at most 3 hours after starting; whether a long pending spell invalidates the ticket is unverified.
- `--steer` works only once the turn has started. `cancel` followed by a resend while still queued takes a new ticket and queues again, consuming one of the free takes; for small direction changes, wait for the turn to start and `--steer`.

**Exit code 2: refused before or while taking a ticket**, handle it by the error's cause:

| What the error says | What you should do |
| --- | --- |
| `an off-peak send requires an idle session (no running runner and an empty queue)…` — right after a `cancel` | Wait a few seconds, then resend to the same session once `status` shows no runner |
| `an off-peak send requires an idle session (no running runner and an empty queue)…` — a normal send is running | Wait for it to finish; or open another worktree and `new` a separate session |
| `the session's model <modelId> is not in the off-peak model list (…)` (the error lists the list) | Run `zcode-executor models` to see which tier currently gets a listed model, then `new` a session with that `--tier` |
| `off-peak send is unavailable: …` (not signed in, team plan, no off-peak eligibility) | Tell the user: off-peak requires signing in with an individual Coding Plan subscription account in the ZCode App |
| `off-peak quota is used up; you can take a ticket again after <time>` | Tell the user that time; switch urgent work to a normal send |
| `…temporarily unavailable (HTTP …); try again later` / `cannot reach the off-peak server (…)` | Send again later, or use a normal send |
| `…the off-peak API may have changed; run zcode-executor doctor --offpeak to check` | Run `zcode-executor doctor --offpeak`, relay the verdict to the user, and use a normal send this time |
| `send … not settled, runner is gone` | See "When something goes wrong" below |

**When something goes wrong**: go by the "off-peak: send … not settled, runner is gone" line in `status`; phase `exited` by itself is just a normal wrap-up, nothing to recover.

- That line is present (turn exited or runner gone) → `zcode-executor send <id> --offpeak --resume`.
  It only restarts the runner to continue that send — no new ticket, no body, no `--task`.
- You no longer want it → `zcode-executor cancel <id>`; the ticket is settled automatically at any stage.
- `status` shows "off-peak: ticket … not settled" → tell the user the ticket ids; those tickets failed to settle on the server side.

**Health check**: `zcode-executor doctor --offpeak` checks only the off-peak interface and spends no quota (it goes online and runs a fake-ticket turn).
Only exit code 1 ("the interface changed") needs action: the reason is on stderr — tell the user the off-peak route is temporarily broken and dispatch with normal sends. "Temporarily unavailable" and "not applicable" exit 0; just relay that line to the user.

If the user wants a periodic check, suggest hanging it on their own cron (this tool never runs it by itself). A cron PATH is short; use absolute paths for node and the script;
stdout always carries one verdict line — throw it away and judge only by the exit code and stderr:

```cron
0 9 * * * /abs/path/to/node /abs/path/to/bin/zcode-executor doctor --offpeak >/dev/null
```

When the App version differs from the verified version, stderr adds one extra line each run; every run also leaves one self-check session in the zcode CLI's session store that the App cannot see, so do not run it too often (once a day is enough).

## start-plan sends

Start Plan is another subscription tier inside the ZCode App. `send <id> <text> --start-plan` bills **this turn** to Start Plan quota;
everything else is exactly like a normal send: starts immediately, no ticket, does not monopolize the session, acceptance unchanged. `--offpeak` and `--start-plan` are mutually exclusive,
and `--steer` cannot steer into a start-plan send (it is a new send). (It was unavailable on headless hosts from 2026-09-29 because of an Aliyun captcha, and was restored on 2026-10-09 after the server dropped the check.)

- The model list follows the ZCode App's builtin configuration (a refusal exits 2 and the error lists the list); if the session's model is not on it, create a new session with a different `--tier`.
- One session may mix both: some sends with `--start-plan`, some without; they do not interfere, and a failed start-plan send does not affect later normal sends.
