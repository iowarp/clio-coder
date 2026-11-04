---
title: "Command-line surfaces"
summary: "Describes the modal overlay surfaces under src/interactive/overlays: the shared tabbed list view, the Library browser and its review gate, the /interop peer surface, the ask-user interview, the model picker, the settings center and the library-model projection. Read this when changing one of these screens or the way they hand keys, state or writes to the session."
sources:
  - "src/interactive/overlays/list-overlay.ts"
  - "src/interactive/overlays/library.ts"
  - "src/interactive/overlays/library-review.ts"
  - "src/interactive/overlays/library-model.ts"
  - "src/interactive/overlays/interop.ts"
  - "src/interactive/overlays/ask-user.ts"
  - "src/interactive/overlays/model-selector.ts"
  - "src/interactive/overlays/settings.ts"
  - "src/interactive/overlay-model-selectors.ts"
symbols:
  - "ListOverlayView"
  - "openListOverlay"
  - "openLibraryOverlay"
  - "openLibraryReviewOverlay"
  - "openLibraryImportOverlay"
  - "buildLibraryRows"
  - "interopOverlaySurface"
  - "openInteropOverlay"
  - "openAskUserOverlay"
  - "AskUserOverlayView"
  - "openModelOverlay"
  - "buildModelItems"
  - "openSettingsOverlay"
  - "parseNumberSetting"
tests:
  - "tests/extended/library-browser.test.ts"
  - "tests/extended/ask-user-layout.test.ts"
  - "tests/contracts/ask-user-tool.test.ts"
  - "tests/contracts/settings-target-wizard.test.ts"
invariants:
  - "The Library browser reads and reviews only; a managed change is written only through a plan the operator reviews and accepts, and closing the browser releases any pending review's staged source."
  - "A list overlay with tabs re-reads each tab's rows on switch, and its title names the active tab."
  - "The Library list opens with an explicit activeTabId equal to the browser's category, so the tab shown and the category acted on agree."
  - "The /interop surface reads proposals and configured peers from one contract snapshot so Detected and Configured describe the same moment."
  - "In the /interop overlay, the adoption plan is written only by the y key while a plan is pending, and a plan is discarded by b, by a reset, or by closing the overlay."
  - "A settings number row whose submission fails its rule keeps the editor open with a 'Not applied:' refusal and does not commit; a value that passes is committed through the apply path."
  - "An unattended ask-user round, when opened with an unattended window, closes as timedOut when no key arrives within that window; any key received before expiry holds the countdown instead."
  - "Within an ask-user round opened with inputGuardMs, keys other than Esc are ignored until the guard window elapses."
validate:
  - "pnpm run test:file -- tests/extended/library-browser.test.ts"
  - "pnpm run test:file -- tests/extended/ask-user-layout.test.ts"
  - "pnpm run test:file -- tests/contracts/ask-user-tool.test.ts"
  - "pnpm run test:file -- tests/contracts/settings-target-wizard.test.ts"
  - "pnpm run typecheck"
---

# Command-line surfaces: modal overlays for the interactive session

This area holds the modal screens an operator opens over the interactive session. It includes the
shared full-screen list used by several browsers, the Library browser with its review and import
gates, the `/interop` view of other coding agents on the machine, the ask-user interview, the model
picker, the settings center, and the library-model projection. Read this page when you change one of
these screens or how it hands keys, state or writes to the rest of the session. The per-widget
rendering rules live on [Interactive renderers](renderers.md), and the slash commands that open these
overlays are described on [Session control](../session-control.md).

## Shared list overlay

`src/interactive/overlays/list-overlay.ts` defines the data shapes and the view that most list
surfaces use. `ListOverlayItem` carries an `id`, a themed `label`, optional two-column `cells`, a
`group`, and a lazily computed `detail` function that receives the pane width. `ListOverlayTab`
owns its own `items()` callback, so the rows are rebuilt on each switch rather than served from a
snapshot taken when the overlay opened. `ListOverlayOptions` is the single configuration object:
it holds the title, `tabs`, `activeTabId`, `onTabChange`, `filterable`, `explicitSearch`,
`layout` (`stack` or `split`), `onSelect`, keyed `actions`, `globalActions`, `hints`, and empty
state wording.

`ListOverlayView` is the stateful class behind the overlay. Its constructor sets the filter focus
from `filterable` and `explicitSearch`, and it keeps the live item set separately from
`options.items` so a data source can replace rows through `setItems` without losing the selection
or the detail scroll. The filter result is memoized because the item set is fixed per query. The
detail pane is memoized per item, width and epoch.

`openListOverlay` in the same file is the entry point. It takes `options` plus a required
`markerId`, builds a `ListOverlayView`, mounts it through `showClioOverlayFrame`, and extends the
returned handle with `setItems`, `refreshTabs`, `setActiveTab`, `activeTabId`, `selectById`,
`toggleDetail`, `openDetail` and `clearFilter`. The `markerId` names the mounted modal rather than
being derived from the title, because the title of a tabbed overlay changes with the active tab.
`fullScreen` switches the frame to full width and feeds the terminal row count into the view
through `setViewportRows`.

## Library browser

`openLibraryOverlay` in `src/interactive/overlays/library.ts` is the Library browser. Its
`LibraryOverlayDeps` interface is the injection surface: `lifecycle` is the package lifecycle port,
and `readInventory`, `readPairs`, `inspectCopy`, `openReview`, `openImportReview`, `openList`,
`planImport`, `applyImport` and `scheduleInitial` default to the shared implementations and exist
so tests can replace them. The browser's `view` object holds the current category (`tab`), mode
(`browse` or `installed`) and scope (`user` or `project`), read from `initialTab`, `initialMode`
and `initialScope`.

The browser opens a `list` overlay through `deps.openList ?? openListOverlay`, with `markerId:
"library"`, `fullScreen: true` and `layout: "split"`. It passes `activeTabId: view.category`
explicitly. The inline comment in the file records why: the list defaults to its first tab while
the view's category defaults to plugins, and letting them disagree drew one tab's rows under
another tab's name and pointed actions at the wrong category.

Key handling is split between `globalActions` (for `n`, `b`, `s`, `o` and `R`) and per-row
`actions` (for `v`, `i`, `u`, `r` and `e`). The `o` key calls `deps.openImport` and is refused with
a warning when that dependency is absent. `i`, `u`, `r` and `e` call a `manage` function with an
operation name. `manage` resolves the selected subject through `requestRefFor`, which turns a row
into a package reference or a reason it cannot be managed (a core component, or a component found
directly in a resource root). The `e` key chooses `enable` or `disable` from `subjectEnabled`,
which reads the copy's enabled flag for the current scope.

When the browser is opened with a focus or an intent (from `/library inspect <ref>` or
`/library install <ref>`), `start` runs once through `scheduleInitial`. It matches the focus
against the row set's subjects, then calls `handle.selectById` and, if an intent was given,
`manage(intent, ...)`. A focus that matches nothing produces a warning notice and no selection.
The `start` comment states that the deferral keeps the browser's own handle from overwriting a
review that would otherwise open during construction; the injectable default is one microtask.

`hide()` on the returned handle sets `closed`, takes the pending review in `child` and calls its
`release()` before `hide()`. The comment says this releases a staged source that would otherwise
stay in the temp tree.

### Row construction

`buildLibraryRows` in `src/interactive/overlays/library-model.ts` turns one inventory read into a
`LibraryRowSet` (`items`, `subjects`, `notices`, `truncated`). Its `LibraryRowOptions` carry the
`inventory`, the `view`, and optional `inspection`, `failure` and `pairs`. Every record is passed
through `safeInventory`, `safeRecord` or `safe` at the top of the function, so display neutralization
happens once at this seam. Its doc comment describes the two modes: browse lists install targets,
and installed lists what the machine has. Browse rows state their installed copies, and installed
rows state their origin.

When a member is drilled into (`view.member` with an `inspection`), the function emits one row per
resource, one `companion file` notice per ancillary item, and one notice per inspection diagnostic.
Otherwise browse mode lists `inventory.packages` and the row's `subject` is a `package` record. Row
ids are derived from the ref and scope (for example `pkg:<ref>`), and `push` adds each row to the set.
The status line and detail panes are built from the same subjects. The row-level rules beyond these
branches were read only at their structure; this page does not describe the full status-chip
ordering.

Tests cover the row builder through `tests/extended/library-browser.test.ts`, which imports
`buildLibraryRows`, `libraryStatusLine`, `formatLibraryPlanReview` and `formatLibraryOutcome` along
with a plan fixture from `tests/harness/library-plan-fixture.ts`. This run did not read the individual
assertions in that file, so no specific test case is cited here.

### Review and import gate

`src/interactive/overlays/library-review.ts` exports `openLibraryReviewOverlay`, which takes an
`OpenLibraryReviewOptions` with a `plan`, `columns`, a `commit` callback and a `retryRefresh`
callback. It delegates to a shared `openReviewOverlay` helper. The `commit` callback is invoked only
after the operator accepts; the wrapper stores the result in a local `applied` variable and returns
a renderer for the outcome. `onCancel` is documented in the options as the point where nothing has
been written and the caller releases the staged source. `onDone` is invoked only when `applied` is
set, so an operator who cancels does not get a completion callback.

`openLibraryImportOverlay` applies the same gate to an explicit import named on the command line.
Its doc comment states that the source given to `/library import <path-or-url>` is the one planned
and reported; the local-agent discovery surface is a separate entry point. The import path carries
an `outcome` projection so the import result can be shown in the same outcome widget.

The browser module comment states the division of responsibility: the browser reads and reviews,
and every managed change goes through a plan the operator sees first.

## Interop peers

`src/interactive/overlays/interop.ts` renders `/interop`, the list of other coding agents detected
on the machine. Its module comment names the operator's two questions: which agents are connected
as delegation peers, and what can be adopted from each. The file's constant `INTEROP_EMPTY` is the
empty-state wording, and the group names `Proposed`, `Detected`, `Connected`, `Declined`,
`Inventory`, `Not installed` and `Adoption plan` are declared at the top of the file.

`InteropOverlayDeps` declares `report`, `proposals`, `configured`, `accept`, `decline` and
`onClose`. `interopOverlaySurface(interop, notify)` builds the first five from an `InteropContract`.
Its `proposals` reads the last report before asking the contract for proposals. `accept` calls
`interop.accept([kind])` and notifies once per wired id and once per diagnostic. `decline` calls
`interop.decline([kind])`. The surface's doc comment explains why `configured` and `proposals` come
from one contract: reading the wired peers from the settings snapshot previously lagged the
proposals by a config-watcher tick.

`openInteropOverlay(tui, ctx, onClose)` is the opener. It takes the surface from `ctx.interop`,
falling back to an empty report and empty lists when no surface is wired. It wraps `deps.report` so
a fresh detection result, once it arrives, takes precedence over the original report.

Adoption state lives in three local variables: `settings` (the destination `scope`, `user` or
`project`, and an optional kind `filter`), `pending` (the reviewed plan, or undefined), and `items`.
The `u`, `p` and `c` global keys change `settings.scope` or cycle `settings.filter` through
`KIND_CYCLE`, then call `reset()`. Each of these keys posts an informational notice.

The adoption flow has three steps:

1. `preview` runs on the `i` key. It acts only on rows whose id begins with `inventory:` and whose
   text is not `NOTHING_ADOPTABLE`. It finds the agent's inventory in `deps.report()`, then calls
   `planInteropAdoption({ host, inventory, scope, kind? })` and stores the result in `pending`. It
   clears the filter and replaces the rows with `planItems(pending)`, which puts the `approval` row
   first and one `plan:<index>` row per entry, then selects `approval`.
2. The `y` key, handled only when `pending` is set, takes the plan, clears `pending`, and calls
   `applyInteropAdoption(plan, true)`. It posts a notice per installed id and a warning per
   diagnostic, then calls `reset` with the inventory row for the plan's host as the return target.
3. The `b` key, handled only when a plan is pending, calls `reset` with the same return target, so
   the cursor goes back to the inventory the plan came from without applying anything.

`reset(returnTo?)` clears `pending`, rebuilds `items` with `buildItems`, replaces them through
`handle.setItems`, and reselects `returnTo` when one is given. The comment on `reset` states that the
rows are replaced rather than mutated: the view memoizes its frame on the row set, and a mutated array
left an accepted or declined agent under its old group until the next keystroke.

The `a` and `d` keys call `decide`, which acts only on rows whose id begins with `proposal:`, passes
the kind to `deps.accept` or `deps.decline`, and then calls `reset()`. The `hints` callback shows the
`y` and `b` hints while a plan is pending and the `a` and `d` hints on a proposal row. `close` sets
`closed`, clears `pending` and calls `onClose`.

Detection runs once more in the background through `detectInteropAgents({ inventory: true,
probeVersion: true })`. The result is stored in `fresh`, and rows are rebuilt only if the overlay is
still open and no plan is pending. A rejected detection posts a warning notice.

## Ask-user interview

`src/interactive/overlays/ask-user.ts` exports `openAskUserOverlay(tui, deps)`, which constructs an
`AskUserOverlayView` and mounts it through `showClioOverlayFrame` with `markerId: "ask-user"`,
`adaptiveHeight: true`, and a `title` function that shows the interview title or a classified
decision title. It returns an `AskUserOverlaySession`. Its `ask(questions, presentation, round)`
delegates to `view.begin`, and its `close` (also bound to `hide`) calls `view.close()` before
releasing terminal selection and hiding the frame.

`AskUserRoundOptions` declares the round behaviors. `inputGuardMs` sets `inputGuardUntil` in
`begin`, and `handleInput` drops every key except Esc until that time passes. `unattended` carries a
`windowMs` and optional timers. `startCountdown` creates an unattended countdown only when
`windowMs` is greater than zero. On expiry it syncs the active control and calls
`finish({ answers: this.answers(), timedOut: { afterSeconds } })`, so the operator's committed answers
are kept and the remaining questions are filled by the tool. Any key received during the window
calls `countdown.hold()` before the guard check, so the countdown stops even when the key is dropped
by the guard.

`begin` returns a cancelled result when the view is closed, and returns an unavailable result when a
round is already on screen. `finish` cancels the countdown, clears the list and text controls, pushes
answers into the history for non-cancelled results, and resolves the pending promise. `close` marks
the phase `closed` and finishes as cancelled.

The tool side is tested in `tests/contracts/ask-user-tool.test.ts`. Its test named "answers a round
nobody answered with its recommended options, closes the interview, and says so" builds a fixture
whose round resolves with `timedOut: { afterSeconds: 300 }` and asserts that the result has
`event: "round_auto_resolved"`, `status: "complete"`, auto-filled answers, and an `unattended` detail
of `{ afterSeconds: 300, autoResolved: 2 }` for two questions. The same file also covers the yolo case.
`tests/extended/ask-user-layout.test.ts` builds a fake session in place of `openAskUserOverlay` and
passes an `unattendedMs` value; this page covers only that harness shape, not its layout assertions.

## Model selector and model overlay wiring

`src/interactive/overlays/model-selector.ts` exports `openModelOverlay`, `modelsForTarget` and the
`ModelSelection` and `ModelRow` types. `modelsForTarget` returns `modelIdsForStatus(status)`, so live
discovery takes precedence when it is available.

`buildModelItems(deps)` builds the `rows` and `summary` for the picker from `deps.settings` and
`deps.providers`. It reads the active target and model from `settings.chat`, derives `favoriteSet`
from `chat.modelPicker.favorites`, and `recentSet` from `listRecentModels`. It keeps only providers
whose runtime passes `isOrchestratorEligibleRuntime`, then sorts them with the active target first,
then `statusPriority` (healthy and available first, down last), then runtime display name, then id.
For each provider it takes `modelCandidatesForStatus`. When there are no candidates, it emits one
non-selectable row with `model: ""`, `source: "missing"`, and a `model-not-configured` diagnostic
unless the target has a `defaultModel`, in which case `resolveOverlayRuntimeTarget` resolves that
default and supplies its capabilities and thinking display. `resolveOverlayRuntimeTarget` calls the
same `resolveRuntimeTarget` used by the footer and chat loop, with `use: "orchestrator"` and
`requireTools`, `requireStreaming` and `requireOutputBudget` set. When resolution fails, it falls back
to the status capabilities through `fallbackCapabilityDecisions`. `buildSummary` counts only
`selectable` rows as local or cloud models.

`openModelOverlay` is opened from `src/interactive/overlay-model-selectors.ts`, where
`createOverlayModelSelectors` resolves `openModel` from injected dependencies or the module default.
Its `openModelOverlayState` returns early unless the overlay transition state is `closed`. It calls
`openModel` with `onSelect`, which closes the picker and opens the scope dialog, `onToggleFavorite`,
which rewrites `chat.modelPicker.favorites` through `writeSettings` (`writeSettings` is called at
line 92 of that file), and `onClose`. The scope dialog's `onChoose` applies the selection and then the
thinking level, and reports a refused save as an error notice without changing the route. Row layout,
capability badges and the filter (`filterModelRows`) were not traced beyond their names, so this page
does not describe their rules.

## Settings center

`src/interactive/overlays/settings.ts` is the largest module in this area. It exports the
settings-overlay types (`EditableSettingId`, `SettingsCenterRowId`, `SettingsNavigationDepth`,
`SettingsPresentationKind`) and the submenu builders used for text, number, enum-list, target and
model edits.

`openSettingsOverlay(tui, deps)` is the entry point. Its `deps` supply `getSettings`, `writeSettings`
or `commitSetting`, and optional providers, fleet nodes, route breakers, interop proposals, and the
target wizard. It builds the rows with `buildSettingItems(deps.getSettings(), buildOptions)` and
creates a `SettingsCenter` whose `prepareChange` callback is `createSettingsChangePlan`. Its `onApply`
callback is the write path: when `commitSetting` is provided it commits each changed leaf path, and
otherwise it calls `writeSettings(plan.proposed)`. After a committed change it posts a success notice
and refreshes the rows through `refreshSettingItemsInPlace`. The comment on `onApply` states that only
a committed edit reaches the notice and the shortcut update. `onAddTarget` and `editTarget` launch the
target wizard through `openTargetWizard`. A test in `tests/contracts/settings-target-wizard.test.ts`
covers that wizard; this page does not read its assertions.

The `delegation.agents` row is produced by `delegationAgentsAffordance`. With no agents and no interop
proposals it is read-only, with the affordance "edit settings.yaml". Otherwise it opens a picker whose
choices are `add <kind>` for each proposal and `remove <id>` for each configured agent. Its doc comment
says that adding writes the same entry `configure --interop` would, and that removing stops the
`/delegate` id from resolving.

Number rows use `NUMBER_SETTING_RULES`, a map from setting id to `min`, optional `max`, `integer`, and
`allowBlank`. The bounds are documented as mirroring the config validator's. `editNumberSubmenu` builds
the editor. On submit, `parseNumberSetting` either returns `{ value }` or `{ refusal }`. A refusal reads
"Not applied: expected an integer >= 1, got 0." and is shown through `wrapper.setProblem` while the
input stays open. A value that passes is handed back to the row, and a blank value on a rule with
`allowBlank` returns `null`, which clears the key. Esc leaves without applying. The same
`parseNumberSetting` is called at the apply path (line 2264 of `src/interactive/overlays/settings.ts`), so the editor and the
apply path use one bound.

`parseEnumListSetting` applies the same refuse-in-place rule to comma-separated activation lists: an
unknown entry or a duplicate is refused with `Not applied:` and the editor stays open.

The tests that cover this editor were not identified. A repository-wide search for
`openSettingsOverlay`, `parseNumberSetting` and the `Not applied: expected` wording found no test file
in `tests/` that references them, so the number-rule behavior is supported by source reads only.

`src/interactive/overlays/library-model.ts` supplies `buildLibraryRows`, `libraryStatusLine` and
`libraryRowActions` to the Library browser. Its exported group constants (`LIBRARY_GROUP_INSTALLED`,
`LIBRARY_GROUP_AVAILABLE`, `LIBRARY_GROUP_MEMBERS`, `LIBRARY_GROUP_UNMANAGED`, `LIBRARY_GROUP_NOTICES`)
are the group names the rows use. The row-builder branches are summarized under the Library browser.

## Things to watch when editing

- Library mutations must stay behind a reviewed plan. `src/interactive/overlays/library.ts` reads and
  dispatches; the write happens in the `commit` callback that `src/interactive/overlays/library-review.ts`
  calls after acceptance. A new write path that skips review would break the contract the module
  comment states.
- The Library tab switch resets the selected member, the pending requirements flag and the cached
  inspection (`onTabChange` in `src/interactive/overlays/library.ts`). A change that keeps one of those
  across tabs can show rows for one category under another category's name.
- `ListOverlayView` keeps selection and detail scroll through `setItems`. Replacing `options.items`
  directly, instead of calling `setItems`, skips the item epoch that the render memo depends on.
- `openListOverlay` requires `markerId`. Omitting it or deriving it from a tabbed title makes the
  modal identity change on tab switches.
- Interop accept and decline go through the contract, not through the settings snapshot. Keep the
  proposal and configured reads on one source, as the surface constructor does. Replacing the row set
  in place rather than through `setItems` leaves the view's memoized frame stale, as the comment in
  `openInteropOverlay` describes.
- The interop adoption plan is a projection held in `pending`. Changing `reset` to skip clearing
  `pending`, or applying a plan from any key other than `y`, would bypass the approval row the operator
  reviews.
- Number-row bounds are duplicated in intent with the config validator. `NUMBER_SETTING_RULES` is the
  rule both the editor and the apply path use, so a bound change must be made there and in the
  validator together, which this page does not verify.
- Close paths must release resources. `openLibraryOverlay`'s `hide()` releases a pending review's
  staged source before hiding it, and `openAskUserOverlay`'s `close` releases terminal selection. A
  new modal child should follow the same pattern.
- An ask-user round's `inputGuardMs` drops keys other than Esc, but the countdown `hold()` runs before
  that guard. Reordering those two lines would change whether a dropped key still holds the countdown.
