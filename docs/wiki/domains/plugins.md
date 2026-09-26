---
title: "Domains plugins"
summary: "How plugins are discovered, verified against recorded digests, installed into user or project scopes, and projected as resource roots for skills, prompts, agents, and fleets."
sources:
  - "src/domains/plugins/index.ts"
  - "src/domains/plugins/state.ts"
  - "src/domains/plugins/discovery.ts"
  - "src/domains/plugins/discovery-pass.ts"
  - "src/domains/plugins/integrity.ts"
  - "src/domains/plugins/catalog.ts"
  - "src/domains/plugins/resources.ts"
  - "src/domains/plugins/types.ts"
tests:
  - "tests/contracts/plugin-engine.test.ts"
  - "tests/extended/library-lifecycle.test.ts"
invariants:
  - "Every plugin listing re-verifies each installed tree against its recorded content digest; drift marks the entry invalid and non-loadable."
  - "A cooperative `.mutation.lock` prevents concurrent writes to the same scope's state; a held lock throws `locked` immediately rather than blocking."
  - "A reviewed plan (`expect`) is rechecked inside the writer's lock; any fact that changed refuses with `stale_plan` before any write occurs."
  - "Project-scope plugins compete with user-scope plugins of the same id; valid, compatible project copies win and project-scope entries are marked effective."
  - "Disabling or removing a plugin refuses when it would break an enabled, effective dependent that is satisfied now."
validate:
  - "pnpm run test -- tests/contracts/plugin-engine.test.ts"
---

# Domains plugins

The plugins domain provides the complete lifecycle for portable extension packages:
discovery of a `plugin.json` manifest, structural and cryptographic verification,
scoped installation with crash-safe staging, integrity-bound content digests, a
reviewed-plan writer guard, dependency-aware enable/disable/remove, and a
generation-cached projection of loadable resources.

## What this area does

Plugins are self-contained packages that contribute skills, prompts, agents, or
fleets to a Clio session. A plugin is a directory containing a `plugin.json`
manifest at the root, optionally with resource directories and component
declarations. The domain manages:

1. **Discovery** — reading and validating a plugin tree into a `PluginCandidate`
   with an exact-tree SHA-256 content digest.
2. **Installation** — copying a verified source into a managed base directory
   (`~/.config/clio-coder/plugins` for user scope, `.clio-coder/plugins` for
   project scope) under a staged copy, atomic rename, and state.json write.
3. **Integrity** — every listing recomputes the tree digest and compares it to
   the recorded digest; drift invalidates the entry.
4. **Mutation guard** — a cooperative file lock and an optional reviewed plan
   (`PluginExpectedState`) that refuses to write if any reviewed fact changed.
5. **Resource projection** — building a frozen `PluginSnapshot` that maps
   loadable plugins to their resource roots, cached by generation number.

## Ownership and key symbols

| File | Role | Key symbols |
|------|------|-------------|
| `src/domains/plugins/index.ts` | Public module surface and re-exports | `PluginsDomainModule`, all public functions |
| `src/domains/plugins/types.ts` | All public types and interfaces | `PluginScope`, `PluginManifest`, `InstalledPlugin`, `PluginState`, `PluginSnapshot`, `PluginExpectedCopy` |
| `src/domains/plugins/discovery.ts` | Manifest parsing, component validation, path containment | `parsePluginManifest`, `readPluginManifest`, `discoverPluginPackages`, `pluginResourcePath`, `isPluginId` |
| `src/domains/plugins/discovery-pass.ts` | Synchronous discovery-pass memoization | `withPluginDiscoveryPass`, `passPluginCandidate`, `passPluginSnapshot`, `outsidePluginDiscoveryPass` |
| `src/domains/plugins/integrity.ts` | Re-exports the exact-tree digest from the extensions domain | `pluginContentDigest`, `pluginContentDigestWithCapture` |
| `src/domains/plugins/state.ts` | Install, update, enable, disable, remove, and locking | `installPlugin`, `updatePlugin`, `enablePlugin`, `disablePlugin`, `removePlugin`, `withPluginScopeLock`, `PluginWriterRefusal`, `resolvePluginPrecedence`, `newlyBrokenDependents` |
| `src/domains/plugins/resources.ts` | Snapshot building, caching, and resource-root projection | `buildPluginSnapshot`, `pluginSnapshotFor`, `reloadPluginResources`, `enabledPluginResourceRoots`, `committedPluginResourceRoots` |
| `src/domains/plugins/catalog.ts` | GitHub-sourced plugin fetching and bundled library index | `fetchPluginSource`, `parsePluginGithubSource`, `readPluginCatalog`, `bundledPluginCatalog` |
| `src/domains/plugins/extension.ts` | Domain bundle lifecycle (snapshot cleanup on stop) | `createPluginsBundle` |
| `src/domains/plugins/manifest.ts` | Domain manifest (`dependsOn: ["config"]`) | `PluginsManifest` |

## Discovery and manifest validation

Discovery starts with `discoverPluginPackages(root)` in `src/domains/plugins/discovery.ts`.
If the root itself contains a `plugin.json`, it is read directly; otherwise each
subdirectory is treated as a separate package root. The central function is
`readPluginManifest(root)`, which:

1. Computes the exact-tree digest via `pluginContentDigestWithCapture`,
   capturing the `plugin.json` bytes for parsing.
2. Parses the manifest with `parsePluginManifest(bytes, root)`.
3. Returns a `PluginCandidate` with `valid`, `contentDigest`, `manifestDigest`,
   and `diagnostics`.

`parsePluginManifest` enforces:
- The `$schema` must equal `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`.
- The `name` must be a portable plugin id (`isPluginId`: 1–64 chars, lowercase
  alphanumeric with dashes/dots, no `..`, not `state.json`).
- A `version` must be present and a valid Semantic Version.
- The `extensions["ai.iowarp.clio"]` block is parsed by `clioConfiguration`,
  which validates `manifestVersion: 1`, resource kinds (`skills`, `prompts`,
  `agents`, `fleets`), component kind/id/path, dependency references, and
  compatibility ranges.
- Component dependency cycles are detected with a visiting-set DFS.
- For non-plugin kinds (`skill`, `agent`, `prompt`, `fleet`), the manifest must
  declare exactly one public component of that kind and only the matching
  resource root.

The integrity digest comes from `src/domains/extensions/integrity.ts` (re-exported
through `src/domains/plugins/integrity.ts`). It hashes the entire tree in
stable relative-path order, binding file names, node kinds, symlink targets,
directory structure, and file bytes into a single SHA-256. Symlinks must resolve
within the package root. Hard-linked files are rejected.

## Installation state machine

Installation is implemented by `installPlugin(sourcePath, options)` in
`src/domains/plugins/state.ts`. The flow:

1. **Pre-mutation validation** (outside the lock):
   - Resolve the source path, read the manifest, compute the digest.
   - Check Clio compatibility (`evaluateClioCompatibility`).
   - Compare `options.expectedKind`, `expectedDigest`, `expectedId`,
     `expectedVersion` against the source; any mismatch returns a diagnostic.
   - Refuse if the source path overlaps the managed destination
     (`pluginPathContained` in both directions).

2. **Mutation under lock** (`withMutation` → `withPluginScopeLock`):
   - Acquire the cooperative `.mutation.lock` file. If it exists, throw
     `PluginWriterRefusal("locked", …)`.
   - Read the current `PluginState` and its raw bytes.
   - Assert the reviewed plan (`options.expect`) via `assertExpectedState`,
     which re-checks every reviewed copy fact through `observePluginCopy`.
   - Refuse replacement of an interop (foreign-origin) package.
   - Refuse kind change during replacement.
   - If the target exists without `force`, refuse.
   - **Staging**: copy source to a unique sibling (`.name.install-<pid>-<hex>`).
   - **Verification**: re-read the staged manifest and recompute its digest;
     both must match the source digest. Also re-check that the source itself
     has not changed.
   - **Publication**: rename the existing target to a backup sibling, then
     rename staging to the target. Verify the published tree digest matches.
   - **State write**: record the install in `state.json` with digest, origin,
     kind, trust, and timestamp. Write atomically via `safeResourceWrite`
     with a `beforeRename` check that the state file has not changed.
   - **Rollback on failure**: if anything fails after staging, remove the
     staging copy. If the target was moved and the new target is not the same
     content, preserve the backup as a recovery copy and return a diagnostic.
   - **Recovery cleanup**: after success, if the backup was the same content
     as before, remove it; otherwise preserve it and report it in
     `result.recovery.packageBackup`.

3. **Post-mutation listing**: call `listInstalledPlugins` and return the
   updated `InstalledPlugin` entry.

### Locking

`acquireScopeLock` opens `.mutation.lock` with `O_CREAT | O_EXCL`. The lock is
non-blocking: a held lock throws immediately with `PluginWriterRefusal("locked")`.
The release function closes the fd and removes the lock file. `withPluginScopeLock`
is the exported wrapper; `withMutation` catches all errors and returns them as
diagnostics.

### State format

`state.json` is a JSON object with `version: 1`, a `disabled` array of plugin
ids, and an `installed` map of id → `PluginInstallRecord`. The record contains
`installedAt` (ISO string), `source`, `contentDigest` (64-hex SHA-256), and
optionally `origin`, `trust`, and `kind`.

`readState` validates every field: plugin ids must pass `isPluginId`, the digest
must be 64 lowercase hex characters, and origins are validated by `validOrigin`
which checks kind, source format, and (for foreign formats) the host and
marketplace fields.

## Integrity check

The content digest is the cornerstone of the integrity model. `pluginContentDigest`
is a re-export of `extensionContentDigest` from `src/domains/extensions/integrity.ts`.
It walks the entire plugin tree:

- Directories are hashed in sorted entry order, with each entry's relative path
  and kind recorded in a header frame.
- Files are hashed by their exact bytes.
- Symlinks are hashed by their target string, and must resolve within the
  package root.
- Hard links (nlink > 1) are rejected.
- Every file and directory is verified to have unchanged stat fields before
  and after reading.

Because the digest covers the full tree, any modification—file content, file
name, symlink target, or directory structure—changes the digest.

The integrity check is performed in two places:
1. **During installation**: the staged copy is re-digested and compared to the
   source digest.
2. **During listing** (`scopeEntries` in `state.ts`): each installed plugin
   directory is re-digested via `passPluginCandidate` and compared to the
   recorded digest. Drift produces an error diagnostic and marks the entry
   `valid: false` and `loadable: false`.

The discovery pass (`withPluginDiscoveryPass` in `discovery-pass.ts`) memoizes
digest computations within a single synchronous pass. This prevents redundant
tree walks when multiple plugins are listed in sequence. The memo lives only
while the pass body runs; the next pass, every reload, and every install or
removal verify from disk again.

## Precedence and effective/loadable semantics

`resolvePluginPrecedence` in `state.ts` implements a single rule: valid,
compatible copies compete, and the project scope wins. After precedence is
resolved:

- `entry.effective` is true only for the winning copy of each id.
- `entry.loadable` is true when the entry is valid, compatible, enabled, and
  effective.
- `entry.overriddenBy` is set to the winner's scope for non-effective copies.

`listInstalledPlugins` aggregates both scopes, resolves precedence, and by
default filters to effective or invalid/incompatible entries. The `all: true`
option returns every entry.

## Mutation guard and reviewed plans

The mutation guard prevents two classes of race:

1. **Concurrent mutations**: the `.mutation.lock` file ensures only one writer
   per scope at a time.
2. **Stale plans**: a caller that reviewed the current state (e.g., a GUI
   showing the user a diff) can pass `options.expect` (a `PluginExpectedState`)
   to the mutation. Inside the lock, `assertExpectedState` re-checks every
   reviewed fact via `observePluginCopy`. If any fact changed, it throws
   `PluginWriterRefusal("stale_plan", …)` with the specific expected vs
   observed values.

`observePluginCopy` reads the install record, computes the current tree digest,
and assembles the `PluginExpectedCopy` including enabled status, recorded digest,
kind, trust, and origin.

The comparison is JSON-stringified for each fact key. In full-snapshot mode
(`partial: false`), the union of expected and observed keys is compared, so a
fact that appears or disappears also triggers a stale-plan refusal.

## Dependency management

`newlyBrokenDependents` in `state.ts` projects the effective set after a
disable or removal and reports which enabled, effective dependents would lose
satisfaction. It compares the "before" and "after" precedence-resolved sets and
identifies requirements that were met before but would not be met after.

`refuseBrokenDependents` calls this and throws
`PluginWriterRefusal("dependents", …)` if any newly broken dependents exist.
This is invoked by `setEnabled` (disable path) and `removePlugin`.

Pre-existing breakage (dependents that were already unsatisfied before the
mutation) is listed but never refuses.

## Resource projection

`buildPluginSnapshot(cwd)` in `resources.ts` creates a frozen `PluginSnapshot`:

1. Calls `listInstalledPlugins(cwd, { all: true })` to get all entries.
2. For each loadable entry with provenance, resolves its resource paths via
   `pluginResourcePath` and pushes `PluginResourceRoot` entries.
3. Computes a SHA-256 digest of the identity array (id, scope, rootPath,
   enabled, loadable, contentDigest) for change detection.
4. Freezes the entire snapshot object tree.

The snapshot is cached in a module-level `Map` keyed by the canonical cwd and
config dir. `pluginSnapshotFor(cwd)` returns the cached snapshot or builds one
through `passPluginSnapshot` (which memoizes within a discovery pass).
`reloadPluginResources(cwd)` builds a fresh snapshot under
`outsidePluginDiscoveryPass` (bypassing the pass memo) and replaces the cache
entry. `reloadPluginResourcesAndNotify` in `src/entry/plugin-reload.ts` wraps
this and emits a `PluginsReloadedPayload` event.

`enabledPluginResourceRoots(kind, cwd)` returns the resource roots from the
snapshot, filtered to only those whose plugins are still loadable according to
a fresh `listInstalledPlugins`. This means revocation and content drift take
effect on the next read, even before a planned session reload.

`committedPluginResourceRoots(kind, cwd)` returns the snapshot roots without
re-verifying; it is for display only (e.g., naming prompt templates in a
completion menu).

## GitHub-sourced plugins and the bundled catalog

`fetchPluginSource(source, cwd)` in `catalog.ts` resolves a plugin source to a
local directory:

- Local paths are resolved directly (with `~/` expansion).
- GitHub tree URLs are parsed by `parsePluginGithubSource`, which extracts the
  owner, repo, ref, and optional subdir. The URL must match
  `https://github.com/owner/repo/tree/ref/path`.
- For GitHub sources, it performs a `git clone --depth 1 --branch <ref>` into a
  temp directory, using `buildSafeToolEnv` to prevent credential prompts and
  system config interference. The `.git` metadata is removed for root-level
  packages. The subdir is validated to not escape the repo.

`readPluginCatalog(file, diagnostics)` parses a YAML library index. Each entry
requires `kind`, `name`, `description`, `sourceUrl`, `version` (SemVer), and
`sha256` (64-hex). Optional fields include `requires`, `provides` (bounded hint
list), `category`, `audit`, and `triggers`. Remote sourceUrls must be parseable
as GitHub tree URLs. The bundled index ships inside the Clio-Coder package at
`library/registry.yaml`.

## Extension seams

- **New resource kinds**: add to `PLUGIN_RESOURCE_KINDS` in `discovery.ts`,
  add to the `PluginResourceKind` type in `types.ts`, add to the
  `resourceRoots` initialization in `buildPluginSnapshot` in `resources.ts`,
  and add to the `componentRoots` map in `clioConfiguration` in `discovery.ts`.
- **New component kinds**: add to `COMPONENT_KINDS` in `discovery.ts` and to
  the `PluginComponentKind` type.
- **New library kinds**: add to the `isLibraryKind` check in
  `src/domains/resources/library-types.ts` and to the `clioConfiguration`
  validation.
- **New diagnostic codes**: add to the `PluginDiagnosticCode` type in
  `types.ts` and handle it in `PluginWriterRefusal` usage sites.
- **Foreign package formats**: add to `FOREIGN_FORMATS` in `state.ts` and to
  the `ForeignPackageFormat` type in `types.ts`.

## Named focused tests

`tests/contracts/plugin-engine.test.ts` demonstrates:
- Loading a portable skills-only package and verifying the content digest
  matches `extensionContentDigest`.
- Rejecting missing, duplicate, and cyclic component references.
- Refusing the retired `themes` resource kind.
- Installing into the project scope and verifying the resource root path.
- The `installPlugin` → `listInstalledPlugins` → `enabledPluginResourceRoots`
  flow with actual assertions on `loadable`, `source`, and `rootPath`.

`tests/extended/library-lifecycle.test.ts` demonstrates:
- The full lifecycle including catalog-driven imports, interop adoption,
  dependency-aware disable, and recovery copies.
- Use of `withPluginScopeLock` and `planLibraryLifecycle`.

## Things to watch when editing

- **The discovery pass must stay synchronous**: `withPluginDiscoveryPass`
  memoizes only within the synchronous body. An `await` inside the body causes
  the memo to expire, defeating its purpose. Do not add async work inside a
  pass without moving it outside.
- **The lock is non-blocking**: `acquireScopeLock` uses `O_CREAT | O_EXCL`.
  A held lock throws immediately. Do not add retry logic; the caller must
  handle the `locked` refusal.
- **The `evals` key is retired**: the `clioConfiguration` parser still accepts
  `evals` in the allowed-keys set for a compatibility window, but the value is
  ignored. Removing it from the allowed set will break installed plugins that
  still declare it.
- **`safeResourceWrite` with `beforeRename`**: the state write uses a
  `beforeRename` callback to re-check that the state file has not changed
  since the read. Do not remove this guard; it prevents the write from
  clobbering concurrent edits.
- **Symlink safety**: `pluginResourcePath` and `extensionContentDigest` both
  canonicalize through `realpathSync` and verify containment. Do not bypass
  the canonical check when adding new path resolution.
- **The `state.json` file is reserved**: a plugin package cannot contain a
  `state.json` at its root; `readPluginManifest` throws if it does.
- **Recovery copies**: when installation fails after the target was moved, the
  backup is preserved as a recovery copy. The caller must check
  `result.recovery.packageBackup` and clean it up or present it to the user.
- **`committedPluginResourceRoots` is display-only**: it does not re-verify.
  Do not use it for anything that executes resources; use
  `enabledPluginResourceRoots` instead.
- **The catalog's `provides` hints are advisory**: a malformed hint list is
  dropped with a diagnostic and the row stays valid. Hints support discovery,
  never admission.
- **Foreign origin packages cannot be updated in place**: `updatePlugin` and
  `installPlugin` both refuse to replace an interop package. The user must
  remove it first and re-adopt it through a new reviewed adoption.
