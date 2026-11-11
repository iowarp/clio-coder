---
title: "Interactive footer: compact line, expanded pages and notices"
summary: "The live region under the interactive prompt: the compact status line, the one expanded dashboard page, the notification center, the spend and context readers, and the local machine sampler. Read this when changing what the footer shows or when it refreshes."
sources:
  - "src/interactive/footer/dashboard.ts"
  - "src/interactive/footer/pages.ts"
  - "src/interactive/footer/widgets.ts"
  - "src/interactive/footer/notifications.ts"
  - "src/interactive/footer/spend.ts"
  - "src/interactive/footer/context-rail.ts"
  - "src/interactive/footer/system-metrics.ts"
  - "src/interactive/footer/demo-hints.ts"
symbols:
  - "buildFooterDashboard"
  - "FooterDashboardDeps"
  - "FooterDashboardPanel"
  - "renderCompactDashboard"
  - "dashboardPageViewport"
  - "createNotificationCenter"
  - "topNotification"
  - "footerTelemetry"
  - "contextRailHint"
  - "createLocalMachineSampler"
  - "createDemoHints"
tests:
  - "tests/contracts/footer-machine-sampling.test.ts"
  - "tests/contracts/footer-responsive-pages.test.ts"
invariants:
  - "The footer has two modes: compact and one expanded dashboard page. `toggleExpanded` flips between them (Alt+U); there is no page cycle."
  - "The local machine sampler no longer runs in the footer; `/usage` starts it only while its Health tab is shown, per the machine sampling contract test."
  - "Every rendered footer row is no wider than the requested width, and rows carry only SGR escape sequences, per the machine sampling and responsive pages tests."
  - "A notice added with a key replaces an existing notice that has the same key; info and success notices expire after 12 seconds unless a ttlMs is supplied, and warnings and errors persist until dismissed."
  - "topNotification chooses the highest-severity live notice, then the most recent one, so an unresolved error is not hidden by a newer info notice."
  - "Footer spend reads only the telemetry read model; a missing read model renders as unavailable and a cold read renders as reading, and unknown values render as ? rather than 0."
validate:
  - "pnpm run test:file -- tests/contracts/footer-machine-sampling.test.ts"
  - "pnpm run test:file -- tests/contracts/footer-responsive-pages.test.ts"
---

# Interactive footer: compact line, expanded pages and notices

The footer is the live region drawn below the interactive prompt. A reader needs this page when they change what the footer displays, how it refreshes, how notices are queued and expired, or how spend, context occupancy, or machine metrics reach the screen. The footer has two modes. The compact mode draws a short status line. The expanded mode draws one of three pages, and an operator can cycle through them.

## What the area does

`buildFooterDashboard` in `src/interactive/footer/dashboard.ts` builds a `FooterDashboardPanel`. The panel owns a `FooterText` view, the mode (`compact` or `expanded`), the current page, scroll state, and a local machine sampler. Its `render` path composes text at the terminal width. `refresh` recomposes the text at the current width, and `dispose` stops the sampler.

The file-level rendering is split across modules:

- `src/interactive/footer/pages.ts` holds `renderCompactDashboard`, `dashboardPageViewport`, `renderDashboardPage` and `machineBlock`. The expanded page lists live and recent dispatch workers through the shared board renderers, reads the context budget, and shows the session totals with the cost `ceiling` chip; the machine block is drawn by `/usage` Health.
- `src/interactive/footer/widgets.ts` defines the facts interfaces (`WorkspaceFacts`, `SessionFacts`, `ContextEngineFacts`, `AgentWorkFacts`, `ToolTallySnapshot`) and the width-fitting helpers such as `fitDashboardLine` and `formatToolTally`.
- `src/interactive/footer/notifications.ts` holds the notice center, the severity and expiry rules, and a desktop notification path (`createInteractiveDesktopNotifications`).
- `src/interactive/footer/spend.ts` converts a telemetry view into the `FooterTelemetry` value.
- `src/interactive/footer/context-rail.ts` computes occupancy bars and percentages. It is also imported by `src/interactive/clio-editor.ts` for the composer rail.
- `src/interactive/footer/system-metrics.ts` reads local CPU, memory, network, disk, and GPU counters.
- `src/interactive/footer/demo-hints.ts` rotates a small set of idle tips.

## Callers and wiring

`src/interactive/interactive-presentation.ts` imports `buildFooterDashboard`, `FooterDashboardDeps`, and `createNotificationCenter`, so it is the main composition point for the footer. `src/interactive/overlay-lifecycle.ts` passes the panel to overlays and routes the footer toggle to `footer.toggleExpanded()`. `src/interactive/interactive-application.ts` creates the desktop notifier through `createInteractiveDesktopNotifications`. `src/interactive/interactive-event-projection.ts` calls `classifyNoticeLevel` to turn plain harness strings into notices.

The panel reads its data only through the optional getters on `FooterDashboardDeps`. Examples include `getTelemetry`, `getContextUsage`, `getDispatchRows`, `getNotifications`, and `getAgentStatus`. A missing getter degrades to a default value, not an error. Any getter may be absent.

## Paging and the sampler lifecycle

`toggleExpanded` in `src/interactive/footer/dashboard.ts` calls `setExpanded(mode === "compact")`: from compact it opens the one expanded page, and from that page it returns to compact. `setExpanded` resets the scroll offset and refreshes.

`createLocalMachineSampler` in `src/interactive/footer/system-metrics.ts` starts a two-second interval only when `setActive(true)` is called. `setActive(false)` clears the interval and clears the snapshot. Its one caller is `src/interactive/usage-overlay.ts`, which activates it only on the Health tab. The sampler reads `/proc/net/dev`, `/proc/diskstats`, `/sys/block`, and `/sys/class/drm` on Linux, and it reads `os` values on every platform. It does not run subprocesses.

The test `tests/contracts/footer-machine-sampling.test.ts` replaces `setInterval` and `clearInterval` with counters and checks that the footer adds no interval and that every rendered row fits the width and contains only SGR sequences (`ESC [ ... m`).

## Width and layout

`renderCompactDashboard` in `src/interactive/footer/pages.ts` emits one row at width 60 or less and two rows above that, as `tests/contracts/footer-responsive-pages.test.ts` asserts for widths 40, 59, 60, 61, 80, and 120. In `tests/contracts/footer-responsive-pages.test.ts`, the first row carries the version and context figures, and the second row carries workspace and branch facts. The test also checks that a narrow footer with a pending error notice still shows the error text, truncated with an ellipsis, and that an armed Ctrl+C prompt appears as "Ctrl+C again to quit".

`FooterText` in `src/interactive/footer/dashboard.ts` recomposes the text when the terminal width, the row budget, or the skin epoch changes. It does not re-wrap rows built for an older width.

## Notices

`createNotificationCenter` in `src/interactive/footer/notifications.ts` stores entries in an array. Calling `add` with a `key` removes any earlier entry that has the same key before pushing the new one. Expiry follows `resolveExpiry`:

- A `ttlMs` value of 0 or less pins the entry, so `expiresAt` is null.
- A positive `ttlMs` sets `expiresAt` to `addedAt + ttlMs`.
- Without `ttlMs`, `info` and `success` entries expire after `DEFAULT_INFO_TTL_MS` (12 seconds), and `warning` and `error` entries are pinned.

`list` returns only live entries, sorted by severity and then by recency. `hasBlocking` returns true when a live entry has a level other than `info`. `topNotification` returns the first live entry in the same order. A scheduled `setTimeout` prunes expired entries and calls `onChange`.

`classifyNoticeLevel` in the same file maps a plain string to a level. Text that matches `malformed`, `failed`, or `error` becomes `error`. Text that matches keybinding, invalid, untrusted, and similar words becomes `warning`. Any other text becomes `info`.

The `tests/contracts/footer-notice-priority.test.ts` file exists in the repository and covers notice ordering, but it was not inspected for this page.

## Spend and context readers

`footerTelemetry` in `src/interactive/footer/spend.ts` returns `unavailable` when no view is passed and `reading` while the view is still seeding. Otherwise it returns a `ready` value, cached per view in a `WeakMap`. The value includes whole-session tokens and cost from `view.session()`, the newest turn's counts through `view.quantity`, the newest main call's prompt-cache split, and its speed. Unknown values are rendered through the telemetry renderers, which produce `?` for an unknown count. A `neverSent` count appears only when it is non-zero.

`contextUsagePercent` and `contextBreakdownForBar` in `src/interactive/footer/context-rail.ts` compute the displayed share. When a `budget` is present, `used` and `contextWindow` come directly from the facts. Otherwise they fall back to the ledger. `contextRailHint` returns an empty string when the percentage is unknown or when neither a ledger nor a budget is present. The composer uses it for a graphic-only rail, and the footer uses the same bar renderer.

## Demo hints

`createDemoHints` in `src/interactive/footer/demo-hints.ts` returns a function that picks at most one tip. It shows a tip only when `enabled` is true and `quiet` is false. A tip is shown once per session and is replaced after 10 seconds. A new tip is considered no sooner than 60 seconds after the previous one. The tip list includes an Activity hint, a `/context` hint, a `/view` hint, and a `/help` hint. The `learned` callback removes a tip whose feature the operator already uses. The `tests/extended/demo-guidance.test.ts` file covers this module, and it was not inspected for this page.

## Things to watch when editing

- The footer owns no timers for the machine sampler; `/usage` does. Any change to the Health tab must keep `machine.setActive` in step with the tab, or the interval will leak or stay off.
- `renderCompactDashboard` and `dashboardPageViewport` depend on the width the footer receives. A new row must be checked at the narrow widths in `tests/contracts/footer-responsive-pages.test.ts`, because a row that is wider than the terminal breaks the layout.
- Notice replacement is keyed. Two callers that use the same `key` overwrite each other's notice.
- `FooterDashboardRenderState` is assembled in `state(width)` inside `buildFooterDashboard`. A new fact needs a getter on `FooterDashboardDeps` and a field on the state. Missing getters must still produce a valid render.

Related pages: [Interactive overlays](overlays.md), [Interactive renderers](renderers.md), [Interactive status](status.md), and [Domains telemetry](../domains/telemetry.md).
