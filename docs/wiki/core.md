---
title: "Core: settings schema, layered configuration, bus contracts, safe exec, and session routing"
summary: "The shared foundation modules under src/core that every domain depends on: the one strict settings schema and its layered merge, the event-bus channel registry with payload contracts, the sandboxed subprocess runner, the session-local routing state machine, and the workspace file enumerator."
sources:
  - "src/core/config.ts"
  - "src/core/defaults.ts"
  - "src/core/settings-layers.ts"
  - "src/core/bus-events.ts"
  - "src/core/safe-exec.ts"
  - "src/core/settings-controls.ts"
  - "src/core/workspace-files.ts"
  - "src/core/session-routing.ts"
symbols:
  - "ClioSettings"
  - "DEFAULT_SETTINGS"
  - "readStrictLayeredSettings"
  - "BusChannels"
  - "BusPayloadMap"
  - "runCommandVector"
  - "createProcessGroupCleanup"
  - "SETTING_CONTROLS"
  - "applyControlValue"
  - "enumerateWorkspaceFiles"
  - "enumerateWorkspaceFilesAsync"
  - "SessionRoutingState"
  - "seedSessionRouting"
  - "applySessionRouting"
  - "commitRoutingPatch"
  - "routingPatchForId"
tests:
  - "tests/contracts/settings-controls.test.ts"
  - "tests/contracts/safe-exec-streaming.test.ts"
invariants:
  - "Every domain reads settings through the single strict schema in src/core/config.ts; the config domain wraps it with watcher, hot-reload, and event emission."
  - "Project settings layers strip credential-bearing keys and the safety.autonomy leaf; only user settings and operator flags may set those."
  - "The event bus performs no runtime payload validation; subscribers that consume data crossing a process boundary must keep validating."
  - "Session routing patches are applied to session-local state first, then written through to saved settings; a persist that throws puts the route back before rethrowing."
  - "The safe-exec runner always spawns children in a new process group on POSIX and signals the group (not just the leader) for timeout, cancellation, and output-cap kills."
---

# Core

The `src/core/` directory holds the shared foundation modules that every Clio domain depends on. These are not domain-specific; they provide the settings schema, layered configuration merge, event-bus contracts, sandboxed subprocess execution, session-local routing state, and workspace file enumeration. The config domain at `src/domains/config/index.ts` wraps the core settings layer with a watcher, hot-reload dispatch, and event emission, but the schema itself and the atomic file write/lock machinery live here in core.

## Ownership

| Module | Responsibility | Key entry points |
|--------|---------------|------------------|
| `src/core/config.ts` | The one strict settings schema: read, validate, write, cross-process lock | `readSettings`, `validateSettings`, `updateSettings`, `applySettingsDelta`, `withSettingsLock` |
| `src/core/defaults.ts` | Shipped default values and the machine-readable YAML mirror | `DEFAULT_SETTINGS`, `DEFAULT_SETTINGS_YAML`, all `*Settings` interfaces |
| `src/core/settings-layers.ts` | Four-layer merge (built-in < user < project < project.local < CLI) with credential stripping and trust verification | `readLayeredSettings`, `readStrictLayeredSettings`, `updateLayeredSettings`, `updateProjectLocalSettings` |
| `src/core/bus-events.ts` | Canonical event-bus channel names and compile-time payload contracts | `BusChannels`, `BusPayloadMap`, `BusPayloadMapCoversAllChannels` |
| `src/core/safe-exec.ts` | Sandbox subprocess runner with process-group teardown, output capping, UTF-8 boundary handling | `runCommandVector`, `createProcessGroupCleanup`, `buildSafeToolEnv`, `createRetainedStreamWindow` |
| `src/core/settings-controls.ts` | UI-facing settings catalog with labels, descriptions, and value parsing/validation | `SETTING_CONTROLS`, `applyControlValue`, `settingControl` |
| `src/core/workspace-files.ts` | Git-first workspace file enumeration with bounded fallback walk | `enumerateWorkspaceFiles`, `enumerateWorkspaceFilesAsync`, `filterWorkspaceFileCandidates` |
| `src/core/session-routing.ts` | Session-local routing state, patches, diffs, and effective-view composition | `seedSessionRouting`, `applySessionRouting`, `commitRoutingPatch`, `routingPatchForId`, `diffRouting` |

## Settings schema and validation

`src/core/config.ts` defines the single strict schema for all Clio settings. The type `ClioSettings` is `typeof DEFAULT_SETTINGS`, meaning the shape of the settings object is determined by the defaults in `src/core/defaults.ts`. There is exactly one schema: the file on disk and the in-memory shape use the same version-2 key names (`targets`, `chat.target`, `fleet.permissions.mode`, etc.).

`validateSettings(raw: unknown)` at `src/core/config.ts:1296` clones `DEFAULT_SETTINGS` and walks the raw input, accumulating `SettingsIssue` entries for every unknown key, type violation, retired value, and schema violation. It does not throw; it returns `{ settings, issues }`. `readSettings()` wraps `validateSettings` and throws `SettingsValidationError` when issues exist.

The write path is locked and atomic. `updateSettings(mutate)` at `src/core/config.ts:2315` runs under `withSettingsLock`, which acquires an advisory file lock on `settings.yaml`. Inside the lock it re-reads the freshest saved document, applies the mutator, re-validates through the schema, and persists the delta via `safeResourceWrite` (temp file + rename). `applySettingsDelta(saved, before, after)` writes only the keys the mutation actually changed, so materialized defaults never leak into a file that never had them.

`updateSavedSettingsDocument(mutate)` at `src/core/config.ts:2278` is the lower-level writer used by the layered settings system; it runs the mutator inside the same lock but skips the schema revalidation because the layered system does its own validation against the project layers before calling it.

### Defaults and the YAML mirror

`src/core/defaults.ts` exports `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML`. The YAML string is a hand-mirrored human-readable version of the same object; the two must stay in sync. `DEFAULT_SETTINGS` covers chat routing, fleet configuration, context management, safety limits, interface settings, and integrations. All fleet guardrail values are sourced from `GUARDRAIL_DEFAULTS` in `src/core/guardrails.ts`.

The change recipe for adding a settings key requires updating `DEFAULT_SETTINGS`, `DEFAULT_SETTINGS_YAML`, the `unknownKeys` list in `src/core/config.ts`, the `classify.ts` timing map, and two documentation tables. Missing any of these causes validation to reject user files that contain the key or causes the key to be silently classified as restart-required.

## Layered settings

`src/core/settings-layers.ts` implements the four-layer precedence merge:

```
built-in  <  user settings.yaml  <  project .clio-coder/settings.yaml
        <  project .clio-coder/settings.local.yaml  <  CLI flags
```

Layering happens on the raw parsed YAML blobs so each effective leaf can be attributed to the layer that set it, then the merged blob is validated against the one strict schema. `readLayeredSettings(cwd)` returns a `LayeredSettings` object with the effective settings, per-leaf source attribution (`sources`), issues, and layer presence. `readStrictLayeredSettings(cwd)` adds a strict launch gate: it re-validates the user layer alone and throws `SettingsValidationError` if the user file has schema violations, even when the project layers would mask them.

Project layers are committed team configuration and must stay secrets-free. `stripCredentials` recursively walks project-layer blobs and removes keys whose lowercase form is in `CREDENTIAL_KEYS` (`auth`, `apikey`, `api_key`, `token`, `secret`, `password`). `stripProjectAutonomy` removes `safety.autonomy` from project layers because autonomy is operator-owned. Both record a diagnostic issue explaining the removal.

`updateLayeredSettings(cwd, mutate)` at `src/core/settings-layers.ts:343` atomically persists a mutation into the user layer while preserving references to project-only targets. It re-layeres the candidate with the same project files before writing, and refuses a mutation that a higher-precedence project leaf would silently override.

`updateProjectLocalSettings(cwd, mutate)` at `src/core/settings-layers.ts:385` persists a project-local mutation in `settings.local.yaml`. It verifies the project settings surface is already trusted (or both files are absent), writes under a state-file lock, and then re-reads the effective stack to confirm the save was not overridden by another layer.

## Event bus contracts

`src/core/bus-events.ts` is the canonical registry of event-bus channel names and their payload contracts. `BusChannels` is a const object with one key per channel (e.g., `BusChannels.ConfigHotReload = "config.hotReload"`). Downstream code imports from this file rather than hard-coding string literals so renames are a single edit.

`BusPayloadMap` is a type that maps each channel to its payload interface. The shared bus types `emit`/`on` against this map, so payload drift between an emitter and this file is a compile error. The type `BusPayloadMapCoversAllChannels` is an exhaustiveness tripwire: adding a member to `BusChannels` without registering its payload in `BusPayloadMap` fails to typecheck.

The bus performs no runtime validation. The types describe what in-process emitters send; subscribers that consume data which crossed a process boundary (worker/ACP event streams) must keep validating at runtime.

Key payload contracts include:
- `ConfigChangePayload` for hot-reload, next-turn, and restart-required settings changes.
- `PermissionRequestedPayload` / `PermissionResolvedPayload` for operator permission flows.
- `LoopBlockedPayload` for the identical-call loop guard escalation.
- `DispatchRunIdentity`, `DispatchCompletedPayload`, `DispatchFailedPayload` for the dispatch lifecycle.
- `AgentStatusChangedPayload` for interactive agent phase transitions.

## Safe subprocess execution

`src/core/safe-exec.ts` provides the sandboxed subprocess runner used by new tool subprocesses and the ACP transport. The primary entry point is `runCommandVector(file, args, options)`.

Key behaviors:
- **Process group management**: On POSIX, the child is spawned with `detached: true` so it leads its own process group. `createProcessGroupCleanup` at `src/core/safe-exec.ts:279` opens a bounded cleanup window: SIGTERM, grace period, SIGKILL, then a bounded wait for the group to disappear. Every signal follows an existence probe (`kill(-pgid, 0)`) in the same synchronous step; the first observation that the group is gone (ESRCH) closes the window for good.
- **Output capping**: Without an output sink, combined stdout+stderr is capped at `SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES` (600 KB). With a sink, the cap does not apply; instead `createRetainedStreamWindow` keeps a bounded head-and-tail rendering (default 4 KB head, 16 KB tail).
- **UTF-8 boundary handling**: `trimIncompleteUtf8Suffix` and `trimLeadingUtf8Continuation` drop partial UTF-8 sequences at the window boundaries so the retained text decodes cleanly.
- **Environment allowlist**: `buildSafeToolEnv` copies only `ENV_ALLOWLIST` variables from the parent process, plus caller-supplied extra variables. Provider keys and Clio gates are deliberately absent.
- **CWD confinement**: `resolveSafeCwd` resolves the child's working directory and throws if it escapes the workspace root.

## Session routing

`src/core/session-routing.ts` manages session-local routing state. Saved settings are shared by every Clio process; live routing for a running session is owned by the process that is running it. Each process seeds its routing from saved settings at boot via `seedSessionRouting(saved)`, which extracts `chat`, `context.memory`, and `fleet.default` into a `SessionRoutingState`.

`applySessionRouting(saved, routing)` produces the effective settings view: the shared snapshot with the session's routing fields overlaid. Every UI surface that displays routing must read through this view.

`commitRoutingPatch(routing, patch, persist, onChange)` at `src/core/session-routing.ts:103` moves the live route, then persists it. If persist throws, the route is rolled back before rethrowing. `routingPatchForId(path, settings)` builds the routing patch for a single /settings edit. `diffRouting(prev, next)` computes a field-level diff of the routing surface between two settings blobs, used to absorb routing edits made through whole-settings writers.

`planResumedRouting(route, settings, pinned)` at `src/core/session-routing.ts:180` plans the live-route change that resuming a session implies: it restores the session's recorded route instead of the saved default, and returns a notice when the recorded target is no longer configured.

`applyOverrides(base, overrides)` at `src/core/session-routing.ts:271` applies session-local overrides for non-routing settings, returning the base untouched when there are no overrides so the common path stays allocation-free.

## Workspace file enumeration

`src/core/workspace-files.ts` enumerates the visible file set for a workspace. `enumerateWorkspaceFiles(cwd)` first tries `git ls-files -z --cached --others --exclude-standard`; when Git is unavailable it falls back to a bounded filesystem walk via `fallbackFilesWalk`, a step generator that yields once per processed entry. The generator enforces `DEFAULT_WORKSPACE_FALLBACK_LIMITS` (100k entries, 64 depth, 64 MB path bytes, 5 s time) and throws `WorkspaceEnumerationLimitError` or `WorkspaceEnumerationIncompleteError` when the contract is exceeded.

`enumerateWorkspaceFilesAsync(cwd, cooperate)` is the non-blocking variant: the `git ls-files` subprocess runs async, and both the per-path lstat validation and the non-Git fallback walk yield cooperatively through a `WorkspaceEnumerationTick` (a structurally compatible cooperative slicer). The time limit meters the walk's own accumulated work rather than wall clock, so a busy event loop cannot fail an enumeration that did no more work than its budget allows.

`WORKSPACE_EXCLUDED_DIRS` lists directories omitted even when Git tracks files beneath them: `.git`, `node_modules`, `dist`, `build`, `coverage`, `__pycache__`, `.clio-coder`, `.claude`, `.codex`, `.superpowers`, and others.

## UI settings controls

`src/core/settings-controls.ts` provides the UI-facing catalog of setting controls. `SETTING_CONTROLS` is a readonly array derived from the default settings schema via `collectControlPaths`, which walks `DEFAULT_SETTINGS` and emits one control per leaf. Each control carries a `path`, `label`, `description`, `help`, optional `choices`, a `kind` (`boolean` | `number` | `string` | `list` | `json`), `optional`, and `readOnly` flags.

`applyControlValue(settings, path, text)` at `src/core/settings-controls.ts:594` parses and validates a user-entered value against the control's kind, choices, and cross-field constraints. It performs registry-backed eligibility checks (e.g., a chat target must be an HTTP/native runtime), enforces target/model pair invariants, and runs the full schema validation before committing. Invalid values throw and leave the original settings untouched.

`settingsV2PathForRow(id)` maps legacy v1 settings-center IDs to canonical v2 paths, ensuring the UI shows and persists only canonical paths while maintaining backward-compatible navigation.

## Data and control flow

### Settings read path

```
Config domain boot
  -> readStrictLayeredSettings(cwd)         // src/core/settings-layers.ts
     -> readRawLayer("user", userFile)      // src/core/settings-layers.ts
     -> prepareProjectLayers(cwd)           // reads project + project.local
        -> captureProjectSurface(cwd)       // trust verification
        -> stripCredentials / stripProjectAutonomy
     -> mergeLayersWithSources([user, project, project.local])
     -> validateSettings(merged)            // src/core/config.ts
        -> Issues accumulator
        -> cloneValue(DEFAULT_SETTINGS)     // src/core/defaults.ts
  -> ConfigContract.get()                   // src/domains/config/extension.ts
     -> returns the validated snapshot
```

### Settings write path (updateSettings)

```
Config domain update(mutate)
  -> updateLayeredSettings(cwd, mutate)     // src/core/settings-layers.ts
     -> updateSavedSettingsDocument(mutate) // src/core/config.ts
        -> withStateFileLockSync(lockfile)
           -> readSettings()                // strict gate
           -> readSavedDocument()
           -> persistSettings(mutate(clone(saved)))
              -> safeResourceWrite          // temp + rename
     -> validateLayerStack(user, project, local)
     -> deepEquals check against project layers
  -> ConfigContract.update returns effective settings
  -> diffSettings(prev, next)               // src/domains/config/classify.ts
  -> dispatch("hotReload"/"nextTurn"/"restartRequired")
     -> bus.emit(BusChannels.ConfigHotReload, payload)  // src/core/bus-events.ts
```

### Session routing flow

```
Session boot
  -> seedSessionRouting(saved)              // src/core/session-routing.ts
     -> extracts chat, context.memory, fleet.default
  -> applySessionRouting(saved, routing)    // effective view for this session

Routing change (e.g., Shift+Tab)
  -> createRoutingGestures(deps).cycleThinking()
     -> deps.apply({ orchestrator: { thinkingLevel: next } }, "session")
        -> applyRoutingPatch(routing, patch)
        -> persist()                         // write-through to settings.yaml
           -> if persist throws: applyRoutingPatch(routing, prior); onChange(); rethrow
```

## Extension seams

- **Adding a settings key**: Add to `DEFAULT_SETTINGS` in `src/core/defaults.ts`, mirror in `DEFAULT_SETTINGS_YAML`, add to the `unknownKeys` allowlist in `src/core/config.ts`, classify timing in `src/domains/config/classify.ts`, and add rows to the documentation tables.
- **Adding a bus channel**: Add a member to `BusChannels` in `src/core/bus-events.ts` and register its payload in `BusPayloadMap`. The `BusPayloadMapCoversAllChannels` exhaustiveness check will fail if either is forgotten.
- **Adding a UI control**: The control catalog in `src/core/settings-controls.ts` is derived from the schema automatically. For custom labels and help, add entries to `SETTINGS_LABELS_BY_ID`, `SETTINGS_DESCRIPTIONS_BY_ID`, and `SETTINGS_HELP_BY_ID`. For structured JSON controls, add the path to the `STRUCTURED` set.
- **Adding a workspace exclusion**: Add the directory name to `WORKSPACE_EXCLUDED_DIRS` in `src/core/workspace-files.ts`.

## Focused tests

### `tests/contracts/settings-controls.test.ts`

This test file demonstrates the control catalog's contract:
- Every shared control has a TUI home and accepts its shipped value: iterates `SETTING_CONTROLS` and verifies each control's path appears in the TUI's `buildSettingItems` output, and that applying the shipped default value via `applyControlValue` does not throw.
- Invalid typed values leave the original intact: exercises `applyControlValue` with invalid inputs (unknown autonomy, NaN retries, bad target refs, malformed JSON) and asserts the original settings are unchanged.
- Changing a role connection clears only that role's previous model override: sets `chat.target` to "second" and asserts `chat.model` becomes null while `fleet` is untouched.
- Saved edits preserve unrelated fields: uses `isolateClioEnv` to write settings via `saveControl` and re-reads to verify the delta was applied correctly.

### `tests/contracts/safe-exec-streaming.test.ts`

This test file exercises the streaming output path of `runCommandVector`:
- Uses a node one-liner that writes fixed-size chunks to stdout and a single line to stderr.
- Validates the retained head-and-tail window rendering, the `omitted` byte count, and the `[... N bytes omitted ...]` marker.
- Tests output-cap kills when no sink is provided, and sink-based streaming when a `SafeCommandOutputSink` is supplied.

## Things to watch when editing

- **Keep `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` in sync.** The change recipe in the repository guidance explicitly requires both in the same change. A divergence causes `clio-coder doctor` to report schema drift.
- **The `settingsRemedy` function in `src/core/config.ts` is the single voice for settings failure guidance.** Both `SettingsValidationError` and `formatSettingsIssues` call it. Changing the wording here changes operator-facing diagnostics in both the error object and the runtime reload notice.
- **Credential stripping in project layers is recursive and case-insensitive.** `CREDENTIAL_KEYS` checks `key.toLowerCase()`, so adding a new credential key name means adding it to the set in `src/core/settings-layers.ts`. The diagnostic message is fixed ("credentials are not allowed in project settings; key ignored").
- **The safe-exec process-group cleanup window has a residual hazard documented in its own doc comment.** Linux keeps a PGID reserved while any member of the group lives, so a signal can only reach an unrelated group if every member dies between the probe and the signal that immediately follows it. This is accepted and documented.
- **The `BusPayloadMapCoversAllChannels` type is a compile-time tripwire.** Adding a channel to `BusChannels` without its payload entry will cause a typecheck failure. Do not suppress the tripwire.
- **Session routing patches are applied to session state first, then written through.** `commitRoutingPatch` rolls back on persist failure. Any new routing gesture must go through this function to preserve the rollback invariant.
- **The workspace fallback walk's time limit meters accumulated walk time, not wall clock.** `fallbackFilesWalk` receives an `elapsedMs()` callback; the sync driver passes `performance.now() - startedAt`, the async driver passes accumulated active time. Changing this contract affects both drivers.
- **`applySettingsDelta` only writes keys that changed.** A mutation that sets a key to the same value it already has will not write that key to the file. This prevents materialized defaults from leaking into user files that never had them.
