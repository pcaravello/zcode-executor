# T-XXX task title

> This file is the contract from Claude (planning) to zcode (execution). zcode does what is written here,
> and Claude checks the work against the acceptance criteria below. Anything left vague, zcode will improvise — that is the root cause of rework.
>
> The send must carry this file's path:
> `zcode-executor send <id> "execute tasks/T-XXX.md" --task "$WT/tasks/T-XXX.md" --wait` (`--task` takes an absolute path: it is resolved against Claude's current directory, and the task file lives in the worktree `$WT`)
> Model review treats this file as the authorization basis: actions not covered by the acceptance criteria are not approved automatically.

## What to do

State the goal in one sentence. Not "improve X", but "change X from state A to state B".

## Background (already verified by Claude; do not re-explore)

- Relevant files: `path/to/a.mjs:120` (this is where … lives), `path/to/b.mjs` (…)
- Known constraints: …
- Approaches already ruled out: … (say clearly why that path was rejected, so it is not tried again)

## Files to change

- [ ] `path/to/a.mjs` — what to change
- [ ] `path/to/a.test.mjs` — which tests to add

## Acceptance criteria (must be machine-checkable)

- [ ] `<test command>` passes fully (e.g. `npm test`)
- [ ] New tests cover … (down to the case names)
- [ ] `<build or check command>` reports no errors (e.g. `node --check`)
- [ ] `git diff` touches only the files listed above

## Off-limits

- Do not change `…` (reason)
- Do not add new dependencies
- Do not run git commands: no commit, no rebase, no amend. Leave the changes in the working tree; Claude commits after acceptance

## When done

Leave the changes uncommitted in the working tree, and say briefly which files changed and whether anything deviated from this file. No long report needed —
Claude verifies from the diff and the tests itself.
