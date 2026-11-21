---
id: GUARD-3            # Linear issue ID, e.g. NOVA-12
title: "Guard: check inline code passed to node -e / perl -e / ruby -e"
status: draft          # draft | plan-review | ready | in-progress | impl-review | changes-requested | human-gate | done
owner: claude          # implementing agent
reviewer: codex
branch: agent/claude/GUARD-3
risk: security         # low | normal | hardware | security  (Linear labels risk:low, risk:normal, risk:hardware, risk:security)
human_gates: [plan-approval, merge]        # e.g. [plan-approval, merge, firmware-flash, hardware-change]
---

## Goal

Treat inline code passed to interpreters other than Python the way `python -c` is already treated. Block when the code mentions a guarded operation, so `node -e "…git push origin main…"` can no longer slip past `.claude/hooks/guard.js`.

## Context and links

- Found 2026-11-21 while revising GUARD-2. Probe against `main` at `1b5a589`, calling `check({tool_name:'Bash', tool_input:{command}, cwd})` (nothing executed):
  - `node -e "require('child_process').execSync('git push origin main')"` → **ALLOWED**
  - `perl -e 'system("git push origin main")'` → **ALLOWED**
  - `python -c 'import os; os.system("git push origin main")'` → BLOCKED (`checkPython`, guard.js:541-543: a RISKY scan of the `-c` code)
- Cause: `checkCommand` (guard.js:401-419) has no branch for `node`, `perl` or `ruby`, so they return `null`.
- GUARD-2 handles code sent to these interpreters through **stdin** (heredocs, here-strings, pipes). This task covers code passed as an **argument**. GUARD-2 listed it as out of scope.
- Sequencing: GUARD-2 (merged) → GUARD-4 → GUARD-5 → **GUARD-3** (owner's decision, 2026-11-21). GUARD-4's pre-push hook already stops pushes to main from any route, including these. That leaves GUARD-3 mainly to catch firmware uploads launched from inline code and to fail earlier with a clearer message. All of them change `guard.js`, so cut this branch fresh from `main` after GUARD-5 merges.
- Policy: ADR-0001.

## Acceptance criteria

- [ ] `checkCommand` recognises these interpreters and inline-code flags, including attached forms (`-e<code>`, `--eval=<code>`) and flags bundled after other options (e.g. `perl -w -e …`, `node --no-warnings -e …`):
  - `node` (incl. `nodejs`, `node.exe`): `-e`, `--eval`, `-p`, `--print`
  - `perl`: `-e`, `-E`
  - `ruby`: `-e`
  - `deno eval`, `bun -e` / `bun --eval`. Include them if trivial, otherwise list them as out of scope with a reason.
- [ ] If the inline code matches `RISKY` (push|upload|uploadfs|flash|esptool), block it with a message like `node -e code mentions push/upload/flash/esptool and cannot be checked`, the same as `python -c`. Otherwise allow it.
- [ ] Dynamic inline code (contains `$(...)`/backticks/`$var` in a bash context) follows the existing `unsure` rule.
- [ ] Tests in `guard.test.js`:
  - must-block, for each interpreter/flag: inline code containing `git push origin main`, and inline code containing `pio run -t upload` or `esptool`
  - must-allow: `node -e "console.log(1)"`, `perl -e 'print 1'`, `ruby -e 'puts 1'`, `node script.js`, `node --version`
- [ ] All existing tests pass, and the `templates/` copies stay byte-identical.
- [ ] The guard header comment lists the newly covered interpreters.
- [ ] Codex review with no unresolved P1/P2 or high findings.

## Plan

Needs user approval before implementation (risk:security).

1. Write the tests first and confirm the must-block cases fail today.
2. Generalise `checkPython`'s `-c` handling into a table-driven inline-code check: interpreter name pattern → inline flags (with attached and `=` forms) → RISKY scan.
3. Wire it into `checkCommand`, sync `templates/`, update the header, and run the full suite.
4. Codex review, recorded in `.collab/reviews/GUARD-3-r1.md`. Open the PR. The merge is a human gate.

## Out of scope

- Script files (`node script.js`, `perl x.pl`). They match the existing rule that scripts aren't inspected; GUARD-4's pre-push hook covers pushes from them.
- Obfuscated inline code that hides the RISKY words (string building, encoding).
- REPL sessions and `node -i`.
