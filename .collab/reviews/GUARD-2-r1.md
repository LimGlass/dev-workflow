---
task: GUARD-2
round: 1
reviewer: codex
verdict: changes-requested   # approve | changes-requested | blocked
---

Implementation review. Codex `/codex:review --base main` of branch `agent/claude/GUARD-2` at `83a4cb0`, thread `01a2006b-0d82-74d2-b6de-386d0a7b6d71`, 2026-11-21. Codex's summary: substitutions inside quoted heredocs sent to a shell are not analyzed, which would leave a bypass. Codex also reported that it **could not run the test suite**, because its sandbox denied creating the temp directory.

## Findings

| # | Severity | File:line | Finding | Implementer response |
|---|----------|-----------|---------|----------------------|
| 1 | P1 | .claude/hooks/guard.js:117 | `scanHeredocBody` skips `$(...)`/backtick checks for quoted heredocs. So `bash <<'EOF'` containing `$(git push origin main)` would supposedly reach `analyze` as inert text and not be blocked. Suggested: check substitutions in heredoc bodies regardless of quoting when the consumer runs the body. | **Rejected. No code change; regression tests added (`d0e92c1`).** The described bypass doesn't happen. `scanHeredocBody` only extracts substitutions the *outer* shell would expand, which correctly excludes quoted bodies. When the consumer is a shell, `checkStdin` sends the body to `analyze()`, which tokenizes it again as a script. The `$(...)` and backticks are extracted and checked there, whatever the delimiter quoting. Verified with `check()` on 2026-11-21. All of these are **blocked**: `bash <<'EOF'` with `$(git push origin main)`, with `echo $(git push origin main)`, with `` echo `git push origin HEAD:main` ``, and with `echo "$(git push origin main)"`; `sh <<"EOF"` with `` x=$(pio run -t upload) ``; and `printf '$(git push origin main)' \| bash`. `bash <<'EOF'` with `echo $(git status)` is allowed, as intended. The cited line 117 is the `tokenize` doc comment, not the code path described. Two of these cases are now permanent must-block tests (suite: 170 passed, 0 failed). |

## Pilot measures

- Findings raised: 1
- Accepted: 0
- Rejected: 1 (finding 1; the bypass doesn't reproduce, and regression tests were added to prove it)
- Confirmed defects caught before merge: 0
- Note: Codex couldn't run the tests in its sandbox, so its review was static only.
- Minutes spent: not recorded
- Codex usage before/after: not recorded
