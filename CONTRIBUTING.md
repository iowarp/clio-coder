# Contributing to Clio Coder

Clio Coder is IOWarp's coding agent for supervised repository work. The
project is in alpha: public behavior, installation paths, and release process
may move until a stable release is announced.

This repository is optimized for human reviewers and coding agents alike.
Keep changes small, explicit, and easy to verify from git history.


## Setup

Requirements:

- Node.js `>=22.19.0`
- npm
- Linux or macOS for full parity. Windows is best effort until a stable release.

Bootstrap:

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

Local and GitHub PR gate (fast, deterministic):

```bash
npm run ci
```

Release gate (for maintainers before tags or release artifacts):

```bash
npm run ci:release
```

Live LLM smoke validation (manual/opt-in):

```bash
CLIO_LIVE_SMOKE=1 CLIO_LIVE_TARGET=anthropic ANTHROPIC_API_KEY=your_key npm run test:live
```

## Testing conventions

CLI-facing contract tests drive the built binary through the child-process
harness in `tests/harness/spawn.ts`: `makeScratchHome()` gives the run an
isolated `CLIO_HOME`, and `runCli(args, { env, cwd })` spawns `dist/cli` and
returns its captured `stdout`, `stderr`, and exit code. Rebuild `dist/` with
`npm run build` after changing CLI source, since these tests exercise the
built output.

Do not assert a CLI subcommand's output by capturing `process.stdout.write`
in-process. In-process stdout capture fights the node:test spec reporter:
async flushes land in the capture buffer and the reporter's pass/fail counters
get eaten, so a passing test can report as no output. Spawn the CLI through the
harness instead. Patching `process.stdout`/`stderr` to assert a small library
function's own output is fine; the trap is capturing a whole subcommand's
output in-process while the reporter runs.

## Releasing

Releases are tag-driven and publish from CI. Nothing is published from a
workstation.

1. Bump `version` in `package.json` and retitle the `unreleased` section in
   `CHANGELOG.md` to the version being cut.
2. Run `npm run ci:release`. It runs the full `ci` gate, then
   `scripts/check-release.mjs`, which verifies the built `dist/` and audits
   the exact npm package contents.
3. Land the release commit through the normal PR flow.
4. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag must
   match `package.json`'s version; the release workflow refuses mismatches.
5. `.github/workflows/release.yml` verifies the tag against `package.json`,
   reruns the full gate, and creates the GitHub release with the tarball
   attached. The npm publish step stays disabled until the first stable
   v0.3.0; when it is re-enabled, the `NPM_TOKEN` repository secret must hold
   an automation token that can publish `@iowarp` packages.

What `scripts/check-release.mjs` enforces, and how to respond when it fails:

- Only `dist/cli/index.js` and `dist/worker/entry.js` carry a shebang. The
  shebang comes from the hashbang line in each entry source file. Never add
  a tsup `banner`; it would stamp every chunk in `dist/`.
- The package ships no source maps, benchmarks, caches, or repo scripts. If
  a forbidden file appears, fix the `files` allowlist in `package.json`
  rather than deleting the file from the repo.
- Runtime resources must resolve from the installed package root: prompt
  fragments, builtin agents, model catalogs, `docs/html`, the 128px logo,
  and `damage-control-rules.yaml`. A new runtime resource must be listed in
  both package.json `files` and the required list in `check-release.mjs`.
  The double bookkeeping is deliberate: neither edit can silently drop a
  resource the CLI needs at runtime.
- Size budgets: 2 MB tarball, 6 MB unpacked. If a legitimate change exceeds
  them, raise the budget in the same PR with a justification, never as a
  drive-by.

Build shape, for anyone changing `tsup.config.ts`: two ESM entries with code
splitting on. `src/cli/index.ts` imports every subcommand dynamically, so a
command pays only for its own chunk and `clio --version` stays fast. Keep new
subcommands behind dynamic imports, and keep heavyweight runtime dependencies
in the `external` list so they load from `node_modules` only when a chunk
that needs them runs.

## Hard Rules

1. Do not push to `main`.
2. Open pull requests against `main`.
3. `main` requires review by `@akougkas`.
4. Keep every PR focused. Split unrelated docs, runtime, CLI, and TUI work.
5. Update `CHANGELOG.md` for user-visible behavior, developer workflow, or
   release status changes.
6. Run `npm run ci` before requesting review.
7. Do not commit secrets, local config, generated `dist/`, or scratch plans.

## Architecture Invariants

The boundary checker enforces these:

- Engine boundary: only `src/engine/**` value-imports pi SDK packages
  (`@earendil-works/pi-*`, pinned in `package.json`).
- Worker isolation: `src/worker/**` value-imports only the worker-safe
  provider runtime rehydration modules under `src/domains/providers/**`;
  all other worker domain imports must be type-only.
- Domain independence: cross-domain flows go through `SafeEventBus`.

Run:

```bash
npm run check:boundaries
```

## Branches

Use short branch names:

- `feat/<topic>`
- `fix/<topic>`
- `docs/<topic>`
- `test/<topic>`
- `chore/<topic>`

Examples:

- `feat/worker-profiles`
- `fix/session-resume-replay`
- `docs/github-governance`

## Commits

Use concise conventional subjects:

```text
feat(cli): add target profile flag
fix(session): restore chat on fork
docs(changelog): record v0.1.0-exp release notes
```

Rules:

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `build`, `ci`, `chore`.
- Optional scope is encouraged.
- Subject <= 72 characters.
- Explain why in the body when behavior or architecture changes.
- Use ASCII punctuation in docs and commits.

## Pull Requests

PRs should include:

- Problem and approach.
- User-facing behavior changes.
- Tests run.
- Changelog/status updates, or why none are needed.
- Screenshots only for visible TUI changes when useful.

Review rubric:

- Correctness: behavior matches the stated problem.
- Boundaries: architecture invariants still hold.
- Safety: no secret leakage, unsafe shell behavior, or destructive defaults.
- Tests: coverage matches the risk and changed surface.
- Docs: changelog/status/contributor guidance stays current.

## Agent Etiquette

Agents should:

- Read `CLIO.md`, `CHANGELOG.md`, and this file before broad
  edits.
- Prefer `rg` for search.
- Use existing modules and helpers before adding abstractions.
- Keep generated summaries short and cite git ranges when summarizing history.
- Avoid touching unrelated files in a dirty worktree.
- Leave remote writes, branch rules, and release tags to `@akougkas` unless
  explicitly instructed.

## Skills

`skills/` is the curated skills marketplace: maintainer-approved `SKILL.md`
guides, distinct from the runtime skills any user can drop into a discovery
root. It is not itself a discovery root, so nothing here auto-loads; skills
activate only via `clio skills install <name>`.

To propose a skill:

1. Add `skills/<name>/SKILL.md`. Follow the `superpowers:writing-skills`
   methodology and Anthropic's skill-authoring guidance: a trigger-rich
   `description` (third person, "Use when ..."), one excellent example, and
   progressive disclosure (push heavy reference into `references/`).
2. Include the provenance frontmatter (`registry-id`, `source-url`, `version`,
   `license`) and ship an `evals.md` with the baseline scenarios you tested.
3. Verify locally: `clio skills validate skills/<name>/SKILL.md`, then
   `clio skills install <name>` and `clio skills list`.
4. Open a PR. A maintainer reviews against the rubric, then sets `audit: pass`
   and the `version` to approve it for the catalog.

Full catalog conventions and install options: [skills/README.md](skills/README.md).
