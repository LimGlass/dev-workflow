# Agent instructions

Shared rules for every coding agent (Claude Code, Codex) working in this repository.
`CLAUDE.md` imports this file; keep project rules here, not there.

## Project commands

- Build: `{{BUILD_COMMAND}}`
- Test: `{{TEST_COMMAND}}`
- Lint / format: `{{LINT_COMMAND}}`

Run the test command before asking for review. If a command cannot run on this machine, say so in the task file instead of skipping silently.

## Hard rules

Agents must never:

- merge pull requests;
- push to `main` (directly or via force-push);
- flash firmware or upload to devices;
- change hardware configuration or physical setups.

These are human gates. When a task reaches one, set the task status to `human-gate`, log it, and stop.

## Branches and working trees

- Work on branches named `agent/<agent>/<TASK-ID>`, e.g. `agent/claude/NOVA-12` or `agent/codex/NOVA-12`.
- One writer per working tree. Parallel work uses separate Git worktrees; never edit a tree another agent is writing to.
- `main` changes only through pull requests merged by the user.

## Reviews

- Codex reviews run through `/codex:review` or `/codex:adversarial-review` (read-only).
- For `risk:hardware` and `risk:security` tasks, the written plan is saved in the task file and may get a Codex plan review before implementation; the user approves the plan before work starts.
- Record each review in `.collab/reviews/` and respond to every finding in its table.
- Rejecting a P1 or high-severity review finding on a `risk:security` or `risk:hardware` task needs owner sign-off before the PR is opened.

## Collaboration files (`.collab/`)

- `.collab/tasks/<TASK-ID>.md` — task spec and plan (copy `tasks/TEMPLATE.md`).
- `.collab/reviews/<TASK-ID>-r<round>.md` — review records (copy `reviews/TEMPLATE.md`).
- `.collab/log.md` — append-only handoff log, one line per event.
- `.collab/decisions/` — project-specific ADRs.

Keep task status in the front matter in sync with Linear.
