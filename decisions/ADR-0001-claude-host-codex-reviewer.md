# ADR-0001: Claude Code as host, Codex as reviewer via codex-plugin-cc

**Status:** Proposed  
**Date:** 2026-11-18  
**Decision owner:** Human project owner  
**Scope:** Reusable development workflow for NOVA and future projects

## Context

The project needs a practical development workflow on a Windows laptop. Claude Code will be the primary implementation environment, with Codex providing independent review. The workflow must retain human control over merges, firmware flashing, hardware changes, and other consequential actions.

The OpenAI `codex-plugin-cc` connects Claude Code to the local Codex CLI and app server. It can run read-only reviews and delegate tasks. It uses the local Codex installation, authentication, configuration, repository checkout, and machine environment. Codex usage through ChatGPT sign-in draws on the user's plan allowance.

Architecture decisions must remain available to all local development tools and be versioned with the code. ADRs that apply across projects live in the dev-workflow repository; project-specific ADRs live in that project's `.collab/decisions/`. Notion indexes and links to both.

## Decision

For the initial pilot:

- Claude Code is the host and primary implementer.
- Codex is used for explicit, targeted reviews of meaningful diffs.
- For tasks labelled `risk:hardware` or `risk:security`, an optional Codex plan review is performed after the written plan is saved in `.collab/tasks/<LINEAR-ID>.md` and before implementation starts.
- The optional automatic review gate remains disabled.
- Codex delegation that can edit files is deferred until the review workflow is proven useful.
- The user approves every `risk:hardware` or `risk:security` plan before implementation, and remains responsible for merges, firmware flashing, and hardware changes.
- GitHub is the source of truth for code; `main` changes through user-merged pull requests.
- Each project uses one clone outside OneDrive. Parallel work uses separate Git worktrees, with one writer per working tree.
- Shared agent instructions live in `AGENTS.md`; `CLAUDE.md` imports those instructions. Task specifications, reviews, and ADRs live in the repository. Linear tracks task status, and Notion indexes durable guidance and links to repository records.

## Enforcement

- `.claude/settings.json` denies Claude Code commands for force-pushes, pushes to `main`, pull-request merges, and firmware-flashing commands.
- Codex reviews run through the read-only `/codex:review` or `/codex:adversarial-review` commands.
- Any Codex task allowed to edit files runs only from a clean, separate worktree that has a Git commit beforehand.
- GitHub branch protection, where available on the selected GitHub plan, prevents direct changes to `main`.

These controls reduce accidental actions; the user remains the final gate for consequential changes.

## Rationale

A single implementation host reduces coordination overhead. A separate Codex review can identify issues Claude missed, while explicit review requests keep usage controlled. Reviewing high-risk plans before implementation provides an early design challenge without requiring reviews on every low-risk task.

## Consequences

- Review quality and usefulness must be evaluated during the pilot.
- ChatGPT plan limits may constrain review frequency; usage must be checked in account settings.
- Claude and Codex use the same local machine and repository checkout through the plugin, so they are not isolated from local files or environment.
- Human gates and repository protections remain necessary for merges and hardware operations.
- Before relying on the plugin, run `/codex:setup` and record the installed Claude Code, Codex CLI, and plugin versions.
- The collaboration protocol stays small until pilot evidence shows which records and states are useful.

## Pilot measures

Record the following for every Codex review:

- findings raised;
- accepted and rejected findings, with reasons;
- confirmed defects caught before merge;
- minutes spent; and
- Codex allowance percentage before and after the review.

## Deferred decisions

- ChatGPT plan tier and sustainable review frequency.
- Native Windows versus WSL2 for the actual toolchain.
- Whether repository task files and Linear remain sufficient as the workflow scales.
- Repository visibility and available GitHub branch protection.
- Whether Codex should later take implementation tasks.
- Whether an orchestrator on the home PC is justified.

## Review point

Review this decision after the first collaboration-sandbox cycle and one low-risk NOVA task, or by 31 December 2026, whichever comes first. Record review findings, time spent, setup friction, and observed allowance use, then decide whether to keep, change, or drop the workflow.
