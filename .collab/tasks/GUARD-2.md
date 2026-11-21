---
id: GUARD-2            # Linear issue ID, e.g. NOVA-12
title: "Guard: stop treating quoted heredoc bodies as code, keep blocking substitution in unquoted heredocs"
status: draft          # draft | plan-review | ready | in-progress | impl-review | changes-requested | human-gate | done
owner: claude          # implementing agent
reviewer: codex
branch: agent/claude/GUARD-2
risk: security         # low | normal | hardware | security  (Linear labels risk:low, risk:normal, risk:hardware, risk:security)
human_gates: [plan-approval, merge]        # e.g. [plan-approval, merge, firmware-flash, hardware-change]
---

## Goal

Stop `.claude/hooks/guard.js` from blocking legitimate commands whose quoted heredoc (`<<'EOF'`, `<<"EOF"`) contains backticks or other shell syntax. Command substitution in unquoted heredocs (`<<EOF`) must still be found and checked, so no gap opens in the push/upload guard.

## Context and links

- Found on 2026-11-21 while opening [LimGlass/dev-workflow#2](https://github.com/LimGlass/dev-workflow/pull/2). `gh pr create --body-file - <<'EOF'` with Markdown backticks in the body was blocked with `the command name is computed at run time` (guard.js:390). The workaround was writing the body to a file and passing `--body-file <path>`. The PR description lists this as a known issue.
- Root cause: the bash tokenizer (`tokenize`, guard.js:75) doesn't recognise `<<` at all. Heredoc body lines are tokenized as ordinary command text:
  - backticks become command substitutions (guard.js:172-179)
  - `$(...)` becomes a substitution (guard.js:146)
  - each body line becomes its own command segment
- So a quoted heredoc whose body says `git push origin main` (for example, a PR description or commit message that mentions the policy) could also be blocked as an actual push.
- Bash semantics: quoting any part of the delimiter (`'EOF'`, `"EOF"`, `\EOF`, `E"OF"`) makes the body literal, with no expansion. An unquoted delimiter allows `$(...)`, backticks and `$var` expansion in the body. `<<-` only strips leading tabs; quoting rules are the same.
- Policy: ADR-0001 (agents never push to main or write firmware to a board). The guard header says it "catches mistakes; it is not a sandbox", but it must not get weaker.

## Acceptance criteria

- [ ] The bash tokenizer recognises heredoc operators `<<WORD` and `<<-WORD`, works out whether the delimiter is quoted, and consumes the body up to the line that matches the delimiter. The body doesn't become command segments.
- [ ] **Quoted heredoc, inert target:** the body is treated as literal data. Backticks, `$(...)` and text such as `git push origin main` inside it don't cause a block when the receiving command is not a shell or interpreter (e.g. `cat`, `gh pr create --body-file -`, `git commit -F -`, `tee`).
- [ ] **Unquoted heredoc:** every `$(...)` and backtick substitution in the body is still extracted and checked like any other substitution. A body containing `` `git push origin main` `` or `$(git push origin HEAD:main)` is blocked. One containing `$(pio run -t upload)` is blocked.
- [ ] **Heredoc fed to a shell runs as a script:** when the receiving command is a shell or interpreter (`bash`, `sh`, `zsh`, `dash`, `pwsh`, `powershell`, plus `bash -s`, `sh -s` and wrapped forms), the body is parsed and checked as commands **whether or not the delimiter is quoted**. `bash <<'EOF'` with `git push origin main` in the body is blocked.
- [ ] Unterminated heredoc (no closing delimiter line) fails safe: treated as unparseable, which keeps the existing behaviour of blocking only when the text matches `RISKY`.
- [ ] Multiple heredocs on one line (`cmd <<A <<'B'`) and heredocs followed by `&&`/`;` chains on the operator line are handled. The commands after the operator on the same line are still checked.
- [ ] New test cases in `.claude/hooks/guard.test.js`, at least:
  - must-allow: `gh pr create --body-file - <<'EOF'` + body with backticks and `$(...)`
  - must-allow: the same with `<<"EOF"`
  - must-allow: `cat <<'EOF'` with `git push origin main` in the body
  - must-allow: `git commit -F - <<'EOF'` with backticks in the body
  - must-allow: `<<-'EOF'` with a tab-indented body and backticks
  - must-allow: `<<\EOF` with backticks
  - must-block: `cat <<EOF` with `` `git push origin main` `` in the body
  - must-block: `cat <<EOF` with `$(git push origin HEAD:main)` in the body
  - must-block: `cat <<EOF` with `$(pio run -t upload)` in the body
  - must-block: `bash <<'EOF'` with `git push origin main` in the body
  - must-block: `sh -s <<"EOF"` with `pio run -t upload` in the body
  - must-block: `bash <<EOF` with `git push -f origin main` in the body
  - must-block: `cat <<'EOF' && git push origin main` + body, so the command after the operator is still checked
  - risky-text case: an unterminated heredoc with `push` in it is blocked as unparseable
- [ ] All existing tests still pass, including the config check that the template copy matches.
- [ ] `templates/.claude/hooks/guard.js` and `templates/.claude/hooks/guard.test.js` stay byte-identical to the `.claude/` copies.
- [ ] Codex review round on the branch with no unresolved P1/P2 findings.

## Plan

Needs user approval before implementation (risk:security).

1. Write the failing tests from the acceptance criteria first (TDD), and confirm the new must-allow cases fail today and the must-block cases pass.
2. In `tokenize` (bash dialect only), detect `<<`/`<<-` outside quotes (but not `<<<` here-strings) and parse the delimiter word, recording whether any part was quoted or escaped. Queue a pending heredoc on the current segment.
3. At the next newline, consume each pending heredoc body line by line until the delimiter line (tabs stripped for `<<-`).
   - **Unquoted:** scan the body only for `$(...)` and backticks and push them to `subs`. Don't split it into segments.
   - **Quoted:** keep it as literal data.
   - Attach the body to the segment it belongs to.
4. In command checking, if a segment's command (after unwrapping) is a shell or interpreter reading stdin, run the full check on the heredoc body as a script, whatever the quoting.
5. Treat an unterminated heredoc as a `ParseError`, so the existing RISKY fallback applies.
6. Copy both files to `templates/`, run the full test suite, and update the guard header comment to mention heredocs.
7. Codex review, record it in `.collab/reviews/GUARD-2-r1.md`, open the PR. The merge is a human gate.

## Out of scope

- PowerShell here-strings (`@'...'@` literal, `@"..."@` expanding). They may have the same class of false positive, but that should be a separate task if it shows up.
- Bash here-strings (`<<<`). The word is already tokenized like a normal argument.
- Process substitution (`<(...)`, `>(...)`) and any other parser gaps not related to heredocs.
- Changing the merged state of PR #2 or the `agent/claude/guard-hook` branch.
