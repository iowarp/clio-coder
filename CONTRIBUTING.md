# Contributing to Clio Coder

Clio Coder welcomes contributions from people working on research software,
agent tooling, and everyday development workflows. The most useful changes fix
an observed problem, explain their scope, and bring evidence a reviewer can check.

Clio is pre-1.0 software. Public interfaces can change between minor releases;
user-visible changes belong in [CHANGELOG.md](CHANGELOG.md). Participation
follows the [Code of Conduct](CODE_OF_CONDUCT.md), and security reports go
through [SECURITY.md](SECURITY.md).

## Set up a checkout

Requirements:

- Node.js **22.19 or newer**.
- **pnpm 10.34.5**, pinned by `packageManager`, and npm for package-install checks.
- Linux or macOS for the primary development workflow. Windows support is best effort;
  CI separately checks its subprocess boundaries.

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run build
pnpm run ci
```

If Corepack is unavailable, install the pinned pnpm version with
`npm install -g pnpm@10.34.5`. The workspace includes
`apps/clio-coder-gui/`; use pnpm for dependency installation across the workspace.

The production build emits the CLI, native worker, code-index worker, and browser
server/worker entries, builds the browser client, and copies runtime assets and
notices into `dist/`. Smoke tests exercise that output: rebuild after changing an
entry point or its runtime dependencies.

## Choose the right validation

| Command | Purpose |
| --- | --- |
| `pnpm run test:file -- tests/contracts/safety-gates.test.ts` | Run a focused source-level regression with the isolated state harness. |
| `pnpm run typecheck` | Check production and test TypeScript. |
| `pnpm run lint` | Check root formatting, architecture boundaries, Pi surface, package/resource rules, and other hygiene. |
| `pnpm run check:gui` | Check browser/server TypeScript and the app's own lint rules. |
| `pnpm run ci` | Routine gate: types, lint, build, root contract/smoke tests, maintenance checks, GUI types/lint and deterministic GUI tests. |
| `pnpm run test:full` | Explicit full root test investigation, including extended regressions. |
| `pnpm run test:gui:full` | Full deterministic GUI test suite. |
| `pnpm --filter @iowarp/clio-coder-gui run smoke:browser` | Browser interaction and accessibility matrix. |
| `pnpm run ci:release` | Qualify a clean, committed candidate and its exact installed tarball. |

Run the tests that exercise the changed behavior. Add focused regressions for
meaningful failures, preferably in an existing suite; avoid tests that simply
repeat the implementation. Do not relocate a failing test to make a gate green.

The root CI workflow runs the routine gate on Node 22, engine/provider/session
compatibility checks on Node 24, and selected Windows subprocess tests. The
current scripts and [CI workflow](.github/workflows/ci.yml) are authoritative;
file and assertion counts naturally change.

### Test isolation and live models

Use `pnpm test:file`, which preloads `tests/harness/tmp-root.ts`. Stateful tests
use `tests/harness/scratch-env.ts` to isolate config, data, state, and cache.
Raw `node --test` commands without this setup can accidentally reuse earlier
prompt manifests or session data.

Never replace `process.stdout.write` across asynchronous test work: the Node
test child sends reporter records through that stream. Prefer subprocess tests
for CLI behavior and dependency injection for small library captures.

Live-model tests are explicit, separate investigations. Choose a configured
route, state the intended permissions, and keep artifacts outside your working
checkout. Do not use another person's local inference server without coordination.
For a minimal read-only check after building:

```bash
node dist/cli/index.js run --target <target-id> --autonomy read-only \
  "Reply with exactly: CLIO_LIVE_OK"
```

## Keep the architecture boundaries

- Only `src/engine/**` imports Pi packages, including type-only imports.
- Worker imports from domains are type-only except for declared provider rehydration seams.
- Domains communicate through contracts and events; do not import another domain's `extension.ts`.
- `src/tools/**` does not import the interactive UI.
- Turn-runtime modules do not import `src/entry/**`; entry points compose dependencies.
- Preserve the protected instant-shell import graph and its declared entry seams.

These boundaries run in lint. See the
[architecture guide](docs/architecture/architecture.md#boundary-invariants)
for exact definitions. Keep CLI subcommands dynamically imported so startup
and `--help` do not load unrelated runtime or GUI code.

Source imports use `.js` extensions. Use the existing contracts and helpers
before adding abstractions. Prefer source-grounded documentation to duplicated
implementation descriptions, and update affected guides with behavior changes.

## Submit a change

1. Work on a focused branch in your fork, or a local maintainer branch.
2. Implement the change and verify the affected behavior.
3. Update documentation and the changelog where appropriate.
4. Run `pnpm run ci` before requesting review.
5. Open a pull request from your fork into canonical `main`.

A useful pull request states the problem, resulting behavior, validation, and
known limits. Include screenshots or terminal captures when they help review a
visible change. Clearly distinguish model claims from checks actually performed.

Use concise conventional commit subjects, for example:

```text
fix(session): preserve branch selection on resume
docs: clarify worker permission scope
feat(cli): add a target inspection option
```

Keep subjects at most 72 characters. Never commit credentials, local config,
generated `dist/`, temporary reports, or copied testing repositories.

### Write documentation for both readers and the browser

The package ships `docs/` to people in the graphical app and to Clio through
`clio_docs`. Keep commands, defaults, and behavior grounded in the owning source.
Mark historical designs and measurements as historical; they are not promises
about the current build or another model.

Lead guides with the task and the common path. Keep lookup tables easy to scan.
Put lengthy implementation explanations and worked examples in native Markdown
`<details>` sections with a specific, sentence-case `<summary>`; leave a blank
line before and after the Markdown body. Preserve existing heading anchors.
The browser opens enclosing sections when a reader follows a heading link.

Review the rendered page at desktop and narrow widths. Check that section names
help someone decide what to open, tables remain readable, and links land on the
intended heading. A passing test or link checker does not establish that the
prose is accurate or pleasant to read.

### Branch and release ownership

The canonical repository keeps `main` as its product branch. Contributors push
topic branches to their own forks. Maintainer topic, integration, and candidate
branches remain local; do not push them to canonical `origin`.

Use names such as `fix/session-resume` or `docs/worker-guide`. A local release
candidate uses a compact name such as `v050`; dotted `v0.5.0` belongs to the
immutable release tag. Push tags only as fully qualified `refs/tags/vX.Y.Z`.

A maintainer may update canonical `main` only through an explicitly authorized,
reviewed fast-forward of the gated candidate; other changes arrive through a
reviewed pull request. Remote writes, release tags, and publication require
explicit maintainer authorization.

After a merged change, verify that its commits reached the intended base before
removing its topic branch or worktree. Preserve uncommitted work and unfinished
experiments. Never delete `main`, move a published tag, or remove another
contributor's active worktree as cleanup.

## Qualify a release

The [release-cut checklist](docs/process/release-cut-checklist.md) describes the
full procedure. The essential sequence is:

1. Commit the exact candidate, make sure the tree is clean, and install the
   pinned workspace dependencies.
2. Run `pnpm run ci:release`. It runs the routine gate, package/advisory checks,
   and installed-package smoke checks, then saves the qualified tarball and
   receipt under `~/.cache/clio-coder/qualification/`.
3. Review the receipt and candidate SHA. With separate publication authorization,
   run `pnpm run release:preflight`, then publish from the unchanged checkout.
   `prepublishOnly` repeats the fast preflight.
4. Verify the published artifact and close the release branch only after the
   reviewed commit and matching tag have reached the intended remote.

Qualification needs registry access for dependency installation and advisory
checks, but no live model or operator credentials. The receipt binds the clean
commit, Node version, artifact digest, and package bytes and expires after 24 hours.
A new commit, rebuild, changed package bytes, or expired receipt requires another
qualification. Do not rebuild between a successful qualification and publication.

The package allowlist and `scripts/release-manifest.json` jointly define shipped
resources. Source, Markdown docs, prompt fragments, recipes, model catalogs,
browser assets, notices, and grammar files must resolve from the installed
package, including when launched outside the checkout. Source maps, caches,
evaluation fixtures, and checkout-only scripts do not ship. Current limits are
12 MB packed and 55 MB unpacked; change a budget only with an explained artifact
measurement, never to hide accidental files.

## Contribute skills and workflows

`library/` contains five package kinds: **skill, agent, prompt, fleet, and plugin**.
Start from `library/_authoring/templates/<kind>/`, then follow the
[library guide](library/README.md) and
[plugin authoring contract](docs/guide/authoring-plugins.md).

```bash
clio-coder library validate <package-path> --json
clio-coder library register <package-path> --project
clio-coder library install <kind>:<name> --project
```

Validation is read-only. Installation is a separate operator action. Test the
installed resources in an isolated project through `/skill`, `/run`, a namespaced
prompt, or `/fleet run`, as appropriate.

When changing bundled content, regenerate and verify its pins:

```bash
pnpm run library:pin
pnpm run library:check
# Also run these when changing curated skill bodies or skill metadata:
pnpm run skills:pin
pnpm run skills:check
```

Library pins cover full distributed package trees. Skill pins separately record
normalized instruction-body evidence. `.claude-plugin/marketplace.json` is a
generated peer-host projection; do not edit it by hand. Core recipes under
`src/domains/agents/` remain product-owned. Harness extensions have a separate
[registration and execution contract](docs/guide/harness-extensions.md).

## Working with coding agents

Read this file, the relevant changelog entry, any local `CLIO-CODER.md`, and the
owning subsystem's documentation. Prefer `rg` and focused source reads. Preserve
other work in a shared checkout and coordinate file ownership before editing.

The code and schemas are authoritative. Do not invent commands, settings,
benchmark results, or completed validation. Keep local session reports outside
the repository. Ask for maintainer direction when scope or a remote action needs
a decision; do not treat an implementation task as permission to publish.
