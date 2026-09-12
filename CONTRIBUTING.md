# Contributing to Clio Coder

Clio Coder is IOWarp's coding agent for supervised repository work. The
project is in alpha: public behavior, installation paths, and release process
may move until a stable release is announced.

This repository is optimized for human reviewers and coding agents alike.
Keep changes small, explicit, and easy to verify from git history.


## Setup

Requirements:

- Node.js `>=22.19.0`
- pnpm 10.34.5 (pinned in `packageManager`) and npm for package compatibility checks
- Linux or macOS for full parity. Windows is best effort until a stable release.

Enable pnpm through Corepack (`corepack enable pnpm`), or install the pinned version locally.
The root workspace includes the unified web application. pnpm owns dependency
installation. `apps/workbench/` is retained reference source and excluded from
workspace builds, publication, and product gates.

Bootstrap, in the order the checks depend on each other (the smoke tests run
the built `dist/`, so build before testing):

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:web
```

Local and GitHub PR gate:

```bash
pnpm run ci
```

This runs types, lint (including architecture boundaries and library pins), one
build, 27 core contract files, three real CLI/ACP/process smoke files, and the
web application's authentication and runtime boundary tests. It deliberately
excludes broad development regressions, catalog inventories and model eval
corpora. Superseded GitHub runs are cancelled. Branch protection requires `ci (22)` (the routine gate) and `ci (24)` (engine,
provider transport and durable-session compatibility only). The separate Windows job runs
only the three subprocess contracts whose process-tree behavior is platform-specific.

Choose the lane for the risk:

```bash
pnpm run test:file -- tests/contracts/safety-gates.test.ts # focused development
pnpm run ci                                              # routine Linux CI
pnpm run ci:release                                      # clean committed candidate
pnpm run test:full                                       # explicit full root investigation
pnpm run test:web:full                                   # explicit full web investigation
pnpm --filter @iowarp/clio-coder-web verify                # full web development, including browser matrix
```

Candidate qualification runs the routine gate, web types, the dependency/package
audit, and two package smoke files. Those install the exact tarball with normal npm
lifecycle scripts, exercise native delayed-header timing, and boot the installed web
app in Chrome. They reuse that installed server for the browser check. No live model
or operator credentials are required. Registry access is needed for the installed
runtime dependencies and advisory audit; a failed audit is a failed qualification.
Cold dependency installation is separate from gate timing.

`tests/extended/` and `tests/extended-smoke/` retain focused development regressions.
Run the relevant ones when editing their surfaces, or the explicit full suite for an
extended investigation. They are not repeated during CI or npm publication. A newly
found correctness regression must be fixed before qualification; moving a failing
test to an extended lane is not a repair.

Live provider validation (manual/opt-in, after `pnpm run build`):

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

Never replace `process.stdout.write` across asynchronous test work. Node's test
child sends reporter records through that stream: a later test's mock can swallow
an earlier failure's name and details. Spawn CLI commands using the current built
binary. Small library captures must forward non-string reporter frames unchanged.


## Releasing

The current [release checklist](docs/process/release-cut-checklist.md) is authoritative.
The withdrawn v0.4.8 candidate is not authorization to restore its tag or publish it.

1. Prepare and commit the exact candidate on a local branch. Install the pinned
   workspace dependencies, then run `pnpm run ci:release` once. It qualifies one
   artifact and stores it with a receipt under `~/.cache/clio-coder/qualification/`.
   A new qualification invalidates old evidence before doing any work.
2. Review the candidate SHA and qualified package. With explicit authorization,
   fast-forward main and push the matching annotated version tag. The tag workflow
   qualifies its own exact package before a dependent job can create the GitHub release.
   It uploads that package, never a newly packed replacement.
3. From the unchanged locally qualified checkout, run `pnpm run release:preflight`,
   then, only with publication authorization, `npm publish`. `prepublishOnly` repeats
   only the fast preflight. It requires the same clean commit, Node version, a
   qualification less than 24 hours old, the original artifact digest, matching
   current package bytes (including ignored build output), and dated release notes.
   Missing, stale or changed evidence fails closed: qualify again. There are no
   bypass flags or ignored lifecycle hooks in this procedure.
4. Verify the published artifact and reconcile the release milestone before branch
   closeout. Remote writes, tags and publishing always require explicit authorization.

Do not run `ci`, the full suite, another build, or another installed-package check
between successful qualification and publication. A rebuild may change package bytes
and require qualification again. Live-model checks and the real-home smoke are
optional investigations, not deterministic publish prerequisites.

What `scripts/check-release.mjs` enforces, and how to respond when it fails:

- Development branches may open with `## Unreleased`. Exact version tags and
  `npm publish` require `## <version> - YYYY-MM-DD`, so unfinished notes cannot
  enter an immutable artifact.
- Only `dist/cli/index.js` and `dist/worker/entry.js` carry a shebang. The
  shebang comes from the hashbang line in each entry source file. Never put a
  shebang in the tsup `banner`; a banner is stamped on every chunk in `dist/`
  (the existing banner only defines `require` for bundled CommonJS code).
- The package ships no source maps, benchmarks, caches, or repo scripts. If
  a forbidden file appears, fix the `files` allowlist in `package.json`
  rather than deleting the file from the repo.
- Runtime resources must resolve from the installed package root: prompt
  fragments, builtin agents, model catalogs, the Markdown guides in `docs/`, the 128px logo,
  and `damage-control-rules.yaml`. A new runtime resource must be listed in
  both package.json `files` and `scripts/release-manifest.json`.
  The double bookkeeping is deliberate: neither edit can silently drop a
  resource the CLI needs at runtime.
- Size budgets: 12 MB tarball, 55 MB unpacked, set in `check-release.mjs`.
  They are a tripwire for packaging defects such as a leaked `node_modules`
  or a doubled `dist/`, not a diet. If a legitimate change exceeds them,
  raise the budget in the same PR with a justification, never as a drive-by.

Build shape, for anyone changing `tsup.config.ts`: two ESM entries with code
splitting on. `src/cli/index.ts` imports every subcommand dynamically, so a
command pays only for its own chunk and `clio-coder --version` stays fast. Keep new
subcommands behind dynamic imports, and keep heavyweight runtime dependencies
in the `external` list so they load from `node_modules` only when a chunk
that needs them runs.

## Getting help and reporting problems

- Questions, bug reports, and feature requests go to
  [GitHub issues](https://github.com/iowarp/clio-coder/issues). Include the
  Clio and Node versions, the relevant `clio-coder doctor` output, and steps
  to reproduce, with credentials and sensitive project data removed.
- Security issues follow [SECURITY.md](SECURITY.md), not a public issue.
- Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
- Field reports from real research projects are the most useful input: a
  difficult build, an unreliable model connection, or a workflow that needs
  better support.

## Hard Rules

1. The canonical repository's only branch is `main`. Maintainer topic,
   integration, and release-candidate branches stay local and are never pushed
   to canonical `origin`.
2. Contributors push topic branches to their own forks and open pull requests
   from the fork into canonical `main`; they never push a topic branch to the
   canonical repository.
3. A maintainer may update canonical `main` only by an explicitly authorized,
   reviewed fast-forward from the exact locally gated candidate. Everyone else
   changes `main` through a pull request reviewed by `@akougkas`.
4. Keep every PR focused. Split unrelated docs, runtime, CLI, and TUI work.
5. Update `CHANGELOG.md` for user-visible behavior, developer workflow, or
   release status changes.
6. Run `pnpm run ci` before requesting review.
7. Do not commit secrets, local config, generated `dist/`, or scratch plans.
8. Push release tags as fully qualified `refs/tags/vX.Y.Z`; never push a
   similarly named branch.

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

The checker runs as part of `pnpm run lint` (`scripts/check-hygiene.ts` imports
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

Maintainer branches are local-only. A temporary release candidate uses the
compact version spelling with no dots: `v046` for release tag `v0.4.6`. Never
create or push a branch named `v0.4.6`; dotted `vX.Y.Z` names belong exclusively
to immutable release tags. The compact branch is local scaffolding and is
deleted after its reviewed commit reaches `main` and the release succeeds.

Contributors use the same topic prefixes in their own forks. The pull request
head is `<contributor-fork>:<topic>` and its base is canonical `main`. Delete
the fork branch after merge so both the canonical repository and contributor
forks return to a small steady state.

### Branch closeout

Branch and worktree cleanup is part of finishing work, not optional future
housekeeping. Use `branch-closeout` (or `ship closeout`) to automate this
verification and teardown safely. After a PR is merged or a release is tagged:

1. Fetch and prune remote-tracking refs, then verify the PR is merged and its
   result is represented on `origin/main`. An ancestry check is sufficient for
   merge commits; squash and cherry-pick landings require the merged PR and
   resulting commit as evidence rather than a matching subject alone.
2. Confirm the source worktree has no tracked or untracked work worth keeping.
   Remove a registered worktree with `git worktree remove <path>`, never
   `rm -rf`; use `--force` only after explicitly authorizing disposal of the
   remaining local artifacts.
3. Delete the local topic or release branch. For a contributor PR, delete its
   branch from the contributor's fork after merge. A topic branch must never be
   created on canonical `origin`, and canonical `main` is never deleted.
4. Preserve unfinished experiments by filing their result and next decision in
   an issue, not by accumulating anonymous `work/`, `wip/`, or `tmp` refs.
5. Report the remaining local branches, worktrees, stashes, local-only tags,
   and canonical remote heads. The expected canonical head set is exactly
   `refs/heads/main`; every additional head is a cleanup failure.

For a release, first verify `refs/tags/vX.Y.Z^{commit}` equals the reviewed
commit on `main`, then close the compact candidate branch such as `v046`.
Published tags are never deleted, moved, or recreated during cleanup.

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

## Library packages

`library/` is the canonical home of shareable packages and recipes across the
five supported kinds: `skill`, `agent`, `prompt`, `fleet`, and `plugin`.
All five kinds share one portable package engine (a `plugin.json` manifest,
exact semantic version, full-tree SHA-256 pin, and scoped lifecycle). Optional
`extensions["ai.iowarp.clio"]` metadata declares Clio-specific kinds and resource
paths; a conventional plugin with `skills/` needs no such metadata. Bundled packages are indexed in `library/registry.yaml`,
ship with the npm package, and resolve relative to the installed index without
requiring a network fetch.

- Standalone skills live under `library/skills/<category>/<name>/`.
- Domain bundles live under `library/plugins/<name>/` (e.g. `library/plugins/materio/`).
- Standalone agent, prompt, and fleet packages live under `library/agents/`,
  `library/prompts/`, and `library/fleets/`.
- Working authoring templates for all five kinds live under `library/_authoring/templates/{skill,agent,prompt,fleet,plugin}/`.
- `.claude-plugin/marketplace.json` and `.agents/skills/` are the generated outbound
  surfaces. The first is regenerated by `library:pin`; the second is two symlinks at
  the canonical trees so a Codex session started in a clone discovers them. Neither
  holds a copied recipe body, and neither is edited by hand.
- Core agent recipes (`src/domains/agents/builtins/`) and baseline fleets
  (`src/domains/agents/fleets/`) remain product-owned in `src/` and are not
  community library packages.
- Recipe packages may contain contained scripts for evaluation or workflow tasks;
  these are declared metadata, executed only on explicit request, and are strictly
  distinct from harness extension registration (which registers runtime tools,
  hooks, and session UI under the separate extension lifecycle).

### Contributor journey

Follow this unified workflow to contribute or update a library package:

1. **Choose package kind**:
   - `skill`: Single procedure and supporting knowledge (`SKILL.md`).
   - `agent`: Standalone worker recipe (`version: 1`, `skills: []`, `audience: custom`, strict budget and result contract).
   - `prompt`: Reusable task template with path-derived invocation (`/<name> [args]`).
   - `fleet`: Multi-agent coordination contract with a valid DAG and documented prerequisites.
   - `plugin`: Composite bundle combining multiple resources (e.g., an agent binding a contained skill, prompts, assets).
2. **Copy authoring template**:
   Copy the matching template from `library/_authoring/templates/<kind>/` to begin with a valid envelope, manifest, and realistic scientific/HPC context. Templates are authoring material and are never entered into `library/registry.yaml`.
3. **Author resources**:
   - Single-kind packages expose exactly one public resource in their declared resource directory (`skills`, `agents`, `prompts`, or `fleets`).
   - Keep `README.md` at the package root, outside the resource directory, so the loader does not discover it as a second public recipe.
   - For skills, include house conventions: `triggers`, nested `clio-coder:` provenance block, and an `evals.md` with baseline/treatment scenarios (use `eval-status: scenarios-recorded` without claiming an audit was performed).
4. **Validate**:
   Run payload and manifest validation:
   ```bash
   clio-coder library validate <package-path> --json
   ```
   Validation is strictly read-only: it verifies manifest schemas, resource payloads, reference syntax (`${component:...}`, `${pluginRoot}`), and loadability without modifying workspace files or installation state.
5. **Pin and check**:
   Maintainers regenerate and verify library pins before release:
   ```bash
   pnpm run library:pin
   pnpm run library:check
   ```
   If editing curated house skills in `library/skills/`:
   ```bash
   pnpm run skills:pin
   pnpm run skills:check
   ```
   **Pins vs Evidence**: `library:pin` generates full-tree pins in `library/registry.yaml` covering every distributed byte for runtime distribution integrity. In contrast, `skills:pin` records normalized skill-body hashes in `library/skills/registry.yaml` and `skill-marketplace.json` as provenance evidence for audited instructions.

   The same run regenerates `.claude-plugin/marketplace.json`, the repository's Claude Code marketplace, from those pins. Never edit it by hand. It publishes a package only when a peer host would load a real skill surface from it and nothing it would default-scan into a native component, and prints which packages it left out and why. An agent-, prompt- or fleet-only package is a normal contribution with no peer-host projection; it does not fail the pin.
6. **Try in isolated project**:
   Test the package using isolated registration and installation:
   ```bash
   clio-coder library register <package-path> --project
   clio-coder library install <kind>:<name> --project
   ```
   Verify invocation through `/skill <name>`, `/run <agent-id> <task>`, `/<prompt-name>`, or `/fleet run <name>`. Browse the shared Library through `/library`, `/skills`, `/agents`, or `/prompts`.
7. **Submit a focused fork PR**:
   Push your topic branch to your fork and submit a PR against canonical `main`. Include problem, approach, validation evidence, and tests.

### Skills

`library/skills/` contains the curated skill packages: maintainer-approved `SKILL.md`
guides, distinct from the runtime skills any user can drop into an active discovery
root (`.clio-coder/skills/` or `<configDir>/skills/`). It is not itself a discovery
root. Install with `clio-coder library install skill:<name>`, then activate with
`/skill <name>`. An explicit `clio-coder --skill library/skills/<category>/<name>/SKILL.md`
path is also available for development.

Full catalog conventions and install options: [library/skills/README.md](library/skills/README.md) and [library/README.md](library/README.md).

### Plugins

`library/plugins/` is the publishing shelf for complete domain bundles. Packages use a
portable root `plugin.json`, conventional `skills/`, and namespaced Clio metadata
for native prompts, recipes, and fleets. Follow the
[plugin authoring guide](docs/guide/authoring-plugins.md) and keep harness command
implementations in the separate [extension lifecycle](docs/guide/harness-extensions.md).

After changing any bundled file, run `pnpm library:pin` and review the updated
full-tree digest in `library/registry.yaml`. Run `pnpm library:check` to verify
the exact candidate; lint and the release gate include this check. Add behavior
tests for lifecycle changes and validate an installed package's actual resources,
including package-local references and bound skills. Peer projections must state
which host capabilities they translate and which they omit.
