# dev-workflow

Shared templates and cross-project decisions for my Claude Code + Codex development workflow.

Claude Code is the host and primary implementer; Codex reviews meaningful diffs (and high-risk plans) through the `codex-plugin-cc` plugin. The human owner approves high-risk plans and stays responsible for merges, firmware flashing, and hardware changes. See [ADR-0001](decisions/ADR-0001-claude-host-codex-reviewer.md).

## Layout

```
decisions/                 Cross-project ADRs (source of truth; Notion links here)
templates/                 Copy into each new project
  AGENTS.md                Shared agent rules (fill in the {{...}} placeholders)
  CLAUDE.md                Imports AGENTS.md for Claude Code
  .claude/settings.json    Permission deny/ask rules + PreToolUse guard hook registration
  .claude/hooks/guard.js   Blocks pushes to main and firmware uploads (needs Node.js)
  .claude/hooks/guard.test.js  Tests for the guard: node .claude/hooks/guard.test.js
  .githooks/pre-push       Git hook rejecting any push to main, however git is run
  .githooks/pre-push.test.js  End-to-end tests for the hook: node .githooks/pre-push.test.js
  .gitattributes           Keeps .githooks/* LF so the hook runs on Windows checkouts
  .collab/
    decisions/             Project-specific ADRs
    tasks/TEMPLATE.md      Task spec: front matter + Goal/Context/Acceptance/Plan/Out of scope
    reviews/TEMPLATE.md    Review record: verdict + findings table
    log.md                 Append-only handoff log
.claude/, .githooks/       Same settings, guard and pre-push hook, applied to this repo
```

## Using the templates in a project

1. Copy everything under `templates/` into the project root (including the dot-folders).
2. Enable the pre-push hook in every clone: `git config core.hooksPath .githooks`. Until then the guard blocks every push from the project.
3. Replace the `{{...}}` placeholders in `AGENTS.md` with the project's build, test, and lint commands.
4. Add project-specific ADRs under `.collab/decisions/`; cross-project ADRs stay here.
5. For each Linear issue, copy `.collab/tasks/TEMPLATE.md` to `.collab/tasks/<LINEAR-ID>.md`.
6. Record each Codex review as `.collab/reviews/<LINEAR-ID>-r<round>.md`.

## Conventions

- Branches: `agent/<agent>/<TASK-ID>` (e.g. `agent/claude/NOVA-12`).
- One writer per working tree; parallel work uses separate Git worktrees.
- `main` changes only through user-merged pull requests.
- Risk labels map to Linear: `risk:low`, `risk:normal`, `risk:hardware`, `risk:security`.

## Protection layers for `main`

1. **Guard hook** (`.claude/hooks/guard.js`): blocks Claude's Bash/PowerShell commands that would push to `main`, skip or disable the pre-push hook, write `main` or merge through `gh`, or upload firmware. It catches mistakes; it is not a sandbox.
2. **Pre-push hook** (`.githooks/pre-push`): Git rejects any push that would create, update or delete `main`, whatever ran git.
3. **GitHub branch protection** (recommended; set by the owner in the repository settings): require a pull request for `main` and block force-pushes and deletion. This is the only layer an agent cannot bypass from the local machine.
