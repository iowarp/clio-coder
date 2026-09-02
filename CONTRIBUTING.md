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

Live provider validation (manual/opt-in, after `npm run build`):

```bash
node dist/cli/index.js run \
  --target <configured-target-id> \
  --autonomy read-only \
  "Reply with exactly: CLIO_LIVE_OK"
```

## Testing conventions

Contract tests import `src/` directly through tsx. The test scripts preload
`tests/harness/tmp-root.ts`, which gives the run one guarded temporary root,
and stateful tests use the helpers in `tests/harness/scratch-env.ts` to isolate
Clio's data, config, state, and cache directories. Smoke tests exercise the
built `dist/cli/index.js`; their files own the process drivers needed for each
boundary. Rebuild `dist/` after changing CLI or entry-point source before
running a focused smoke test.

Do not assert a CLI subcommand's output by capturing `process.stdout.write`
in-process. In-process stdout capture fights the node:test spec reporter:
async flushes land in the capture buffer and the reporter's pass/fail counters
get eaten, so a passing test can report as no output. Spawn the CLI through the
harness instead. Patching `process.stdout`/`stderr` to assert a small library
function's own output is fine; the trap is capturing a whole subcommand's
output in-process while the reporter runs.

## Releasing

Releases are cut from a tag. The GitHub release is created by CI; the npm
publish is a manual maintainer step. The current procedure is the sequence
below together with `.github/workflows/release.yml` and
`scripts/check-release.mjs`. The
[v0.4.1 release-cut checklist](docs/history/release-cut-checklist.md) is a
historical record, not a reusable current checklist.

1. During development, keep the top changelog section at `## Unreleased` and
   bump `version` in `package.json` when opening the release branch. Before the
   cut, retitle that section `## <version> - YYYY-MM-DD`.
2. Run `npm run ci:release`. It runs the full `ci` gate, then
   `scripts/check-release.mjs`, which verifies the built `dist/` and audits
   the exact npm package contents.
3. Land the release commit on `main`. There is no need to wait on the `ci`
   workflow before tagging: the release workflow runs the same gate itself.
4. Tag and push: `git tag -a vX.Y.Z && git push origin vX.Y.Z`. The tag must
   match `package.json`'s version; the release workflow refuses mismatches.
5. `.github/workflows/release.yml` verifies the tag against `package.json`,
   runs `npm run ci:release` on the tagged tree, and creates the GitHub
   release with the tarball attached and the version's `CHANGELOG.md` section
   as the body. It does not publish to npm.
6. A maintainer publishes from the tagged commit with `npm publish`;
   `prepublishOnly` runs the same `ci:release` gate in release mode first.

What `scripts/check-release.mjs` enforces, and how to respond when it fails:

- Development branches may open with `## Unreleased`. Exact version tags and
  `npm publish` require `## <version> - YYYY-MM-DD`, so unfinished notes cannot
  enter an immutable artifact.
- Only `dist/cli/index.js` and `dist/worker/entry.js` carry a shebang. The
  shebang comes from the hashbang line in each entry source file. Never add
  a tsup `banner`; it would stamp every chunk in `dist/`.
- The package ships no source maps, benchmarks, caches, or repo scripts. If
  a forbidden file appears, fix the `files` allowlist in `package.json`
  rather than deleting the file from the repo.
- Runtime resources must resolve from the installed package root: prompt
  fragments, builtin agents, model catalogs, the Markdown guides in `docs/`, the 128px logo,
  and `damage-control-rules.yaml`. A new runtime resource must be listed in
  both package.json `files` and the required list in `check-release.mjs`.
  The double bookkeeping is deliberate: neither edit can silently drop a
  resource the CLI needs at runtime.
- Size budgets: 10 MB tarball, 50 MB unpacked, set in `check-release.mjs`.
  They are a tripwire for packaging defects such as a leaked `node_modules`
  or a doubled `dist/`, not a diet. If a legitimate change exceeds them,
  raise the budget in the same PR with a justification, never as a drive-by.

Build shape, for anyone changing `tsup.config.ts`: two ESM entries with code
splitting on. `src/cli/index.ts` imports every subcommand dynamically, so a
command pays only for its own chunk and `clio-coder --version` stays fast. Keep new
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

The boundary checker enforces these six rules:

- Engine boundary: only `src/engine/**` imports the
  `@earendil-works/pi-*` packages, including type-only imports.
- Worker isolation: `src/worker/**` may value-import only the declared
  provider runtime rehydration seams under `src/domains/providers/**`; all
  other worker imports from domains must be type-only.
- Domain independence: one domain never imports another domain's
  `extension.ts`; cross-domain behavior uses public contracts and event buses.
- Tool substrate: `src/tools/**` never imports `src/interactive/**`.
- Entry-point composition: `src/interactive/turn-*.ts` and `chat-loop.ts` never
  import `src/entry/**`.
- Stage 0 closure: external value importers enter the protected instant-shell
  graph only through declared seams, and those seams may not create an
  undeclared edge back into the closure.

The checker runs as part of `npm run lint` (`scripts/check-hygiene.ts` imports
`tests/boundaries/check-boundaries.ts`), so a boundary violation fails the
same lint every PR runs. The full definitions and exceptions live in
[Architecture](docs/architecture/architecture.md#boundary-invariants).

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

- Read `CLIO-CODER.md`, `CHANGELOG.md`, and this file before broad
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
activate after `clio-coder skills install <name>` or from an explicit
`clio-coder --skill skills/<category>/<name>/SKILL.md` development path.

To propose a skill:

1. Add `skills/<category>/<name>/SKILL.md`. Follow the local
   [`skill-craft`](skills/meta/skill-craft/) guidance: put trigger phrases in
   `triggers`, keep `description` to the job and explicit routing boundaries,
   and move conditional detail into `references/`.
2. Include the core `name`, `description`, `version`, and `license` fields plus
   a nested `clio-coder:` block with `registry-id`, `source-url`, `provenance`,
   and `eval-status`. Ship an `evals.md` with the baseline scenarios.
3. Verify locally with
   `clio-coder skills validate skills/<category>/<name>/SKILL.md`.
4. Install the candidate by name and confirm it appears with
   `clio-coder skills list`.
5. Open a PR. A maintainer reviews against the rubric, sets `audit: pass`,
   approves the catalog version, then regenerates and checks the catalog with
   `npm run skills:pin` and `npm run skills:check`.

Full catalog conventions and install options: [skills/README.md](skills/README.md).
