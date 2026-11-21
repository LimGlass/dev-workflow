---
id: GUARD-2            # Linear issue ID, e.g. NOVA-12
title: "Guard: text-only heredocs stop false positives; text fed to any other command is checked"
status: in-progress    # draft | plan-review | ready | in-progress | impl-review | changes-requested | human-gate | done
owner: claude          # implementing agent
reviewer: codex
branch: agent/claude/GUARD-2
risk: security         # low | normal | hardware | security  (Linear labels risk:low, risk:normal, risk:hardware, risk:security)
human_gates: [plan-approval, merge]        # e.g. [plan-approval, merge, firmware-flash, hardware-change]
---

## Goal

Two outcomes for `.claude/hooks/guard.js`:

1. **No false positives for text-only heredocs.** A quoted heredoc (`<<'EOF'`, `<<"EOF"`) going to a command that only treats its input as text, such as `gh pr create --body-file -`, is no longer blocked because its body contains backticks, `$(...)` or words like "git push origin main".
2. **No bypass through stdin.** Text that reaches any *other* command's stdin is scanned for guarded operations, and the command is blocked if one is found. This covers heredocs, here-strings and piped literal text, sent to shells, python, node, perl, ruby or unknown programs. Command substitution in unquoted heredocs stays checked.

## Context and links

- Found on 2026-11-21 while opening [LimGlass/dev-workflow#2](https://github.com/LimGlass/dev-workflow/pull/2). `gh pr create --body-file - <<'EOF'` with Markdown backticks in the body was blocked with `the command name is computed at run time` (guard.js:390). It happened again in this session when writing a probe script with `cat > file <<'EOF'`.
- Root cause of the false positive: the bash tokenizer (`tokenize`, guard.js:75) has no `<<` handling. Heredoc body lines are tokenized as command text:
  - backticks become substitutions (guard.js:172-179)
  - `$(...)` becomes a substitution (guard.js:146)
  - each body line becomes its own command segment
- **Plan review r1** ([.collab/reviews/GUARD-2-plan-r1.md](../reviews/GUARD-2-plan-r1.md), Codex adversarial review, accepted). The original plan only re-checked heredocs fed to a named list of shells, so `python <<'EOF'` running `os.system("git push origin main")` would have slipped through. This revision replaces that list with an allowlist of text-only consumers.
- **The same gap is live on `main` today** (`1b5a589`, probed 2026-11-21). The current guard **allows** all of these:
  - Bash dialect:
    - heredocs: `python <<'X'` / `node <<'X'` with push or `pio run -t upload` code in the body
    - here-strings: `bash <<< 'git push origin main'`, `python <<< '…os.system("git push origin main")'`
    - piped literal text: `printf 'git push origin main\n' | bash`, `echo 'pio run -t upload' | sh`, `printf '…' | python`, `echo '…' | node`
  - PowerShell dialect: `'git push origin main' | bash`, `'git push origin main' | pwsh -Command -`, `'…os.system(…)' | python`, `Write-Output 'pio run -t upload' | sh`
- Why: `checkShell` returns `null` when there is no `-c` (guard.js:466-468), `checkPython` returns `null` with no script argument (guard.js:532-549), and `node`, `perl` and `ruby` aren't handled at all.
- `bash <<'X'` and `cat <<'X' | bash` with a push in the body are blocked today **only by accident**, because the body is tokenized as commands. Fixing the tokenizer removes that accident, so they must become explicit must-block tests.
- Bash semantics: quoting any part of the delimiter (`'EOF'`, `"EOF"`, `\EOF`, `E"OF"`) makes the body literal. An unquoted delimiter allows `$(...)`, backticks and `$var` expansion. `<<-` strips leading tabs only.
- Policy: ADR-0001 (agents never push to main or write firmware to a board). The guard "catches mistakes; it is not a sandbox", but this change must not weaken it.

## Design

**Stdin text sources.** The guard tracks text that reaches a command's stdin from any of these:

- a heredoc body, quoted or unquoted
- a here-string word (`<<<`)
- a pipe from a producer whose output is a literal known before the command runs:
  - bash: `echo` / `printf` with literal arguments
  - PowerShell: a string literal, or `Write-Output` / `echo` of literals
  - `cat` / `tee` passing through such a source

**Text-only consumers (allowlist).** These receive stdin text unchecked:

- `cat`
- `tee`
- `gh <subcommand> … --body-file -` (or `--body-file=-`)
- `git commit -F -` (or `--file -` / `--file=-`)

The allowlist is matched exactly, including the `-` stdin argument. A bare `gh` or `git commit` without it is not on the allowlist. `cat` and `tee` copy stdin to stdout, so when their output is piped onward the text **flows on to the next command** and is classified there. For example, `cat <<'EOF' | bash` is checked as text sent to `bash`.

**Every other consumer.** The text is scanned:

- **Shells** (`bash`, `sh`, `zsh`, `dash`, `ksh`, `ash`, `mksh`, `fish`, including `-s`; `pwsh`/`powershell` with `-Command -` or reading stdin): the text is parsed and checked as a script with the full guard. A push to `agent/*` is allowed and a push to `main` is blocked. If the text can't be parsed, use the existing fallback: block if it matches `RISKY` (push|upload|uploadfs|flash|esptool).
- **Everything else** (python, node, perl, ruby, unknown programs): the text can't be parsed reliably, so block if it matches `RISKY`. This is the same fail-safe that `python -c` uses today (guard.js:542).

**Unquoted heredocs.** `$(...)` and backtick substitutions in the body are extracted and checked like any other substitution, *in addition* to the consumer rule above.

## Acceptance criteria

- [ ] The bash tokenizer recognises `<<WORD`, `<<-WORD` and `<<<word`. It works out whether a heredoc delimiter is quoted and consumes the body up to the delimiter line. Body lines no longer become command segments.
- [ ] Stdin text from heredocs, here-strings and literal pipe producers is attached to the command that receives it, in both the bash and PowerShell dialects.
- [ ] **Allowlisted text consumers** (`cat`, `tee`, `gh … --body-file -`, `git commit -F -`) get heredoc/here-string/piped text unchecked. Backticks, `$(...)` and words like "git push origin main" in a quoted body don't cause a block.
- [ ] **Pass-through:** text that goes through `cat`/`tee` into another command via a pipe is checked against that next command.
- [ ] **Any other consumer** has its stdin text scanned. Shells: full guard parse with the RISKY fallback. Non-shells (python, node, perl, ruby, unknown): block if the text matches RISKY.
- [ ] **Unquoted heredocs:** every `$(...)` and backtick substitution in the body is checked, even when the consumer is allowlisted.
- [ ] An unterminated heredoc fails safe: treated as unparseable, so it's blocked if the text matches RISKY.
- [ ] Multiple heredocs on one line (`cmd <<A <<'B'`), and commands after the operator on the same line (`&&`, `;`, `|`), are handled. Those later commands are still checked.
- [ ] New test cases in `.claude/hooks/guard.test.js` (see the test list below), plus all existing tests still pass.
- [ ] `templates/.claude/hooks/guard.js` and `templates/.claude/hooks/guard.test.js` stay byte-identical to the `.claude/` copies.
- [ ] The guard header comment documents the heredoc/stdin rules and the limits listed under "Out of scope".
- [ ] Codex review round on the implementation with no unresolved P1/P2 or high findings.

### Test cases

**Must-allow (allowlisted text consumers):**
- `gh pr create --body-file - <<'EOF'`, body with backticks, `$(...)` and "git push origin main"
- `gh pr create --body-file - <<"EOF"`, same body
- `gh issue create --body-file=- <<'EOF'`, body with backticks
- `git commit -F - <<'EOF'`, body with backticks and "pio run -t upload"
- `git commit --file - <<'EOF'`, body with backticks
- `cat <<'EOF'`, body "git push origin main"
- `cat > notes.md <<'EOF'`, body with backticks and `$(...)`
- `tee notes.md <<'EOF'`, body with backticks and "git push origin main"
- `cat <<-'EOF'`, tab-indented body with backticks
- `cat <<\EOF`, body with backticks
- `printf 'git push origin main\n' | cat`
- `echo 'see `docs`' | tee log.txt`
- `bash <<'EOF'`, body `git push origin agent/claude/x` (a shell consumer is parsed precisely, and pushing to an agent branch is allowed)

**Must-block (other consumers):**
- `python <<'EOF'`, body `import os` / `os.system("git push origin main")`
- `python3 <<"EOF"`, body calling `subprocess.run(["pio", "run", "-t", "upload"])`
- `node <<'EOF'`, body `require("child_process").execSync("git push origin main")`
- `node <<'EOF'`, body running `esptool.py write_flash …`
- `perl <<'EOF'`, body `system("git push origin main")`
- `ruby <<'EOF'`, body `system("pio run -t upload")`
- `some-unknown-tool <<'EOF'`, body "git push origin main"
- `bash <<'EOF'`, body `git push origin main` (regression; blocked today only by accident)
- `sh -s <<"EOF"`, body `pio run -t upload`
- `bash <<EOF`, body `git push -f origin main`
- `cat <<'EOF' | bash`, body `git push origin main` (pass-through)
- `bash <<< 'git push origin main'`
- `python <<< 'import os; os.system("git push origin main")'`

**Must-block (piped literal text):**
- `printf 'git push origin main\n' | bash`
- `echo 'pio run -t upload' | sh`
- `printf 'import os\nos.system("git push origin main")\n' | python`
- `echo 'require("child_process").execSync("git push origin main")' | node`
- PowerShell: `'git push origin main' | pwsh -Command -`
- PowerShell: `'import os; os.system("git push origin main")' | python`

**Must-block (unquoted heredoc substitutions):**
- `cat <<EOF`, body with `` `git push origin main` ``
- `cat <<EOF`, body with `$(git push origin HEAD:main)`
- `gh pr create --body-file - <<EOF`, body with `$(pio run -t upload)` (allowlisted consumer, but the substitution still runs)

**Edge cases:**
- must-block: `cat <<'EOF' && git push origin main` + body (the command after the operator is still checked)
- must-block: an unterminated heredoc to `bash` whose text contains "push" (unparseable, RISKY fallback)
- must-allow: `cat <<A <<'B'` with two text bodies, one containing backticks

## Plan

Needs user approval before implementation (risk:security). **Approved by the owner on 2026-11-21** (revision `ba7d378`, after plan review r1). Any change to the design or scope during implementation goes back for approval.

1. Write the tests above first (TDD). Confirm the must-allow false positives fail today, and that the must-block cases currently allowed (python/node/perl/ruby heredocs, here-strings, piped literals) fail today too.
2. Tokenizer (bash): recognise `<<`, `<<-` and `<<<` outside quotes. For heredocs, parse the delimiter word, record whether it's quoted, and at the next newline consume the body up to the delimiter line (stripping tabs for `<<-`). For unquoted bodies, extract `$(...)`/backtick substitutions into `subs`. Attach `{ kind, text, quoted }` stdin sources to the segment. An unterminated body throws `ParseError`.
3. Tokenizer: record pipe links between segments (`a | b`) so a segment knows its upstream producer, in both the bash and PowerShell dialects.
4. Producer resolution: a pipe producer is a literal stdin source when it is bash `echo`/`printf` with non-dynamic arguments (apply `printf`'s `\n` escapes), a PowerShell string literal or `Write-Output`/`echo` of literals, or `cat`/`tee` whose own stdin is a literal source (pass-through). Any other producer has unknown output.
5. Consumer check in `checkSegment`: when a segment has a known stdin text source, check whether the command is on the text-only allowlist (exact match, including the `-` argument). If not, use the full guard parse for shells (RISKY fallback if unparseable) and the RISKY scan for everything else.
6. Copy both files to `templates/`, run the full suite, and update the header comment.
7. Codex review of the implementation, recorded in `.collab/reviews/GUARD-2-r1.md`. Open the PR. The merge is a human gate.

## Out of scope

Known limits, documented in the guard header rather than fixed here:

- **Stdin whose content isn't known before it runs**, e.g. `cat script.sh | bash`, `bash < script.sh`, `python - < x.py`, `curl … | bash`. These match the existing rule that scripts aren't inspected (`bash script.sh` is already allowed). Two-step tricks like `tee x.sh <<'EOF'` followed by `bash x.sh` are also out of scope.
- **Obfuscated text** that hides the guarded words from the RISKY scan (string concatenation, encoding). The guard catches mistakes; it isn't a sandbox.
- **Inline code flags for node/perl/ruby** (`node -e`, `perl -e`, `ruby -e`). These are currently allowed even when they run `git push origin main` (probed 2026-11-21). This is a related gap but not about stdin, so it should be a separate follow-up task, similar to how `python -c` is handled.
- **PowerShell here-strings** (`@'…'@`, `@"…"@`) as a false-positive source. They are covered as a pipe producer only if the PowerShell tokenizer already handles them; otherwise that's a follow-up.
- Process substitution (`<(...)`, `>(...)`), `xargs`, and other parser gaps not about stdin text.
