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

Bootstrap:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
```

Local and GitHub PR gate (fast, deterministic):

```bash
pnpm run ci
```

This runs type checking, lint (including boundaries, documentation drift and
skill audit records and full-tree library pins), one build, the contract/smoke
suite, and the unified web application tests. Use `pnpm run library:check` for package pins
and `pnpm run skills:check` for skill authoring records; both run in `lint` and `ci`.

The GitHub `ci` job runs the release gate on Ubuntu. The separate
`windows-subprocess` job uses Node 22 on `windows-latest` and runs typecheck
plus the Antigravity subprocess, Bash settlement, and Windows process-tree
contracts. It is a focused Windows lane, not the full suite. Native Windows
local checks provide local evidence; they do not establish a hosted CI pass.

Release gate (for maintainers before tags or release artifacts):

```bash
pnpm run ci:release
```

The release gate includes `ci` and adds the package audit. Running `ci` again
on the same unchanged tree is unnecessary. Run a focused regression while
developing a repair, then the full gate for the candidate being reviewed.

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

1. During development, keep the top changelog section at `## Unreleased`. A
   maintainer collects release work on a **local-only** compact candidate
   branch (`v046` for `v0.4.6`) and bumps `version` there. Never push this
   candidate branch to the canonical repository. Before the cut, retitle the
   changelog section `## <version> - YYYY-MM-DD`, align the ACP registry manifest
   version, and update the README's install tag and release notices.
2. Run `pnpm run ci:release` on the exact candidate. It runs the full `ci` gate,
   then `scripts/check-release.mjs`, which verifies the built `dist/` and
   audits the exact npm package contents.
3. Fetch `origin`, require the fetched `origin/main` to be the candidate's
   ancestor, then fast-forward local `main` with `git merge --ff-only v046`.
   Re-run the release gate if the candidate changed and verify local `main`
   equals the reviewed candidate SHA.
4. Fetch once more and stop on unexpected movement. With explicit maintainer
   authorization, push only `refs/heads/main:refs/heads/main`; no topic or
   release-candidate branch is pushed to canonical `origin`.
5. Require CI for that exact `main` SHA to pass. Create the annotated tag on
   that commit and push only it: `git tag -a v0.4.6` followed by
   `git push origin refs/tags/v0.4.6`. The tag must match `package.json`; the
   release workflow refuses mismatches.
6. `.github/workflows/release.yml` verifies the tag against `package.json`,
   runs `pnpm run ci:release` on the tagged tree, and creates the GitHub release
   with the tarball attached and the version's `CHANGELOG.md` section as the
   body. It does not publish to npm.
7. A maintainer publishes from the tagged commit with `npm publish`;
   `prepublishOnly` runs the same `ci:release` gate in release mode first.
8. Verify the release and tag. Reconcile milestone tickets against tagged
   implementation and acceptance evidence; plain issue references and release
   tags do not close tickets. Verify automatic closures, explicitly close
   completed tickets that remain open, and carry incomplete work forward before
   closing the milestone. Then delete the local compact candidate branch.
   The canonical remote returns to its steady state: `main` plus immutable
   release tags and GitHub releases, with no release branch.

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
  both package.json `files` and `scripts/release-manifest.json`.
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
