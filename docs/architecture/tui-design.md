# Clio TUI Design System

`ClioEditor` in [clio-editor.ts](../../src/interactive/clio-editor.ts) owns composer editing. The [commands and modes guide](../guide/commands-and-modes.md) lists operator controls.

Boot sequence, presentation modes and the benchmark that measures them are in [TUI boot presentation and measurement](tui-boot-performance.md).

This document is the reference specification for the Clio Coder TUI visual layout, styling, and behavior across [src/interactive/](../../src/interactive/interactive-shell.ts).

The governing architectural principle: **the user reads state from color, structure from frames, and identity from brand marks.** Everything that is not state or structure remains visually quiet.

---

## Output Styles

Toggle styles with **Alt+O** (`Compact` → `Standard` → `Detailed` → `Compact`). Standard is the default (`interface.outputDetail`). The control is **Chat → Replies → Output style** in `/settings chat`, and **Appearance → Display & keyboard → Output style** in `clio-coder configure --section interface`. The row budgets below are the `POLICIES` in [transcript-detail.ts](../../src/interactive/transcript-detail.ts).

| Content | Compact | Standard (Default) | Detailed |
| :--- | :--- | :--- | :--- |
| **Answers & Prompts** | Complete | Complete | Complete |
| **Supplied Reasoning** | Single fold marker per run | 3 rows before words, marker before action | 12 preview rows |
| **Reads & Searches** | Class fold (`▸ explored N files`) | Action and outcome | 8 result rows |
| **Knowledge Lookups** | Class fold (`§ consulted N`) | Action and outcome | 8 result rows |
| **File Mutations** | Class fold (`± edited N files`) | 8 diff rows | 20 diff rows |
| **User Questions** | Question and answer on 1 row | Question and answer on 1 row | Question and answer on 1 row |
| **Agent Shell Commands** | Command and outcome | Command, outcome and 3 output rows | Command, outcome and 12 output rows |
| **Live Tool Output (while running)** | None | 6 rows | 16 rows |
| **Operator Shell (`!`/`!!`)**| 3 output rows | 6 output rows | 12 output rows |
| **Dispatched Workers** | Identity, execution and validation outcome | Facts line (tokens processed, context, tool calls) + 3 summary rows | Facts line + 8 summary rows + call trail |
| **Helper / Shadow Work** | 1 row (`↳ role · task ✓`) | 1 row (`↳ role · task ✓`) | Full worker card |
| **Failures & Refusals** | Up to 4 rows actionable reason | Up to 4 rows actionable reason | Up to 12 rows with context |
| **Notices & Retries** | Level mark + bounded message | Level mark + bounded message | Diagnostic detail |
| **Turn Receipt** | None | Outcome + duration | Outcome, duration, calls, tokens, cache, reasoning, prewarm |

- **Preview Budgets**: Counted *after terminal wrapping*, including the `… N rows · /view` overflow hint. Short terminals scale a budget down to `max(2, floor((terminal rows - 8) / 2))` when that is smaller than the style's own limit (`previewBudget` in [preview.ts](../../src/interactive/renderers/preview.ts)).
- **Worker Inspection**: Full unbounded output is inspectable via `/view transcript`.
- **Idle Pre-rendering**: Settled entries are pre-rendered into the two alternative styles during idle time, eliminating delay on Alt+O switching.

---

## 1. Color System

Token resolution lives in [src/interactive/theme/tokens.ts](../../src/interactive/theme/tokens.ts); canonical hex values in [src/core/theme-token-hex.ts](../../src/core/theme-token-hex.ts). Raw ANSI SGR escapes, SGR color fragments and hex colors are forbidden in `src/interactive/` outside its `theme/` directory; the `theme-discipline` check in `scripts/check-hygiene.ts` fails on them.

### 1.1 Color Tokens

Renderers ask for semantic roles (`TEXT_ROLES`, `STRUCTURAL_ROLES` and `FUNCTION_ROLES` in [theme-roles.ts](../../src/core/theme-roles.ts)), where text intensity (`subdued`, `supporting`, `reading`, `focal`, `strong`) and accent intent (`neutral`, `ivory`, `cyan`, `turquoise`, `action`, `success`, `warning`, `error`) are independent. The legacy token names below remain as the compatibility vocabulary for external profiles and configured roster colors; a council roster member's `color` accepts the names in `THEME_NAMED_COLORS` ([defaults.ts](../../src/core/defaults.ts)) or a literal `#rrggbb`. Each token maps to one palette entry in `TERMINAL_PALETTE`.

| Token | Hex (unknown background) and palette entry | Role |
| :--- | :--- | :--- |
| `editor` | `#15959e` (`cyanFocal`) | Compatibility name. The composer rails paint the `composerRail` role, which resolves to the same palette entry. |
| `editorDanger` | `#dd5353` (`error`) | Compatibility name; no renderer paints it. |
| `editorAction` | `#c7783d` (`orangeFocal`) | Compatibility name; no renderer paints it. |
| `editorYoloBackground` | `#1d2b2a` (`yoloSurface`) | Compatibility name. The `yolo` composer surface paints the `composerSurface` role, which resolves to the same palette entry. |
| `editorYoloText` | `#948773` (`ivoryFocal`) | Compatibility name; `yolo` composer text resolves through the role matrix. |
| `accent` | `#15959e` (`cyanFocal`) | Selections, prompts, the active dashboard tab, voice glyph (`✦`), active phases. |
| `accentDeep` | `#1b929a` (`cyanReading`) | Bold CAPS section headers and structural tags. |
| `action` | `#c7783d` (`orangeFocal`) | Active operations: dispatch pills, running fleet badges, steering queue markers. |
| `emphasis` | `#998a73` (`neutralFocal`) | Emphasized neutral text. |
| `tool` | `#928673` (`neutralReading`) | Action-row verbs in the tool ledger. |
| `agent` | `#258e87` (`turquoise`) | Dispatch verbs and active worker counts. |
| `success` | `#2a9c5c` (`success`) | Positive outcomes (`✓`), clean git state, added diff lines (`+`). |
| `warning` | `#b08000` (`warning`) | Warnings, dirty git trees, retry attempts, blocked tools. |
| `error` | `#dd5353` (`error`) | Failures (`✗`), error rails, removed diff lines (`-`). |
| `info` | `#288b91` (`cyanSupporting`) | Informational notices and links. |
| `reason` | `#898071` (`neutralSupporting`) | Reasoning indicators. |
| `dim` | `#898071` (`neutralSupporting`) | Scaffolding: separators, shortcuts, durations, timestamps. |
| `muted` | `#928673` (`neutralReading`) | Secondary text: paths, previews, telemetry counts. |
| `title` | `#a0917c` (`neutralStrong`) | Overlay and frame headers. |
| `frame` | `#737a80` (`border`) | Borders, dividers, unused context meter space. |
| `frameStrong` | `#1b929a` (`cyanReading`) | Compatibility name; the transcript scrollbar thumb paints the `scrollMarker` role, which resolves to the same palette entry. |

The palette follows the website's warm stone and ivory paper tones for text, with cyan and copper from the IOWarp logo as accents. Near-white is reserved for answers and entered text.

Each palette entry has three projections in [theme-token-hex.ts](../../src/core/theme-token-hex.ts), one per terminal background, each with a truecolor hex and an indexed xterm color. Background resolution ([terminal-background.ts](../../src/core/terminal-background.ts)) takes `CLIO_CODER_THEME` first (`dark`, `light`, or `neutral` for the unknown column), then the answer to the startup OSC 11 query, then `COLORFGBG`, then unknown. The startup query is followed by DA1 so that a terminal which ignores OSC 11 costs one round trip, with a 200 ms cap. A dark terminal gets the brighter projection, a light terminal gets deeper tones, and an unknown background uses the mid-luminance column. Truecolor is used when `COLORTERM` or `TERM` names `truecolor` or `24bit`; otherwise the indexed color applies. `NO_COLOR` set to a nonempty value, `TERM=dumb` and `TERM=unknown` disable color. State is also spelled by labels, meter fill, and motion, so a monochrome terminal does not have to infer it from hue.

### 1.2 Placement Invariants

- **State Indication**: Color is strictly functional. Telemetry and neutral numbers use `muted` or `dim`.
- **Orange Scarcity**: Orange marks live work and a pending operator decision. Settled rows and idle borders stay cyan or neutral.
- **Budgeting**: Max one non-neutral token per chip; max one status token per framed card.
- **Status Colors Mean Status**: `success`, `warning` and `error` mark outcomes and conditions only. Categorical color, such as context meter categories, shell flags and code ink, uses brand, `tool`, `info`, `reason` or `agent`, so a healthy screen never shows amber or red.
- **Yolo Surface**: Under `yolo` autonomy only the composer and its docked menus change. They paint on the `yoloSurface` background with ivory input text and orange command hints, and the top rail carries a `━ YOLO` label. Errors, warnings and selection keep their normal colors ([yolo-surface.ts](../../src/interactive/theme/yolo-surface.ts)).

### 1.3 Composer Rails

The composer is framed by a top and a bottom rail. Both are drawn with bold `━` in the `composerRail` role (`cyanFocal`). The rails never animate: `ClioEditor` always renders them static, so working, steering and permission states are carried by the labels below, not by motion or hue.

| Rail | Content |
| :--- | :--- |
| Top, left | `━ YOLO` under `yolo` autonomy. |
| Top, label | A phase mark, the model nickname, and the activity wording (see [4.4](#44-composer-phases)). |
| Top, right | Hidden-line count (`↑N`) when the draft scrolls, and `STEER` or `FOLLOW-UP` while a run is live and a draft is typed. |
| Bottom, right | Hidden-line count (`↓N`), permission or menu key hints, the thinking hint and the context occupancy bar. The keys take room first, then the thinking hint, and the context bar is dropped when it does not fit. |

The bottom rail's context bar is 6 cells wide, 10 cells from 100 columns. The thinking hint is four static marks: `off` fills none, `minimal` and `low` fill one, `medium` two, `high` three, and `xhigh`, `max` four, with `max` in attention ink. Marks are `●` and `○`, or the Nerd Font brain glyph when `CLIO_CODER_NERD_FONT=1`. The hint falls back to text (`think <level>`) for binary or forced thinking capabilities, an unsupported level, a rail too narrow for four marks, screen-reader mode and color-disabled terminals. Thinking is absent from the footer.

---

## 2. Glyph Vocabulary

All symbols are defined in the `GLYPH` object in [src/interactive/theme/glyphs.ts](../../src/interactive/theme/glyphs.ts). A glyph means one thing everywhere; a surface that needs a new meaning asks for a new constant rather than borrowing a shape.

| Glyph | `GLYPH` key | Token | Meaning | Used by |
| :--- | :--- | :--- | :--- | :--- |
| `>C_` | `brand` | `accent`, `title` | Brand wordmark | Launchpad, session header and footer dashboard tabs. |
| `✦` | `agent` | `accent` | Agent voice | First row of agent prose; `error` on a failed turn. |
| `▌` | `userBar` | `accent` | Operator input | Gutter of every prompt row. |
| `›` | `user` | `action` | Quoted operator text | Steering queue entries, `/btw` and `/draft` request echoes, command reference cards. |
| `❯` | `cursor` | `accent` | Focus | Selected row in lists, menus and overlays; Pi SelectList renders it through the public `selectedText` theme hook. |
| `▸` | `toolHeader` | `tool` | Observe or search | Reads, listings, searches. |
| `§` | `classKnowledge` | `tool` | Knowledge or skill | Context, docs, library, evidence, skills. |
| `±` | `classMutate` | `tool` | Mutate | Writes, patches, edits. |
| `$` | `classExecute` | `tool` | Execute | Shell commands, checks, git. |
| `↗` | `classNetwork` | `tool` | Network | Web fetches. |
| `?` | `classInteraction` | `warning` | Operator question | Approvals and `ask_user`. |
| `⇢` | `classExternal` | `tool` | External call | MCP tools and gateways. |
| `◇` | `workerHuman` | `accent` | Run the operator started | Worker block, board origin column, footer count. |
| `◆` | `workerAgent` | `agent` | Run the model started | Same surfaces as `◇`. |
| `·` | `workerInternal` | by audience | Internal run | Board origin column only; elsewhere `·` is the unit separator. |
| `↳` | `subProcess` | by audience | Helper or shadow run | One-row helper lines. |
| `●` | `running` | `accent` | Running | Status marks, island rows. |
| `◌` | `queued` | `dim` | Queued or pending | Status marks, task island, held boot submissions. |
| `⚙` | `phaseTool` | `muted` | Live tool activity | Running tool rows. |
| `✓` | `ok` | `success` | Done | Outcomes, reviewed trust verdicts. |
| `✗` | `error` | `error` | Failed | Outcomes, compromised trust verdicts. |
| `⊘` | `cancelled` | `dim` | Cancelled | Aborted turns and runs. |
| `↻` | `phaseRetry` | `warning` | Retry | Provider retries and failover. |
| `i` | `info` | `info` | Notice | Info notices. |
| `!` | `warn` | `warning` | Warning | Warning notices, quota limits, stale state. |
| `│` | `rail` | `frame` | Rail | Island sides, column separators. |
| `╌` | `innerDivider` | `frame` | Inner divider | Rows inside an island. |
| `…` | `ellipsis` | inherits | Cut | Every truncation. |
| `↺` | `recent` | `dim` | Recently used | Model picker mark column. |
| `━` `─` | `meterFull` `meterEmpty` | by meter | Meter cells | Quota and resource bars. |
| `→` | `next` | inherits | Next step | Dashboard page order, key chords. |

Trust verdicts on a dispatch card print `✓` for reviewed (`success`) and `✗` for compromised (`error`). Grounded (`info`) and unverified (`body`) print the verdict word alone, because a diamond on that line would read as an origin.

---

## 3. Structural Layouts

### 3.1 The Island (Framed Block)
Every framed block is built by `frame()` and `innerDivider()` in [rules.ts](../../src/interactive/theme/rules.ts): the launchpad, the task island, the Fleet runs board, the dispatch cards, notices, the steering queue and the exit summary. No surface draws its own corners, tees or rounded frame.
- **Header**: Embedded in the top border in bold `heading`: `┌─ Title ─────────── meta ─┐`. Optional right metadata is `annotation`. A title wider than the island is clipped with `…` before the corner.
- **Body**: `│ ` + content padded to the inner width + ` │`. Sections inside one island are separated by a full-width `╌` row, never by a `├┤` tee.
- **Width**: Every row is exactly the island width in visible cells (minimum 4). Content is truncated with `…`, never wrapped past the rail.
- **Color**: Corners and fills use the `border` role; the inner divider uses `divider`.

### 3.2 Docked Surfaces and Overlays
Every modal surface (`/settings`, pickers, `/view`, `/tasks`, `/usage`, permission cards, interviews) lives in the dock ([dock.ts](../../src/interactive/dock.ts)), the composer's own slot, instead of floating over the transcript. The engine keeps one overlay per frame so focus and input routing stay unchanged, but that overlay paints nothing: the frame registers with the dock and the composer draws it in normal flow between its rails, the way slash autocomplete is drawn. The transcript keeps its position and its scrollback and stays selectable by the terminal. A docked body is at most 16 rows (`DOCK_BODY_ROWS_MAX`) and shrinks to leave two rails, the footer and a sliver of transcript, with a floor of 3 rows. A permission card keeps the composer's draft visible beneath its body, because a steer typed while a call is parked is what the `CONFIRM` label is for.
- Header: Centered or left-aligned title with category tabs.
- Navigation: `↑`/`↓` for items, `Tab` for sections, `Enter` to select, `Esc` to close.
- **Selection**: A focused row carries `❯`. Self-drawn lists use `selectionMark` and `selectionLabel` in [overlay-frame.ts](../../src/interactive/overlay-frame.ts) for an `accent` marker and bold `accent` label. Pi SelectList uses the public `selectedText` hook to replace its leading arrow with `❯` and style the selected row in bold `selectedOption`, including its description. No subclass or dependency patch is used.
- **Floating exception**: The task island is the one surface that still floats: a non-capturing overlay at the top right. The `?` key card is a non-capturing docked frame.
- **Pane-host docks are a different mechanism**: The files, music and workers docks are Herdr panes beside Clio's own pane, not composer dock frames, and they never draw into the transcript or the composer. They have three states (visible, hidden, closed), a first-tap show or hide on `Alt+E`, `Alt+A` and `Alt+W`, and a double tap within 400 ms that closes them. [Panes and the Files Pane](../guide/panes-and-files.md#showing-hiding-and-closing-docks) specifies them.

### 3.3 Dispatch Status Marks
A run's status is a glyph and a word from `dispatchStatusPresentation` in [dispatch-board.ts](../../src/interactive/dispatch-board.ts):

| Status | Mark | Token |
| :--- | :--- | :--- |
| running | `●` | glyph `activity`, word `dispatchAction` |
| queued | `◌` | `body` |
| retrying | `↻` | `warning` |
| cancelling | `⊘` | `warning` |
| stale | `!` | `warning` |
| completed (`done` when compact) | `✓` | `success` |
| failed (`fail` when compact), dead | `✗` | `error` |
| aborted (`abort` when compact) | `⊘` | `annotation` |

Only a pending human decision animates (`spinnerFrame` with `attention`). Routine progress stays a static `●`, and nothing animates under `CLIO_CODER_REDUCE_MOTION=1`, screen-reader mode, `NO_COLOR` or `interface.demo: false`.

### 3.4 Width Degradation

No row exceeds the terminal width in visible cells at any width. `tests/contracts/tui-island-frames.test.ts` and `tests/contracts/transcript-retry-prefix.test.ts` render at 60, 80, 120 and 200 columns, and `tests/extended/rendering-invariants.test.ts` also renders at 40. The thresholds below are constants in the named modules.

| Surface | Rule |
| :--- | :--- |
| Launchpad | Under 76 columns the compact wordmark sits on one band above the details, and under 57 columns the brand moves into the frame title. From 76 the stacked compact wordmark sits beside the details, from 100 the wide wordmark, and from 160 a rotating hint column is added. |
| Session header | One row. Under pressure the branch drops first, then the path, then the name and version, and the route is protected. |
| Fleet runs | Docked above the composer while a run is live, at every width. |
| Task island | 48 cells wide at the top right. Shown from 80 columns and 18 rows, hidden when an overlay is open, the footer is expanded, a non-helper run is live or no task is open. |
| Context progress | A full-width three-row rail directly above the composer, shown while a compaction, init, refresh or reset runs and for 6 seconds after it ends. |
| Council card | Side-by-side columns while every column is at least 34 cells wide after 2-cell gutters, otherwise stacked. |
| Compact footer | Two rows. Line 1 reserves a stats column at least 28 cells wide once a figure shows, capped at 40% of the width, so changing numbers do not move the path. At 60 columns or fewer, line 2 is omitted when it has nothing to say and key hints show one entry instead of two. |
| Expanded footer | Context and Status pages split into two columns from 84 columns. Activity splits its summary from 110 and shows two active worker cards side by side from 120. |
| Transcript | Prompt and prose rows wrap. Tables, code and diagrams are fitted to the width (see [5.1](#51-assistant-text-rendering)). Fullscreen reserves the last column for the scrollbar. |

Gutters stay 2 columns with hanging indents.

### 3.5 Pinned Islands and the Dynamic Transcript

The viewport has two kinds of content.

- **Pinned**: the dock below the transcript in [layout.ts](../../src/interactive/layout.ts), from top to bottom: the steering queue (`Steering Queue` island), live Fleet runs, the context progress rail, the composer and the footer. While runs are live, Fleet renders in normal flow just above the composer, reserving its own rows in both regular and fullscreen modes. It uses the same phase wording, counts and council projection as the run cards. It shows one card and a count of additional cards, which remain inspectable through Fleet Runs. With no live run, Fleet takes no rows and never paints over a transcript row. The task island is a non-capturing top-right summary owned by `src/interactive/interactive-tickers.ts`, and it hides while an overlay is open or the footer is expanded. The decision board stays a capturing docked surface (`/decisions`), because a decision needs the keyboard and an island may not hold it.
- **Dynamic**: everything in the transcript. Dispatch, council and worker state render as transcript blocks that update in place; the islands summarize them and never become a second history.

**Hydration.** The instant shell paints `createBootWelcome` with the settings already read, at the same geometry as the hydrated launchpad. A resumed session replays its turns through the same panel operations a live turn uses (`rehydrateChatPanelFromTurns` in `src/interactive/chat-renderer.ts`), and the settled entries are pre-rendered in the other output styles while idle.

**Stream ticks.** The chat panel returns a frame as `ChatPanelRegions`: a frozen `prefix` of the contiguous settled entries from the top of the transcript, and a `tail`. The prefix array keeps its identity across stream ticks, and the regular-mode root skips rewriting it while it sits at the same row. A settled entry is a committed prompt, a non-live replay block, a finished worker, a retry row, or an assistant entry with no pending message and no running tool. A stream tick renders only the live entry: `ChatPanelRenderMetrics.entriesRendered` is 1 per tick. An entry that changes after it settles, such as a retry row for the same attempt, drops its cached render and the freeze behind it.

**Measuring.** `src/interactive/render-trace.ts` records frames, panel `entriesRendered` and `cacheHit`, bytes written per commit, and `rowsChanged`: the number of root rows that differ from the previous frame at the same index. Set `CLIO_CODER_RENDER_TRACE` to a file path to arm the trace. `rowsChanged` is computed only while a trace file is armed and is an estimate of pi-tui's differential write, since a viewport move, a resize or an overlay can make pi-tui repaint more rows. Tests never assert wall-clock time.

### 3.6 Screen Modes

`interface.mode` selects the renderer: `regular` (default) preserves terminal scrollback and appends the dock after the transcript, and `fullscreen` uses the alternate screen with a scrolling transcript view above a pinned dock. In fullscreen the transcript view follows the end until the operator scrolls, `interface.fullscreenScrollbar` (`hidden`, `auto` default, `always`) controls the scrollbar, and a submission returns the view to the live edge. The scrollbar column is reserved whenever a scrollbar can appear, so it never reflows rows. Paging, search and mouse scrolling exist only in fullscreen; regular mode relies on the terminal's own scrollback and Find.

### 3.7 Overlay Input and the Mouse Wheel

One application input gate registers on the TUI before any other listener ([application-input-tui.ts](../../src/engine/application-input-tui.ts)), so Clio's policy sees every key before Pi's viewport shortcuts and the focused widget. Key-release events are dropped there, and bracketed paste reaches the policy as literal data.

In fullscreen with any overlay visible, the mouse wheel scrolls the transcript and never moves list choices. Pi would offer the wheel to the overlay under the pointer, where its select and settings lists turn it into selection moves; the gate instead scrolls the transcript by one line per notch, five with Alt, and consumes the event. Choices move only on keys.

A native `ask_user` interview holds a terminal-selection lease (`useTerminalSelection` in [instrumented-tui.ts](../../src/engine/instrumented-tui.ts)) for as long as it is open. The lease turns off mouse tracking (DECSET 1000, 1002, 1003 and 1006) so the terminal can select text on the stable interview screen, and it turns off alternate-scroll mode 1007. On the alternate screen without mouse tracking, mode 1007 makes a terminal send the wheel as arrow keys that arrive identical to real ones and would move the interview's choice. When the last lease releases, tracking comes back (1003 is skipped under tmux, zellij and screen) together with 1007, the common terminal default.

---

## 4. Screen Surfaces & State Choreography

The visual hierarchy coordinates four primary screen surfaces: Header, Transcript, Composer, and Footer.

### 4.1 Welcome Launchpad & Session Header

The header operates in two distinct modes:
- **Launchpad (before the first prompt)**: A standard island whose bottom row, under an inner divider, names the one next step by what blocks work (`/model` for an unset route, `/settings targets` for an unavailable or degraded one, then `/context init`, `/context refresh` or `/context` by project-awareness state) and carries the version at the right. The island has no title at normal widths because the wordmark carries the brand; under 57 columns the title is `>C_ Clio Coder v<version>`. Rows: session start time, project (workspace, Git state, project awareness), account usage (two rows reserved from the first paint, ending in `… /usage` when more accounts exist), and one tagline chosen per process from `WELCOME_TAGLINES` when the island's inner width is at least 36 cells. Usage and awareness are read off the render path. The launchpad shows only with `interface.demo` on, a terminal that is not `dumb` or `unknown`, and screen-reader mode off.
- **Session Header (after prompt admission)**: Collapses once into a single compact line showing the brand mark, product name and version, the active route, the working directory and the Git branch (`*` when dirty), preserving vertical space for the transcript. It stays live, so a mid-session model change shows. `/new` brings the launchpad back. Demo-off and compact-terminal starts show this line from the first frame.

### 4.2 Composer (ClioEditor)

The input surface (`ClioEditor`) frames the operator's prompt:
- **Rails**: Framed by the static top and bottom rails of [1.3](#13-composer-rails). The empty composer reads `Ask Clio…  / for commands`, and its prompt changes while a parked call, a preparing turn or a compaction owns the composer (see [4.4](#44-composer-phases)).
- **Steering Affordance**: Messages queued for a live run show in a `Steering Queue` island above the composer, with the send-now and restore keys.

### 4.3 Progressively Disclosed Footer

The compact footer is two lines:
- **Line 1 (Workspace & Metrics)**: Working directory and Git branch with a `*` when dirty, then a right-hand stats column with context occupancy (`used/window (percent)`) and throughput (`tps`). Branch and context figures stay blank until known. Once metrics appear, the footer reserves their column and the dirty marker's space so changing numbers do not shift the path's cut point. A narrow row drops the percent, then states it as `ctx N%`.
- **Line 2 (Notices & Hints)**: One message, in this order of precedence: an armed quit or leader key, an open approval card's key legend, the top notice, setting feedback, a footer tip, then rotating key hints. Beside it, when space permits, the tail shows active worker count, armed skill names and the selected model's weekly quota headroom. Key hints are shown whole, two per page (one at 60 columns or fewer), and rotate every 12 seconds; a dropped hint leads the next page.
- **Notice Slot**: Line 2 has room for one notice. It shows the head of the notice center's order, most severe first and newest within a level, with the level's glyph and token. A notice that is multi-line or wider than its room is cut and ends in the dashboard key plus `more`; the expanded dashboard wraps it in full.
- **Narrow Terminals**: Secondary hints yield space to the context percentage and phase without wrapping; optional counts drop before a number is cut.

The expanded footer has three pages, Activity, Context and Status, which the dashboard key cycles through before closing. Machine counters are sampled only while Status is visible. Worker counts in both footers include running, queued, cancelling, retrying and stale runs.

### 4.4 Composer Phases

The live phase is named on the composer's top rail, after the model nickname. It is not in the footer.

| Phase | Top-rail wording |
| :--- | :--- |
| Preparing a consumed prompt | `is preparing` |
| Waiting for the model | `is waiting for a response` |
| Thinking | `is thinking` |
| Writing | `is writing`, or `is preparing a tool` while a tool call forms |
| Tool running | Tool-specific wording, or `is running <tool>` |
| Dispatch in flight | `is waiting for a worker` |
| Approval required | `needs approval`, with the permission keys on the bottom rail |
| Retrying | `is retrying <attempt>/<max>` |
| Compacting | `is compacting context` |
| No output | `has no output · <seconds>s` |
| Ended | `finished`, `failed`, `was cancelled`, `reached the output limit`, or `stopped generating tool arguments` |

While the composer is empty its placeholder follows the mode: `A parked call is waiting for your decision`, `Clio has your prompt and is preparing the turn`, or `Clio is compacting the session context`. The expanded Activity page shows a `state` row with the footer phase verb while a turn streams.

### 4.5 Exit Summary

A clean interactive exit prints a branded session summary in the island frame, per `interface.exitSummary` (`full`, `brief`, `off`). Contents, timing and suppression are in [Exit summary](../guide/commands-and-modes.md#exit-summary).

---

## 5. Transcript & Gutter Grammar

Every transcript row follows a rigid 2-column gutter format:
```text
<gutter:2> <content>
```
- **Prose Head**: `✦ ` followed by text in standard color.
- **Prose Continuation**: `  ` indented 2 spaces.
- **Tool Action Row**: Class glyph (`▸`, `§`, `±`, `$`, `↗`, `?`, `⇢`) + verb + scalar target + outcome (`✓ Done · 12ms`).
- **Operator Grant**: A call that ran because the operator allowed it at a permission card keeps a rail row under its action row, `? allowed by you · safety-net rail <rule>` or `· autonomy level <level>`, with `?` in `warning`. Compact never folds such a call into its neighbors. The row is live only, because the approval facts never reach the session ledger.
- **Edit Preview**: An `edit` call shows its diff as soon as its arguments close, before it runs, in Standard and Detailed. Compact keeps the row alone. Long-running write, edit and command output streams in the fixed-height live windows of the output-style table.
- **Worker Rows**: The origin mark (`◆` model, `◇` operator) heads the worker block; a running tool inside it shows `⚙`.
- **Turn Settlement**: The final outcome closes the block with its mark in the gutter. Standard prints the outcome and duration (`✓ Done · 14s`). Detailed adds the call count when more than one, input and output tokens, cache read and write, reasoning (`≈` when estimated), why a cold cache was expected, and prewarm results (`✓ Done · 14s · 3 calls · in 100k · out 380`).
- **Context Progress**: Known stage counts fill the bar; unknown work advances an unfilled marker monotonically within the stage without claiming a percentage. Helper timing stays live, showing elapsed seconds, the limit and the run id.

### 5.1 Assistant Text Rendering

Assistant text renders through one stock pi-tui `Markdown` component per text segment, streaming or settled ([chat-panel.ts](../../src/interactive/chat-panel.ts)). A turn is a sequence of text and tool segments in event order, so a reply interleaved with tool calls has several segments. Markdown renders each top-level block independently and caches by text and width, which keeps the rows above the open block byte-stable while text arrives and lets a finished answer restyle at most the block that was still open. Clio adds no second renderer or post-processor; the changes reach Markdown through its theme and transform hooks.

- **Code fences**: Ink comes through the theme's `highlightCode` hook, keyed on the first word of the info string, which is the only part used (`ts title="a.ts"` is read as `ts`). Pi draws the fence rows. The live transcript keeps top-level fence rows; `/export` drops them and labels the block with its language word.
- **Tables**: A pipe table is kept for Pi to draw while the width allows 15 cells per column plus one. Narrower than that, it becomes one block per row of `header: value` lines separated by rules.
- **Math**: `renderLatex` is on.
- **Mermaid**: A top-level fence whose language word is `mermaid` is drawn as a diagram with box-drawing rows ([mermaid.ts](../../src/interactive/renderers/mermaid.ts)). A flowchart or graph declared `LR` that is wider than the terminal is retried as `TD`. The fence falls back to its source only when the diagram cannot be drawn, is still wider than the terminal after the retry, or is taller than 120 rows. Once the fence is closed, the source is followed by `Mermaid diagram shown as source: it <reason>.`, with the reason stated as `could not be drawn`, `is N columns wide and the terminal fits M`, or `is N rows tall, over the 120-row limit`. A fence still streaming shows no note. Fences nested in lists or quotes are not drawn as diagrams.
- **Reasoning**: Supplied reasoning is a separate italic excerpt rail. Inline emphasis markers are dropped from it and its length follows the output style.

Clio cannot see how her reply renders on the operator's screen. The surface decides layout from the terminal width and the settings above after she has written the text, and nothing returns the drawn rows to her. A report that something displayed wrongly therefore describes the surface and not anything she can observe. The guidance she carries about this, including keeping diagrams top-to-bottom with short labels, is in the attended-only `identity.clio-attended` fragment, so headless runs and workers do not receive it.

---

## 6. Overlays & Inspection

- **`/settings`**: The settings center is one docked surface over `SETTINGS_AREAS` in [settings-areas.ts](../../src/core/settings-areas.ts): Recent & Pinned, Connections, Models & Inference, Chat, Agents & Delegation, Fleet, Context & Memory, Workspace & Files, Permissions & Limits, Appearance, Integrations, Advanced. Control names and explanations come from the shared core catalog; live profile and node entries and guided actions stay beside their owning controls. Connections offers **Add a target** and an Edit action for URL, runtime and default model; the docked target wizard drives them through `src/cli/configure-host.ts`, loaded only when setup starts. Save writes global target settings; Esc goes back, and Ctrl+C cancels setup without quitting Clio. Browser sign-in stores credentials immediately. Existing explicit routing defaults remain in place. Route model pickers offer **Use connection default**; proactive memory offers **Rules only**. The [settings walkthrough](../guide/configuration-and-targets.md) explains navigation and the TUI's session/project/global save scopes.
- **`/config`**: Takes no arguments. It suspends the TUI, runs the full configure wizard on the plain terminal, then resumes, applies the saved routing change to the live session and prints the result as a notice. It refuses while a turn is running.
- **`/view transcript`**: Inspect complete un-truncated output, tool payloads, and raw responses.
- **`/usage`**: 5 tabs (Activity, Accounts, Session, Models, Workers) with consumption vs budget percentages. Activity opens first with a Monday-first workspace session heatmap of up to 182 days (fewer weeks on small terminals), working-tree changes loaded asynchronously, session consumption and the first reported plan window. Every tab scrolls within the dock.
- **`/tasks`**: Interactive task board tracking parent/child subagent execution status.
- **`/doctor`**: In-session diagnostic reports with severity-ordered findings.
- **Key card**: On an empty composer, `?` opens a docked key card, `←` opens Fleet Runs and `↓` opens Tasks. The card is not modal, and the next key dismisses it and is consumed. With a draft, these keys keep their editing meaning.

---

## 7. Source Implementation Map

| Subsystem | Source Location | Key Exports |
| :--- | :--- | :--- |
| Theme & Tokens | [tokens.ts](../../src/interactive/theme/tokens.ts) | `ClioToken`, `createClioTheme`, `withThemeContext` |
| Glyph Constants | [glyphs.ts](../../src/interactive/theme/glyphs.ts) | `GLYPH`, `SPINNER_FRAMES` |
| Frames and rules | [rules.ts](../../src/interactive/theme/rules.ts) | `frame`, `innerDivider`, `rule` |
| Output style budgets | [transcript-detail.ts](../../src/interactive/transcript-detail.ts) | `transcriptDetail` |
| Layout | [layout.ts](../../src/interactive/layout.ts) | `buildLayout` |
| Dock | [dock.ts](../../src/interactive/dock.ts) | `dockMount`, `DOCK_BODY_ROWS_MAX` |
| Welcome Dashboard | [welcome-dashboard.ts](../../src/interactive/welcome-dashboard.ts) | `buildWelcomeDashboardLines`, `createBootWelcome` |
| Composer | [clio-editor.ts](../../src/interactive/clio-editor.ts) | `ClioEditor` |
| Footer | [dashboard.ts](../../src/interactive/footer/dashboard.ts) | `buildFooterDashboard` |
| Session transcript | [session-transcript.ts](../../src/interactive/session-transcript.ts) | `createSessionTranscript` |
| Assistant text | [chat-panel.ts](../../src/interactive/chat-panel.ts) | `createChatPanel` |
| Mermaid | [mermaid.ts](../../src/interactive/renderers/mermaid.ts) | `createMermaidMarkdownTransform` |
| Permission overlay | [permission-overlay.ts](../../src/interactive/permission-overlay.ts) | Permission presentation |
| Terminal lease | [terminal-lease.ts](../../src/interactive/terminal-lease.ts) | `createProcessTerminalLease` |
| Input gate and wheel | [application-input-tui.ts](../../src/engine/application-input-tui.ts) | `ApplicationInputTuiAltScreen` |
| Interview selection lease | [instrumented-tui.ts](../../src/engine/instrumented-tui.ts) | `InstrumentedTuiAltScreen.useTerminalSelection` |
| Exit summary | [exit-summary.ts](../../src/interactive/exit-summary.ts) | `renderExitSummary` |
