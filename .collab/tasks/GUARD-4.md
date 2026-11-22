---
id: GUARD-4            # Linear issue ID, e.g. NOVA-12
title: "Versioned Git pre-push hook rejecting pushes to main, plus guard rules against skipping or disabling it"
status: human-gate     # draft | plan-review | ready | in-progress | impl-review | changes-requested | human-gate | done
owner: claude          # implementing agent
reviewer: codex
branch: agent/claude/GUARD-4
risk: security         # low | normal | hardware | security  (Linear labels risk:low, risk:normal, risk:hardware, risk:security)
human_gates: [plan-approval, merge]        # e.g. [plan-approval, merge, firmware-flash, hardware-change]
---

## Goal

Add a second, independent layer against pushes to `main`: a versioned Git `pre-push` hook. Git itself runs it on every push, so it rejects any update of `refs/heads/main` however git was invoked. That covers scripts, aliases, interpreters, stdin tricks, and the parser gaps `.claude/hooks/guard.js` can't see (such as GUARD-5's early-close bypass). The Claude guard gets matching rules so an agent can't skip, repoint or delete that hook, and so the hook must be active before any push.

## Context and links

- ADR-0001: agents never push to main or write firmware to a board. `main` changes only through user-merged pull requests.
- `guard.js` parses command text, so it can't see pushes from inside scripts, git aliases, or code it can't read. Its header says: "This catches mistakes; it is not a sandbox."
- **Sequencing (owner, 2026-11-21):** GUARD-2 (merged as PR #3) → **GUARD-4** → GUARD-5 → GUARD-3. GUARD-4 comes first because it covers every push route at once. This branch is cut fresh from `main` after PR #3 merged.
- This branch also carries two process changes made on 2026-11-21, kept as separate commits:
  - the `templates/AGENTS.md` rule "Rejecting a P1 or high-severity review finding on a risk:security or risk:hardware task needs owner sign-off before the PR is opened"
  - the owner's sign-off on the GUARD-2 r1 P1 rejection, recorded in `.collab/reviews/GUARD-2-r1.md`
- Today: `core.hooksPath` is unset in this repo, `.git/hooks` has only samples, and nothing mentions `--no-verify` or `hooksPath`. The guard hook only sees the **Bash and PowerShell** tools (`matcher: "Bash|PowerShell"`), so Claude's Edit/Write tools are covered only by permission rules.
- Git facts the design depends on:
  - `pre-push` gets the remote name and URL as `$1`/`$2`, and one line per ref on stdin: `<local ref> <local sha> <remote ref> <remote sha>`. A delete has local ref `(delete)` and an all-zero sha. A non-zero exit aborts the whole push.
  - It is skipped by `git push --no-verify`. Git accepts unambiguous abbreviations of long options, so `--no-veri`, `--no-verif` and so on also skip it. (`--no-ver` is ambiguous with `--no-verbose` and fails.)
  - Ways to repoint `core.hooksPath` for one command: `git -c core.hooksPath=…`, `git --config-env=core.hooksPath=VAR`, `GIT_CONFIG_PARAMETERS`, or `GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`. Persistently: `git config [--local|--global|--system|--worktree|--file …] core.hooksPath …`, `git config --unset[-all] core.hooksPath`, or the newer `git config set|unset …`. Config keys are case-insensitive (`core.hookspath`).
  - `core.hooksPath` is local config, not versioned, so every clone must set it.
  - Claude Code permission rules: `Edit(path)` deny rules cover Edit, Write and NotebookEdit, and also Bash writes through `tee` and `>` redirection. They don't stop `rm`/`mv` or scripts. `Write(path)` rules never match. (code.claude.com/docs/en/permissions, checked via Context7 on 2026-11-21.)

## Design

1. **The hook: `.githooks/pre-push`**, POSIX `sh` with no dependencies. It runs under Git for Windows' bundled sh and on macOS/Linux. It reads every stdin line and rejects if any remote ref equals `refs/heads/main`, compared case-insensitively to match the guard. That includes creates, updates, force-updates and deletes. It prints an ADR-0001 message naming the remote and exits 1 after reading all lines, so every offending ref is reported. Committed with mode `100755`. A `.gitattributes` rule (`.githooks/* text eol=lf`, in this repo and in `templates/`) keeps it LF on Windows: this repo has `core.autocrlf=true`, and a CRLF shebang would break the script.
2. **Activation.** This repo sets `git config core.hooksPath .githooks`. The README setup steps add the same command for new projects, and `templates/.githooks/pre-push` is a byte-identical copy.
3. **Guard rule A: the hook must be active.** If the repository being pushed from contains `.githooks/pre-push` and its effective `core.hooksPath` (read with the same `-C`/`-c` options as the push) is not `.githooks`, `git push` is blocked with the one-line fix. Repos without the hook file are unaffected. **This is a decision for you:** it adds friction on fresh clones until the hook is enabled, but without it the hook protects nothing until someone remembers to set it.
4. **Guard rule B: no skipping.** `git push` with `--no-verify`, or any abbreviation from `--no-veri` up, in any position, is blocked whatever the target. `git commit --no-verify` is not affected: it doesn't skip pre-push.
5. **Guard rule C: no repointing for a push.** A `git push` is blocked when its own command sets `core.hooksPath` through `-c` or `--config-env`, or is preceded by `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*` assignments. That covers inline `VAR=…`, `env VAR=…`, `export VAR=…` earlier on the same line, and PowerShell `$env:GIT_CONFIG_* = …`.
6. **Guard rule D: no persistent changes.** These are blocked:
   - `git config … core.hooksPath <value>` with any value other than `.githooks`, in any scope
   - `--unset`/`--unset-all` of it
   - `git config set|unset core.hooksPath …`
   - writing the key with `--file` or `-f`

   Setting it to `.githooks` is allowed. Reading it (`--get`, `--list`) is allowed.
7. **Guard rule E: no deleting or moving the hook.** `rm`, `mv`, `cp` onto, `chmod`, `git rm`, `git mv`, `Remove-Item`/`Move-Item`/`Copy-Item`/`Set-Content`/`Out-File`/`Add-Content` targeting `.githooks` or `.githooks/pre-push` are blocked.
8. **Permission deny rules** in both `settings.json` files: `Edit(/.githooks/**)` and `Edit(/.git/config)`. This stops Claude's file tools, and Bash `tee`/`>` writes, from editing the hook or repointing `core.hooksPath` in the git config. Check the exact path syntax against the current permissions docs while implementing, and keep it in the config test.
9. **AGENTS.md hard rules** (template) get one line: agents must never skip or disable Git hooks (`--no-verify`, changing `core.hooksPath`, editing `.githooks/`).
10. **Guard rule F: no writing `main` or merging through the GitHub API** (owner, 2026-11-21). These `gh api` calls are blocked:
    - a write (PATCH/POST/PUT/DELETE) to `git/refs/heads/main`
    - creating `refs/heads/main` through a POST to `git/refs`
    - a pull request merge endpoint (`pulls/<n>/merge`)
    - other routes that write `main`: a POST to `merges` with base `main`; PUT/DELETE on `contents/…` with branch `main` or no branch (which means the default branch); writes under `branches/main/…`, including removing branch protection; POST to `merge-upstream` for `main`
    - GraphQL mutations that merge or move refs: `mergePullRequest`, `mergeBranch`, `enablePullRequestAutoMerge`, `updateRef(s)`, `createRef`, `deleteRef`
    - `gh pr merge`, which calls the merge endpoint, in any flag order (today only the prefix deny rule `Bash(gh pr merge:*)` covers it)

    The method follows `gh` itself: `-X/--method` if given, otherwise POST when fields (`-f/-F/--raw-field/--field`) or `--input` are present, otherwise GET. Endpoints are matched with or without a leading `/`, as full `https://api.github.com/…` URLs, with `{owner}/{repo}` placeholders, URL-decoded, and case-insensitively for `main`. Read-only calls stay allowed.

## Acceptance criteria

- [x] `.githooks/pre-push` exists, is POSIX sh, has mode `100755`, and is byte-identical to `templates/.githooks/pre-push`.
- [x] **End-to-end hook test**, `.githooks/pre-push.test.js` (Node). It runs real `git` in temp repos with a local bare remote and `core.hooksPath` pointing at this hook:
  - rejected: `HEAD:main`; force `+HEAD:main`; `--delete main`; `main` pushed together with `agent/x`; `HEAD:refs/heads/main`; `HEAD:MAIN`
  - accepted: `HEAD:agent/claude/x`, tags, deleting `agent/x`
  - the rejection message names ADR-0001

  It runs on Windows (Git for Windows) and on POSIX.
- [x] This repo has `core.hooksPath=.githooks`. The README setup step and layout block are updated, and the README recommends GitHub branch protection.
- [x] Guard rules A–E are implemented in `guard.js`, with the `templates/` copy byte-identical.
- [x] Guard tests, must-block:
  - A: `git push origin agent/x` in a temp repo that has `.githooks/pre-push` but no `core.hooksPath`
  - B: `git push --no-verify origin agent/x`, `git push origin agent/x --no-verify`, `git push --no-verif origin agent/x`, and in PowerShell
  - C: `git -c core.hooksPath=/dev/null push origin agent/x`, `git -c core.hookspath=x push`, `git --config-env=core.hooksPath=H push`, `GIT_CONFIG_PARAMETERS="'core.hooksPath=x'" git push`, `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=x git push`, `export GIT_CONFIG_PARAMETERS=…; git push`, PowerShell `$env:GIT_CONFIG_PARAMETERS="…"; git push`
  - D: `git config core.hooksPath /dev/null`, `git config --global core.hooksPath x`, `git config --unset core.hooksPath`, `git config unset core.hooksPath`, `git config set core.hooksPath x`, `git config --file .git/config core.hooksPath x`
  - E: `rm .githooks/pre-push`, `rm -rf .githooks`, `mv .githooks/pre-push x`, `chmod -x .githooks/pre-push`, `git rm .githooks/pre-push`, PowerShell `Remove-Item .githooks/pre-push`
- [x] Guard tests, must-allow:
  - `git push origin agent/claude/x` in a repo with the hook active
  - `git push` in a repo with no `.githooks/pre-push`
  - `git config core.hooksPath .githooks`, `git config --get core.hooksPath`
  - `git commit --no-verify -m wip`
  - `git push --verbose origin agent/x`
  - `cat .githooks/pre-push`
- [x] The config tests also check: both `Edit(...)` deny rules are present, and the hook template copy matches. The `core.hooksPath` check reports SKIP rather than FAIL when it isn't set (CI clones).
- [x] Guard rule F tests:
  - must-block:
    - `gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=…`
    - `gh api --method DELETE repos/{owner}/{repo}/git/refs/heads/main`
    - `gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=…` (implicit POST)
    - `gh api -X PUT repos/o/r/pulls/3/merge`, `gh api --method=PUT /repos/o/r/pulls/3/merge -f merge_method=squash`
    - `gh api -XPOST repos/o/r/merges -f base=main -f head=x`
    - `gh api -X PUT repos/o/r/contents/f -f message=m -f content=… -f branch=main`, and the same with no branch
    - `gh api -X DELETE repos/o/r/branches/main/protection`
    - a full `https://api.github.com/…/git/refs/heads/main` PATCH
    - GraphQL `mergePullRequest` and `updateRef` mutations
    - `gh pr merge 3 --squash`, `gh pr merge -R o/r 3`
    - one PowerShell case
  - must-allow:
    - GETs of `git/refs/heads/main` (implicit and `-X GET`) and of `pulls/3/merge`
    - `gh api repos/o/r/pulls --paginate`
    - a GraphQL `query { … mergeable … }`
    - a PATCH to `git/refs/heads/agent/claude/x`
    - a contents PUT with `branch=agent/claude/x`
    - `gh pr create …`, `gh pr view 3`
- [x] `.gitattributes` keeps `.githooks/*` LF in this repo and in `templates/`.
- [x] Every existing guard test passes, including GUARD-2's.
- [x] Codex review with no unresolved P1/P2 or high findings. Rejecting one needs owner sign-off before the PR (new AGENTS.md rule).

## Plan

Needs user approval before implementation (risk:security). **Approved by the owner on 2026-11-21**, with two decisions: keep rule A (block pushes while the hook exists but `core.hooksPath` isn't `.githooks`), and add rule F (GitHub API writes to `main` and merges). Any further change to the design or scope goes back for approval.

1. Write the hook's end-to-end test and the guard tests first (TDD), and confirm they fail.
2. Write `.githooks/pre-push`, set the exec bit (`git update-index --chmod=+x`), and set `core.hooksPath` in this repo. Get the end-to-end test passing.
3. Add guard rules B and C inside `checkGit`/`checkPush` (option and env scan), rule D as a `git config` check, rule E as a small path check for the file commands listed, rule A as a `git config --get core.hooksPath` lookup before the push checks, and rule F as a `gh` check (an `api` argument parser plus `pr merge`).
4. Add the deny rules to both `settings.json` files, and update the README and `templates/AGENTS.md`. Copy everything to `templates/`.
5. Run the full suites and check live in this session: a dry-run push with `--no-verify` is blocked by the guard, and a real push of a throwaway ref to a local bare remote is rejected by the hook.
6. Codex review, recorded in `.collab/reviews/GUARD-4-r1.md`. Open the PR. The merge is a human gate.

## Out of scope

- **Server-side protection.** GitHub branch protection or rulesets on `main` (require a PR, block force-pushes and deletion) is the only layer an agent can't bypass locally. The owner sets it in GitHub; the README and PR recommend it, but this task changes no repo settings.
- **Firmware upload/flash routes.** The pre-push hook only covers git; uploads stay with the guard (GUARD-5, GUARD-3).
- **Pushes that don't run local hooks, beyond rule F's `gh` coverage**: direct `curl` calls to the GitHub API, other API clients, `gh api` requests whose body comes from a file or stdin (`--input`, `-F field=@file`), and repository rulesets. Server-side protection covers those.
- **A determined bypass through a script that edits `.git/config` or the hook itself.** The guard and deny rules block the obvious commands; the guard "catches mistakes; it is not a sandbox".
