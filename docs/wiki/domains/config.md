---
title: "Config Domain"
summary: "The config domain owns the single strict startup settings snapshot, watches settings files for changes, classifies each changed leaf into a hot-reload / next-turn / restart-required bucket, and dispatches bus events so other domains can observe the new value without importing the config internals."
sources:
  - "src/domains/config/index.ts"
  - "src/domains/config/extension.ts"
  - "src/domains/config/contract.ts"
  - "src/domains/config/classify.ts"
  - "src/domains/config/keybindings.ts"
  - "src/domains/config/watcher.ts"
  - "src/domains/config/agent-namespace.ts"
  - "src/core/settings-layers.ts"
symbols:
  - "ConfigDomainModule"
  - "createConfigDomainModule"
  - "createConfigBundle"
  - "ConfigContract"
  - "diffSettings"
  - "settingsChangeKind"
  - "CLIO_APP_KEYBINDINGS"
  - "CLIO_KEYBINDINGS"
  - "startConfigWatcher"
  - "assertAgentIdNamespace"
tests:
  - "tests/extended/config-mutation-admission.test.ts"
  - "tests/contracts/configuration-reference.test.ts"
invariants:
  - "A held watcher fire (reloadsHeld) marks a reload pending but never reads settings until releaseReloads() is called, so a settings write that arrives during the boot phase is admitted by the agents namespace before it is applied."
  - "Every settings reload is validated against the agents id namespace; a rejected reload leaves the previous good snapshot untouched and publishes a formatted one-line failure notice."
  - "The classify function is exhaustive: a changed path that matches no known bucket is classified as restartRequired, not silently dropped."
validate:
  - "pnpm run test:file -- tests/extended/config-mutation-admission.test.ts"
---

# Config Domain

The config domain is the process-local owner of Clio's effective settings. It loads one strict snapshot at startup, watches the operator's user settings file and the workspace project settings for external changes, classifies every changed leaf into one of three effect buckets, and publishes those buckets on the event bus so that other domains can act without importing the config internals.

The domain exposes two module entry points in `src/domains/config/index.ts`. The plain `ConfigDomainModule` (line 5) is a static `DomainModule` used by CLI subcommands and headless entry points that do not need the strict startup snapshot. `createConfigDomainModule` (line 11) wraps the same bundle but injects a pre-read strict snapshot and an optional `holdReloads` flag. The orchestrator in `src/entry/orchestrator.ts:1327` chooses between the two:

```ts
options.startupSettings
  ? createConfigDomainModule(options.startupSettings, { holdReloads: bootPhaseBoundary !== undefined })
  : ConfigDomainModule,
```

## What the domain owns

The primary implementation is `createConfigBundle` in `src/domains/config/extension.ts:32`. It returns a `DomainBundle<ConfigContract>` containing:

- **`extension`**: the lifecycle hooks `start()` and `stop()`. `start()` (line 121) either copies the injected `initialSettings` snapshot or calls `readStrictLayeredSettings(process.cwd())`. It then calls `setGitCommitAttributionEnabled` with the `integrations.git.commitAttribution` value (line 124) and attaches the watcher via `startConfigWatcher` (line 125). `stop()` (line 127) closes the watcher.
- **`contract`**: the query-only surface exposed to other domains via `getContract<ConfigContract>("config")`.

The external surface is defined by `ConfigContract` in `src/domains/config/contract.ts:8`:

| Method | Purpose |
|--------|---------|
| `get()` | Returns the current `Readonly<ClioSettings>` snapshot. Throws if the domain has not started. |
| `update?(mutate)` | Cross-process-safe read-modify-write of the user settings layer. Validates, writes, refreshes the snapshot, and dispatches change events. |
| `updateProject?(mutate)` | Writes to the trusted private project-local settings layer. Same validation and dispatch flow. |
| `onChange(kind, listener)` | Subscribes a listener for one `ChangeKind` bucket. Returns an unsubscribe function. |
| `releaseReloads?()` | Releases the boot-time hold on watcher reloads and runs the one pending reload. |

## The strict startup snapshot

`readStrictLayeredSettings` in `src/core/settings-layers.ts:320` reads the four-layer settings stack (built-in defaults, user `settings.yaml`, project `.clio-coder/settings.yaml`, project `.clio-coder/settings.local.yaml`) and applies the strict user-settings gate. Unlike `readLayeredSettings`, which never throws and returns validation issues in a list, `readStrictLayeredSettings` throws a `SettingsValidationError` if the user-layer file contains any validation issue. This is the "strict launch gate" that the config domain relies on for its one immutable startup snapshot.

When `createConfigBundle` receives an `initialSettings` argument, it deep-clones it into the local `snapshot` variable and skips the file read entirely. This is the mechanism by which the interactive entry point passes a pre-read snapshot to the orchestrator: the interactive layer has already validated the user file strictly (via `src/cli/clio.ts`), and the orchestrator binds that snapshot so that the config domain never re-reads it.

## The watcher

`startConfigWatcher` in `src/domains/config/watcher.ts:11` watches three filesystem locations:

1. **User settings directory**: `watch(dirname(settingsPath()))` watches the config directory rather than the file itself. The comment explains that settings writes go through temp-file + rename, which replaces the inode; watching the directory catches the rename. A name filter (`filename !== settingsFile`) keeps `.lock` and `.tmp-*` churn from other Clio processes out of the reload path.
2. **Project settings directory**: `attachProjectWatcher()` watches `.clio-coder/` for changes to `settings.yaml` or `settings.local.yaml`. If the directory does not exist at startup, it falls back to watching the workspace root for the directory's creation.
3. **Workspace root fallback**: If the project directory does not yet exist, a watcher on the workspace root watches for the `.clio-coder` directory being created and retries `attachProjectWatcher()`.

All three watchers share an 80 ms debounce timer (`schedule()`). When the debounce fires, the callback `onWatcherFire` in `extension.ts:87` is invoked with `{ at: Date.now() }`.

## Classify: the three effect buckets

`classify.ts` partitions changed settings paths into three buckets that determine how urgently a change takes effect. The three `Set<string>` constants are:

- **`HOT_RELOAD_FIELDS`** (line 21): paths that a live reader can observe immediately without rebuilding runtime state. Examples: `interface.keybindings`, `safety.autonomy`, `chat.modelPicker`, `interface.outputDetail`, `interface.demo`, `interface.smoothStreaming`, `interface.panes.notifications`, `integrations.git.commitAttribution`, `interface.panes.files`, `safety.review`.
- **`NEXT_TURN_FIELDS`** (line 39): paths that the next request, dispatch, or explicit open observes. Examples: `targets`, `chat`, `fleet.default`, `fleet.profiles`, `fleet.rosters`, `fleet.agentProfiles`, `fleet.adaptiveRouting`, `fleet.nodes`, `fleet.permissions`, `fleet.retry`, `fleet.worktrees`, `fleet.limits`, `fleet.history`, `context`, `safety.limits`, `interface.terminalProgress`, `interface.desktopNotifications`, `integrations.projectResources`, `integrations.externalAgents`, `integrations.library`.
- **`RESTART_REQUIRED_FIELDS`** (line 62): paths that require process or pane-host setup to be rebuilt. Examples: `fleet.concurrency`, `interface.mode`, `interface.fullscreenScrollbar`, `interface.panes.enabled`, `integrations.runtimePlugins`.

`matchesPrefix` (line 70) checks whether a dotted path matches a set entry either exactly or as a prefix followed by `.`. `settingsChangeKind` (line 79) applies the sets in the order hotReload → restartRequired → nextTurn, and falls through to `restartRequired` if no set matches. This default-to-restart is deliberate: a new settings key that has not been classified is conservatively treated as requiring a restart rather than silently hot-reloading.

`diffSettings` (line 86) recursively walks the two `ClioSettings` objects with `collectChangedPaths` (line 95), which produces a flat list of dotted leaf paths for every value that differs (using `Object.is` for primitive comparison and recursing into objects and arrays). It then buckets each path with `settingsChangeKind`.

The result is a `ConfigDiff` with three `string[]` arrays. A single change can land in multiple buckets; the caller emits one event per non-empty bucket.

## How a change flows from disk to subscribers

When the watcher fires, `onWatcherFire` (extension.ts:87) runs:

1. If `reloadsHeld` is true, it sets `reloadPending = true` and returns. This is the boot-time hold.
2. It calls `readStrictLayeredSettings(process.cwd())` to produce a fresh snapshot.
3. If the read throws, it calls `publishReloadFailure(formatSettingsFailure(err))` and returns. The previous good snapshot is untouched.
4. It calls `assertAgentNamespace(next)`, which looks up the agents domain's `NativeAgentNamespace` contract and validates that no ACP delegation agent id collides with a native recipe id. A collision throws and is handled by `publishReloadFailure`.
5. On success it calls `publishReloadFailure(null)` to clear any prior failure, stores the new snapshot, and calls `setGitCommitAttributionEnabled`.
6. It computes `diff = diffSettings(prev, next)` and dispatches one event per non-empty bucket:
   - `dispatch("hotReload", { diff, settings: next })` → emits `BusChannels.ConfigHotReload` and notifies local listeners.
   - `dispatch("nextTurn", ...)` → `BusChannels.ConfigNextTurn`.
   - `dispatch("restartRequired", ...)` → `BusChannels.ConfigRestartRequired`.

The `dispatch` function (extension.ts:53) emits on the shared bus and also iterates the local `listeners` map for the matching `ChangeKind`. Local listeners are registered via `onChange(kind, listener)`.

The interactive event projection in `src/interactive/interactive-event-projection.ts` subscribes to all three channels:

- **ConfigHotReload**: calls `deps.onConfigHotReload?.(payload.settings)` and `deps.refreshSettingsOverlay()`. The application handler (`interactive-application.ts:681`) calls `keybindings.reload(settings.interface.keybindings ?? {})`, refreshes the footer, and requests a render. The chat loop (`chat-loop.ts:1191`) also subscribes to `ConfigHotReload` to invalidate the session prompt cache.
- **ConfigNextTurn**: refreshes the footer and requests a render.
- **ConfigRestartRequired**: calls `restartRequiredNotice(payload)` and shows a warning notification.
- **ConfigReloadFailed**: displays the formatted one-line failure message as a notice.

## The boot-time hold and releaseReloads

During interactive boot, the event loop turns between domain starts (the `bootPhaseBoundary` mechanism in `src/entry/orchestrator.ts:1219`). A settings write that arrives via the watcher before the agents domain has started would race the agents namespace validation. The `holdReloads` flag prevents this:

- `onWatcherFire` checks `reloadsHeld` first. While held, a fire sets `reloadPending = true` and returns without reading settings.
- After all domains have started and the first TUI frame commits, the orchestrator calls `config?.releaseReloads?.()` (`src/entry/orchestrator.ts:3207`).
- `releaseReloads` (extension.ts:177) clears `reloadsHeld`, and if `reloadPending` is set, runs `onWatcherFire()` once. At this point the agents domain is loaded and can validate the held write.

The focused test in `tests/extended/config-mutation-admission.test.ts:78` demonstrates this: it loads `createConfigDomainModule(startup, { holdReloads: true })` alongside `AgentsDomainModule`, injects a sibling settings write in `beforeEach`, waits 400 ms (longer than the watcher's 80 ms debounce), then asserts that `config.get().integrations.externalAgents.entries` is still the empty initial value (the write is held). After calling `config.releaseReloads()`, it polls for the `ConfigReloadFailed` bus event and asserts the message matches `/agent id collision/u`, and the entries remain empty.

## The keybinding schema

`keybindings.ts` defines the Clio-specific keybinding ids and merges them with pi-tui's editor/select defaults.

`ClioAppKeybindings` (line 22) is a TypeScript interface that declares 20 action ids (e.g. `clio-coder.output.cycle`, `clio-coder.thinking.cycle`, `clio-coder.exit`). Each value is `true`, which makes the key a type-level discriminant. `ClioKeybinding` (line 45) is the union of all those keys.

A declaration merge in a `declare module "@earendil-works/pi-tui"` block extends pi-tui's `Keybindings` interface with `ClioAppKeybindings`, so `KeybindingsManager` returned from `createKeybindingManager` accepts `clio-coder.*` ids with full TypeScript checking.

`CLIO_APP_KEYBINDINGS` (line 66) is a `const` object that maps each `ClioKeybinding` to an `AppActionDescriptor` with `defaultKeys`, `description`, `scope` (always `"composer"`), `kind` (one of `"toggle" | "cycle" | "send" | "exit" | "edit" | "dismiss"`), `repeat` (always `false`), and an optional `leader` suffix. Notable defaults:

| Key | Default | Description |
|-----|---------|-------------|
| `clio-coder.library.toggle` | `alt+l` | Leader `l` |
| `clio-coder.model.select` | `alt+m` | Leader `m` |
| `clio-coder.thinking.cycle` | `shift+tab` | Leader `t` |
| `clio-coder.leader` | `ctrl+g` | No leader suffix |
| `clio-coder.exit` | `ctrl+d` | No leader suffix |
| `clio-coder.message.followUp` | `ctrl+q` | Leader `f` |

Several entries have `defaultKeys: []` (no binding), which means they are only reachable through the leader menu or command.

`CLIO_KEYBINDINGS` (line 222) merges `TUI_KEYBINDINGS` with overrides and `CLIO_APP_KEYBINDINGS`. It overrides several pi-tui defaults:

- `tui.editor.historyPrevious` → `ctrl+p`
- `tui.editor.historyNext` → `ctrl+n`
- `tui.editor.deleteWordBackward` → `["ctrl+w", "alt+backspace", "ctrl+backspace"]`
- `tui.editor.undo` → `ctrl+_`
- `tui.input.newLine` → `["ctrl+j", "shift+enter"]`
- `tui.altScreen.top` / `bottom` → `[]` (disabled)
- `tui.altScreen.previousPrompt` / `nextPrompt` → `ctrl+up` / `ctrl+down`
- `tui.altScreen.search` → `ctrl+r`

`CLIO_APP_KEYBINDING_IDS` (line 242) is the list of all `clio-coder.*` key ids, derived from `Object.keys(CLIO_APP_KEYBINDINGS)`.

## Agent namespace validation

`assertAgentIdNamespace` in `src/domains/config/agent-namespace.ts:2` throws if any ACP delegation agent id appears in the set of native recipe ids. The extension calls it both on every watcher fire (inside `onWatcherFire`) and on every `update`/`updateProject` call. The error message includes the colliding id.

## The update path

`update(mutate)` (extension.ts:138) and `updateProject(mutate)` (extension.ts:156) perform a cross-process-safe read-modify-write. Both:

1. Call `updateLayeredSettings` or `updateProjectLocalSettings` from `src/core/settings-layers.ts`, which re-layer the project files, validate, and write under an advisory lock.
2. Validate the result against the agents namespace.
3. Store the new snapshot.
4. Compute the diff and dispatch events for every non-empty bucket.

The focused test in `tests/extended/config-mutation-admission.test.ts:15` demonstrates that a rejected mutation (one that introduces an agent id collision) does not publish a `nextTurn` event, does not change the snapshot, and does not change the settings file on disk. It also demonstrates that the mutator sees the freshest on-disk value: after a sibling `updateSettings` advances `fleet.history.maxRuns` to 37, the mutator's `settings.fleet.history.maxRuns` is 37 on its only invocation.

## Extension seams

The config domain invites three kinds of change:

1. **Adding a new settings key** requires updating the three `Set<string>` constants in `classify.ts` to place the new path in the correct effect bucket. If no bucket is added, the new key defaults to `restartRequired` (the fallthrough in `settingsChangeKind`). The repository guidance in `.claude/CLAUDE.md` explicitly warns that nothing checks this: a missing entry silently means restart-required.

2. **Adding a new keybinding** requires declaring the id in `ClioAppKeybindings`, adding a descriptor entry in `CLIO_APP_KEYBINDINGS`, and (optionally) adding a leader suffix. The declaration merge ensures TypeScript checking everywhere `KeybindingsManager` is used.

3. **Adding a new reload subscriber** requires subscribing to the appropriate `BusChannels.Config*` channel on the shared bus, or calling `onChange(kind, listener)` on the config contract. Local listeners are process-local and do not require bus access.

## Things to watch when editing

- **The classify fallthrough is silent**: a new settings path that is not added to any of the three sets defaults to `restartRequired`. This is the safe default, but it means the user sees a restart notice for a change that could have been hot-reloaded.

- **The watcher watches the directory, not the file**: the comment in `watcher.ts` explains that settings writes use temp-file + rename, which replaces the inode. If you change the settings writer to a different atomicity strategy, the watcher may stop detecting changes.

- **The hold mechanism only works during boot**: `reloadsHeld` is set once from the `holdReloads` option and is never re-set. After `releaseReloads()` runs, subsequent watcher fires process immediately. There is no way to re-hold reloads.

- **The agents namespace check runs on every reload**: if the agents domain's contract is not available (e.g., the agents domain failed to load), `assertAgentNamespace` is skipped. This is safe because a missing agents domain means no native recipes exist, so no collision can occur.

- **`formatSettingsFailure` is the only failure formatting path**: the extension never calls `console.error` or emits a raw Error on the bus. If you add a new failure path, route it through `publishReloadFailure` which calls `formatSettingsFailure` to produce a single operator line.
