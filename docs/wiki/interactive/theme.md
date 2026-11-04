---
title: "Command-line surfaces: theme, tokens and layout primitives"
summary: "How the interactive terminal UI paints text, resolves semantic color tokens, and builds the shared rows, rules, frames and labels that dialogs and dashboards compose. Read this before adding a surface or changing how color, glyphs or width fitting behave."
sources:
  - "src/interactive/theme/index.ts"
  - "src/interactive/theme/tokens.ts"
  - "src/interactive/theme/primitives.ts"
  - "src/interactive/theme/rules.ts"
  - "src/interactive/theme/labels.ts"
  - "src/interactive/theme/glyphs.ts"
  - "src/interactive/theme/functions.ts"
  - "src/interactive/theme/yolo-surface.ts"
symbols:
  - "clioTheme"
  - "createClioTheme"
  - "ClioTheme"
  - "paintHex"
  - "withThemeContext"
  - "frame"
  - "rule"
  - "fitUnits"
  - "chipRows"
  - "sectionRule"
  - "formatTargetLabel"
  - "createComposerSurfacePainter"
  - "toolFunction"
tests:
  - "tests/contracts/tui-island-frames.test.ts"
invariants:
  - "frame() returns rows that all measure exactly the requested width by visibleWidth, including when the title or right meta is wider than the island; the top border is clipped with an ellipsis before its closing corner (tests/contracts/tui-island-frames.test.ts, the 'title or meta wider than the island' case)."
  - "When color is disabled, createClioTheme() paint and fg calls return unstyled text, and fgSequence returns an empty string."
  - "paintHex returns the input text unchanged when the value is not a six-digit #rrggbb color; it emits 38;2 truecolor SGR when truecolor is set and the nearest xterm 6x6x6 cube entry otherwise."
  - "fitUnits drops whole units from the end and marks the cut with a dim ellipsis; a first unit that cannot fit is hard-truncated rather than dropped."
validate:
  - "pnpm run test:file -- tests/contracts/tui-island-frames.test.ts"
---

# Command-line surfaces: theme, tokens and layout primitives

This area is the shared visual vocabulary of the interactive terminal UI. A reader needs it when they add a dialog, dashboard row or overlay, when they change how a status or tone looks, or when a line of terminal output overflows or loses its color. Surfaces under `src/interactive/` compose these helpers rather than painting raw escape codes.

## What this area does

- Resolves a semantic role or legacy token to a palette color and emits SGR escape sequences, truecolor or xterm-256, through `createClioTheme` (`src/interactive/theme/tokens.ts`).
- Provides pure layout helpers that take a theme and a width and return strings already fitted to that width by `visibleWidth`: `chip`, `statusChip`, `keyCap`, `chipRow`, `chipRows`, `sectionRule`, `sectionLabel`, `titleRow` (`src/interactive/theme/primitives.ts`), and `rule`, `frame`, `innerDivider`, `padAnsi` (`src/interactive/theme/rules.ts`).
- Defines the glyph set and animation cadence (`GLYPH`, `SPINNER_FRAMES`, `spinnerFrame`, `attentionCue` in `src/interactive/theme/glyphs.ts`).
- Formats identities and fact rows that must fit a cell budget (`fitIdentityLabel`, `abbreviateModelId`, `modelNickname`, `formatTargetLabel`, `joinFacts`, `holdFact` in `src/interactive/theme/labels.ts`).
- Maps a tool invocation to a harness function family and its transcript role (`toolFunction`, `functionText` in `src/interactive/theme/functions.ts`).
- Paints the composer surface for the YOLO context with cached rows (`createComposerSurfacePainter` in `src/interactive/theme/yolo-surface.ts`).

`src/interactive/theme/index.ts` is the barrel. It exports `clioTheme()`, which lazily memoizes one `createClioTheme()` result in a module-level `sharedTheme`, and re-exports `components`, `functions`, `glyphs`, `labels`, `primitives`, `rules`, `segments`, `tokens`, plus `applySkin` from `src/interactive/theme/skin.ts`. Two of those re-exported modules, `components.js` and `src/interactive/theme/segments.ts`, are not among the anchor sources and are not described here.

## Theme and tokens

`ClioToken` is a union of semantic roles (`SemanticRole`, defined in `src/core/theme-roles.ts` and re-exported) and legacy palette names (`LegacyToken`, from `src/core/theme-token-hex.ts`). `tokenStyle` resolves a semantic role through `resolveRole(token, context, state)` and a legacy token through `LEGACY_TOKEN_COLOR`.

`createClioTheme(options)` builds a `ClioTheme` object with `paint`, `fg`, `bg`, `style`, `fgSequence` and `base`. Options are `truecolor`, `color`, `background` and `context`; each defaults from the environment. Truecolor detection reads `COLORTERM` and `TERM` for `truecolor` or `24bit` (`detectTruecolor`). Color enablement defaults to `!colorDisabled()` from `src/core/terminal-preferences.ts`. The background defaults to `terminalBackground()` from `src/core/terminal-background.ts`.

Lookups go through a per-background `PALETTES` cache. `palette(background)` maps each `PaletteColor` to an rgb triple and an xterm index. `setPaletteSkin` replaces the operator's overrides, clears that cache and increments `epoch`, which `skinEpoch()` exposes. `createComposerSurfacePainter` uses that epoch to invalidate its row cache.

Render context is scoped, not global. `withThemeContext(context, render)` sets a module-level `renderContext` for the synchronous duration of `render` and restores the previous value in a `finally`. The comment in `src/interactive/theme/tokens.ts` states that it never persists autonomy in the application-wide theme. A theme built without an explicit `context` option reads `renderContext` on each call.

`paint(text, mods)` assembles SGR codes in this order: bold, dim, italic, underline, foreground, background, then closes with `SGR_RESET` when any code was emitted. It returns `text` unchanged when no code applies, and returns `text` unchanged for every call when `color` is false.

`base(role, text)` paints a body in a role's foreground and re-applies that foreground after each inline SGR that resets the foreground (`sgrResetsForeground`), so a reset inside a syntax-highlighted span does not drop the reading color. The `ClioTheme.base` doc comment states this intent.

`paintHex(text, hex, options)` is a separate, exported function outside the theme object. The source comment says a council roster member may carry a configured `#rrggbb` color, and that this is the only place a literal color reaches the screen. It returns `text` unchanged when the value does not match `HEX_COLOR` or color is disabled. Otherwise it emits `38;2;r;g;b` under truecolor and `38;5;n` with `rgbXterm` otherwise.

## Primitives and rules

`src/interactive/theme/primitives.ts` documents the grammar in its header comment: tone, chip, status chip, key cap, section rule, title row, fact table, meter, selection row, choice row, command block, and empty or error states. The functions in this file are the parts that exist with those names in the source; other parts of that grammar are implemented by consumers outside this area and are not described further here.

- `chip(theme, text, tone, glyph?)` paints `[glyph ]text` with `toneRole(tone)`. `Tone` maps to `SemanticRole` through the `TONE_ROLE` table.
- `statusChip(theme, status, label?)` leads with a glyph from `STATUS_GLYPH` and paints it with the `STATUS_TONE` tone. Without a label the chip is the glyph alone.
- `statusSeverity(status)` gives an ordering where lower is worse, so a row can sort its chips and drop the least severe first. The `STATUS_SEVERITY` table ranks `error` first and `ok` last.
- `chipRow` joins present chips with the `dotSep` separator and clips the result with `clip`. `chipRows` wraps chips across rows: it swaps spaces to non-breaking spaces in any chip that fits the width, wraps the joined string with `wrap`, and then restores ordinary spaces with `releaseSpaces`. A chip wider than the width is allowed to wrap at its own spaces.
- `sectionRule` renders a `rule()` with a clipped label on the left and an optional dim `meta` on the right. The label is clipped with `clip` against a room computed from the meta width.
- `titleRow` renders a bold title with a right-aligned meta; the source comment says the meta is dropped before the title is clipped.

`src/interactive/theme/rules.ts` holds the lower-level pieces:

- `padAnsi(text, width, ellipsis)` delegates to `truncateToWidth(..., pad = true)`, which returns exactly `width` columns.
- `fitUnits` and `fitUnitsKept` both call `fitUnitsPlan`. The plan joins units with ` · `, reserves two columns for a ` …` marker on every unit except the last, and stops at the first unit that does not fit. If the first unit itself does not fit, the function returns `truncateToWidth(candidate, maxWidth, "…")` with `kept` equal to zero. Otherwise it returns the kept prefix followed by a dim `…`. `fitUnitsKept` lets a caller count how many units survived.
- `rule(theme, width, options)` draws `left`, a fill of `─`, and `right`. A `renderFill` callback can replace the fill; it receives the fill width and the absolute starting column. When the labels alone exceed the width, `rule` truncates the trimmed label text.
- `frame(theme, title, lines, width, opts)` builds a bordered island with corners and fills in the `border` role. The title is bold in the `heading` role unless it already contains an ESC character, in which case it is placed verbatim. `rightMeta` renders dim before the closing corner. Body rows are `│ ` + `padAnsi(theme.base("body", line), contentWidth)` + ` │`, so each row measures `width`. A top border whose title and meta exceed the width is truncated with `truncateToWidth(composedTop, safeWidth - 1, "…")` and closed with a corner.
- `innerDivider(theme, width)` repeats `GLYPH.innerDivider` in the `divider` role.

`frame` is the recipe that the welcome dashboard, task island, steering queue and dispatch cards are documented to share (`src/interactive/theme/rules.ts` doc comment). Callers in `src/interactive/` that import from this area include `src/interactive/welcome-dashboard.ts`, `src/interactive/dispatch-board.ts`, `src/interactive/tasks-overlay.ts` and `layout.ts`, as found by a repository search for imports of `src/interactive/theme/index.ts` and the theme submodules. The concrete per-surface call sites were not individually traced for this page.

## Labels and identities

`src/interactive/theme/labels.ts` covers text that must keep its meaningful part when it is shortened:

- `fitIdentityLabel(value, width)` sanitizes the value with `sanitizeCallTargetText` from `src/domains/safety/call-target.ts`. If the value does not fit, it keeps a grapheme-segmented tail of roughly half the budget and a head filling the rest, joined by `…`. The tail is preserved so that the distinguishing suffix survives.
- `abbreviateModelId(modelId)` returns `model` for an empty id, the id unchanged when it fits `MODEL_ID_LABEL_WIDTH` (34 cells), and otherwise keeps the placement prefix and the final path segment through `fitIdentityPrefix` and `fitIdentityLabel`. The comment on `MODEL_ID_LABEL_WIDTH` explains the 34-cell choice with a concrete pair of route ids that would collide at 24 cells.
- `modelNickname(modelId)` strips publisher prefixes, `@` suffixes, size and quantization suffixes, and returns `No model` for an empty id.
- `joinFacts` and `holdFact` join short facts with ` · ` and hold the spaces inside any fact of sixteen characters or fewer (`HELD_FACT_MAX`), so a wrapped row breaks between facts.

`formatTargetLabel`, `formatCompactMs` and `formatContextPercent` are also exported from `src/interactive/theme/labels.ts`. This page does not describe their behavior beyond their names.

## Glyphs and animation

`GLYPH` is a frozen record of one-cell symbols, with comments that bind several of them to meaning: `toolHeader` for observed tool rows, the `classMutate`, `classExecute` and `classNetwork` family for action classes, and `workerHuman` versus `workerAgent` for who requested a dispatched run. `spinnerFrame(tick, attention)` returns `GLYPH.running` unless `attention` is true and `motionEnabled()` (from `src/core/terminal-preferences.ts`) is true, in which case it cycles `SPINNER_FRAMES`. `attentionCue(nowMs, animate)` samples at `ATTENTION_STEP_MS` (480 ms). The source comment says routine progress stays static and only a pending human decision opts into motion.

## Function family

`toolFunction(toolName, toolClass?, resourceKind?)` in `src/interactive/theme/functions.ts` returns a `HarnessFunction`. The order of checks is: MCP tool names, harness extension tool names, a `skill` resource kind, then a switch on `ToolNames` (shell for `Bash` and `RunScript`, mutation for `Write` and `Edit`, network for `WebRead` and `WebFetch`, context for `Context` and `SelfCompact`, dispatch for `Dispatch`, `Monitor`, `Steer` and `Consult`, decision for `AskUser` and `Decide`, artifact for `Artifact`). Unmatched names fall through to a `toolClass` check. `functionText(theme, kind, label)` paints a label with the role from `TRANSCRIPT_FUNCTION_ROLES`. That table is typed `satisfies Record<HarnessFunction, SemanticRole>`, so a new function kind must have a role.

## Composer surface (YOLO context)

`createComposerSurfacePainter(theme, width, baseRole)` returns a per-line painter. It reads `projectsYolo(context)` from `theme.context`, and when true it takes a `composerSurface` background sequence. It re-applies that background and the base foreground after each SGR that resets the foreground or background, unless `inlineBackgroundAfter` says an explicit background is active. Rows are cached in a map capped at 64 entries and cleared when `skinEpoch()` changes. When there is no background and no foreground, the painter returns the line unchanged.

## Tests

- `tests/contracts/tui-island-frames.test.ts` exercises `frame` across a set of widths. The case at its end calls `frame(clioTheme(), "council ".repeat(32), ["body"], width, { rightMeta: "12m 04s" })` and asserts that every row has `visibleWidth` equal to `width`, and that the top row matches `/^┌─ council .*…┐$/u`. This shows the top-border clipping branch of `frame`.
- Other repository tests that import these helpers include `tests/extended/rendering-invariants.test.ts`, `tests/extended/editor-rails.test.ts`, `tests/extended/dispatch-board.test.ts`, `tests/extended/footer-pages.test.ts`, `tests/contracts/tui-library-ergonomics.test.ts`, `tests/contracts/terminal-background.test.ts` and `tests/contracts/routes-model-picker.test.ts`, as found by a repository search for the theme symbols. Their assertions were not read for this page, so they are not described here.

No focused test for `paintHex`, `fitUnits`, `chipRows` or `createComposerSurfacePainter` was located beyond the references listed above; the behavior described for those functions comes from source reads only.

## Things to watch when editing

- `ClioTheme` outputs depend on `colorDisabled()`, `terminalBackground()`, `motionEnabled()` and the render context at call time. Module-level caches (`sharedTheme`, `PALETTES`) mean an override from `setPaletteSkin` only takes effect after `skinEpoch` changes, and surfaces that cache rows must check it, as `createComposerSurfacePainter` does.
- `frame` and `padAnsi` measure by `visibleWidth`, not by string length. Escape sequences in titles are placed verbatim, so a caller that pre-styles a title must not add its own width.
- `TONE_ROLE`, `STATUS_TONE` and `TRANSCRIPT_FUNCTION_ROLES` map to `SemanticRole` values. A new `Tone` or `StatusKind` requires an entry in each table; the `satisfies` clause on `TRANSCRIPT_FUNCTION_ROLES` enforces this for `HarnessFunction` only.
- `paintHex` is intentionally the only literal-color path. Token-based colors should continue to go through the role system.
