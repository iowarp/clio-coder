---
title: "Command-line maintenance scripts"
summary: "The repository's scripts/ directory: release gates, publication and dev-snapshot tooling, skill and marketplace generators, the hygiene lint, and TUI benchmarks. Read this page to find which script owns a release, catalog or lint check and how it is invoked."
sources:
  - "scripts/check-hygiene.ts"
  - "scripts/release-publish.mjs"
  - "scripts/pin-skills.ts"
  - "scripts/bench-tui-feedback.ts"
  - "scripts/native-install.cjs"
  - "scripts/check-release.mjs"
  - "scripts/bench-tui.ts"
  - "scripts/generate-library-marketplace.ts"
  - "package.json"
symbols:
  - "publicationPlan"
  - "snapshotPayload"
  - "compareVersions"
  - "forwardedTags"
  - "verifyQualificationRecord"
  - "PinSkillsOptions"
  - "pinSkillsCatalog"
  - "renderLibraryMarketplace"
  - "generateLibraryMarketplace"
  - "portabilityVerdict"
tests:
  - "tests/contracts/native-install-hardening.test.ts"
  - "tests/contracts/installed-package-ci.test.ts"
  - "tests/extended/library-portability.test.ts"
invariants:
  - "publicationPlan rejects any branch not matching v followed by three digits, and any version whose channel tag fails publishTagErrors."
  - "verifyQualificationRecord accepts a qualification run only when it is a successful workflow_dispatch run of .github/workflows/ci.yml on the exact commit, with prepare, ci (22) and ci (24) all successful."
  - "compareVersions orders strict SemVer ignoring build metadata; forwardedTags only forwards a registry dist-tag that is strictly older than the version being published."
  - "generateLibraryMarketplace in check mode reports drift and exits non-zero when .claude-plugin/marketplace.json differs from the rendered content; in default mode it rewrites that file."
  - "check-release.mjs enforces per-class package size budgets and a 3,000-entry ceiling, and forbids shipping source maps, benchmarks, stray scripts, environment files and node_modules."
validate:
  - "pnpm run lint"
  - "pnpm run skills:check"
  - "pnpm run library:check"
  - "pnpm run test:file tests/contracts/installed-package-ci.test.ts"
  - "pnpm run test:file tests/contracts/native-install-hardening.test.ts"
---

# Command-line maintenance scripts

The `scripts/` directory holds the maintainer-facing tooling that sits outside the shipped runtime. Reach for this page when you need to know which script gates a release, regenerates the skill or marketplace catalogs, runs the lint hygiene pass, or benchmarks the terminal UI. None of these scripts is loaded by the CLI at runtime. The package allowlist in `package.json` ships only a subset (`scripts/native-install.cjs` and the release-manifest scripts), and `scripts/check-release.mjs` treats any other `scripts/` file in the tarball as a defect.

## What the area contains

Each script is a standalone Node or tsx entry point. They are wired through `package.json` scripts:

- `lint` runs `biome check .` and then `node --import tsx scripts/check-hygiene.ts`.
- `skills:pin` and `skills:check` run `scripts/pin-skills.ts`, with and without `--check`.
- `library:pin` and `library:check` run `scripts/pin-library.ts`. That file was not inspected for this page.

The other anchor scripts (`scripts/release-publish.mjs`, `scripts/check-release.mjs`, `scripts/native-install.cjs`, `scripts/bench-tui.ts`, `scripts/bench-tui-feedback.ts`, `scripts/generate-library-marketplace.ts`) are not exposed as named `package.json` scripts in the lines inspected. Their owning responsibilities are described below from source.

## Release gating and publication

`scripts/release-publish.mjs` owns the publication plan and the dev snapshot path.

- `publicationPlan(receipt, branch, mode)` requires the branch to match `^v\d{3}$`, derives a channel (`dev`, `beta` when the version contains `-`, otherwise `latest`), and throws if `publishTagErrors` reports problems. The returned object carries the commit, package specifier, tarball name and checksums, with `tag` set to `null` in dev mode.
- `snapshotPayload(receipt, directory)` builds a dev snapshot from an already qualified tarball. It refuses archives with entries outside `package/`, `..` segments, backslashes, or non-file and non-directory tar types. It then rewrites only `package.json`'s `version` field and checks that every other file's mode and digest is unchanged. The repacked archive is produced with fixed owner, group and mtime, then re-extracted and compared against the expected inventory.
- `releaseMode` reads `CLIO_CODER_RELEASE_MODE` and only accepts `release` or `dev`. `payload` calls `snapshotPayload` only in dev mode.
- `compareVersions` implements strict SemVer ordering with build metadata ignored. `forwardedTags` uses it to decide which npm dist-tags (`beta`, `dev` for a `latest` publish; `dev` for a `beta` publish) must be moved forward, returning only tags that are strictly older than the new version.
- `verifyQualificationRecord(record, jobs, commit, inProgress)` is the gate that accepts a qualification run. It requires `head_sha` to equal the commit, `path` to be `.github/workflows/ci.yml`, `event` to be `workflow_dispatch`, and (unless `inProgress`) a completed successful run. It then requires the newest jobs named `prepare`, `ci (22)` and `ci (24)` to have succeeded. `qualification` fetches the run and jobs through `api`, which shells out to `gh api`.

The focused test `tests/contracts/installed-package-ci.test.ts` imports this module. Its cases include "qualification rejects another commit, automatic events, and failed required gates" and "candidate checksums bind its archive version, site provenance, and installer bytes". Those tests were located by search, and their assertion bodies beyond the case names were not read for this page.

`scripts/check-release.mjs` is the release gate for the built `dist/` tree and the npm package contents. It runs in the release path (its header names `ci:release` and `prepublishOnly`). Its key rules, as read in the first 160 lines:

- Dist integrity: `dist/cli/index.js` and `dist/worker/entry.js` must carry the `#!/usr/bin/env node` shebang, and no shared chunk may carry one.
- Pack-report mode: when `--tarball` and `--report` are both supplied, the script checks the tarball's sha512 integrity and size against the report, rejects unsafe tar paths, and compares the tarball's file inventory to the report. It then extracts the tarball and audits the extracted `package/` root.
- `FORBIDDEN` rules reject `patches/`, retired `docs/html/`, Python bytecode, `.map` files, `benchmarks/`, unshipped `scripts/` files, `.tsbuildinfo`, `.env` files and `node_modules/`.
- `SIZE_BUDGETS` assigns each payload class (grammars, codemap, dist bundles, gui client, src, docs, and the library/examples/models/root group) a byte ceiling. The total unpacked ceiling is their sum. `MAX_TARBALL_BYTES` is 17,000,000 and `MAX_ENTRY_COUNT` is 3,000. The inline comments record that budgets are re-pinned only with explicit maintainer approval.

The required file and prefix lists are read from `scripts/release-manifest.json`, which the same file's comment says is shared with a packaging contract test.

## Catalog generators

`scripts/pin-skills.ts` regenerates `library/skills/registry.yaml` (the pinned content hashes) and publishes `library/skills/skill-marketplace.json`. Its header states that runtime discovery uses the shared `library/registry.yaml` and that this script is not a second installation authority.

- `pinSkillsCatalog(options)` (exported, line 396) takes `catalogDir` and `check` options and returns a `PinSkillsResult` with drift flags, drift lines and the rendered manifest and index text.
- `collectPackageDirs` treats a directory with its own `SKILL.md` as a package and otherwise descends into it as a category folder.
- Required frontmatter is enforced: `REQUIRED_CORE_KEYS` (`name`, `description`, `version`, `license`) and `REQUIRED_CLIO_KEYS` (`registry-id`, `source-url`) inside the `clio-coder:` block. Malformed frontmatter is a hard failure in both modes.
- `allowed-tools` and `disallowed-tools` values are checked against `ALL_TOOL_NAMES` in canonical lowercase spelling. The in-source comment explains that Claude Code reads the same key as a pre-approval grant, so a mis-cased name could silently auto-approve a host tool.
- Normalized content hashes come from `normalizedSkillHash` in `src/domains/resources/skills/content-hash.ts`, and the body line budget comes from `SKILL_BODY_LINE_BUDGET` in `src/domains/resources/skills/authoring-check.ts`. Both were imported and not read.

`scripts/generate-library-marketplace.ts` regenerates `.claude-plugin/marketplace.json` from the pinned library registry.

- `renderLibraryMarketplace` (exported, line 186) produces the marketplace content and the included entries and excluded packages.
- `portabilityVerdict(directory, manifest)` decides inclusion. A package is excluded, with a reason rather than an error, when a root `agents`, `commands`, `hooks`, `output-styles`, `.mcp.json` or `.claude-plugin` exists, since Claude Code would default-scan those. The header records this as measured against Claude Code 2.1.267.
- `generateLibraryMarketplace(options)` (exported, line 297) runs in two modes. With `check` it compares the rendered content to the file on disk and returns drift lines. Without `check` it writes the file. Render errors return early with `ok: false` and no write.
- The CLI entry at the bottom of the file prints excluded packages, reports drift on stderr, and exits 1 on drift, directing the operator to `pnpm run library:pin`.

The focused test `tests/extended/library-portability.test.ts` imports `renderLibraryMarketplace`. The search did not reveal further assertions from this file.

## Lint hygiene

`scripts/check-hygiene.ts` runs as the second half of `pnpm run lint`. It accumulates failures through `fail(rule, message)` into a module-level `errors` array. Rules visible in the inspected region:

- `checkDocumentationLinks` scans `docs/**/*.md`, `README.md` and `CONTRIBUTING.md`. It checks Markdown and HTML link targets for existence and, for `.md` targets with a fragment, checks the heading anchor using `slugify` from `src/tools/context/docs-engine.ts`. It also checks backticked `src/`, `tests/`, `scripts/` and `apps/` paths. Fenced code blocks are skipped.
- `collectFiles(dirs, extensions)` walks directories and returns files by extension for the export-hygiene pass. The header comment records that the pass was rewritten to avoid spawning one `grep` per exported symbol.

The remainder of the file (the export-hygiene and product-namespace checks, from roughly line 139 onward) was not read in detail for this page.

## Native installer helper

`scripts/native-install.cjs` is a CommonJS helper that runs before any package is importable. Its inspected parts:

- `atomic(file, text, mode)` writes to a temporary file, fsyncs it, and renames it into place.
- `clioRoot(role)` resolves the config and state roots using the same order as `src/core/xdg.ts`: `CLIO_CODER_<ROLE>_DIR`, then `CLIO_CODER_HOME`, then platform defaults for Windows, macOS, and XDG on other systems. The comment states the order is repeated because the helper runs first.
- `record(root)` reads `install.json` under the state root, requires `node`, `current` and `launcher` to be absolute, requires schema 1 or 2, and checks that `current` lies inside `versions/` and `node` inside `runtime/`. Errors are thrown with the file path.

The focused test `tests/contracts/native-install-hardening.test.ts` covers these areas. Its cases include "truncated and malformed install records give actionable errors without partial launch state", "retention preserves current, rollback and live receipts while collecting old and refused versions", and "rollback keeps the capable desktop manager and cleanup while launching the activated server". Only the test names were read for this page; the bodies were not inspected.

## TUI benchmarks

`scripts/bench-tui.ts` and `scripts/bench-tui-feedback.ts` are developer benchmarks. They are not part of the lint or release path.

`scripts/bench-tui.ts` parses `--turns`, `--frames`, `--repeats`, `--columns`, `--rows`, `--mode`, `--workload` and `--style`, validating against a fixed workload list (for example `composer`, `diagram`, `workers`, `reply-500k`) and modes `regular` and `fullscreen`. Its `CountingTerminal` implements the `Terminal` interface from `src/engine/tui.ts` and counts written bytes, so timings exclude emulator painting. Workloads drive `createChatPanel` from `src/interactive/chat-panel.ts` and `buildLayout` from `src/interactive/layout.ts`. The renderer observer is a no-op `TuiRenderObserver`. `scripts/bench-tui-feedback.ts` was indexed but not read for this page.

## Things to watch when editing

- `scripts/check-release.mjs` size budgets and the `MAX_TARBALL_BYTES` value carry inline comments that they are maintainer-approved pins. Raising a budget without that approval is what the file's own comments warn against.
- `scripts/check-release.mjs` and `scripts/release-publish.mjs` both read the release manifest and version policy. The `scripts/release-version-policy.mjs` module that supplies `publishTagErrors` and `snapshotVersion` was not read for this page.
- `scripts/pin-skills.ts` and `scripts/generate-library-marketplace.ts` both describe `library/` as the canonical tree. Edits to skill frontmatter feed the pinned hashes; the marketplace is a projection and is not meant to be hand-edited. The generator's check mode is what `lint` relies on through `pnpm run library:check`.
- `scripts/native-install.cjs` duplicates the XDG resolution from `src/core/xdg.ts` by design. A change to the resolution order must be made in both places.

## Related pages

- [Tests contracts](tests/contracts.md) covers the contract tests that exercise these scripts.
- [Tests extended](tests/extended.md) covers the library portability test.
- [Core](core.md) covers `src/core/xdg.ts` and the package-root resolution the installer mirrors.
- [Interactive](interactive.md) covers the chat panel and layout that the TUI benchmarks drive.
