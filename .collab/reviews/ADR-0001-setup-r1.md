---
task: ADR-0001-setup
round: 1
reviewer: codex
verdict: changes-requested   # approve | changes-requested | blocked
---

Codex `/codex:review` of the uncommitted initial working tree (thread `01a1f058-e4f6-7710-913a-f3c5aed5f251`, 2026-11-18). Codex's summary: the permission settings meant to enforce the hard push/flash rules miss several command forms; no other definite issues in the templates or documentation.

## Findings

| # | Severity | File:line | Finding | Implementer response |
|---|----------|-----------|---------|----------------------|
| 1 | P1 | templates/.claude/settings.json:5-6 | Deny rules don't block all pushes to `main`: other remote names, refspecs, and `--force-with-lease` aren't covered, so they fall through to the `Bash(git push:*)` ask rule (approval prompt) instead of a hard deny. | **Accepted in part.** The first example is wrong: `git push origin main` *is* matched by the prefix rule `Bash(git push origin main:*)` and is denied. The rest holds, and there are more gaps: other remotes (`git push upstream main`), refspecs (`HEAD:main`, `feature:main`, `+main`, `:main`), flags before the remote (`git push -u origin main`), `-f` and `--force-with-lease` (only `--force` is denied), and a bare `git push` while `main` is checked out. Fix: a PreToolUse hook in Node.js that parses push commands; the existing deny/ask rules stay. |
| 2 | P2 | templates/.claude/settings.json:8 | PlatformIO deny rule only matches the literal `pio run -t upload`; `pio run -e <env> -t upload` and `--target upload` slip through. | **Accepted.** Also not covered: `--target=upload`, the `platformio` executable name, and other upload targets (`uploadfs`, `program`). The same hook will catch these in any argument order. |

## Pilot measures

- Findings raised: 2
- Accepted: 2 (finding 1 in part; its first example was rejected because the existing rule already matches it)
- Rejected: 0 whole findings
- Confirmed defects caught before merge: 2 (gaps in the guard rules; nothing was committed yet)
- Minutes spent: _not recorded_
- Codex allowance before/after: _not recorded_
