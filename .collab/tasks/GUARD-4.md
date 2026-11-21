---
id: GUARD-4            # Linear issue ID, e.g. NOVA-12
title: "Versioned Git pre-push hook rejecting pushes to main, plus a guard rule against --no-verify"
status: draft          # draft | plan-review | ready | in-progress | impl-review | changes-requested | human-gate | done
owner: claude          # implementing agent
reviewer: codex
branch: agent/claude/GUARD-4
risk: security         # low | normal | hardware | security  (Linear labels risk:low, risk:normal, risk:hardware, risk:security)
human_gates: [plan-approval, merge]        # e.g. [plan-approval, merge, firmware-flash, hardware-change]
---

## Goal

Add a second, independent layer against pushes to `main`. This is a versioned Git `pre-push` hook, enabled through `core.hooksPath` and copied into `templates/`. Git itself runs it on every push, so it rejects any update of `refs/heads/main` no matter how git was invoked: scripts, aliases, `bash -c`, interpreters, stdin tricks, or anything else `.claude/hooks/guard.js` can't see. The Claude guard gets a matching rule that blocks the ways to skip or disable that hook (`git push --no-verify` and its equivalents).

## Context and links

- ADR-0001: agents never push to main or write firmware to a board. `main` changes only through user-merged pull requests.
- `.claude/hooks/guard.js` parses command text, so by design it can't see pushes made from inside scripts, git aliases, or programs whose code isn't visible in the command. Its header says: "This catches mistakes; it is not a sandbox. Scripts, aliases and git aliases are not inspected."
- GUARD-2 closes stdin/heredoc/pipe routes. GUARD-3 closes `node -e`/`perl -e`/`ruby -e`. Both are text-parsing fixes. A pre-push hook covers every push route at once, which is why GUARD-4 is sequenced **before GUARD-3** (owner's decision, 2026-11-21).
- Sequencing: GUARD-2 → **GUARD-4** → GUARD-3. GUARD-4 edits `guard.js` (the `--no-verify` rule), so cut its implementation branch from `main` after GUARD-2 merges.
- Today: `core.hooksPath` is unset in this repo, there are no non-sample hooks in `.git/hooks`, and nothing in the repo mentions `--no-verify` or `hooksPath`.
- Git facts the design depends on:
  - `pre-push` receives `<local ref> <local sha> <remote ref> <remote sha>` lines on stdin, one per ref being updated. A non-zero exit aborts the whole push.
  - It is skipped by `git push --no-verify` (also `--no-verify` placed before the remote) and by any setting that points `core.hooksPath` elsewhere, e.g. `git -c core.hooksPath=/dev/null push`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`, or `git config core.hooksPath …`.
  - `core.hooksPath` is local config, not versioned, so each clone has to set it.

## Acceptance criteria

- [ ] A versioned hook at `.githooks/pre-push` (and `templates/.githooks/pre-push`, byte-identical). It reads the stdin ref lines and exits non-zero with an ADR-0001 message if any **remote ref** is `refs/heads/main`. That includes creates, updates, force-updates and deletes (a delete has a local sha of all zeros), for any remote name or URL.
- [ ] The hook allows pushes to every other ref (e.g. `refs/heads/agent/claude/x`, tags).
- [ ] The hook runs on Windows (Git for Windows' bundled sh) as well as macOS/Linux. It needs nothing beyond what the repo already needs (Node.js is already required by the guard, or plain POSIX sh).
- [ ] This repo sets `core.hooksPath=.githooks`, and the README's "Using the templates in a project" steps tell new projects to run `git config core.hooksPath .githooks`.
- [ ] New guard rule in `.claude/hooks/guard.js`: block `git push` with `--no-verify`, in any position and combined with any other flags, whatever the target branch. The block message explains that the pre-push hook must not be skipped.
- [ ] New guard rule: block attempts to bypass or repoint the hook. This covers:
  - `git -c core.hooksPath=… push`
  - `git config [--local|--global|--system|--worktree] core.hooksPath <anything other than .githooks>`
  - `git config --unset core.hooksPath`
  - `GIT_CONFIG_PARAMETERS=…` / `GIT_CONFIG_COUNT=…` env assignments in front of a git push
  - edits or deletion of `.githooks/pre-push` through shell commands (`rm`, `mv`, redirect, `chmod -x`)

  Each case gets must-block tests. Matching is case-insensitive where git is (`core.hookspath`).
- [ ] Tests for the hook itself, a new `.githooks/pre-push.test.js` (or equivalent) that pipes sample ref lines in:
  - must-reject: an update of main, a force-update of main, a delete of main, and main among several refs
  - must-accept: agent branches and tags
- [ ] Guard tests in `guard.test.js` for all new rules, plus must-allow cases: a plain `git push origin agent/claude/x`, `git config core.hooksPath .githooks`, and `git log --no-verify`-style flags on other subcommands.
- [ ] `templates/` copies stay byte-identical (the guard test already checks guard.js; extend the check to the hook).
- [ ] An end-to-end check in a throwaway repo with a local bare remote:
  - `git push origin HEAD:main` is rejected by the hook.
  - `git push origin HEAD:agent/x` succeeds.
  - Both run outside Claude Code, i.e. without the guard.
- [ ] Codex review with no unresolved P1/P2 or high findings.

## Plan

Needs user approval before implementation (risk:security).

1. Write the hook tests and guard tests first (TDD) and confirm they fail.
2. Implement `.githooks/pre-push`. Prefer a small POSIX sh script with no dependencies, or a Node script with a sh shim if parsing is clearer. Decide during plan review.
3. Add the guard rules: a `--no-verify` check inside `checkPush`; a `core.hooksPath` check for `git -c`, `git config` and env assignments; protection for the hook file.
4. Set `core.hooksPath` in this repo, update the README steps and layout block, and copy to `templates/`.
5. Run the end-to-end check in a temp repo with a bare remote. Run the full test suites.
6. Codex review, recorded in `.collab/reviews/GUARD-4-r1.md`. Open the PR. The merge is a human gate.

## Out of scope

- **Server-side protection.** GitHub branch protection or rulesets on `main` (require a PR, block force-pushes) is the only layer an agent can't bypass locally. The owner sets it in GitHub; recommend it in the PR, but this task doesn't change repo settings.
- Firmware upload/flash routes. The pre-push hook only covers git; upload/flash coverage stays with the guard.
- Pushes made by tools that don't run git hooks (e.g. the GitHub API or `gh api` writing refs directly). Server-side protection covers those.
- Making `core.hooksPath` impossible to change. The guard blocks the obvious commands, but a determined bypass through a script is out of scope ("catches mistakes; it is not a sandbox").
