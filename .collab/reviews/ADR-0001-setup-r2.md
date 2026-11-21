---
task: ADR-0001-setup
round: 2
reviewer: codex
verdict: changes-requested   # approve | changes-requested | blocked
---

Codex `/codex:review --base main` of branch `agent/claude/guard-hook` at `2fb5fd1` (the PreToolUse guard hook added in response to round 1), thread `01a20037-85b2-7e21-8d6c-4dc48e4ca709`, 2026-11-21. Codex's summary: the hook registration does not pass the guard script to Node, so the protection would be inactive, and the template copy has the same problem. Codex's other checks (push parsing, parser tests, guard bypasses) found no issues.

## Findings

| # | Severity | File:line | Finding | Implementer response |
|---|----------|-----------|---------|----------------------|
| 1 | P1 | .claude/settings.json:24-25 (also templates/.claude/settings.json) | `args` is not a supported command-hook field, so the hook runs `node` without `guard.js` and the guard never blocks anything. Fix suggested: put the script path in the `command` string. | **Rejected. No code change.** (1) A live test in this repo blocked `git push --dry-run origin HEAD:main` with `BLOCKED by .claude/hooks/guard.js`. That message can only appear if Node ran the script. (2) The current Claude Code hooks docs list `args` as a valid command-hook field (exec form, no shell, v2.1.295+). This repo runs 2.1.327. |

## Pilot measures

- Findings raised: 1
- Accepted: 0
- Rejected: 1 (finding 1; the live test and current docs contradict it)
- Confirmed defects caught before merge: 0
- Areas checked with no issues: push parsing, parser tests, guard bypasses
- Minutes spent: [X]
- Codex usage before/after: [Y]
