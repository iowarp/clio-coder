---
title: "Scripts"
summary: "Checkout-only tooling under scripts/: the drift/lint gate, the library and skill pinning pipeline, the release qualification gate, the Pi API surface diff, and the two operator-run benches."
sources:
  - "scripts/check-hygiene.ts"
  - "scripts/pin-skills.ts"
  - "scripts/pin-library.ts"
  - "scripts/generate-library-marketplace.ts"
  - "scripts/check-release.mjs"
  - "scripts/release-candidate.mjs"
  - "scripts/pi-surface-diff.ts"
  - "scripts/decision-probe.ts"
  - "scripts/configuration-reference.ts"
  - "scripts/release-version-policy.mjs"
  - "scripts/release-manifest.json"
symbols:
  - "pinSkillsCatalog"
  - "generateLibraryMarketplace"
  - "renderLibraryMarketplace"
  - "configurationReferenceMembership"
  - "releaseVersionErrors"
  - "readmeInstallVersion"
  - "buildPiSurfaceSnapshot"
  - "comparePiSurfaceSnapshots"
tests:
  - "tests/contracts/configuration-reference.test.ts"
  - "tests/contracts/release-boundary.test.ts"
  - "tests/extended/library-portability.test.ts"
  - "tests/extended/pin-library-remote.test.ts"
invariants:
  - "scripts/ is checkout-only: it never ships in the npm package, enforced by the packaging check in `scripts/check-hygiene.ts` and by the FORBIDDEN list in `scripts/check-release.mjs`."
  - "The lint gate (`scripts/check-hygiene.ts`) makes no model requests and never touches a real user installation; its subprocesses are dry runs and fixture projects."
  - "`library/registry.yaml`, `library/skills/registry.yaml`, `library/skills/skill-marketplace.json`, and `.claude-plugin/marketplace.json` are generated artifacts; pin mode rewrites them and check mode (`--check`) only reads them and exits 1 on drift."
validate:
  - "node --import tsx scripts/check-hygiene.ts"
---

# Scripts

`scripts/` holds the repository's checkout-only tooling: static drift checks,
catalog generators, the release qualification gate, and two operator-run
benches. Everything here operates on a source checkout, and none of it ships
in the npm package. The hygiene gate `checkPackaging` in
`scripts/check-hygiene.ts` asserts `patches/`, `scripts/`, and `tests/` are
checkout-only against the `package.json` `files` allowlist, and the release
gate `scripts/check-release.mjs` forbids any file under `scripts/` inside the
packed tarball ("repo scripts operate on a source checkout only").

Scripts never copy validation logic from `src/`; they import it.
`check-hygiene.ts` takes `DEFAULT_SETTINGS` and `resolvePackageRoot` from
`src/core/defaults.ts` and `src/core/package-root.ts`, `pin-skills.ts` takes
`ALL_TOOL_NAMES` from `src/core/tool-names.ts` and `normalizedSkillHash` from
`src/domains/resources/skills/content-hash.ts`, and `pin-library.ts` takes
`validateLibraryPackage` from
`src/domains/resources/library-validation.ts`.

## How each entry point is registered

The `package.json` `scripts` field wires the entry points (inspected in this
run):

- `lint` runs `biome check . && node --import tsx scripts/check-hygiene.ts`.
- `skills:pin` / `skills:check` run `scripts/pin-skills.ts`, with `--check`
  forwarded to check mode.
- `library:pin` / `library:check` run `scripts/pin-library.ts`, with `--check`.
- `pi:surface-diff` runs `scripts/pi-surface-diff.ts`; `pi:surface-snapshot`
  runs the same file with `--write`.
- `ci:release` runs `node scripts/release-candidate.mjs qualify`;
  `release:preflight` (also the `prepublishOnly` hook) runs
  `scripts/release-candidate.mjs preflight`.
- `test:file` and the `test` / `test:full` scripts preload
  `tests/harness/tmp-root.ts` for environment isolation.

`scripts/check-release.mjs` has no `package.json` entry of its own; it is
called by the qualification flow in `scripts/release-candidate.mjs` and is the
gate `prepublishOnly` ultimately protects.

## The hygiene gate: `check-hygiene.ts`

`scripts/check-hygiene.ts` is the drift gate. It runs twenty named checks in
one process and exits 1 if any collected an error. The ordered list lives in
the `checks` array near the bottom of the file:

```
documentation-links, product-namespace, case-portable-paths, export-hygiene,
boundaries, ci-scripts, library-pin, defaults-yaml, settings-inventory,
environment-variable-inventory, configuration-reference, theme-discipline,
readme-install-block, readme-shape, packaging, gitignored-reference,
prompts, docs-source, pi-surface, tool-contract-coverage
```

Errors accumulate through `fail(rule, message)`; the run reports
`check-hygiene: N drift condition(s) found` and exits 1, or
`check-hygiene: ok (20 checks, <ms>)` otherwise. `CHECK_HYGIENE_PROFILE=1`
prints per-check timing.

Two of the checks are delegated calls rather than inline logic, which makes
`check-hygiene.ts` the composition root for the other scripts:

- `checkLibraryPin` spawns `node --import tsx scripts/pin-library.ts --check`
  and fails on a nonzero exit, folding the library pin into the lint gate.
- `checkPiSurface` runs `scripts/pi-surface-diff.ts` (without `--write`)
  against the committed `docs/pi-surface.json` and fails when the consumed Pi
  declaration graph changed or an imported symbol disappeared.

The `packaging` check reads `scripts/release-manifest.json` and holds the
`package.json` `files` allowlist against it, then scans `src/` for
`resolvePackageRoot()` joins and verifies each resolved literal path is
shipped. The `readme-install-block` check extracts the default bin dir and the
`export PATH` line directly from `scripts/install-local.sh` and asserts the
README's Install block matches; it also runs two concurrent dry runs of
`install-local.sh --dry-run --skip-deps --no-build` with a stub `clio-coder`
earlier on `PATH` to prove the installer warns about shadowing. The
`readme-shape` check pins the README's section list to `README_SECTIONS` and
requires the Install clone to pin `--branch v<version>`, where the version
comes from `readmeInstallVersion` in `scripts/release-version-policy.mjs`.

## Library pinning pipeline

The library pinning is a three-script pipeline with a fixed ordering,
driven by `scripts/pin-library.ts` (run via `pnpm run library:pin`):

1. **Validate** curated packages. `pin-library.ts` walks
   `library/{skills,agents,prompts,fleets,plugins}` looking for `plugin.json`,
   collects authoring templates under `library/_authoring/templates`, and
   runs `validateLibraryPackage` on each. Any validation error exits 1 before
   anything is written.
2. **Pin skills.** It calls `pinSkillsCatalog({ check })` from
   `scripts/pin-skills.ts`, which regenerates
   `library/skills/registry.yaml` (provenance-stripped sha256 pins) and
   `library/skills/skill-marketplace.json` from the skill catalog.
3. **Write full-tree pins.** `pin-library.ts` builds registry rows with
   `buildRegistryRow` from `scripts/pin-library-remote.ts`, merges the
   "blessed" remote rows read back from the previous `library/registry.yaml`
   via `readBlessedRemoteRows` / `refreshBlessedRemoteRow`, sorts by name,
   and writes `library/registry.yaml`.
4. **Project to Claude Code.** It calls `generateLibraryMarketplace({ root,
   check })` from `scripts/generate-library-marketplace.ts`, which reads the
   just-written `library/registry.yaml` and renders
   `.claude-plugin/marketplace.json`.

`pin-skills.ts` is the deepest validator in the chain. `collectEntries` walks
the skill catalog (`collectPackageDirs` treats a directory carrying its own
`SKILL.md` as a package and descends into directories without one), and
enforces the catalog contract: required frontmatter keys
(`REQUIRED_CORE_KEYS`, `REQUIRED_CLIO_KEYS`), a provenance value from
`PROVENANCE_VALUES` (`designed` | `adapted` | `imported`), a `clio-coder.origin`
for `adapted`/`imported`, `audit: pass`, a `source-url` that ends with the
catalog path, and an `allowed-tools` / `disallowed-tools` list whose entries
must be Clio tool names in canonical lowercase. The lowercase rule is load
bearing: Claude Code reads the same key as a pre-approval grant, so a
capitalized name like `Bash` would auto-approve Bash in Claude Code. Malformed
YAML frontmatter is a hard failure in both modes.

`generate-library-marketplace.ts` is a pure projection: it never invents
entries. `portabilityVerdict` returns a reason (not an error) when a pinned
package is not portable, because a native-only package is a normal library
contribution, not a pinning failure. It excludes a package when a root
directory in `HOST_SCANNED_ROOTS` (`agents`, `commands`, `hooks`,
`output-styles`, `.mcp.json`, `.claude-plugin`) exists, when `skills/` holds no
`<name>/SKILL.md`, when there is neither a root `SKILL.md` nor a `skills/`
directory, or when a top-level `skills` manifest field would suppress the root
fallback. Remote entries (source URLs matching
`^(?:[a-z][a-z0-9+.-]*:\/\/|git@)`) are reported as excluded, not published.
The entry set is verified by `pnpm run library:check`, which `lint` runs, so a
stale marketplace fails the gate.

## The release qualification gate

`scripts/release-candidate.mjs` orchestrates release qualification. In
`qualify` mode it requires a clean committed tree, runs `pnpm run ci`
(`qualify-after-ci` mode runs only `pnpm run build`, trusting the tag workflow
to have run the reusable CI), then runs `scripts/check-release.mjs`, packs the
tarball, runs `pnpm run test:package` against it, re-packs to prove
determinism, and writes a receipt to the user cache with mode 0o600. In
`preflight` mode it validates that receipt is fresh (same commit, same Node,
less than 24 hours old), that the version is coherent, and that the artifact
digest still matches a fresh pack.

`scripts/check-release.mjs` is the tarball audit. It checks the two
executable entries (`dist/cli/index.js`, `dist/worker/entry.js`) exist with
the shebang `#!/usr/bin/env node`, and that no shared chunk carries a shebang.
It runs `npm pack --dry-run --json` and applies:

- `FORBIDDEN` rules: `patches/`, `docs/html/`, Python bytecode, `.map`,
  `benchmarks/`, `scripts/`, `.tsbuildinfo`, `.env` files, and `node_modules/`.
- `REQUIRED_FILES` / `REQUIRED_PREFIXES` from `scripts/release-manifest.json`.
- Size budgets: `MAX_TARBALL_BYTES = 12_000_000` and
  `MAX_UNPACKED_BYTES = 55_000_000`.
- Builtin recipe frontmatter: every `.md` under `src/domains/agents/builtins`
  must be in the pack and carry the strict v1 schema (`requiredRecipeKeys` /
  `allowedRecipeKeys`).
- Dependency advisories via `shippedAdvisoryFindings` in
  `scripts/release-audit.mjs`, which audits only the root importer.

Version coherence runs through `releaseVersionErrors` in
`scripts/release-version-policy.mjs`: a development tree may open
`CHANGELOG.md` with `## Unreleased`, but an explicit publish context
(`CLIO_CODER_RELEASE_CONTEXT=publish`), a hosted tag, or an exact local
version tag requires the heading `## <version> - YYYY-MM-DD` and the
`package.json` version to match it. `readmeInstallVersion` returns the latest
dated stable release when the tree is still under `## Unreleased`, and the
package version otherwise.

## The Pi API surface diff

`scripts/pi-surface-diff.ts` guards the Pi SDK boundary. It collects every
`@earendil-works/pi-*` import in `src/` (both `import` and `export` clauses),
resolves each imported specifier to a `.d.ts` declaration via the package's
`exports` map, and builds a TypeScript program over those declarations.
`buildPiSurfaceSnapshot` emits a snapshot of each export's normalized
declaration hash (`signatureHash`), and `comparePiSurfaceSnapshots` compares
the baseline `docs/pi-surface.json` to the installed surface, failing only
when an imported export was removed or changed signature and reporting new
exports as info. `--write` regenerates the snapshot; comparison without
`--write` is what `lint` runs. The three packages are pinned exactly and move
together (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`,
`@earendil-works/pi-tui`), per the Pi SDK dependency section of the repository
handbook.

## The operator-run benches

Two scripts are explicitly operator-run and are never part of CI:

The maintainer’s local boot benchmark measures boot interactivity. It launches
`dist/cli/index.js` in a real pseudo-terminal (via `node-pty`) against an
isolated home and a local stub HTTP target, starts typing the moment the
Stage 0 editor paints, and times each keystroke's echo. It reports Stage 0
commit, Stage 1 hydration, the longest input block, and first/max echo
latency. `prepareHome` writes a scratch settings.yaml
with an `lmstudio` runtime target and runs the CLI's `upgrade` command once to
migrate settings and fill the compile cache; that first boot is not reported.

`scripts/decision-probe.ts` scores a System One site's wording against its labeled
fixture under `tests/fixtures/decision-cases/`, live. It **calls the named engine**
(from `systemOne.engines`, or built from `--kind`, `--target` and `--model`), runs
each case through `createSystemOne` as production does, and reports per labeled key
how many answers agreed, abstained or were wrong, the probability ranges of the two
classes, and a suggested cut with its margins. It prints the answering build because
a cut belongs to one build. The usage comment marks it "never part of CI."

## Focused tests

`tests/contracts/configuration-reference.test.ts` (CI) exercises
`configurationReferenceMembership` against the live `DEFAULT_SETTINGS` schema.
It asserts real paths resolve as supported (`context.compaction.model`,
`fleet.profiles.<key>.node`, `targets[].auth.headers.<key>`,
`fleet.rosters.<key>.members[].model`) and stale/optional paths resolve as
unsupported (`chat.obsoleteOption`, `targets[].capabilities.obsoleteOption`,
`chat[].model`). The test deliberately avoids repository fixtures because the
checker reads the typed schema once.

`tests/contracts/release-boundary.test.ts` (CI) covers two script helpers:
`shippedAdvisoryFindings` from `scripts/release-audit.mjs` and
`releaseVersionErrors` / `readmeInstallVersion` from
`scripts/release-version-policy.mjs`. It asserts a clean `pnpm audit` report
yields no notes or errors; that an unknown report shape (`null`, `{}`, an
error code, or a report missing `metadata`) throws "unknown"; and that a
missing advisory detail for a non-zero vulnerability count throws
"without advisory details". For advisories it blocks `high` and `critical`
while keeping `moderate` visible as a note. For versions it asserts
`readmeInstallVersion` pins to the latest dated stable release
(`0.4.4`) under `## Unreleased`, requires a dated stable release to exist, and
that `releaseVersionErrors` allows `Unreleased` in development but refuses it
for a tag or publish and requires the exact version and a `YYYY-MM-DD` date.

`tests/extended/library-portability.test.ts` (extended, not routine CI)
exercises `renderLibraryMarketplace` against throwaway fixture roots built
from `library/_authoring/templates`. It asserts the composite template
(a root `agents/`) is excluded with a reason naming the host-scanned
directory; agent-, prompt-, and fleet-only packages are excluded with
"no portable skill surface"; and a standalone skill package publishes
alongside them. It also asserts the canonical skill inventory in
`library/skills` and the Materio bundle matches `library/registry.yaml`, and
that optional host links are symlinks that never copy bodies.

`tests/extended/pin-library-remote.test.ts` (extended) exercises
`refreshBlessedRemoteRow` with an injected `fetchPluginSource`, asserting a
successful fetch regenerates the row and recomputes the digest, an
identity-mismatch or invalid tree preserves the pinned row with a warning, a
network failure preserves the row unchanged with a warning, and cleanup runs
on both success and failure.

Note the CI distinction: `tests/contracts/*` runs in routine CI, while
`tests/extended/*` runs only under `pnpm run test:full`, so the extended
library tests do not gate routine pull requests.

## Extension seams

- **Add a hygiene check**: append a `[name, fn]` pair to the `checks` array at
  the bottom of `scripts/check-hygiene.ts` and implement the function in the
  same file using `fail(rule, message)`. The check must stay fast because the
  CI `checks` job has a 4-minute budget including lint.
- **Add a library kind**: extend `KIND_DIRS` in `scripts/pin-library.ts` to add
  another `library/<dir>` scanned for `plugin.json`, matching the expected
  `clio.kind` on the manifest.
- **Add a Pi package**: extend `PI_PACKAGES` in `scripts/pi-surface-diff.ts`;
  the snapshot and comparison then cover it automatically.
- **Add a portability rule**: change `portabilityVerdict` or
  `HOST_SCANNED_ROOTS` in `scripts/generate-library-marketplace.ts`. The rule
  must return a reason string, not throw, so a native-only package is reported
  rather than failing the pin.
- **Add a required package file**: add it to `scripts/release-manifest.json`
  `requiredFiles`, and the `packaging` hygiene check will enforce it against
  the `package.json` `files` allowlist while `check-release.mjs` enforces it
  against the actual tarball.

## Things to watch when editing

- **scripts/ never ships.** Both the `packaging` check in
  `scripts/check-hygiene.ts` and `FORBIDDEN` in `scripts/check-release.mjs`
  assert this. Adding a `scripts/` path to the `package.json` `files` allowlist
  or to `release-manifest.json` will fail these gates.
- **No model calls in the lint gate.** `check-hygiene.ts` must stay free of
  model requests and real user installations; the local boot benchmark and
  `decision-probe.ts` are operator-run tools that exercise real
  runtimes, and they are invoked only by hand, never by CI.
- **Generated catalogs are committed.** `library/registry.yaml`,
  `library/skills/registry.yaml`, `library/skills/skill-marketplace.json`, and
  `.claude-plugin/marketplace.json` are checked into the tree and must be
  regenerated with `pnpm run library:pin` after a library change; a stale
  catalog fails `library:check` and therefore `lint`.
- **The marketplace is a projection, not an authority.** Do not hand-edit
  `.claude-plugin/marketplace.json`; `generate-library-marketplace.ts` derives
  it from `library/registry.yaml` and `library:check` verifies it.
- **The `check-release.mjs` size budgets are tripwires, not diets.**
  `MAX_TARBALL_BYTES` and `MAX_UNPACKED_BYTES` exist to catch packaging
  defects (leaked `node_modules`, doubled `dist`). Raising them requires a
  deliberate decision; lowering them will fail on the current artifact.
- **Remote pin rows are re-fetched on every pin.** `pin-library.ts` reads the
  previous `library/registry.yaml` via `readBlessedRemoteRows` and re-fetches
  each blessed remote row to verify its digest; a network failure keeps the
  row unchanged with a warning, it does not fail the pin.
- **Version coherence is enforced at publish.** `prepublishOnly` runs
  `scripts/release-candidate.mjs preflight`, which requires a fresh receipt
  from `ci:release`. A version bumped in `package.json` without a dated
  `CHANGELOG.md` heading will fail at publish time and cannot be replaced
  afterwards because published tags are immutable.

<!-- clio-coder:wiki unresolved sources: docs/html/, tests/contracts/*, tests/extended/* -->
