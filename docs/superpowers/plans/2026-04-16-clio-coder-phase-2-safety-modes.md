# Phase 2 — Safety & Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Status:** Ready to plan (Phase 1 hardened). Write this document before starting Phase 2.

**Depends on:** Phase 1 complete and hardened (tags `phase-1-complete`, `phase-1-hardened`).

## Phase 1 hardening summary (landed 2026-04-16)

The hardening pass proved the foundation under adverse input and left behind four diagnostics plus a tightened boundary enforcer that Phase 2 inherits. Any code that fails these gates does not enter Phase 2.

- `npm run diag:interactive` — SIGINT shutdown path, banner, four-phase bus ordering, exit 130.
- `npm run diag:config` — live fs.watch hot-reload matrix, three buckets, invalid-edit fail-closed.
- `npm run diag:xdg` — four XDG/CLIO env permutations plus a three-row install error matrix against `clio doctor`.
- `npm run diag:boundaries` — 14 synthetic fixtures covering every rule × every import form; strict type-only posture; wired into `ci`.

Sixth plan bug discovered during hardening and fixed: `SafeEventBus` delivered listeners via deferred microtasks, so the four-phase shutdown's later events never surfaced before `process.exit`. Delivery is now synchronous with per-listener try/catch; see commit `3072abb` and the updated `src/core/event-bus.ts` JSDoc. Phase 2 domain listeners honor the synchronous contract.

Also landed: CI matrix now covers `ubuntu-latest` + `macos-14`; `scripts/git-hooks/pre-commit` + `scripts/install-hooks.sh` gate format and boundary regressions locally; `CONTRIBUTING.md` documents the workflow; `README.md` documents the `npm link` run-from-source flow.

**Goal:** Implement the safety domain (action classifier, scope, audit) and modes domain (matrix, state, Shift+Tab mode-cycling), with mode gating applied at the tool registry level.

**Exit criteria:** see `2026-04-16-clio-coder-roadmap.md` under Phase 2.
