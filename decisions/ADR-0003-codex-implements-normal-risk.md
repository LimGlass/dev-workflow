# ADR-0003: Codex may implement risk:normal tasks

**Status:** Accepted (2026-11-27)
**Date:** 2026-11-27
**Decision owner:** Human project owner
**Amends:** ADR-0001, decision 5 ("Codex delegation that can edit files is deferred until the review workflow is proven useful")
**Scope:** dev-workflow and all projects using it (NOVA first)

## Context

ADR-0001 deferred letting Codex edit files until reviews had proven useful. The pilot has since shown that Codex reviews catch real defects (guard gaps, body-drain edge cases, an emergency stop that could fail to latch, a stop that reported success without sending anything, a P2 config-restart bug in NOVA-3a). The owner upgraded to ChatGPT Pro on 2026-11-25; Codex usage is no longer the limiting factor (5-hour and weekly limits largely unused).

The Claude-side protections (guard hook, ask-before-push rule, deny rules for merges and flashing) are Claude Code settings and do not apply to Codex. Only the Git pre-push hook (rejects any push to main) and GitHub-side settings apply to every agent.

## Decision

1. Codex may implement tasks marked **risk:normal** (and risk:low).
2. Tasks marked **risk:hardware** or **risk:security** stay with Claude as implementer; Codex continues to review their plans and code.
3. Codex implements in its **own Git worktree and branch** (`agent/codex/<TASK-ID>`), never in a tree another agent is writing to.
4. Codex runs with its own limits, set in `~/.codex/config.toml`:
   - `sandbox_mode = "workspace-write"` (edits only inside the project folder);
   - `approval_policy = "on-request"`;
   - `[sandbox_workspace_write] network_access = false` (no pushing, no GitHub API, no package downloads from its commands);
   - computer-use, unified-computer-use, chrome and browser plugins disabled while it works on repositories.
5. Codex commits locally only. **Claude or the owner pushes** the branch and opens the PR.
6. **Claude reviews** every Codex implementation, recorded in `.collab/reviews/<TASK-ID>-r<n>.md` with a response to each finding, using the same rules as Codex reviews of Claude's work (no automatic acceptance; rejecting a P1/high finding on a security/hardware task needs owner sign-off).
7. The owner merges. Firmware flashing and hardware changes stay human-only for every agent.
8. Same workflow as Claude: task file first, tests first, the AGENTS.md test command must pass, task status and log kept up to date.

## Consequences

- Two agents can work in parallel on independent tasks, roughly doubling throughput on backlog work.
- Gives pilot data on Codex as an implementer and Claude as a reviewer (role swap).
- Codex without network access may be unable to run tests that need local network sockets; if so, record it and adjust (for example allow loopback only) by owner decision.
- Codex's worktree has no Python virtual environment and can't download one offline; it can reuse the main worktree's interpreter (for NOVA: `C:\dev\nova\server\.venv\Scripts\python.exe`).
- The pre-push hook remains the only enforced barrier that covers Codex for pushes; GitHub branch protection would add a server-side one (requires the repo to be public on GitHub Free, or a paid plan).

## First trial

NOVA-8 (phone hub chunked request bodies, following NOVA-6's approach), implemented by Codex in parallel with Claude's NOVA-3b.

## Review point

Fold into the ADR-0001 review (by 31 December 2026): compare findings per review and defects caught for Codex-implemented vs Claude-implemented tasks.
