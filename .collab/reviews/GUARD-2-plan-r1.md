---
task: GUARD-2
round: 1
reviewer: codex
verdict: changes-requested   # approve | changes-requested | blocked
---

Plan review. Codex `/codex:adversarial-review --base main` of branch `agent/claude/GUARD-2` at `9627279` (the task file only; no code yet), thread `01a20047-27b3-7813-b0c5-7e98fdd9f7a1`, 2026-11-21. Focus: could the proposed heredoc handling let a real push to main or a firmware upload slip past the guard, and are the test cases enough? Codex's verdict: **needs-attention**, "do not approve yet". Recorded here as `changes-requested`.

## Findings

| # | Severity | File:line | Finding | Implementer response |
|---|----------|-----------|---------|----------------------|
| 1 | high | .collab/tasks/GUARD-2.md:67 | Step 4 only re-checks heredoc bodies for a named list of shells/PowerShell. `python <<'EOF'` with `os.system("git push origin main")` in the body, or a body that runs a firmware uploader, is literal to the shell, is not inspected by `checkPython`, and isn't covered by any test. Recommendation: define the supported stdin interpreters, add must-block cases for Python and others, and fail safe when the input can't be parsed but contains guarded operations. | **Accepted.** The plan is revised to use an allowlist instead of listing dangerous interpreters. Only known text-only consumers (`cat`, `tee`, `gh … --body-file -`, `git commit -F -`) receive heredoc text unchecked. Every other consumer (shells, python, node, perl, ruby, unknown programs) has the text scanned and is blocked if it contains guarded operations. Probing the current guard (`main` at `1b5a589`) showed the gap is **live today, not only in the plan**. All of these are currently allowed: `python <<'X'` and `node <<'X'` heredocs with push/upload code; here-strings (`bash <<< 'git push origin main'`, `python <<< …`); and piped literal text (`printf 'git push origin main\n' \| bash`, `echo 'pio run -t upload' \| sh`, `… \| python`, `… \| node`). PowerShell-dialect pipes are also allowed (`'git push origin main' \| bash`, `… \| pwsh -Command -`, `Write-Output 'pio run -t upload' \| sh`). The revised task brings here-strings and piped literal input into scope, in both dialects. `bash <<'X'` and `cat <<'X' \| bash` with a push in the body are blocked today only by accident, because the body is tokenized as commands. They become must-block regression tests. |

## Pilot measures

- Findings raised: 1
- Accepted: 1
- Rejected: 0
- Confirmed defects caught before merge: 1. The plan defect was caught before implementation. The same gap also exists in the guard already merged to `main`, and GUARD-2 now covers it.
- Minutes spent: not recorded
- Codex usage before/after: not recorded
