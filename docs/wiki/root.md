---
title: "Repository root: launcher, build configuration, image utilities and example extensions"
summary: "Covers the package's root-level launcher and build config, the image resize and EXIF utilities under src/utils, and the example extensions under examples/. Read this page when changing how the CLI starts, how dist/ is bundled, how images are downscaled for model input, or when authoring an extension from the examples."
sources:
  - "bin/clio-coder.cjs"
  - "tsup.config.ts"
  - "src/utils/image-resize.ts"
  - "src/utils/photon.ts"
  - "src/utils/exif-orientation.ts"
  - "examples/extensions/peer-guard/runtime/extension.ts"
  - "examples/extensions/git-pulse/runtime/extension.ts"
  - "examples/extensions/lab-status/extension.mjs"
symbols:
  - "isSupportedNode"
  - "holdInstall"
  - "resizeImage"
  - "loadPhoton"
  - "applyExifOrientation"
  - "getExifOrientation"
tests:
  - "tests/contracts/launcher-guard.test.ts"
invariants:
  - "bin/clio-coder.cjs compares the running Node against MIN_NODE [22, 19, 0], which must equal the engines.node floor in package.json; a Node below the floor prints advice and sets exitCode 1 before dist/ is imported."
  - "resizeImage returns the input unchanged (wasResized false) when the decoded dimensions are within maxWidth and maxHeight and the base64 input is under maxBytes; otherwise it returns null when encoding fails or no candidate fits maxBytes."
  - "resizeImage returns null when photon-node cannot be loaded; callers receive null rather than an exception for decode, resize and encode failures inside its try block."
validate:
  - "pnpm exec vitest run tests/contracts/launcher-guard.test.ts"
---

# Repository root: launcher, build configuration, image utilities and example extensions

This page covers the files at the top of the tree that a reader needs when the CLI fails to start, when the bundle layout in `dist/` changes, when an image attached to a prompt is downscaled, or when an example extension is copied as a starting point. The owning subsystem pages are linked where they exist.

## Launcher: `bin/clio-coder.cjs`

`bin/clio-coder.cjs` is the executable behind the `clio-coder` command. It is plain CommonJS with ES5 syntax on purpose: its header comment states it must parse on any Node, because an older Node fails to link the ESM graph in `dist/` with an error that names neither Node nor a fix.

Control flow in `main()`:

1. If `CLIO_CODER_NODE` names a different Node binary and the re-exec mark `CLIO_CODER_NODE_GUARD` is not set, `runUnder` spawns that binary with the same arguments, sets the mark in the child environment, forwards SIGTERM and SIGHUP to the child, and exits with the child's code.
2. `isSupportedNode(process.versions.node, MIN_NODE)` is checked. A failure writes `tooOldAdvice(...)` to stderr and sets `process.exitCode = 1`. The advice names the installer command and the `CLIO_CODER_NODE` override, and adds a glibc note on Linux when `glibcVersion()` reports a version below 2.28.
3. `holdInstall(path)` runs the update-lease logic described below. A false return stops the launch.
4. `process.argv[1]` is set to `dist/cli/index.js` (the entry that `dist/cli/index.js` and install-method detection read), and that file is imported through `new Function("u", "return import(u)")`. The indirection keeps a Node too old to parse `import()` on the advice path instead of a SyntaxError.

`parseVersion` and `isSupportedNode` compare major, minor and patch numerically; a leading `v` is stripped and unparseable components become 0. The module exports `isSupportedNode` and `MIN_NODE`, and `tests/contracts/launcher-guard.test.ts` imports them. That test reads `engines.node` from `package.json`, asserts it equals `>=` plus `MIN_NODE` joined by dots, and checks versions such as `18.20.8`, `22.18.9`, `22.19.0`, `v22.19.1` and `garbage` against the expected boolean.

### Deferred update lease (`holdInstall`)

For package-manager installs in a layout `updatableRoot` recognizes (npm/volta `lib/node_modules`, bun `install/global/node_modules`, pnpm `global/<n>/.pnpm`), a detached update wrapper replaces files in place after a session quits. `holdInstall` makes a launch visible to that wrapper: it writes a per-pid record under `.clio-coder-active/` next to the install, refreshes its mtime every five minutes, and removes it on exit. If a `.clio-coder-update.json` lease exists, the launch waits (up to 120 seconds, polling every 250 ms) until the lease's result file records a run newer than the lease start, the lease is no longer alive, or the marker disappears. A timeout sets `process.exitCode = 75`. Source checkouts, native installs, `_npx` caches and project-local copies return early from `updatableRoot` and skip this path. The file's comments reference issues #408, #436 and this lease mechanism; the code does not describe prior behavior beyond what is shown.

Things to watch when editing this file:

- It must stay ES5 CommonJS. It is intentionally not bundled and does not import from `dist/` before the version check.
- `MIN_NODE` must match `engines.node` in `package.json`; the contract test enforces this.
- The lease logic is shared in intent with the update wrapper (the comment says the host id matches it), but the update wrapper is not in this page's scope; no claim is made here about its implementation.

## Build configuration: `tsup.config.ts`

`tsup.config.ts` defines every JavaScript entry bundled into `dist/` and the post-build steps. Entries are declared in the `entries` object: `cli/index` (from `src/cli/index.ts`), `extensions/testing`, `gui/server`, `gui/reads-worker`, `gui/ops-worker`, `worker/entry`, and `codewiki/build-worker`. The config uses `format: ["esm"]`, `target: "node22"`, `splitting: true` (the comment explains that per-subcommand dynamic imports in `src/cli/index.ts` depend on it), `minify: false` (the comment cites decisions #64 and #65 for keeping stack traces readable), and `removeNodeProtocol: false` so that `node:sqlite` is not rewritten to a nonexistent `sqlite` package.

The build id comes from `buildIdPlugin`, not `define`: it mints a fresh UUID at the start of every esbuild run, watch rebuilds included, and serves it as the contents of `src/core/build-id.ts`, so only that module's chunk changes between builds; `onSuccess` writes the id and the build's file list to `dist/build.json`. `clean: false` keeps the previous build's hashed chunks so a running process can still load the ones it has not imported, and `onSuccess` prunes chunks no live process needs; `scripts/build.ts --clean` (`pnpm run build:release`) restores a full clean. Through `define`, `buildProvenanceDefines()` injects `__CLIO_BUILD_COMMIT__` and `__CLIO_BUILD_DIRTY__` from `git rev-parse` and `git status --porcelain`. The file's own comment says `src/core/build-info.ts` reads these constants and that no git process runs at runtime. Outside a git checkout, nothing is defined.

`external` lists `node:sqlite` and `@anthropic-ai/claude-agent-sdk`; the comment explains the SDK is an optional dependency that would otherwise be bundled, and that external keeps the lazy `await import()` in `src/engine/claude/sdk-module.ts` a real runtime import. `noExternal` lists packages (such as `hono`, `chalk`, `yaml`, `@vscode/tree-sitter-wasm`, and `@earendil-works/pi-tui` subpaths) bundled into `dist/`.

The `onSuccess` hook runs after the Node bundles are emitted. It:

1. Builds the GUI client by calling Vite's `build` with `apps/clio-coder-gui/vite.config.ts` into `dist/gui/client`.
2. Calls `vendorGrammars()`, which copies the twelve wasm files listed in `GRAMMAR_ASSETS` (from `src/domains/context/codewiki/grammar-assets.ts`) into `dist/assets/grammars/`, and copies each grammar package's notices into `dist/assets/grammars/notices/`.
3. Calls `vendorTuiNotices()`, which copies license files for the bundled pi-tui and marked packages into `dist/assets/tui-notices/`.
4. Copies the `hono` and `@hono/node-server` LICENSE files and writes a `dompurify.json` record (name, version, source URL, SHA-256 of the entry file) into `dist/assets/gui-notices/`.
5. Writes `dist/build.json` with the build id and a list of emitted `.js`, `.wasm` and `.html` files.

Things to watch when editing this file:

- Adding an entry means adding a key to `entries`; the GUI server and worker entries are built by the same config.
- The `vendorGrammars` step depends on `GRAMMAR_ASSETS`; changing that list changes what lands in `dist/assets/grammars/`. The asset list itself is documented by the codewiki page linked below.
- The build deletes and recreates `dist/assets/grammars`, so anything written there by other steps must run after it.
- `tests/smoke/installed-package.test.ts` exercises an installed package; its checks on `dist/` contents are not analyzed in this page.

## Image resizing: `src/utils/image-resize.ts`

`resizeImage(img, options?)` prepares an `ImageContent` (base64 `data` plus `mimeType`) for model input. Defaults are `maxWidth` 2000, `maxHeight` 2000, `maxBytes` 4.5 MiB (`DEFAULT_MAX_BYTES`) and `jpegQuality` 80. Options are shallow-merged over these defaults.

Flow:

1. `loadPhoton()` (from `src/utils/photon.ts`) is awaited. If it resolves to `null`, `resizeImage` returns `null`.
2. The base64 input is decoded and the raw image is created with `PhotonImage.new_from_byteslice`. `applyExifOrientation` (from `src/utils/exif-orientation.ts`) is applied; if it returns a different image object the raw one is freed.
3. If the oriented width and height are within the limits and the base64 string is shorter than `maxBytes`, the original `data` is returned with `wasResized: false` and the original mime type.
4. Otherwise the target size is computed by scaling to `maxWidth`, then to `maxHeight`, preserving aspect ratio with rounding.
5. A loop encodes at the target size. For each attempt `tryEncodings` produces a PNG and JPEG candidates at quality steps `[jpegQuality, 85, 70, 55, 40]` (deduplicated). The first candidate whose base64 length is below `maxBytes` is returned with `wasResized: true`. If none fits, dimensions shrink by a factor of 0.75 per iteration, with a floor of 1x1; when the floor or a no-change step is reached, the function returns `null`.
6. Any exception inside the try block is caught and yields `null`; the `finally` frees the working image.

`formatDimensionNote(result)` returns `undefined` when nothing was resized. Otherwise it returns a bracketed note of the original and displayed dimensions and the scale factor, so a model can map coordinates back to the original image.

Callers in the tree (found by searching for `resizeImage(`): `src/core/file-references.ts` at its calls around lines 227 and 303, which passes `{ maxBytes }` in one case and no options in the other, and imports `formatDimensionNote`; and `src/entry/orchestrator.ts` near its import at line 365 and call at line 5132, which passes only the image content. Callers must handle a `null` result as "not resized"; this page did not read those call sites in full, so their handling of `null` is not described here.

### Photon loading (`src/utils/photon.ts`)

`loadPhoton()` dynamically imports `@silvia-odwyer/photon-node` once and caches the module (`photonModule`) and the in-flight promise (`loadPromise`). Failure to import sets the module to `null` and resolves `null`; the cache then holds `null` and later calls return it without retrying the import.

During the import, `patchPhotonWasmRead()` temporarily replaces `fs.readFileSync` for paths ending in `photon_rs_bg.wasm`. If the original read fails with `ENOENT`, it tries fallback locations: next to `process.execPath`, in a `photon/` subdirectory of that directory, and in `process.cwd()`. Other error codes are rethrown. The original `readFileSync` is restored in the `finally` block after the import. Only the import is covered; later calls to photon functions are not patched.

### EXIF orientation (`src/utils/exif-orientation.ts`)

`applyExifOrientation(photon, image, originalBytes)` reads the EXIF orientation tag from the original bytes and applies the corresponding transform. `getExifOrientation` recognizes JPEG (SOI `FFD8`, then an APP1 segment with an `Exif\0\0` header) and WebP (RIFF/WEBP with an `EXIF` chunk). Any other format, or any parse failure, yields orientation 1, which returns the image unchanged. For orientations 2 to 8 it uses `photon.fliph`, `photon.flipv`, or `rotate90` with a destination index function, creating a new `PhotonImage` for rotations. The function returns either the same image (mutated in place for flips) or the new rotated image; `resizeImage` compares identity to decide whether to free the raw image.

No focused test for the orientation mapping was found in the repository by the search below. The search used the symbol names `resizeImage`, `applyExifOrientation` and `loadPhoton` across `tests/`; it matched only `tests/smoke/installed-package.test.ts`, `tests/extended/operator-extensions.test.ts` and `tests/extended/library-import.test.ts`, which match on other names in those files. Coverage of this area is therefore source-only in this page.

Things to watch when editing this file:

- `resizeImage` swallows all errors and returns `null`; a change that throws would alter the caller contract, which the callers in `src/core/file-references.ts` and `src/entry/orchestrator.ts` rely on through their `null` handling.
- The size loop only shrinks dimensions; it never raises the JPEG quality beyond `jpegQuality` in the first step.
- `loadPhoton` patches the global `fs.readFileSync` during the dynamic import. Code running concurrently with that import observes the patched function.

## Example extensions: `examples/extensions/`

These three directories are reference extensions, not part of the runtime. Each uses the `api.handle`, `api.on`, `api.hook` or `api.state`/`ctx.store` surface of the extension API. The public extension types are imported from `@iowarp/clio-coder/extensions`. The extension system itself is documented on [domains/extensions.md](domains/extensions.md).

- `examples/extensions/peer-guard/runtime/extension.ts` coordinates file claims between sessions. The `claim`, `release` and `claims` handlers write a `claims` record to the shared store with optimistic versioning (`ctx.store.set(..., { ifVersion })`), retried up to eight times. Paths are canonicalized through `canonicalPath`, which resolves existing symlink parents with `realpathSync`, rejects paths outside the workspace, and rejects NUL bytes or inputs over 1000 characters. Claims expire after `ctx.options.claimMinutes` (validated to 0.1 to 1440) and are capped at 100 active rows. A `before_tool` hook returns a `block_tool` effect for `write` and `edit` calls whose resolved path is claimed by another session. Session identity is stored with `ctx.state` and requires a non-null `ctx.snapshot.sessionId`.
- `examples/extensions/git-pulse/runtime/extension.ts` reports Git status. The `pulse` handler and the `session_open`, `fs_changed` and `tick` hooks call `refresh`, which runs `git` through `execFile` with a fixed argument list (`--no-optional-locks`, `core.fsmonitor=false`, `status --porcelain=v2 --branch --untracked-files=all -z`), a 1200 ms timeout and a 256 KiB buffer. `parseStatus` reads the NUL-separated porcelain records, counting changed entries and skipping the second token of rename records. The snapshot is written to `ctx.state` under `lastSnapshot` with optimistic versioning, and a newer stored snapshot is preferred.
- `examples/extensions/lab-status/extension.mjs` reads a local JSON experiment record and reports job counts. `readRecord` opens the file, requires a regular file of at most 32 KiB, validates `experiment`, `jobs` (at most 100), and each job's `id`, `state` (one of `queued`, `running`, `completed`, `failed`), integer `ranks` and non-negative `elapsedSeconds`. The `dashboard` handler defaults to the bundled `examples/extensions/lab-status/jobs.synthetic.json` and returns text, a status and a panel. The panel labels data as synthetic when `synthetic === true` and states that the extension "never submits or queries cluster jobs." The `session_open` and `turn_end` hooks re-emit the last status.

The test `tests/extended/operator-extensions.test.ts` (around line 457) and `tests/extended/library-import.test.ts` (around lines 182 and 258) reference the `lab-status` extension by id and invoke `ext:lab-status:dashboard`. `tests/smoke/installed-package.test.ts` (around lines 1040 to 1066) installs `examples/extensions/lab-status` with `extensions install --project --json`, runs `extensions run lab-status dashboard --json`, then disables it and checks the disabled run. These tests were located by search; their assertions were not read in full for this page. No focused test for `peer-guard` or `git-pulse` was found by the search.

Things to watch when editing these examples:

- Copies of these files are the starting point for new extensions, so changes here change the documented pattern. The `peer-guard` and `git-pulse` examples document their own safety choices in comments: fixed argv with no shell in `git-pulse`, and symlink-resolved containment in `peer-guard`.

## Related pages

- [domains/extensions.md](domains/extensions.md) for the extension runtime and authoring surface.
- [core.md](core.md) for `src/core`, including `src/core/file-references.ts` callers of image resizing.
- [entry.md](entry.md) for `src/entry`, including the orchestrator call site.
- [scripts.md](scripts.md) for build-related scripts invoked around `tsup`.
- [site.md](site.md) for the site tree.
