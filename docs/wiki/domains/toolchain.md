---
title: "Pinned external tools and the toolchain"
summary: "How Clio pins, installs, resolves, prunes and removes third-party terminal programs under the data root's tools directory. Read this when changing a pin, the PATH-versus-vendored resolution rules, or the installer's atomicity guarantees."
sources:
  - "src/domains/toolchain/index.ts"
  - "src/domains/toolchain/registry.ts"
  - "src/domains/toolchain/install.ts"
  - "src/domains/toolchain/remove.ts"
  - "src/domains/toolchain/resolve.ts"
  - "src/domains/toolchain/archive.ts"
  - "src/domains/toolchain/types.ts"
  - "src/domains/toolchain/version.ts"
  - "src/domains/toolchain/paths.ts"
symbols:
  - "PINNED_TOOLS"
  - "installTool"
  - "installPinnedTool"
  - "pruneSupersededVersions"
  - "removeTool"
  - "resolveToolBinary"
  - "resolveEntryBinary"
  - "toolStatus"
  - "describeResolution"
  - "readZipEntries"
  - "readTarGzEntries"
  - "probeBinaryVersion"
tests:
  - "tests/contracts/asciinema-toolchain.test.ts"
invariants:
  - "A download whose SHA-256 does not match the pin writes nothing under the tool's version directory and returns ok false with a checksum mismatch message."
  - "The version directory appears by renaming a sibling staging directory into place, so an interrupted install does not leave a populated version directory."
  - "A successful install or an already-installed check prunes every other version directory of the same tool, keeping only the pinned version."
  - "Resolution prefers a PATH copy only when its probed version satisfies the registry minimumVersion; otherwise it falls back to the vendored copy, and reports none when neither exists."
  - "The resolution ladder performs no download and writes nothing; installation happens only through installTool or installPinnedTool."
  - "Archive member paths containing an absolute prefix or a .. segment are rejected before extraction."
validate:
  - "pnpm run test:file -- tests/contracts/asciinema-toolchain.test.ts"
---

# Pinned external tools and the toolchain

The toolchain domain owns the registry of third-party terminal programs that Clio uses (asciinema, herdr, yazi, croc and cliamp at the time of reading), and the machinery that installs them under the data root, resolves which copy Clio will run, and removes or prunes them. A reader needs this page when bumping a pin, adding a tool row, changing how a PATH copy is accepted, or debugging why a tool reports as absent or superseded.

## What the area does

Each registry row (`PinnedTool` in `src/domains/toolchain/types.ts`) records the exact version, the per-platform download URL and SHA-256 hash, the archive kind (`raw`, `zip`, `tar.gz`), the members to extract, the upstream license, and a `minimumVersion` floor. The installer downloads only when an operator names the tool, verifies each hash, unpacks the archive, and places files into a version directory. Resolution asks which binary to run and walks a fixed two-step ladder. The module comments state that no startup path can reach the network, and `installTool` is the only export that downloads.

## Ownership

- `src/domains/toolchain/index.ts` is the public barrel. Callers import from here, and it re-exports the symbols listed in the frontmatter.
- `src/domains/toolchain/registry.ts` holds the `PINNED_TOOLS` array and the lookups `findPinnedTool`, `findPinnedToolByBinary`, `currentToolPlatform` and `packageManagerInstallHints`.
- `src/domains/toolchain/install.ts` owns `installTool` (by id) and `installPinnedTool` (by row, used by tests with a fabricated entry), plus the private `prune`, `unpack`, `fetchAsset` and `sha256` helpers.
- `src/domains/toolchain/remove.ts` owns `removeTool`, `pruneSupersededVersions`, `installedToolVersions` and the stale-staging sweep.
- `src/domains/toolchain/resolve.ts` owns the ladder: `resolveToolBinary`, `resolveEntryBinary`, `toolStatus`, `toolStatuses`, `describeResolution` and `describeFloorRejection`.
- `src/domains/toolchain/archive.ts` owns the minimal `readZipEntries` and `readTarGzEntries` readers, built on `node:zlib`.
- `src/domains/toolchain/version.ts` owns `parseVersion`, `compareVersions`, `satisfiesMinimum` and the memoized `probeBinaryVersion`.
- `src/domains/toolchain/paths.ts` owns `toolchainRoot` (`<data>/tools`), `toolVersionDir`, `vendoredBinaryPath`, and the creating variant `ensureToolchainRoot`. Reads go through `resolveClioDirs()` so they do not create the data root.

## Install flow

The caller `installOne` in `src/cli/tools.ts` checks `findPinnedTool(id)`, then calls `installTool(id, { force, onProgress })`. Inside `installPinnedTool`:

1. The platform is `options.platform` or `currentToolPlatform()`. A null platform or a missing `entry.downloads[platform]` returns `failure` without touching disk.
2. If `force` is false and every binary in `binaryMembers` already exists in the version directory, the function prunes superseded versions and returns `skipped: true`.
3. The asset is fetched through `options.fetch` (defaulting to `fetchAsset`, which applies a five-minute `AbortSignal.timeout` and reads a local path from disk). When `options.mirror` or `CLIO_CODER_TOOLCHAIN_MIRROR` is set, `mirroredSources` maps each pinned URL onto two mirror candidates built from its last path segment: the namespaced `<mirror>/<id>/<version>/<name>` first, then the legacy flat `<mirror>/<name>`. A directory or `file:` URL becomes a local path, an HTTP(S) base gets the path appended. `fetchVerified` tries the candidates in order and keeps the first whose SHA-256 equals `download.sha256`; a candidate that fails to download or hashes wrong is skipped, so a flat `LICENSE` that belongs to another tool cannot shadow or block the right copy. Without a mirror the pinned URL is the only candidate. When no candidate matches, a hash mismatch returns `checksum mismatch ... Nothing was written.` and a failed download returns `download failed: ...`.
4. Each document is fetched and hash-checked the same way, then `unpack` builds a member map from the archive.
5. Every `binaryMembers`, `documentMembers` and `runtimeMembers` path must exist in the archive, and runtime members must not be absolute or start with `..`.
6. Files are written into a staging directory named `.<version>.incomplete-<pid>-<t>` beside the target. With `force`, the existing version directory is first renamed to a `.replaced-` name, the staging directory is renamed to the target, and the retired copy is deleted only after that rename succeeds. On a thrown error the staging directory is removed and a retired copy is restored.
7. A concurrent installer that wins the rename is treated as success when `force` is false.
8. `prune` calls `pruneSupersededVersions(entry.id, entry.version, { root })` and the result is reported in the message.

The `NOTICE` file for entries with a `notice` field is written through `safeResourceWrite`, and every install writes `clio-coder-install.json` recording id, version, platform, license, homepage, URL, hash and timestamp.

Test coverage for this flow is in `tests/contracts/asciinema-toolchain.test.ts`. Its first case passes `fetch: async () => Buffer.from("corrupt")` to `installPinnedTool` for the real asciinema row on `linux-x64`, then asserts `bad.ok === false`, that the message matches `/checksum mismatch/`, and that `existsSync(join(root, entry.id, entry.version))` is false. Its second case fabricates a `raw` download whose hash is the SHA-256 of `"fixture program"`, and asserts that the result is ok, that `NOTICE` contents equal `${entry.notice}\n`, and that the NOTICE path is in `result.documents`. Both tests use an isolated root under a scratch directory. The mirror path is covered in `tests/contracts/mux-private-host.test.ts`, which asserts the namespaced-then-flat candidate order and installs two fabricated tools with different `LICENSE` bytes from one namespaced mirror, a legacy flat mirror, and a flat mirror whose `LICENSE` belongs to another tool (refused with `checksum mismatch`). No test in the search covers the `force` replacement path or the archive readers directly, so those are source-only evidence here.

## Resolution ladder

`resolveToolBinary(name)` maps a binary name to its registry row through `findPinnedToolByBinary`, falling back to `findPinnedTool` by id. A name with no row gets a plain PATH lookup with `source` of `path` or `none`. A known row goes to `resolveEntryBinary(entry, binary)`, which:

1. Probes the PATH copy through `probePathCandidate`. The primary binary is probed with `entry.versionArgs`; a secondary binary inherits the verdict from the primary's directory.
2. Returns `source: "path"` when `pathCandidate.satisfiesMinimum` is true.
3. Otherwise returns `source: "vendored"` when `vendoredBinaryPath` points to an existing file.
4. Otherwise returns `source: "none"`.

`satisfiesMinimum` is `compareVersions(found, minimum) >= 0`, and a null version never satisfies. The probe in `src/domains/toolchain/version.ts` runs `spawnSync` with a two-second timeout and `stdio: ["ignore", "pipe", "pipe"]`, and memoizes the result per absolute path in a module-level map. `resetVersionProbeCache` clears that map.

`toolStatus` reports `installed` as `resolution.vendoredPath !== null`, so `installed` refers to the vendored copy specifically, not the resolved binary. `describeResolution` renders one sentence for `tools status` and doctor rows. Its branches are: a PATH resolution, a vendored resolution (noting any rejected PATH copy), an unsupported platform, superseded vendored versions (suggesting `clio-coder tools install <id>`), a floor rejection with nothing vendored, and finally not found.

The consumers in the wider tree are `src/tools/executables.ts` (which returns `resolveToolBinary(name).binaryPath`), `src/domains/mux/yazi/session.ts` and `profile.ts`, `src/domains/mux/cliamp/session.ts`, `src/cli/workspace-launch.ts`, `src/cli/panes.ts` and the herdr row of `src/cli/doctor-toolchain.ts` (which use `resolveVendoredBinary("herdr")`, the vendored copy at the pinned version only and never a PATH copy, and the launcher calls `installTool("herdr", ...)` when it is missing), and `src/cli/doctor-toolchain.ts`. Several other callers, including `src/engine/acp/adapter.ts`, `src/domains/lifecycle/claude-sdk-install.ts` and `src/tools/run-script.ts`, use only `findExecutableOnPath`, which bypasses the registry and the floor check. Those callers are not covered on this page.

## Pruning and removal

`removeVersions` in `src/domains/toolchain/remove.ts` deletes every version directory except `keep`. `pruneSupersededVersions` passes a non-null `keep`, and `removeTool` passes `null`, which also attempts `rmdirSync` on the tool directory when no failures occurred. Only names not starting with `.` are considered versions, so staging and retired directories are not pruned as versions. `sweepStaleStaging` deletes directories matching `STAGING_NAME` (`^\.[^/]+\.(?:incomplete|replaced)-\d+-[a-z0-9]+$`) whose `mtimeMs` is older than `STALE_STAGING_MS` (one hour). The age is the only liveness signal used; the file comment explains that pids are not consulted.

`removeTool` returns `ok: false` with `unknown tool` for an id not in the registry. A tool with nothing installed is a successful no-op with the message `... is not installed ...; nothing to remove`.

## Archives and versions

`readZipEntries` locates the end-of-central-directory record, walks central directory entries, skips directory entries, rejects unsafe member names through `assertSafeMember`, enforces `MAX_TOTAL_UNCOMPRESSED_BYTES` (512 MiB) cumulatively, and inflates deflated members with `inflateRawSync`. Unsupported compression methods throw. `readTarGzEntries` gunzips and parses 512-byte ustar headers, handles GNU long names (`L`), skips PAX (`x`, `g`) and directory entries, and applies the same name and size checks. The installer surfaces any thrown error as `could not unpack the asset`.

`src/domains/toolchain/version.ts` extracts the first `\d+\.\d+\.\d+` triple from `--version` output, on both stdout and stderr.

## Registry contents and pinning rules

`PINNED_TOOLS` in `src/domains/toolchain/registry.ts` is the single table. The file header states that every checksum was computed from the downloaded asset, that a platform without a fetched asset is omitted rather than hashed from nothing, and that a `minimumVersion` moves only on evidence recorded in the adjacent comment. The current rows show these choices. For herdr, the pin is `0.9.5` and `minimumVersion` is `0.7.5`, lowered from the pin on the basis of schema checks recorded in the comment. That floor governs only guest mode (`--with-panes`) and `tools status`; Clio's own pane host always runs the vendored pin. For yazi, the floor stays at the pin, with a comment explaining the unexercised profile and DDS surfaces. The entry for cliamp lists `packageManagerInstallHints` on macOS and Go, which the operator runs by hand; Clio prints the hints and never runs them.

The registry-shape contract test is referenced in the header comment, which says it refuses an entry that carries a platform without a checksum. That test was not located, so the claim rests on the comment alone and should be treated as unverified here.

## Things to watch when editing

- Adding a platform to a row requires its hash to be computed from the actual asset. The header comment forbids unverified hashes, and the installer compares the hash before any write.
- A new archive member must appear in `binaryMembers`, `documentMembers` or `runtimeMembers`; the installer returns an error for any missing member and writes nothing.
- Lowering a `minimumVersion` changes which PATH copies are accepted, so the comment beside the number is part of the change.
- `installed` in `toolStatus` means vendored, not resolvable. Callers that need the resolved binary should read `resolution.binaryPath`.
- Binary names on Windows gain a `.exe` suffix in `executableName` and `vendoredBinaryPath`, keyed by the target platform in the installer and by `process.platform` in `src/domains/toolchain/paths.ts`.
- A version bump supersedes the previous directory on the next successful install, and the installer's already-installed branch also prunes, which repairs earlier machines.

## Related pages

The CLI verbs that drive installation and removal are documented on the [Cli](../cli.md) page. The mux presets that call `resolveToolBinary` are on the [Domains mux](mux.md) page. Doctor rows that render `describeResolution` are covered by the [Domains safety](safety.md) and [Tools verify](../tools/verify.md) pages only where those pages mention the toolchain; this page does not inspect them.

## Coverage notes

This page was written from the eight anchor files plus `src/domains/toolchain/paths.ts`, `src/cli/tools.ts`, the cited mux and tool callers, and `tests/contracts/asciinema-toolchain.test.ts`. The archive readers, the `force` replacement path, the stale-staging sweep and the floor-rejection branches of `describeResolution` were read in source but have no focused test located.
