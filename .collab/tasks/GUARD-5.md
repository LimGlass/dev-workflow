---
id: GUARD-5            # Linear issue ID, e.g. NOVA-12
title: "Guard: make $( ) matching heredoc-aware (apostrophe false positive and early-close bypass)"
status: draft          # draft | plan-review | ready | in-progress | impl-review | changes-requested | human-gate | done
owner: claude          # implementing agent
reviewer: codex
branch: agent/claude/GUARD-5
risk: security         # low | normal | hardware | security  (Linear labels risk:low, risk:normal, risk:hardware, risk:security)
human_gates: [plan-approval, merge]        # e.g. [plan-approval, merge, firmware-flash, hardware-change]
---

## Goal

Make `matchParen` in `.claude/hooks/guard.js` find the real end of a `$( … )` substitution when it contains a heredoc. This fixes two problems with the same cause:

1. **False positive (fails safe).** `git commit -m "$(cat <<'EOF' … EOF )"`, the commit-message pattern agents use all the time, is blocked when the body contains an apostrophe, an unbalanced `(` or a double quote *and* mentions push/upload/flash/esptool.
2. **Bypass (does not fail safe).** An unbalanced `)` in the heredoc body closes the substitution early. The rest of the command, including real commands after `EOF`, is then treated as quoted text and never checked.

**Priority:** the owner set it to low on 2026-11-21, "since it fails safe". The bypass in point 2 was found afterwards, while drafting this task, and it does not fail safe. **The owner should reconsider the priority.**

## Context and links

- Found while implementing GUARD-2 ([LimGlass/dev-workflow#3](https://github.com/LimGlass/dev-workflow/pull/3)). The PR lists the false positive as a known limit; the bypass was found later.
- Cause: `matchParen` (guard.js, `function matchParen`) counts `(`/`)` and skips `'…'`/`"…"` by searching for the next matching quote character. It doesn't know about heredocs (or comments, or backslash escapes inside `$( )`). A heredoc body is literal text in bash, so its apostrophes and parentheses must not count.
- Probes on 2026-11-21 with `check()` (nothing executed). Results are the same on `main` (`1b5a589`) and on GUARD-2.
  - **False positives (blocked, fail safe):**
    - body `Don't block push docs` → `unterminated quote inside $( )`
    - body `see (upload notes` → `unterminated quote inside $( )`
    - body `the "flash step` → `unterminated $( )`
    - `git commit -m "$(cat <<'EOF'\nDon't care\nEOF\n)" && git push origin main` is blocked for the parse error, not for the push. That's the right result for the wrong reason.
  - **Bypasses (allowed, should be blocked):**
    - `echo "$(cat <<'EOF'\n1)\nEOF\ngit push origin main)"`
    - `x="$(cat <<'EOF'\nstep 1) done\nEOF\npio run -t upload)"`
    - `echo "$(cat <<'EOF'\na)\nEOF\nesptool.py write_flash 0x0 fw.bin)"`
  - The unquoted form, `echo $(cat <<'EOF'\n1)\nEOF\ngit push origin main)`, is blocked: the leftover text is still tokenized as commands. Only the double-quoted form hides it.
- GUARD-4's pre-push hook will stop the **push** route once it lands, but not the **upload/flash** route, which only the guard covers.
- Sequencing as drafted: GUARD-2 → GUARD-4 → GUARD-3 → GUARD-5, all in `guard.js`, each branch cut from `main` after the previous one merges. **If the owner raises the priority, GUARD-5 could go straight after GUARD-2.** The fix should reuse GUARD-2's heredoc delimiter parsing.
- Policy: ADR-0001.

## Acceptance criteria

- [ ] `matchParen` handles heredocs inside the substitution. When it meets `<<WORD`, `<<-WORD` or a quoted delimiter, it skips the body (from the next newline to the delimiter line) without counting quotes or parentheses in it. Here-strings (`<<<`) are not heredocs.
- [ ] `matchParen` also ignores `#` comments to end of line (outside quotes, at word start) and handles backslash escapes inside double quotes (`"a\"b"`), so neither ends a quote or the substitution early.
- [ ] The heredoc body inside `$( )` is attached as stdin to its consumer, as GUARD-2 does at top level. This already happens when the inner text is passed to `analyze()`; it must keep working.
- [ ] Unterminated heredocs or quotes inside `$( )` still raise `ParseError` (RISKY fallback, fails safe).
- [ ] Tests in `guard.test.js`:
  - must-allow: `git commit -m "$(cat <<'EOF' … EOF )"` with bodies containing an apostrophe plus "push", an unbalanced `(` plus "upload", an unbalanced `)` plus "push", and a stray `"` plus "flash"
  - must-allow: the same with `<<"EOF"` and `<<-'EOF'`
  - must-block: the three bypass probes above (push, `pio run -t upload`, `esptool.py write_flash`)
  - must-block: `git commit -m "$(cat <<'EOF'\nDon't care\nEOF\n)" && git push origin main`, blocked with reason `updates main` (not a parse error)
  - must-block: an unterminated heredoc inside `$( )` that mentions push
- [ ] All existing tests pass, and the `templates/` copies stay byte-identical.
- [ ] Codex review with no unresolved P1/P2 or high findings. Under the new AGENTS.md rule (added on the GUARD-4 branch), rejecting one needs owner sign-off before the PR.

## Plan

Needs user approval before implementation (risk:security).

1. Write the tests first and confirm the false positives and bypasses reproduce.
2. Move GUARD-2's heredoc delimiter parsing into a shared helper. Teach `matchParen` to queue heredocs and skip their bodies at newlines, and to skip comments and double-quote escapes.
3. Run the full suite, the GUARD-2 probe set, and new probes for nested cases (`$( $( … ) )`, a heredoc inside `bash -c "…"` inside `$( )`).
4. Sync `templates/`, Codex review recorded in `.collab/reviews/GUARD-5-r1.md`, open the PR. The merge is a human gate.

## Out of scope

- A full bash parser. This fixes substitution matching for heredocs, comments and escapes only.
- `$(( … ))` arithmetic and `case` patterns with a bare `)` inside `$( )`. Note them if a probe shows a bypass, otherwise leave them.
- The same early-close problem with backtick substitutions (they can't nest heredocs in the same way). Probe it during implementation and file it separately if found.
