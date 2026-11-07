---
title: "Plugin packages, install state, and resource snapshots"
summary: "How Clio discovers, verifies, installs, and loads plugin packages: manifest parsing, the per-scope install writer and its lock, precedence between user and project copies, and the committed resource snapshot. Read this before changing plugin lifecycle or resource loading."
sources:
  - "src/domains/plugins/index.ts"
  - "src/domains/plugins/types.ts"
  - "src/domains/plugins/discovery.ts"
  - "src/domains/plugins/state.ts"
  - "src/domains/plugins/resources.ts"
  - "src/domains/plugins/discovery-pass.ts"
  - "src/domains/plugins/catalog.ts"
  - "src/domains/plugins/older-clio.ts"
symbols:
  - "PluginsDomainModule"
  - "parsePluginManifest"
  - "readPluginManifest"
  - "installPlugin"
  - "installLibraryPackage"
  - "withPluginScopeLock"
  - "resolvePluginPrecedence"
  - "listInstalledPlugins"
  - "reloadPluginResources"
  - "enabledPluginResourceRoots"
  - "withPluginDiscoveryPass"
tests:
  - "tests/contracts/plugin-walks-per-operation.test.ts"
invariants:
  - "A plugin manifest must declare the exact $schema, a portable name that is not state.json, and an explicit Semantic Version; parsePluginManifest rejects anything else before any install."
  - "Resource and component paths must be relative and must resolve inside the installed root, including through symbolic links; pluginResourcePath throws otherwise."
  - "A mutation takes the scope's non-blocking .mutation.lock; a held lock returns a locked refusal immediately rather than waiting."
  - "A reviewed plan is rechecked inside the lock; any reviewed copy fact that differs from the observed one refuses the write with stale_plan before state.json changes."
  - "Among valid, compatible, untrust-blocked copies with the same id and namespace, a project copy wins over a user copy; an unapproved project copy neither loads nor shadows the user copy."
  - "Interop-origin packages cannot be replaced by a plain install; the install path refuses them with a message to adopt again."
  - "Outside a discovery pass, each plugin listing re-verifies installed trees; inside withPluginDiscoveryPass, repeated listings in one synchronous body reuse the first verdict."
validate:
  - "pnpm run test:file -- tests/contracts/plugin-walks-per-operation.test.ts"
  - "pnpm run typecheck"
---

# Plugin packages, install state, and resource snapshots

This area owns the plugin package model: how a directory with a `plugin.json` is parsed into a manifest, how an installed copy is recorded in a per-scope `state.json`, how user and project copies are ranked, and how the enabled resources (skills, prompts, agents, playbooks) are exposed to the rest of the runtime. Read this page when you change plugin installation, removal, enablement, precedence, or the resource roots that skill and prompt loading consume. Library-package kinds and the extension-bundle loader are adjacent; see [Domains extensions](extensions.md) and [Domains resources](resources.md) for those owners.

## What the area does

- Parses and validates a `plugin.json` (`parsePluginManifest`) and reports a candidate with diagnostics (`readPluginManifest`).
- Installs, updates, enables, disables, and removes packages in one of two scopes, `user` (under the Clio config directory) or `project` (under `.clio-coder/plugins` in the project root), through a writer that holds a per-scope lock and rechecks reviewed facts before writing (`src/domains/plugins/state.ts`).
- Decides which copy of an id is effective (`resolvePluginPrecedence`).
- Commits a snapshot of enabled resource roots per working directory and re-verifies them on read (`src/domains/plugins/resources.ts`).

## Ownership

| Concern | Symbols | File |
| --- | --- | --- |
| Domain registration | `PluginsDomainModule` (manifest and `createPluginsBundle` extension) | `src/domains/plugins/index.ts` |
| Public types | `PluginScope`, `PluginResourceKind`, `ClioPluginConfiguration`, `PluginManifest`, `PluginCandidate`, `InstalledPlugin`, `PluginExpectedState`, `PluginSnapshot`, `PluginState` | `src/domains/plugins/types.ts` |
| Manifest parsing and path containment | `PLUGIN_SCHEMA`, `PLUGIN_EXTENSION_KEY` (`ai.iowarp.clio`), `parsePluginManifest`, `readPluginManifest`, `pluginResourcePath`, `isPluginId` | `src/domains/plugins/discovery.ts` |
| Install state, writer lock, install/update/enable/remove, listing, precedence | `installPlugin`, `installLibraryPackage`, `updatePlugin`, `enablePlugin`, `disablePlugin`, `removePlugin`, `listInstalledPlugins`, `withPluginScopeLock`, `observePluginCopy`, `resolvePluginPrecedence`, `newlyBrokenDependents` | `src/domains/plugins/state.ts` |
| Resource snapshot and enabled roots | `reloadPluginResources`, `pluginSnapshotFor`, `committedPluginSnapshot`, `enabledPluginResourceRoots`, `enabledPluginResourceRootsFor`, `committedPluginResourceRoots`, `buildPluginSnapshot` | `src/domains/plugins/resources.ts` |
| Discovery memo | `withPluginDiscoveryPass`, `outsidePluginDiscoveryPass`, `passPluginCandidate`, `passPluginSnapshot` | `src/domains/plugins/discovery-pass.ts` |
| Remote and local source fetching for catalogs | `parsePluginGithubSource`, `pluginLocalPath`, `fetchPluginSource`, `readPluginCatalog`, `bundledPluginCatalog` | `src/domains/plugins/catalog.ts` |
| Retired `fleets` layout refusal | `olderClioDeclaration`, `olderClioMessage` | `src/domains/plugins/older-clio.ts` |

`src/domains/plugins/index.ts` re-exports these symbols. It also exports `pluginContentDigest` and `pluginContentDigestWithCapture` from `integrity.ts` and `pluginPromptNames` from `src/domains/plugins/prompt-names.ts`; those two modules were not inspected for this page.

## Manifest parsing

`parsePluginManifest(raw, root)` parses the JSON and enforces, in order: an object root with only the allowed root keys (`ROOT_KEYS`), the exact `$schema` value, a `name` that passes `isPluginId` (1 to 64 characters, lowercase letters, digits, `.` and `-`, no `--` or `..`, and not `state.json`), string-typed optional metadata, and a `version` that `isSemanticVersion` accepts. Any `extensions["ai.iowarp.clio"]` block that matches the retired fleets layout is refused with the text from `olderClioMessage` before the Clio block is read.

The Clio block is validated by `clioConfiguration`. It requires `manifestVersion: 1` when the block is present, a `kind` that is a library kind other than `extension` (default `plugin`), and a `compatibility.clio` range that `evaluateClioCompatibility` marks as valid. Resource directories are restricted to `skills`, `prompts`, `agents`, and `playbooks`. A `skills/` directory at the root is added automatically when present. Components are checked by `components()`: each has a known kind, a stable id, a relative path that must be a file, a `SKILL.md` basename for skill components, and a `requires` graph that must be acyclic and resolve within the package.

For a non-`plugin` kind, `clioConfiguration` requires exactly one public component of that kind, allows only the matching `<kind>s` resource root, and scans that root so that it exposes only the declared file. A package that exposes an undeclared `.md` (or `SKILL.md` for skills) file is refused.

`readPluginManifest(root)` hashes the tree with `pluginContentDigestWithCapture`, capturing the exact `plugin.json` bytes, and parses those bytes. It also refuses a root that contains `state.json`. When `mcp.json` is present it adds a warning that MCP servers become plugin-scope declarations only after the operator trusts them with `clio-coder mcp trust <id>`. Failures are returned as `valid: false` candidates with an `error` diagnostic rather than thrown.

## Install and lifecycle

`installPlugin(sourcePath, options)` in `src/domains/plugins/state.ts` is the single publication path. The sequence, as read from the source, is:

1. `readPluginManifest(source)` runs first. An invalid candidate returns its diagnostics and performs no write.
2. The compatibility range is evaluated; an unsatisfied range returns an error.
3. The optional `expectedKind`, `expectedDigest`, `expectedId`, and `expectedVersion` pins are compared against the source. A mismatch returns "does not match the pinned digest, identity, or version".
4. The source may not overlap the managed base, and the target may not contain the source.
5. The mutation runs inside `withMutation`, which calls `withPluginScopeLock`. Inside the lock, `readState` loads the current `state.json` bytes and `assertExpectedState(options.expect, cwd)` rechecks any reviewed copy facts.
6. The install refuses interop-origin copies (`isForeignPluginOrigin`), refuses a kind change on replacement, refuses an existing target unless `force` is set, and refuses a symbolic-link target.
7. The source is copied to a unique staging sibling with `cpSync`, re-read and re-digested, and only then published. A previous copy is moved to a backup sibling and preserved when its digest differs from the recorded one; `sweepRecoveryCopies` keeps the newest three such preserved copies per package.

`withMutation` converts a thrown `PluginWriterRefusal` into a diagnostic carrying `code` (`stale_plan`, `locked`, or `dependents`) and, for `stale_plan`, the changed fact. Other thrown errors become diagnostics without a code. Callers therefore receive a result object rather than an exception from the mutation API.

`installLibraryPackage(input)` is the kind-aware seam used by library and interop adapters. It forwards to `installPlugin` with `expectedKind` set to the input kind, so the kind check in step 3 applies.

`withPluginScopeLock` is non-blocking. `acquireScopeLock` creates `.mutation.lock` with `wx`; an existing lock raises `PluginWriterRefusal("locked")` at once. Its doc comment states that a composer that reviewed peer-scope facts may hold the peer lock and let the writer take its own, and that the same scope must not be nested. The focused test for this lock was not located in the search performed for this page.

Precedence is applied by `resolvePluginPrecedence(entries)`. Peers compete only when they share an id and a namespace (`packageNamespace`: `extension` for standalone extensions, `plugin` for every other kind). A peer is a candidate when it is valid, compatible, and not `trustBlocked`. The project copy sorts last and therefore wins. `loadable` is set only for the effective entry that is also enabled and valid and compatible.

`listInstalledPlugins(cwd, options)` reads both scopes (or the one named in `options.scope`), applies `blockUntrustedProjectPlugins`, then `resolvePluginPrecedence`, and returns entries sorted by id and scope. Without `all`, it keeps only effective entries plus entries that are trust-blocked, invalid, or incompatible.

## Resource snapshot

`reloadPluginResources(cwd)` builds a new `PluginSnapshot` with a fresh generation number inside `outsidePluginDiscoveryPass`, so a reload always verifies from disk even when called inside a discovery pass, then replaces the committed entry for the working directory. The snapshot key combines the resolved Clio config directory and the realpath of `cwd` (`keyFor`).

`buildPluginSnapshot` lists packages with `listInstalledPlugins(cwd, { all: true })`. For each package that is `loadable` and has `provenance`, it creates one `PluginResourceRoot` per declared resource kind, with a resolved `path` produced by `pluginResourcePath`. The snapshot object is deep-frozen by `freeze`.

`enabledPluginResourceRoots(kind, cwd)` is the execution-facing accessor. For generation 0 (boot, before any reload) it returns the snapshot roots directly. For later generations it filters the roots through `stillVerified`, which keeps a root only when a fresh `listInstalledPlugins` result still shows an enabled, loadable copy with the same canonical root, manifest digest, and content digest. `committedPluginResourceRoots` is explicitly display-only: its doc comment says it does not re-verify trees, and execution must use `enabledPluginResourceRoots`.

`enabledPluginResourceRootsFor(kind, ids, cwd)` applies the same check to a subset of ids, listing each id separately.

## Discovery pass memo

`withPluginDiscoveryPass(body)` sets a module-level `active` memo for the duration of a synchronous `body`, and clears it in `finally`. Inside a pass, `passPluginCandidate` memoizes `readPluginManifest` results by resolved path, and `passPluginSnapshot` memoizes `buildPluginSnapshot` results by key. Outside a pass both functions call through without caching. `outsidePluginDiscoveryPass` suspends the memo; `reloadPluginResources` uses it so reloads are not served from a pass. The module comment states that an awaited continuation runs after the pass has closed.

## Callers and dependencies

- Upstream: `src/domains/plugins/index.ts` is the domain's public export surface. `PluginsDomainModule` binds `PluginsManifest` from `manifest.js` and `createPluginsBundle` from `extension.js`; neither file was inspected for this page. The resource accessors are consumed by skill and prompt loading. `tests/contracts/plugin-walks-per-operation.test.ts` imports `reloadPluginResources`, `listInstalledPlugins`, and `installPlugin` from `src/domains/plugins/index.ts`, and exercises `createResourcesLoader` from `src/domains/resources/loader.ts`. Other consumers were not traced in source for this page.
- Downstream: `src/domains/plugins/state.ts` imports `clioConfigDir` and `clioProjectRoot` from core configuration helpers, `evaluateClioCompatibility` and `isSemanticVersion` from `src/domains/extensions/compatibility.ts`, `pluginContentDigest` from `integrity.ts`, `safeResourceWrite` for the atomic state write, and the library kind helpers. `src/domains/plugins/discovery.ts` imports `evaluateClioCompatibility` and `isLibraryKind` and the integrity capture function. `src/domains/plugins/catalog.ts` uses `runStagingCommandSync` to run a bounded `git clone --depth 1` for GitHub tree sources.

## Focused test

`tests/contracts/plugin-walks-per-operation.test.ts` pins how many times a listing re-verifies installed trees. Its fixture installs six project-scope plugins (`PLUGINS = 6`), each with a skill, four reference files, and a prompt template, using `installPlugin` with `{ cwd, scope: "project" }`. The first test's `counted` helper measures `fstatSync` minus `openSync` calls and asserts that a single `listInstalledPlugins(cwd, { all: true })` walk costs at least `PLUGINS * 6`. It then asserts per-operation ceilings, such as `completing a slash command` at zero and `reading the library inventory` at one. The second test installs one plugin, expands `/walk-kit-0-run`, rewrites that prompt file on disk, and asserts that completion still lists the template from the committed snapshot while `expandPromptTemplate` refuses to expand the drifted file. This second case is the observable form of the rule that display uses committed roots and execution re-verifies.

No focused test was located for the install writer's `stale_plan` refusal, the `locked` refusal, the interop-origin refusal, or `resolvePluginPrecedence`; the search was a repository-wide grep for the discovery, resource, and install symbols across `tests/`. Those branches are described here from source only.

## Things to watch when editing

- Any new plugin lifecycle write must go through `withMutation` or an equivalent path that holds `withPluginScopeLock` and calls `assertExpectedState` inside the lock. `installPlugin` shows the ordering: the reviewed facts are rechecked after the lock is taken and before any write.
- `observePluginCopy` and `assertExpectedState` compare the full union of fact keys unless `partial` is set. Adding a new `PluginExpectedCopy` field requires that `observePluginCopy` also set it, or every plan that does not carry the fact will read as changed.
- Execution code must read through `enabledPluginResourceRoots` or `enabledPluginResourceRootsFor`, not `committedPluginResourceRoots`, which skips re-verification.
- A new resource kind requires changes in `PLUGIN_RESOURCE_KINDS`, the `resources` type in `src/domains/plugins/types.ts`, and the per-kind array in `buildPluginSnapshot`. The manifest validator and `resourceRoots` both key on this list.
- `pluginResourcePath` is the only containment check for declared paths; resolve every manifest path through it rather than joining paths directly.
- Discovery memoization is only safe for synchronous bodies. Do not await inside `withPluginDiscoveryPass`.
- Retired manifest shapes are refused on purpose. The `evals` key is accepted and ignored in `clioConfiguration`; `fleets` and `fleet:` references are refused with the `src/domains/plugins/older-clio.ts` message.

Related pages: [Domains extensions](extensions.md), [Domains resources](resources.md), [Domains safety](safety.md), [Domains extensions](extensions.md).
