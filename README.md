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
  .collab/
    decisions/             Project-specific ADRs
    tasks/TEMPLATE.md      Task spec: front matter + Goal/Context/Acceptance/Plan/Out of scope
    reviews/TEMPLATE.md    Review record: verdict + findings table
    log.md                 Append-only handoff log
.claude/                   Same settings and guard hook, applied to this repo
```

## Using the templates in a project

1. Copy everything under `templates/` into the project root (including the dot-folders).
2. Replace the `{{...}}` placeholders in `AGENTS.md` with the project's build, test, and lint commands.
3. Add project-specific ADRs under `.collab/decisions/`; cross-project ADRs stay here.
4. For each Linear issue, copy `.collab/tasks/TEMPLATE.md` to `.collab/tasks/<LINEAR-ID>.md`.
5. Record each Codex review as `.collab/reviews/<LINEAR-ID>-r<round>.md`.

## Conventions

- Branches: `agent/<agent>/<TASK-ID>` (e.g. `agent/claude/NOVA-12`).
- One writer per working tree; parallel work uses separate Git worktrees.
- `main` changes only through user-merged pull requests.
- Risk labels map to Linear: `risk:low`, `risk:normal`, `risk:hardware`, `risk:security`.
