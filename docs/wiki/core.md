---
title: "Core runtime: settings, trust, safe execution and run records"
summary: "Describes the src/core leaf modules that load layered settings, gate project-supplied files behind operator consent, run commands through the sandbox-aware exec helpers, and record run provenance. Read this when changing how settings are resolved, how a command is spawned, or where run evidence is written."
sources:
  - "src/core/settings-layers.ts"
  - "src/core/workspace-trust.ts"
  - "src/core/safe-exec.ts"
  - "src/core/bash-exec.ts"
  - "src/core/run-records.ts"
  - "src/core/config.ts"
symbols:
  - "readLayeredSettings"
  - "readStrictLayeredSettings"
  - "updateLayeredSettings"
  - "projectSurfaceTrust"
  - "runCommandVector"
  - "runBashCommand"
  - "createRunRecord"
tests:
  - "tests/contracts/trust-gate.test.ts"
  - "tests/contracts/safe-exec-streaming.test.ts"
  - "tests/contracts/bash-exec-settlement.test.ts"
invariants:
  - "Project settings and project.local settings are read only when the project surface snapshot verdict is trusted; otherwise their layer blob is dropped and a trust notice is recorded as an issue."
  - "Operator-only safety keys (scratchRoots, sandboxPassEnv, sandboxUnixSockets, unattendedAfterSeconds, yoloAccepted, yoloConfinement, yoloUnconfinedAccepted, judge) and trustedUnmediated are stripped from project layers, with an issue recorded for each."
  - "A bash command that would run in the main session without a sandbox plan is refused with a not-spawned result rather than executed."
  - "A run record directory is refused if the records root resolves outside the workspace root, and a pre-existing directory with the same run id is an error."
validate:
  - "pnpm exec node --test dist/tests/contracts/trust-gate.test.js"
  - "pnpm exec node --test dist/tests/contracts/safe-exec-streaming.test.js"
  - "pnpm exec node --test dist/tests/contracts/bash-exec-settlement.test.js"
---

# Core runtime: settings, trust, safe execution and run records

`src/core` holds the leaf modules that the rest of the codebase depends on before any domain starts. A reader needs this page when changing how effective settings are computed, when a project file is allowed to take effect, how a shell or argv command is spawned, or what provenance a `run_script` execution leaves on disk.

## What this area does

- **Layered settings.** `src/core/settings-layers.ts` builds the effective settings from up to four file layers plus a source map. Its header describes the precedence order as built-in, then user `settings.yaml`, then project `.clio-coder/settings.yaml`, then `.clio-coder/settings.local.yaml`. CLI flags are listed as a fifth origin in the `SettingsOrigin` type.
- **Project trust.** `src/core/workspace-trust.ts` stores operator consent for privilege-bearing project files (safety, hooks, settings, extensions, plugins). The settings loader consults it before reading a project layer.
- **Command execution.** `src/core/safe-exec.ts` spawns argv vectors with a filtered environment, a cwd confined to the workspace, a timeout, output capture and bounded streaming. `src/core/bash-exec.ts` builds on the same sandbox plan logic to run shell command strings.
- **Run provenance.** `src/core/run-records.ts` creates a per-run directory under the project records tree and captures file hashes and output references into a manifest.
- **Settings schema validation.** `src/core/config.ts` holds the `ClioSettings` type (derived from `DEFAULT_SETTINGS`), the `validateSettings` path, and the issue and error types used to report failures.

## Ownership and key symbols

| Concern | Path | Principal symbols |
| --- | --- | --- |
| Layer merge, operator-only key stripping, read/update | `src/core/settings-layers.ts` | `readLayeredSettings`, `readStrictLayeredSettings`, `updateLayeredSettings`, `updateProjectLocalSettings`, `settingsSourceFor`, `OPERATOR_ONLY_SAFETY_KEYS`, `stripProjectRuntimeTrust` |
| Trust verdicts and approvals | `src/core/workspace-trust.ts` | `projectSurfaceTrust`, `hasProjectSurfaceTrust`, `captureProjectSurface`, `recordProjectSurfaceTrust`, `revokeProjectSurfaceTrust`, `captureProjectInstallBaseline` |
| Vector command execution | `src/core/safe-exec.ts` | `runCommandVector`, `buildSafeToolEnv`, `resolveSafeCwd`, `createRetainedStreamWindow`, `createProcessGroupCleanup`, `runStagingCommandSync` |
| Shell command execution | `src/core/bash-exec.ts` | `runBashCommand`, `buildToolEnv`, `bashSpawnPlan`, `createBashOutputProgressController` |
| Run directories and manifests | `src/core/run-records.ts` | `createRunRecord`, `landRunRecordsRoot`, `assertRunRecordIntact`, `captureFileRef`, `captureOutputRef`, `writeRunManifest`, `sweepRunRecords` |
| Schema and issues | `src/core/config.ts` | `ClioSettings`, `SettingsIssue`, `SettingsValidationError`, `formatSettingsIssues`, `reportSettingsWarnings` |

`src/core/defaults.ts` and `src/core/settings-controls.ts` are the other anchor sources for this area. They define the default values and the per-setting UI metadata. This page does not trace them in detail.

## How settings are read

`readLayeredSettings(cwd, options)` in `src/core/settings-layers.ts` is the central read path. It never throws. The flow is:

1. `readRawLayer("user", userFile, issues)` reads the user `settings.yaml`, or `options.userPath` when provided.
2. `prepareProjectLayers(cwd, issues, user.blob)` resolves the project root, captures a project surface snapshot with `captureProjectSurface(cwd, "settings")`, and reads both project files. If `snapshot.verdict !== "trusted"`, each project layer returns with `blob: undefined` and a `projectSurfaceTrustNotice` is pushed as an issue. Otherwise the blob is passed through the project stripping functions (`stripProjectAutonomy`, `stripProjectRuntimeTrust`, `stripProjectOperatorSafety`, `stripProjectTelemetry`) and then `stripCredentials`.
3. `validateLayerStack(user, prepared, issues)` deep-merges the layers with `mergeLayersWithSources`, which records the origin of each leaf. It then runs `validateSettings` on the merged result. Invalid leaves fall back to schema defaults, and their source is re-attributed to `"built-in"`.
4. The function returns `settings`, `sources`, `issues`, and a `layers` array describing each layer's path and presence.

`readStrictLayeredSettings` calls `readLayeredSettings` and then throws `SettingsValidationError` only when there are issues whose origin is `user`. Project-layer issues stay diagnostics. The `STRICT_USER_ISSUES` symbol carries the strict validation of the raw user document for this check.

### Operator-only keys and runtime trust

`OPERATOR_ONLY_SAFETY_KEYS` in `src/core/settings-layers.ts` lists the `safety.*` keys that a project layer may not set: `scratchRoots`, `sandboxPassEnv`, `sandboxUnixSockets`, `unattendedAfterSeconds`, `yoloAccepted`, `yoloConfinement`, `yoloUnconfinedAccepted`, and `judge`. `stripProjectOperatorSafety` removes each present key, pushes an issue with `origin` and a `safety.<key>` path, and returns the cleaned blob. `stripProjectRuntimeTrust` does the same for `trustedUnmediated` on `targets[]` entries and `integrations.externalAgents.entries[]`. The code comments state the reason: a repository could otherwise grant itself write authority or hand its commands the operator's tokens.

### Writing settings

`updateLayeredSettings(cwd, mutate)` persists a mutation into the user layer. It validates the saved user document, re-layers it with the current project files, applies the mutator to a clone of the effective settings, validates the candidate, and computes the next saved document with `applySettingsDelta`. It then re-runs `validateLayerStack` on the result and throws `"a higher-precedence project setting prevents this settings update"` when the resulting effective settings differ from the candidate. `updateProjectLocalSettings` is the counterpart that writes `settings.local.yaml`.

Focused test: `tests/contracts/trust-gate.test.ts`, test `S3-01: approved safety, settings, and hooks take effect, and changed bytes restore defaults`. It writes a `settings.yaml` containing `chat.retry.streamStallMs: 60000`, asserts `readLayeredSettings(workspace).settings.chat.retry.streamStallMs` equals 60000 once the settings surface is approved, then appends a comment to the file and asserts the value reverts to 180000 after the verdict becomes `"changed"`. The test also asserts that a `.env` read is blocked before approval and allowed after.

## Trust verdicts

`src/core/workspace-trust.ts` describes itself as the authority store that must be a core leaf, because the settings loader runs before domains start. Its verdict type is `"trusted" | "untrusted" | "changed"`. The surfaces are `"safety" | "hooks" | "settings" | "extensions" | "plugins"`, and the package surfaces `"extensions"` and `"plugins"` use identity hashes rather than byte hashes.

- `captureProjectSurface(workspaceRoot, surface)` reads the surface files, hashes them with `sha256`, and compares the result against the stored record.
- `recordProjectSurfaceTrust` writes an approval for the current content hash. `revokeProjectSurfaceTrust` removes it.
- `projectSurfaceTrust` and `hasProjectSurfaceTrust` return the verdict or a boolean for a given root.

The trust test above confirms that a comment-only change produces the `"changed"` verdict. That is the behavior the code comment describes: any byte change requires fresh consent.

Records are kept under `workspaceTrustDirectory()`. This page did not trace the record file location beyond that function name.

## Command execution

### `runCommandVector` (argv)

`runCommandVector(file, args, options)` in `src/core/safe-exec.ts` returns a Promise of `SafeCommandResult`. The order of operations observed in the source is:

1. `resolveSafeCwd(options.cwd, options.workspaceRoot)` resolves the working directory and throws `cwd escapes workspace root` when the resolved path is outside the root.
2. Timeout and kill-grace values are clamped with `clampTimerDelayMs`. Output limits come from `options.maxOutputBytes` or `SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES`.
3. When `options.output` (a `SafeCommandOutputSink`) is supplied, two `createRetainedStreamWindow` instances retain head and tail bytes per stream. Otherwise the code captures the full stream up to the cap.
4. The environment is built by `buildSafeToolEnv(options.env)`, which copies only the keys in `ENV_ALLOWLIST`, adds caller-supplied keys whose names match `^[A-Z_][A-Z0-9_]*$`, and sets `AI_AGENT`.
5. If `options.shellSandbox` is set, `planMainSandboxSpawn` is used. Otherwise `planSandboxedSpawn` is used. A `refused` plan resolves immediately with a not-spawned result.

`buildSafeToolEnv` is a direct, documented filter. Its unit-level behavior is not separately covered by a test in the sources read for this page.

Focused test: `tests/contracts/safe-exec-streaming.test.ts` drives `runCommandVector` directly through `producer(chunks, chunkBytes)` and `threeSpacedBlocks()`. The second helper ignores SIGTERM and writes three 1 KiB blocks 150 ms apart so that output from later chunks is still received after the first kill. The file also imports `createRetainedStreamWindow` and the `SAFE_EXEC_DEFAULT_RETAIN_*` constants, which indicates that the retained-window behavior is tested in the same file.

### `runBashCommand` (shell string)

`runBashCommand(command, options)` in `src/core/bash-exec.ts` runs a command through the resolved bash binary:

1. `bashShellPath()` resolves the shell. When it returns `null`, the function returns `notSpawnedResult` with an install hint.
2. `bashSpawnPlan()` supplies the spawn mode and a filtered environment through `buildToolEnv`. The argv is `[shell, "-o", "pipefail", plan.mode, command]`. The code comment explains that `pipefail` keeps an upstream failure visible through output filters such as `tail`, and that a caller can opt out with `set +o pipefail`.
3. The same sandbox branch as `runCommandVector` applies. A `sandboxed` plan replaces the environment with `scrubSandboxEnv(plan.source, sandbox.env, plan.source).env`, so credential variables are removed before the sandbox starts.
4. The child is spawned detached on non-Windows platforms with `stdio: ["ignore", "pipe", "pipe"]`. Abort or timeout sends SIGTERM to the process group, then SIGKILL after a grace period if processes remain. A drain timer destroys the stdio pipes when a descendant outside the group keeps them open.

Focused test: `tests/contracts/bash-exec-settlement.test.ts` calls `runBashCommand` with `timeoutMs: 3_600_000` and an `AbortController`. It aborts after 200 ms and races the result against a timer. The command is `echo kept; setsid sleep 60 & echo $! > <pidFile>; sleep 60`, which places a descendant in its own session. The test name and assertions are what settle the abort case; this page did not read the full assertion block beyond the call shape.

### Callers

`runCommandVector` has many callers across the tree. Examples from a repository search include `src/tools/safe-exec.ts:77`, `src/tools/verify/scripts.ts:472`, `src/tools/data/sqlite.ts:215`, and `src/tools/harness-extensions.ts:110`. `runBashCommand` is called from `src/tools/bash.ts:373`, which passes the command text and `runOptions` built from the tool arguments. Callers that run inside a dispatched worker pass `shellSandbox` so that the worker's OS sandbox applies, as the source comments state (decision reference Q8 in those comments).

## Run records

`src/core/run-records.ts` writes provenance for `run_script` executions. Constants define the layout: `RUN_RECORDS_RELATIVE_DIR`, `RUN_MANIFEST_FILENAME`, `RUN_STDOUT_FILENAME`, `RUN_STDERR_FILENAME`, and `RUN_MANIFEST_VERSION`.

- `landRunRecordsRoot(workspaceRoot)` resolves the records root with `realpathSync` and `canonicalizePath`. It returns `{ inside: false, reason }` when the root resolves outside the workspace or onto the workspace root itself.
- `createRunRecord(workspaceRoot, runId)` throws when the landing is not inside. It also throws when the run directory already exists. After `mkdirSync`, it re-checks the real path and the directory's `lstat`, and throws when the directory moved during creation. It returns the paths and an identity record (`realDir`, `dev`, `ino`).
- `assertRunRecordIntact(paths)` is the check before writing a manifest. It guards against a replaced or relinked directory, because a script runs with Clio's own file access.
- `captureFileRef` and `captureOutputRef` hash files up to `RUN_FILE_HASH_MAX_BYTES`. `HashObservation` and `RunHashOmission` record omissions such as `too-large`, `cancelled`, and `unreadable`.
- `writeRunManifest` writes the manifest, and `sweepRunRecords(workspaceRoot, { keep })` prunes old records, with `RUN_RECORDS_DEFAULT_KEEP` as the default retention count.

No focused test for `src/core/run-records.ts` was located. The name search across `tests/` matched only the other contract files listed above, and none of them was read for this page. This is a coverage gap for the run-record workflow.

## Extension seams

- **New operator-only setting.** Add the key to `OPERATOR_ONLY_SAFETY_KEYS` (for a `safety.*` key) in `src/core/settings-layers.ts`. The existing stripping function applies it to project layers without further change. The schema itself lives in `src/core/config.ts`.
- **New trusted project surface.** `ProjectTrustSurface` in `src/core/workspace-trust.ts` is a closed union, and `SURFACES` lists its members. Adding a surface requires the surface file lists (`surfaceEntries`, `surfaceRoot`) and the verdict logic in `captureProjectSurface` to handle it. This page did not read every branch of that logic.
- **New command runner.** Build on `runCommandVector` for argv commands, or on `runBashCommand` for shell strings. Pass `workspaceRoot` and `cwd` explicitly, and pass `shellSandbox` when the call runs inside a worker or contained main-session path.

## Things to watch when editing

- `readLayeredSettings` must not throw. Its callers depend on the never-throws contract, and the strict variant is the only place that throws for user-layer problems.
- Any change to project stripping has to keep the issue entry for each stripped key, because the trust and safety UI reads those issues. Removing an entry from `OPERATOR_ONLY_SAFETY_KEYS` makes a project value take effect.
- Byte-level changes to a trusted surface invalidate its approval. The trust test confirms this for a trailing comment.
- `buildSafeToolEnv` and `buildToolEnv` are the environment filters. Credentials are removed by `scrubSandboxEnv` only on the sandboxed path in `runBashCommand`. A change to the plain spawn path changes what the command can see, so review both branches.
- `resolveSafeCwd` rejects paths that escape the workspace root. A relative cwd that includes `..` is resolved against the root before the check.
