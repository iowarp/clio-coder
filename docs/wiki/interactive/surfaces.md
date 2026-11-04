---
title: "Command-line surfaces: extension workspace, ambient, and dock rendering"
summary: "How the interactive terminal draws operator-extension views: the floating workspace stack, the ambient event subscriber, the extension dock host, and the shared view renderer. Read this before changing how an extension's view, island, band, dock or panel reaches the screen."
sources:
  - "src/interactive/surfaces/view-renderer.ts"
  - "src/interactive/surfaces/registry.ts"
  - "src/interactive/surfaces/ambient.ts"
  - "src/interactive/surfaces/extension-dock.ts"
  - "src/interactive/interactive-application.ts"
symbols:
  - "renderView"
  - "createWorkspaceSurfaces"
  - "WorkspaceSurfaces"
  - "createAmbientSurfaces"
  - "AmbientSurfaces"
  - "hasExtensionDrawing"
  - "createExtensionDockHost"
  - "ExtensionDockHost"
invariants:
  - "renderView clamps its output to the requested width and, when maxRows is given, keeps at most maxRows lines, replacing the last kept line with a muted 'N rows cut' marker."
  - "The workspace island stack is shown only when at least one island or board exists for the active workspace, and its overlay is composited hidden when the terminal is narrower than 80 columns or shorter than 18 rows, or when a host overlay is open."
  - "createAmbientSurfaces ignores subscriber events after dispose and aborts any running interview on dispose."
  - "A text-only extension output is written to the transcript only when none of its drawing keys is set."
validate:
  - "pnpm run typecheck"
---

# Command-line surfaces

This area is the terminal side of operator-extension output. An extension publishes a `View` (a tree of boxes, tables, lists, boards, and similar nodes) and the interactive application draws it in the places the operator sees: a floating workspace stack, an ambient card or toast, the extension dock pane, or the pressable panel. Read this page when a change touches how any of those places is drawn or when an extension view draws incorrectly.

The area has four modules under `src/interactive/surfaces/`, and the core `View` type and its producers live in `src/domains/extensions/`, documented on the [interactive overlays](overlays.md) and [extensions](../domains/extensions.md) pages. Rendering primitives are shared with the [theme](theme.md) and [renderers](renderers.md) pages.

## What each module owns

- `src/interactive/surfaces/view-renderer.ts`: `renderView(view, width, options)` converts a `View` into `RenderedView` (`lines` plus `targets`). Targets are the pressable regions (row, column, width, action, optional key) that a later press can resolve. Internal helpers (`draw`, `drawBox`, `rowWidths`, `sideBySide`, `proportional`, `naturalWidth`) lay out boxes horizontally (`dir: "row"`) and vertically, using `grow`, `width`, `gap`, and `pad` from the box node.
- `src/interactive/surfaces/registry.ts`: `createWorkspaceSurfaces(deps)` builds the `WorkspaceSurfaces` object. It owns the banner part, the board band, the composer rail segment, the footer line, status facts, the leader targets for the active workspace, and the floating island stack. Its exported constants `WORKSPACE_LEAVE_KEY` (`"b"`) and `WORKSPACE_FOCUS_KEY` (`"j"`) are leader suffixes it reserves.
- `src/interactive/surfaces/ambient.ts`: `createAmbientSurfaces(deps)` subscribes once to the operator extension surface model and routes each event (toast, card, panel, dock, interview, prompt, workspace) to a host action. It also exports `hasExtensionDrawing(output)`, which decides whether a text fallback is needed.
- `src/interactive/surfaces/extension-dock.ts`: `createExtensionDockHost(deps)` manages the dock pane in a terminal multiplexer. It writes the rendered frame to a per-session file, watches a tap file for size and press events, and exposes `open`, `update`, `close`, `onPress`, and `dispose`.

## Callers and composition

`src/interactive/interactive-application.ts` composes all four. Its wiring, read, is:

- `createWorkspaceSurfaces` is called only when `operatorExtensions` exists. It receives the surface model, the TUI, a skin lookup, the leave hint built from the leader key, an overlay-open predicate, a rows-above-composer callback, and the press, leave, and focus-board callbacks. The `focusBoard` callback calls `ambientSurfaces.focusRegion(..., "board")` and posts an info notice when that returns false.
- `createAmbientSurfaces` is also gated on `operatorExtensions`. It receives `operatorExtensions` as its `operator` dependency, a dock host built by `createExtensionDockHost` with the multiplexer and the session id, and callbacks for notices, card appends, text fallback, and filling or submitting the editor.
- The interview path in the same file calls `renderView` directly for the interview intro (around the `renderIntro` option at line 701 of the application file).

The workspace surfaces are passed into the presentation through the `workspaceSurfaces` option of `createInteractivePresentation`. The presentation reads `banner`, `board`, `rail`, `footerLine`, `statusFacts`, `yieldsTaskIsland`, and `leaderTargets` from that object.

## Workspace surfaces: the registry

`createWorkspaceSurfaces` reads the active workspace from `deps.model.activeWorkspace` and each part's view from `deps.model.entry(extensionId).regions`. Every part is painted at render time through a memo keyed on the model version, the skin epoch, the active extension and workspace identifiers, and a per-slot extra string such as the width or the island budget. A cache hit returns the stored lines without re-rendering.

The floating stack is an overlay. `refresh()` decides whether a stack exists by calling `islandLines(ISLAND_STACK_ROWS)`. If the result is non-empty and no handle exists yet, it calls `deps.tui.showOverlay` with `anchor: "top-right"`, width 48, `nonCapturing: true`, and a `visible` predicate that checks terminal width at least 80, height at least 18, and `deps.isOverlayOpen()` being false. When the stack empties, `refresh()` calls `setHidden` on the existing handle. The row budget for each render is `islandBudget()`, which is the rows above the composer minus 2, capped at 28, or 28 when the callback returns null.

`islandLines` adds the board island first when `active.board === "island"` and the board region is present, then one island per entry in `deps.model.entry(...).islands` when the `islands` region is taken. Each island is added only if it fits in the remaining budget; the loop stops at the first island that does not fit. Islands are drawn with `frame` at inner width 44 (width 48 minus 4) and body height 12.

The skin follows the workspace. The model subscription in `createWorkspaceSurfaces` calls `applySkin` with the skin from `deps.skinFor` on a workspace event with an active workspace, and calls `applySkin(null)` when a previously skinned workspace is left or dropped. `dispose()` unsubscribes, hides the island handle, and clears any skin it applied.

`yieldsTaskIsland()` returns true when the active workspace uses the `islands` region or the `island` board placement; the host uses it to decide whether the task island stays in the top-right corner. `leaderTargets()` returns the workspace's declared keys (excluding `b` and `j`), then `j` when a board is pressable and `focusBoard` is provided, then `b` as "Leave <title>".

## Ambient surfaces: the subscriber

`createAmbientSurfaces` subscribes to `operator.surface` once. Each event is routed by `kind`:

- `toast` posts a notice with a 12000 ms TTL, keyed per extension.
- `card` appends a framed block through `appendCard`, with at most 22 rows.
- `panel` calls `openPanel(id, "panel")`. `dock` tries `dock.open`, and falls back to `openPanel(id, "dock")` when the dock is unavailable or the open returns false.
- `interview` is queued in `interviews`. The queue drains one interview at a time through `runExtensionInterview`, using the overlay's ask-user state.
- `prompt` either fills the editor with `fill` or submits it with `submit`.
- `workspace` is accepted and does nothing beyond the trailing `refresh()`.

Every event ends with `refresh()`. `refresh()` pushes the dock view to `dock.update` when the dock owner's view has changed, requests a render, and schedules `flush` on a microtask. `flush` only opens a panel when the overlay state is `closed`. It builds a panel from `operator.surface.entry(owner).panel` or, for dock kind, wraps `entry.dock` as a panel titled "Dock". Presses in the panel go to `operator.action` with `source` set to `panel`, and a failing or returned `ExtensionOutputV2` text is shown through `showText` when `hasExtensionDrawing` is false.

`focusRegion` is the path used by the workspace board. It refuses (returns false) when the overlay is not closed or the region view is undefined. Otherwise it opens the extension view panel with a `panel` getter that reads the region view on every call, so the panel follows updates while it is open.

`dispose()` marks the subscriber disposed, unsubscribes, unregisters the dock press listener, aborts the interview controller, clears the interview queue and pending panel, closes the owned panel, and awaits `dock.dispose()`.

## Dock host and the multiplexer

`createExtensionDockHost` works only when `deps.mux` is non-null and `mux.available()` is true. Without a multiplexer, `available()` is false and `open` returns false, so ambient surfaces fall back to the in-terminal panel.

The host keeps one `owner` (extension id, title, view) and one frame. `draw()` renders the owner's view with `renderView(owner.view, width, { maxRows: 400 })`, builds an `ExtensionDockFrame` with an incremented `seq`, and writes it through `writeExtensionDockFrame`. The width starts at 48 and is replaced by the size tap from the viewer, or by `mux.paneWidth` after the pane opens, capped at 4096.

`open` runs through a serial queue. If the session file changed, it closes the old pane and rebinds the tap watcher. It then adopts any existing extension pane, closes a surviving adopted pane whose dock key does not match the current frame file, writes the frame, and either shows a hidden dock with `mux.showDock` or opens a new utility pane running `extensionViewerCommand` with the frame and tap paths. The viewer reports press events back through the tap file. `decodeDockTap` parses those lines; a press is delivered to listeners only when its `seq` equals the current frame `seq` and its action and key match a target in the current frame. A `hide` tap closes the pane when dock visibility is closed, and otherwise hides the dock.

## Shared renderer

`renderView` returns an empty result for width 0. Otherwise it calls the internal `draw`, then `fit` to the width, then applies `maxRows`. When lines exceed `maxRows`, it keeps `maxRows - 1` lines and appends one muted line reading "N row(s) cut", and it filters targets to rows still visible. A `maxRows` of 0 returns no lines. The `draw` switch dispatches on `view.t`, and `TONE_ROLES` maps each `ViewTone` to a semantic theme role.

The module imports `VIEW_LIMITS` from `src/domains/extensions/view-limits.ts`. This page covers the renderer's entry points and layout helpers; the body of each `view.t` case beyond the first 140 lines was not read and is not described here.

## Focused tests

A repository-wide search of the `tests` directory and of all test files for `renderView`, `createWorkspaceSurfaces`, `createAmbientSurfaces`, `createExtensionDockHost`, `hasExtensionDrawing`, or the `surfaces/` path returned no matches. The coverage of this area is therefore source-only. The statements above are derived from the source files listed in this page's `sources` and not from any test assertion.

## Things to watch when editing

- The island stack is placed by screen row from the top, so the `islandBudget` value and the composer-rows callback control which islands survive a short frame. Changing `ISLAND_STACK_ROWS`, `ISLAND_MIN_ROWS`, or the row budget changes which islands are dropped.
- `refresh()` decides overlay creation from the unbudgeted stack, but `islandComponent.render` applies the budget on every frame. A stack can exist and draw nothing on a short frame.
- The memo key does not include the island budget for the `band` slot; the board slot uses only `width`. Any change that depends on a different input must extend the key, or the cached lines will be stale.
- The dock frame carries `seq`. A press is accepted only when its `seq` equals the current frame `seq`, so any change that writes the frame without incrementing `seq` will silently discard presses from the viewer.
- Presses from the workspace and the dock go through different `source` values (`leader`, `board`, `panel`, `dock`). Those values are passed to the operator action path and are not interpreted by this module.
- The dock and the panel are alternatives: `open` falls back to the panel path whenever the dock is unavailable or cannot open, so a change to dock behavior must keep that fallback reachable.

## Related pages

- [Interactive overlays](overlays.md) owns the overlay lifecycle that `isOverlayOpen`, `openExtensionViewPanelState`, and `openAskUserOverlayState` depend on.
- [Interactive status](status.md) and [interactive footer](footer.md) own the host surfaces that receive the banner, rail, footer line, and status facts.
- [Extensions](../domains/extensions.md) owns the `View`, surface model, and operator extension action types that this area consumes.
