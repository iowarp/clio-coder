---
title: "Command-line surfaces: the pane layer (mux)"
summary: "How Clio Coder drives terminal panes through a herdr server: the best-effort runtime contract, managed dock placement, workspace launch, peer prompt delivery, the panes vocabulary and the managed Yazi profile. Read this before changing any pane, dock, launcher or peer-to-peer prompt behavior."
sources:
  - "src/domains/mux/index.ts"
  - "src/domains/mux/contract.ts"
  - "src/domains/mux/socket-client.ts"
  - "src/domains/mux/dock-controller.ts"
  - "src/domains/mux/workspace/launch.ts"
  - "src/domains/mux/workspace/platform.ts"
  - "src/domains/mux/workspace/platform-posix.ts"
  - "src/domains/mux/workspace/config.ts"
  - "src/domains/mux/peer-inbox.ts"
  - "src/domains/mux/operations.ts"
  - "src/domains/mux/yazi/profile.ts"
symbols:
  - "createMuxDomainModule"
  - "createMuxRuntime"
  - "MuxContract"
  - "createMuxClient"
  - "createDockController"
  - "planDockOpen"
  - "DOCK_SPECS"
  - "launchWorkspace"
  - "isClioHostSocket"
  - "renderWorkspaceConfig"
  - "deliverPeerPrompt"
  - "parsePeerPromptRequest"
  - "PANES_PRESETS"
  - "resolvePanesPresetId"
  - "inspectYaziProfile"
  - "ensureYaziProfile"
tests:
  - "tests/extended/panes-files.test.ts"
  - "tests/extended/session-title-typed-input.test.ts"
  - "tests/contracts/panes-tool.test.ts"
  - "tests/contracts/mux-private-host.test.ts"
invariants:
  - "Every method on the pane runtime contract is best-effort: when the layer is absent or a transport or timeout error occurs, the call returns its fallback (null, false, or empty) and does not throw to the caller."
  - "A deliverPeerPrompt call returns not-delivered without writing a request when the inbox owner's paneId or socketPath does not match the request, or when the owner process is not verified alive."
  - "A stale inbox token from a retired conversation cannot create a new conversation in the receiving session (session-title-typed-input test)."
  - "planDockOpen refuses a dock before any split is sent when the anchor axis times half the slot's minCells is below that floor."
  - "The panes preset name yazi resolves to the files preset, and unknown names resolve to null."
  - "Clio's private pane host never reads or writes the operator's own herdr socket or ~/.config/herdr: its server runs on a clio-coder-<hash> socket with every inherited HERDR_* variable removed."
validate:
  - "pnpm run test:file -- tests/contracts/mux-private-host.test.ts"
  - "pnpm run test:file -- tests/extended/panes-files.test.ts"
  - "pnpm run test:file -- tests/extended/session-title-typed-input.test.ts"
  - "pnpm run test:file -- tests/contracts/panes-tool.test.ts"
  - "pnpm run typecheck"
---

# Command-line surfaces: the pane layer (mux)

The mux domain is the layer that puts Clio Coder's own surfaces into terminal panes. It talks to a herdr server over a Unix domain socket, places managed docks beside Clio's anchor pane, starts a Clio workspace when none is running, delivers prompts from one Clio to another through a file inbox, and prepares a managed Yazi profile. A reader needs this page when changing pane behavior, adding a dock slot, touching `/panes`, or debugging why a pane call returned nothing.

## What this area does

The pane layer is best-effort by design. The contract file states that every method is best-effort and that a mux failure never fails a dispatch and never throws at a caller. The runtime enforces this in an `attempt` wrapper that runs one interaction, returns a fallback on any error, and marks the link unhealthy only for transport or timeout errors (`src/domains/mux/contract.ts:createMuxRuntime`).

The area has these parts:

- A module factory that the domain loader calls (`src/domains/mux/index.ts:createMuxDomainModule`).
- A runtime contract with pane open, close, read, prompt, interrupt and layout methods (`src/domains/mux/contract.ts:MuxContract`).
- A socket client that speaks newline-delimited JSON to the herdr server (`src/domains/mux/socket-client.ts:createMuxClient`).
- Dock geometry and lifecycle for managed panes (`src/domains/mux/dock-controller.ts`).
- A launcher for Clio's own private pane host (`src/domains/mux/workspace/launch.ts:launchWorkspace`).
- A peer prompt inbox (`src/domains/mux/peer-inbox.ts`).
- The operator and model pane vocabulary (`src/domains/mux/operations.ts`).
- The managed Yazi profile (`src/domains/mux/yazi/profile.ts`).

The `cliamp/` subdirectory is listed in the assigned scope but was not read for this page. The `workspace/` directory also contains `config.ts`, `exit-marker.ts` and the platform seam (`platform.ts`, `platform-posix.ts`, `platform-win32.ts`), described under Workspace launch.

## Module factory and runtime contract

`createMuxDomainModule` returns a `DomainModule<MuxContract>` whose `createExtension` calls `createMuxBundle(context, options)` from `src/domains/mux/extension.ts` (`src/domains/mux/index.ts:createMuxDomainModule`). The `extension.ts` body was not read, so how the bundle decides gating is not described here. The index file also re-exports the public surface: the contract types, `createMuxRuntime`, dock helpers, the socket client, the Yazi event stream and profile helpers, and `createYaziSession`.

`createMuxRuntime` takes a `MuxDetection`, a nullable `MuxClient`, an optional log and an optional clock (`src/domains/mux/contract.ts:MuxRuntimeOptions`). It constructs a dock controller only when all three hold: a client is present, the detection carries an anchor pane id, and the server reports the `layout.export` method through `muxSupportsMethod` (`src/domains/mux/contract.ts:createMuxRuntime`). It passes a `leaveZoom` callback only when the server supports `pane.zoom`. When any condition fails, the dock controller is `null` and the dock tier answers false or empty.

Health is tracked by two values. `healthy` starts as `client !== null`. A transport or timeout `MuxError` sets `healthy` to false and records `probeHealthAt` as the current time plus `DEGRADE_COOLDOWN_MS` (5 seconds). `usable()` returns false while stopped, when there is no client, or when mode is `none`; otherwise it returns `healthy || now() >= probeHealthAt`. Non-transport errors are logged at debug level and do not change health (`src/domains/mux/contract.ts:createMuxRuntime`).

Ownership is marked with metadata tokens. Every Clio-created pane is tagged with `clio_coder_owner=clio-coder:mux`. The legacy key `clio_owner=clio:mux` is still matched when reading ownership, so panes left by an older session are still recognized (`src/domains/mux/contract.ts:hasOwnedPaneToken`, with the constants above it). Token values are cut to 80 characters, the herdr limit (`src/domains/mux/contract.ts:token`).

## Socket client

`createMuxClient` is in `src/domains/mux/socket-client.ts`. The file header describes the connection model: one connection per request for ordinary calls, and a separate long-lived kind for subscriptions. The client exposes typed methods such as `ping`, `snapshot`, `paneSplit`, `paneMove`, `layoutExport`, `layoutSetSplitRatio` and the `worktree*` family (`src/domains/mux/socket-client.ts:MuxClient`). Each response is parsed by a `read*` function that validates the shape and throws a `MuxError` on malformed input, for example `readPane`, `readSnapshot` and `readLayoutNode`. The `connectSocket`, `readJsonLines` and line-size limit (`MAX_LINE_BYTES`) helpers handle the wire. The `paneMove` method is gated on herdr protocol 14 and `layoutExport` and layout ratio changes on protocol 17, as their doc comments state.

## Managed docks

A dock is a Clio-owned pane placed at a fixed position relative to the anchor pane. `DOCK_SPECS` in `src/domains/mux/dock-controller.ts` defines four slots, each with a direction, a default share and a minimum cell floor:

| Slot | Direction | Default share | Min cells |
| --- | --- | --- | --- |
| `workers` | right | 0.34 | 40 |
| `extension` | down | 0.3 | 12 |
| `files` | down | 0.3 | 12 |
| `music` | down | 0.05 | 18 |

The source comment explains that the spec is fixed per slot rather than derived from terminal width, and the `workers` floor follows the fleet dashboard's 40-column layout.

`planDockOpen(anchorRect, spec, requestedShare?)` decides fit before anything reaches the wire. It computes the axis length for the spec's direction. If `axis * DOCK_MAX_SHARE < spec.minCells`, it returns `{ refused }` with a message naming the slot. Otherwise it clamps the requested share with `clampDockShare` (non-finite or non-positive values fall back to the workers default, and the value is capped at `DOCK_MAX_SHARE` = 0.5), raises it to `spec.minCells / axis` if needed, and returns the wire `ratio` as `1 - share`, since the dock is the second child (`ratioForDockShare`).

`createDockController` keeps a map of slot states. Its `applyShare` re-exports the layout tree for the dock's tab on each call and derives the split path with `deriveSplitPath`. The source comment says the path is never cached because user splits and moves invalidate it. `deriveSplitPath` walks the tree and returns the boolean path to the split separating the anchor from the dock, or `null` when no such split exists. The controller's public methods are `open`, `hide`, `show`, `adopt`, `noteLayoutUpdated`, `notePaneGone`, `notePaneMoved`, `paneIds` and `clear` (`src/domains/mux/dock-controller.ts:DockController`). The method bodies below `createDockController` were not read in full, so details of `hide`, `show` and the adoption path are not described beyond their interface comments.

Caller: `createMuxRuntime` is the only constructor of the controller inside `src/domains/mux/contract.ts`. The contract's `openUtilityPane` request type carries an optional `dock: { slot, share, hidden }` field, documented as the managed placement path that requires the layout tier (`src/domains/mux/contract.ts:MuxOpenUtilityPaneRequest`).

## Workspace launch

`launchWorkspace(options)` in `src/domains/mux/workspace/launch.ts` is the private host Clio starts for itself from bare `clio-coder` (`src/cli/workspace-launch.ts` decides eligibility, resolves the vendored herdr with `resolveVendoredBinary`, and installs it when missing with one status line, a 30-second download budget and a one-day negative cache in `<state>/mux/herdr-install-failed.json`; platforms without a pinned build stay plain silently). The host layout comes from the platform seam in `src/domains/mux/workspace/platform.ts`: `muxHostPlatform().hostLayout({ session, env })` returns the socket path, the herdr arguments, the host environment, the managed config path, herdr's session file, the pane shell, the disposable directories and the cleanup command. On POSIX (`platform-posix.ts`) the session is `clio-coder-<12 hex>` of the project directory, the socket is `<runtime dir>/<session>.sock`, the runtime dir being the first of `$XDG_RUNTIME_DIR/clio-coder`, `$TMPDIR/clio-coder-<uid>` (`$TMPDIR/clio-coder` on macOS) and `/tmp/clio-coder-<uid>` whose socket path fits 100 bytes and that can be made owner-only (`posixRuntimeDirCandidates`), and the server runs with `XDG_CONFIG_HOME` and `XDG_STATE_HOME` pointed at `<state>/mux/<hash>/` plus a `pane-shell` shim that restores the operator's XDG roots before it execs their shell. The root records its socket in `socket-path`, and a later launch whose `XDG_RUNTIME_DIR` or `TMPDIR` differs reuses it while the socket exists, so one root never serves two servers. Windows (`platform-win32.ts`) uses herdr's own `--session`. The flow:

1. Under the lock `<state>/mux/locks/<hash>`, `resolveHost` takes the layout and writes the managed config with `writeWorkspaceConfig` (`config.ts`): prefix `ctrl+b`, or `ctrl+shift+b`/`ctrl+]` when the launch is nested in the operator's herdr; herdr's own screens unbound; chrome chosen by `interface.outputDetail`. The host environment is the caller's environment with every `HERDR_*` removed, plus the layout's.
2. `openWorkspace(host)` starts or reuses the server on the layout's socket (a reused server gets `server.reload_config`; before a fresh start `ensureServer` deletes the layout's `sessionFile`, because herdr always restores `session.json` at startup and has no setting to stop it), finds or opens the Clio pane, and tags it. A refusal or lock failure returns `fallback` with a reason.
3. `attachWorkspace` spawns the herdr client with the layout's arguments and inherits stdio. From that point the terminal belongs to the client.
4. A poll interval (`EXIT_POLL_MS`) checks for the Clio pane's exit marker, `<socket without .sock>.exit-<pane>` (`exit-marker.ts`). A clean quit stages the marker and renames it into place with the exit summary that Clio printed in its pane as its content (`holdExitSummaryForLauncher` in `exit-summary-handoff.ts`). Every `WORKSPACE_CHECK_EVERY` ticks it asks `stillOwnsWorkspace`. Either signal calls `platform.detach`.
5. On `spawnError`, the launcher undoes what it created (`undoLaunch`) under the lock, closes the client and returns `fallback`. Undo is skipped for a workspace the launch reattached to.
6. On normal exit, a clean Clio quit (exit code 0, not a restart handoff) closes the whole workspace, utility panes included, and removes the marker. `describePanesLeftBehind` in `src/interactive/panes-runtime.ts` returns nothing on a Clio host socket for the same reason. Otherwise, `stopServerIfEmpty` decides whether the server stops. A stopped server takes its markers, the layout's disposable directories and, where the layout names one, herdr's own cleanup command with it. Before that cleanup the launcher reads the marker's summary (`readWorkspaceExitSummary`). The result is `{ status: "closed", exitCode, workspaceLeftRunning, exitSummary }`, and `maybeLaunchWorkspace` prints `exitSummary` in the operator's terminal.

Detection treats a process as hosted in Clio's own host only when `isClioHostSocket(HERDR_SOCKET_PATH)` matches a `clio-coder-<hash>` socket, so a launch from the operator's herdr opens a nested host instead of stopping. In guest mode inside its own host, the mux extension re-renders the managed config when `interface.outputDetail` changes and calls `server.reload_config` (`reloadHostChrome` in `config.ts`).

Two things are stated in the source and reflected in the code: the launcher process never boots Clio itself (the file header), and SIGINT is ignored while the client owns the terminal (`process.on("SIGINT", ignore)`).

## Peer prompt inbox

`deliverPeerPrompt(request)` in `src/domains/mux/peer-inbox.ts` hands a prompt to another Clio that this one opened. The file header states the reason: typing into a peer's terminal cannot be made safe, so the channel is a file inbox. The sequence in the function body:

1. Reject a `requestId` that does not match `REQUEST_ID` (a UUID shape) with `not-delivered`.
2. Reject a non-finite or negative `timeoutMs`.
3. Resolve the inbox directory from the token with `peerInboxDir`. A null result is `unavailable`.
4. Read the owner record with `readPeerInboxOwner` and require `owner.paneId === request.paneId` and `owner.socketPath === request.socketPath`.
5. If an earlier receipt exists for the id, return it.
6. Require `peerInboxOwnerState(owner) === "alive"`. Any other state is `unavailable`.
7. Validate the text with `validPeerPromptText`. The source limit is `PEER_PROMPT_MAX_BYTES` = 8192 bytes.
8. Write the request atomically with `safeResourceWrite` at mode 0600, under `requests/<id>`.
9. Poll for a receipt every `RECEIPT_POLL_MS` (100 ms) until the deadline or abort. On timeout or abort, unlink the request. If the unlink succeeds and no claim exists, the result is `not-delivered` with "taken back unread"; otherwise it is `unconfirmed`.

The `unavailable` helper is the central distinction. When the caller supplied a `requestId`, a failure is reported as `unconfirmed`, because an earlier copy may already have been admitted. Without a `requestId`, the same failure is `not-delivered`.

Caller: the `panes` surface in `tests/contracts/panes-tool.test.ts` imports the function, and `tests/extended/session-title-typed-input.test.ts` drives it with a stale token. Production callers were not traced beyond the import list, so this page does not name them.

The focused test `tests/extended/session-title-typed-input.test.ts` passes the initial inbox token, `paneId: "w1:p2"`, `socketPath: "/owned.sock"`, and a 300 ms timeout after an explicit empty `/new` has retired that generation. It asserts the result status is `not-delivered`, that the session still has no current conversation, and that no prompt was sent. This shows the stale-token rejection path. The assertion that the stale result is `not-delivered` relies on the token having no live inbox, which is the case the test sets up.

## Pane vocabulary

`src/domains/mux/operations.ts` is a leaf module that defines the operator and model pane vocabulary. `PANES_PRESETS` lists three presets: `files` (probes the `yazi` binary, install hint `clio-coder tools install yazi`), `logs` (`tail`) and `shell` (`bash`). `PANE_PEER_IDS` lists the fixed interactive peers: `clio`, `claude-code`, `codex`, `opencode`, `antigravity` and `pi`. The source comment says the pane tool never accepts an executable name.

`resolvePanesPresetId` returns the canonical id for a name, accepting the retired alias `yazi` through `PANES_PRESET_ALIASES`, and returns `null` for anything else. The focused test `tests/extended/panes-files.test.ts` asserts `PANES_PRESET_IDS` equals `["files", "logs", "shell"]`, that the alias map equals `{ yazi: "files" }`, that `resolvePanesPresetId("yazi")` and `resolvePanesPresetId("files")` both return `"files"`, and that `"htop"` returns `null`. The same test file checks the model-facing schema's `preset` enum.

The `PanesOperations` interface (`src/domains/mux/operations.ts:PanesOperations`) is the single operations surface that the `/panes` command and the `panes` tool drive, as the file header states. The bodies of those command and tool callers were not read for this page.

## Managed Yazi profile

`src/domains/mux/yazi/profile.ts` maintains a Clio-owned Yazi configuration under the cache directory. `yaziProfileDir` returns the profile path without creating the cache root. `inspectYaziProfile` builds the expected inputs with `expected(options)`: the asset directory, `src/domains/mux/yazi/assets/yazi.toml`, the keymap rendered with `renderYaziKeymap(yaPath)`, the theme from `renderYaziTheme()`, and a stamp of Yazi version, Clio version, `yaPath`, the SHA-256 of the asset tree and the SHA-256 of the theme. It reads the stored stamp with `readStamp` and compares it with `sameStamp`, which requires all five fields to match, and checks the profile files exist with `profileFilesExist`. The result is one of the `YaziProfileState` values: `current`, `stale`, `missing` or `generation-failed`. Inspection does not write.

`ensureYaziProfile` (`src/domains/mux/yazi/profile.ts:ensureYaziProfile`) is the generating path. The function body beyond its signature was not read, so this page does not describe its write sequence or when it returns null.

The focused test `tests/contracts/doctor-yazi-repair.test.ts` imports from this area, and the grep for profile symbols matched it. Its assertions were not read for this page.

## Enforced boundaries

- The contract never throws to its callers. Non-transport errors do not change health. Transport and timeout errors mark the runtime degraded for 5 seconds (`src/domains/mux/contract.ts:createMuxRuntime`).
- Ownership: only panes that carry an owner token are acted on by the runtime's pane methods, and `closePane` refuses a pane Clio did not create (`src/domains/mux/contract.ts:MuxContract` doc comment). The per-method check bodies were not read.
- Peer delivery binds the inbox to pane and server identity before writing (`src/domains/mux/peer-inbox.ts:deliverPeerPrompt`).
- Dock refusal happens before a split reaches the wire (`src/domains/mux/dock-controller.ts:planDockOpen`).

## Things to watch when editing

- The `attempt` wrapper is the only place that converts errors into fallbacks. A new contract method that calls `client` directly, outside `attempt`, would throw to its caller.
- `DOCK_SPECS` values are tied to the rendered layouts the source comments describe (the workers floor to the fleet dashboard, the music floor to cliamp's spectrum height). Changing a floor changes the refusal threshold in `planDockOpen`.
- The peer inbox distinguishes `not-delivered` from `unconfirmed` based on whether a `requestId` was supplied. Callers that retry must pass the same id.
- The owner token constants and the legacy keys are both read by ownership checks. Removing the legacy match would stop recognizing panes left by older sessions, as the comment in `src/domains/mux/contract.ts` says.
- The `cliamp/` directory was not read for this page; edits there are not covered by the behavior described here.
- `src/domains/mux/workspace/platform.ts` is the seam between the POSIX and Windows hosts. `launch.ts` must take every host path, argument and environment variable from `hostLayout()`, never derive one itself.

## Related pages

- [Interactive surfaces](../interactive/surfaces.md) and [Interactive renderers](../interactive/renderers.md) cover the consumers of the pane vocabulary only at the level of their names; this page did not inspect them.
- [Session control](../session-control.md) is referenced by the session-title test above; its contents were not read for this page.

## Coverage gaps

The following central workflows were not inspected in full:

- The bodies of `createMuxBundle` in `src/domains/mux/extension.ts`, which decides how the module's gating reaches the runtime.
- The body of `ensureYaziProfile` (write sequence and failure return) and the remaining methods of the dock controller (`hide`, `show`, `adopt`).
- The per-method owner checks inside `createMuxRuntime`, and the `paneRecord` and registry reconciliation.
- Production callers of `deliverPeerPrompt` and `launchWorkspace`, beyond the test imports.
