# Next-Session Prompt — Phase 1 Hardening (pre-Phase-2)

**How to use:** paste the entire "Session prompt" block below into a new Claude Code session at `/home/akougkas/projects/iowarp/clio-coder`. Do NOT run any /loop or /remote-control invocation first; treat this as a fresh top-level instruction. The session should ingest the briefing, dispatch subagents per the skill, and produce a hardened Phase 1 before Phase 2 begins.

---

## Session prompt

You are continuing the Clio-Coder v0.1 build. Phase 1 (Foundation) landed last session. Your next job is a **Phase 1 Hardening pass**: prove the foundation actually holds under adverse input, document it, and fix whatever falls out. No Phase 2 work. Use `superpowers:subagent-driven-development` throughout.

### Ground truth

- Repo: `/home/akougkas/projects/iowarp/clio-coder`
- Branch: `main`, tree clean.
- Tag: `phase-1-complete` (local only; user has NOT authorized a push yet).
- Last commit: `6939377 docs: open Phase 2 plan placeholder`. Before that, `e7b7f2e chore: apply biome formatting`.
- `npm run ci` green end-to-end on Linux. CI matrix in `.github/workflows/ci.yml` is currently ubuntu-only.
- Authoritative documents (read in order):
  1. `docs/specs/2026-04-16-clio-coder-design.md`
  2. `docs/superpowers/plans/2026-04-16-clio-coder-roadmap.md`
  3. `docs/superpowers/plans/2026-04-16-clio-coder-phase-1-foundation.md`
  4. `docs/architecture/pi-mono-boundary-0.67.4.md`
- pi-mono 0.67.4 real source (reference): `~/tools/pi-mono/packages/{agent,ai,tui}/src`.

### Plan bugs already fixed in Phase 1 (do NOT re-litigate)

1. `scripts/check-boundaries.ts` — `.js` → `.ts` specifier rewrite in `resolveRelativeImport` (commit `65c2d37`).
2. `src/core/domain-loader.ts` — `DomainLoadError.cause` uses `public override readonly cause: unknown` under `noImplicitOverride` (landed in `d113b09`).
3. `src/core/domain-loader.ts` — `DomainContract = object` (was `Readonly<Record<string, unknown>>`, too strict for named-method contracts) (commit `97e17c2`).
4. `StreamFn` lives in `@mariozechner/pi-agent-core`, not `pi-ai`; audit and Task 27 already corrected (commit `119ded2`).
5. Em-dash clause-separator prose pattern purged from `docs/architecture/pi-mono-boundary-0.67.4.md` per CLAUDE.md + spec §23 (commit `9ba780d`).

If you discover a sixth bug, fix it, amend the plan in the same commit, and continue.

### Hardening objectives

Group the work into six fronts. Dispatch a fresh subagent per front. Each front produces one diag script under `scripts/diag-*.ts`, any targeted fixes to production code, and one or more commits. Between fronts, run the two-stage review (spec compliance then code quality) per the subagent-driven-development skill.

**Invariants to respect every commit:** the three hard invariants from the design spec §3 (engine boundary, worker isolation, domain independence). `npm run check:boundaries` must stay green on every commit.

**Front 1 — Interactive idle loop smoke.** The orchestrator has a `CLIO_PHASE1_INTERACTIVE=1` branch that keeps the process alive until drained. Write `scripts/diag-interactive.ts` that spawns `node dist/cli/index.js` with that env var, waits 200ms for the banner, sends SIGINT, and asserts: (a) banner on stdout, (b) `clio: received SIGINT, shutting down...` on stderr, (c) the DRAIN→TERMINATE→PERSIST→EXIT bus events each fired in order, (d) process exits with code 130. Land the script + any fixes to `termination.ts` if event ordering or exit codes are wrong.

**Front 2 — Config hot-reload matrix exercise.** `src/domains/config/extension.ts` classifies diffs into `hotReload` / `nextTurn` / `restartRequired` buckets and emits typed events. Currently nothing proves the classifier actually fires on live edits. Write `scripts/diag-config.ts` that: boots config domain in an ephemeral CLIO_HOME, subscribes to all three channels, mutates settings.yaml three times (one field per bucket), and asserts each subscription fires with the expected `diff` shape. Also test an invalid edit (e.g. `safetyLevel: "bogus"`) and confirm the schema-validation error surfaces on stderr AND the snapshot is NOT replaced. Land any classify/extension bugs the diag surfaces.

**Front 3 — XDG and install error matrix.** Write `scripts/diag-xdg.ts` covering the permutations: CLIO_HOME only, CLIO_CONFIG_DIR+CLIO_DATA_DIR+CLIO_CACHE_DIR split, XDG_* env vars on Linux, and a fallback with no overrides (under a fresh HOME). For each permutation: run `clio install`, assert the expected tree layout, parse `install.json`, assert 0600 on credentials.yaml. Then simulate breakage: delete settings.yaml, chmod credentials.yaml to 0644, corrupt install.json, run `clio doctor`, assert each finding turns red in the correct row. Extend `doctor.ts` with any missing diagnostic (e.g. unreadable settings.yaml).

**Front 4 — Boundary script robustness.** The boundary enforcer is now the gate keeping Phase 2+ honest. Audit its false-negative surface: dynamic import, template-literal specifiers (`` import(`${x}`) ``), re-export chains, type-only imports, `/// <reference>` directives. Decide what the script should and should not catch; extend or document accordingly. Also plant a rule-3 violation that uses `.js` suffix (Phase 1 already proved that path) AND a rule-3 violation via `import type` — verify both trigger (or document why `import type` is acceptable cross-domain since it doesn't emit runtime code). Commit the decision.

**Front 5 — CI matrix + pre-commit discipline.** `.github/workflows/ci.yml` runs on ubuntu only. The roadmap commits to Linux + macOS in v0.1. Add a macos-14 job. While you're in CI config, wire a pre-commit hook (or lefthook/husky equivalent) that runs `npm run format && npm run check:boundaries` so lint and boundary regressions never land again. Decide which tool (simple shell hook is fine for v0.1). Document the hook installation in `CONTRIBUTING.md` (create it; currently missing but referenced in the spec §16 repo layout). Commit in small, reviewable slices.

**Front 6 — `clio` global-install smoke.** `package.json` declares `bin: { clio: "dist/cli/index.js" }`. Verify `npm link` produces a working `clio` binary on PATH. Run `clio --version`, `clio install`, `clio doctor`, `clio` from a directory unrelated to the source tree. Document the expected `npm link` flow in `README.md` under a new "Run from source" section. Land any package.json tweaks the smoke surfaces (missing shebang on rebuild, wrong file permissions, `files` array omissions). This is the check that proves Phase 1 actually ships, not just builds.

### Out of scope

- Any Phase 2 work (safety domain, modes domain, action classifier). The Phase 2 plan is still a stub; writing Phase 2 is a separate future session.
- Pushing to remote. Tag `phase-1-complete` and all hardening commits stay local until the user explicitly authorizes `git push`.
- Rewriting prior Phase 1 code beyond targeted fixes the hardening surfaces.
- New production dependencies. Stick with the pinned set in package.json.

### Execution contract

- Invoke `superpowers:subagent-driven-development` at the very start. Create TodoWrite entries for each of the six fronts plus any sub-tasks the skill's process requires.
- Dispatch one fresh subagent per front. Each subagent reads the three authoritative documents itself; do not skip context transfer.
- Two-stage review after each front: spec compliance reviewer + code quality reviewer. If either finds issues, feed them back to the implementer subagent. Do not mark a front complete with open issues.
- After all six fronts land, dispatch a final `superpowers:code-reviewer` pass over the whole hardening series against the roadmap's invariants and the three plan bugs already fixed (make sure none regressed).
- When all fronts and the final review pass, create an annotated tag `phase-1-hardened` (LOCAL ONLY, do not push). Open `docs/superpowers/plans/2026-04-16-clio-coder-phase-2-safety-modes.md` and flesh out the "Status" line from `Not yet planned` to `Ready to plan (Phase 1 hardened)`.

### Reporting cadence

Announce the six-front task queue after you've loaded the authoritative documents. Between fronts, one or two sentences of status. At the end, a tight summary: what landed, what regressed, what deferred, tag created, ready for Phase 2 planning.

---

End of session prompt.
