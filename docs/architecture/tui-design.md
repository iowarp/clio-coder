# Clio Coder TUI Design System

`ClioEditor` in [clio-editor.ts](../../src/interactive/clio-editor.ts) owns composer editing. The [commands and modes guide](../guide/commands-and-modes.md) lists operator controls.

Boot sequence, presentation modes and the traces that measure them are in [TUI boot presentation and measurement](tui-boot-performance.md).

This document is the reference specification for the Clio Coder TUI visual layout, styling, and behavior across [src/interactive/](../../src/interactive/interactive-shell.ts).

The governing architectural principle: **the user reads state from color, structure from frames, and identity from brand marks.** Everything that is not state or structure remains visually quiet.

---

## Output Styles

Toggle tiers with **Alt+O** (`Minimal` → `Default` → `Detailed` → `Minimal`). Default is the startup tier (`interface.outputDetail: standard`). Persisted values remain `compact`, `standard` and `detailed`. The control is **Output detail** in `/settings interface` or `clio-coder configure --section interface`. The row budgets below are the `POLICIES` in [transcript-detail.ts](../../src/interactive/transcript-detail.ts).

| Content | Minimal | Default | Detailed |
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
| **Helper / Shadow Work** | 1 row (`↳ role · task ✓`) | 1 row (`↳ role · task ✓`), plus the current action while running | Full worker card |
| **Failures & Refusals** | Up to 4 rows actionable reason | Up to 4 rows actionable reason | Up to 12 rows with context |
| **Notices & Retries** | Level mark + bounded message | Level mark + bounded message | Diagnostic detail |
| **Reports** (Doctor, multiline notices, command stdout/stderr, extension results) | Title and counters on 1 row | Counters + up to 8 rows (Doctor lists errors first), then `… N more · Detailed or /view for all` | Every row and detail |
| **Turn Receipt** | One row: outcome glyph + duration | Outcome + duration | Outcome, duration, calls, tokens, cache, reasoning, prewarm |
| **Approval & Question Cards** | Every decision input | Every decision input | Every decision input |

- **Preview Budgets**: Counted *after terminal wrapping*, including the `… N rows · /view` overflow hint. Short terminals scale a budget down to `max(2, floor((terminal rows - 8) / 2))` when that is smaller than the style's own limit (`previewBudget` in [preview.ts](../../src/interactive/renderers/preview.ts)).
- **Worker Inspection**: Retained transcript and output artifacts are inspectable through `/view`; per-artifact readers apply their own bounds.
- **Idle Pre-rendering**: Settled entries are pre-rendered into the two alternative styles during idle time, eliminating delay on Alt+O switching.
- **Background Surfaces**: The tier also bounds surfaces outside the transcript, and a change applies without reopening them. The Fleet runs dock follows [3.5](#35-pinned-islands-and-the-dynamic-transcript). In Minimal the Fleet Runs board drops its token, cost, node and account columns and shortens the selected run's facts; an expanded run detail shows every fact at every tier and pages with `PgUp`/`PgDn`. A settled fleet plan card shows no step rows in Minimal, 4 in Default and 12 in Detailed, keeps the first failed step in view, and counts the rest beside `/fleet for detail`. The workers dock gives each card 1 row in Minimal, 2 in Default and 3 in Detailed, and its header counts cancelled runs apart from failed ones. A settled Detailed worker card keeps its answer and failure. `/doctor` lists errors and warnings at every tier and folds passed and informational checks into one `N routine checks folded` line outside Detailed, and Default also names the passed checks on one `OK` row. `/usage` omits the activity heatmap in Minimal, and in Default when the workspace has no sessions. The `/usage` Health tab in Minimal omits the journal and responsiveness sections and shows the connection only when it reports a failure, an SSE pin or fallback, or a recovery ([background-surfaces.test.ts](https://github.com/iowarp/clio-coder/blob/main/tests/contracts/background-surfaces.test.ts)).

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

All symbols are defined in the `GLYPH` object in [src/interactive/theme/glyphs.ts](../../src/interactive/theme/glyphs.ts). A glyph means one thing everywhere; a surface that needs a new meaning asks for a new constant rather than borrowing a shape. `CLIO_CODER_ASCII=1`, `TERM=dumb` and `TERM=unknown` select a parallel ASCII table (`ASCII_GLYPHS`) with the same keys and meanings.

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
Every framed block is built by `frame()` and `innerDivider()` in [rules.ts](../../src/interactive/theme/rules.ts): the launchpad, the task island, the live Fleet runs island, notices, the steering queue and the exit summary. The Fleet Runs board is a docked overlay and draws a run table instead. No surface draws its own corners, tees or rounded frame.
- **Header**: Embedded in the top border in bold `heading`: `┌─ Title ─────────── meta ─┐`. Optional right metadata is `annotation`. A title wider than the island is clipped with `…` before the corner.
- **Body**: `│ ` + content padded to the inner width + ` │`. Sections inside one island are separated by a full-width `╌` row, never by a `├┤` tee.
- **Width**: Every row is exactly the island width in visible cells (minimum 4). Content is truncated with `…`, never wrapped past the rail.
- **Color**: Corners and fills use the `border` role; the inner divider uses `divider`.

### 3.2 Docked Surfaces and Overlays
Every modal surface (`/settings`, pickers, `/view`, `/tasks`, `/usage`, permission cards, interviews) lives in the dock ([dock.ts](../../src/interactive/dock.ts)), the composer's own slot, instead of floating over the transcript. The engine keeps one overlay per frame so focus and input routing stay unchanged, but that overlay paints nothing: the frame registers with the dock and the composer draws it in normal flow between its rails, the way slash autocomplete is drawn. The transcript keeps its position and its scrollback and stays selectable by the terminal. A docked body is at most 16 rows (`DOCK_BODY_ROWS_MAX`) and shrinks to leave two rails, the footer and a sliver of transcript, with a floor of 3 rows. A permission card keeps the composer's draft visible beneath its body, because a steer typed while a call is parked is what the `CONFIRM` label is for.
- Header: Centered or left-aligned title with category tabs.
- Navigation: `↑`/`↓` for items, `Tab` for sections, `Enter` to select, `Esc` to close.
- **Selection**: A focused row carries `❯`. Self-drawn lists use `selectionMark` and `selectionLabel` in [overlay-frame.ts](../../src/interactive/overlay-frame.ts) for an `accent` marker and bold `accent` label. Rows built from the design primitives use `selectionRow` in [primitives.ts](../../src/interactive/theme/primitives.ts). Pi SelectList uses the public `selectedText` hook to replace its leading arrow with `❯` and style the selected row in bold `selectedOption`, including its description. No subclass or dependency patch is used.
- **Permission card**: From the top, an identity row with the tool in its transcript glyph and color, the action class in a risk tone and the rule that fired; the target in a gutter block that folds and is never clipped; a fact table (`why`, `effect`, `mutation`, `asked by`, `authority`, `advisory`); the unattended countdown; and allow, deny and stop as choice rows with their consequences ([permission-overlay.ts](../../src/interactive/permission-overlay.ts)). A short dock folds the choices to one wrapped row, then pins the identity and choices around a scrolling window, and on the shortest cards the choices join the window. The rail carries only the keys the card's rows do not name, and takes allow, deny and stop back whenever those rows are off screen. Opening the terms brings the window to the choices, with the terms below them.
- **Floating exception**: The task island is the one surface that still floats: a non-capturing overlay at the top right. The `?` key card is a non-capturing docked frame.
- **Pane-host docks are a different mechanism**: The files, music and workers docks are Herdr panes beside Clio Coder's own pane, not composer dock frames, and they never draw into the transcript or the composer. They have three states (visible, hidden, closed), a first-tap show or hide on `Alt+E`, `Alt+A` and `Alt+W`, and a double tap within 400 ms that closes them. [Panes and the Files Pane](../guide/panes-and-files.md#showing-hiding-and-closing-docks) specifies them.

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

Live work may animate through `activityCue`; waits on the operator hold a static mark. Nothing animates under `CLIO_CODER_REDUCE_MOTION=1`, screen-reader mode, `NO_COLOR` or the ASCII glyph set. Demo guidance does not control motion.

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
| Compact footer | Two rows. Line 1 reserves a stats column at least 28 cells wide once a figure shows, capped at 40% of the width, so changing numbers do not move the path. At 60 columns or fewer, line 2 is omitted when it has nothing to say, and key hints drop the learning hint beside pinned keys. |
| Expanded footer | The Context legend and the Status machine and connection sections split into two columns from 84 columns. Activity stays one column at every width. A page's height follows the terminal, 6 to 12 rows, and what does not fit scrolls with `Alt+PgUp` and `Alt+PgDn`. |
| Transcript | Prompt and prose rows wrap. Tables, code and diagrams are fitted to the width (see [5.1](#51-assistant-text-rendering)). Fullscreen reserves the last column for the scrollbar. |

Gutters stay 2 columns with hanging indents.

### 3.5 Pinned Islands and the Dynamic Transcript

The viewport has two kinds of content.

- **Pinned**: the dock below the transcript in [layout.ts](../../src/interactive/layout.ts), from top to bottom: the steering queue (`Steering Queue` island), live Fleet runs, the context progress rail, the composer and the footer. While runs are live, Fleet renders in normal flow just above the composer, reserving its own rows in both regular and fullscreen modes. It uses the same phase wording, counts and council projection as the run cards, and a run waiting on an approval sorts first. Minimal shows one row for one run, Default shows up to two runs with a task row under each, and Detailed shows one card and a count of additional cards, which remain inspectable through Fleet Runs. A terminal under 32 rows gets the row form at every tier, without task rows ([fleet-dock.ts](../../src/interactive/fleet-dock.ts)). With no live run, Fleet takes no rows and never paints over a transcript row. The task island is a non-capturing top-right summary owned by `src/interactive/interactive-tickers.ts`, and it hides while an overlay is open or the footer is expanded. The decision board stays a capturing docked surface (`/decisions`), because a decision needs the keyboard and an island may not hold it.
- **Dynamic**: everything in the transcript. Dispatch, council and worker state render as transcript blocks that update in place; the islands summarize them and never become a second history.

**Hydration.** The instant shell paints `createBootWelcome` with the settings already read, at the same geometry as the hydrated launchpad. A resumed session replays its turns through the same panel operations a live turn uses (`rehydrateChatPanelFromTurns` in `src/interactive/chat-renderer.ts`), and the settled entries are pre-rendered in the other output styles while idle.

**Stream ticks.** The chat panel returns a frame as `ChatPanelRegions`: a frozen `prefix` of the contiguous settled entries from the top of the transcript, and a `tail`. The prefix array keeps its identity across stream ticks, and the regular-mode root skips rewriting it while it sits at the same row. A settled entry is a committed prompt, a non-live replay block, a finished worker, a retry row, or an assistant entry with no pending message and no running tool. A stream tick renders the live entry and reuses every cached one, so `ChatPanelRenderMetrics.entriesRendered` is 1 per tick while one entry streams. Inside that entry, a running turn's settled head also joins the freeze. The head is its segments up to its last finalized text, with every call before that text finished, and it is joined once. A tick then walks only the segments after the head (`segmentsRendered`), so a turn that streams thousands of messages copies only its live rows. A head segment that changes, through its text or a settled call's revision, drops the head and the head's part of the freeze. A live worker card is cached too: its own state changes drop its render, and while it has a running tool the render key also carries the panel's 100 ms clock tick, so only elapsed time re-renders it. An entry that changes after it settles, such as a retry row for the same attempt, drops its cached render and the freeze behind it.

**Prose reuse.** Inside an entry, each assistant text segment and each reasoning stretch keeps its wrapped rows for up to three layouts (width and fence mode, plus the preview budget for reasoning), keyed by its source text, whether it is finalized and the skin epoch. Another entry streaming or a running tool's clock therefore never re-wraps earlier prose. A worker card projects its answer preview and redaction incrementally over appended deltas, and caches each redacted display field by its source text ([worker-entry.ts](../../src/interactive/renderers/worker-entry.ts)).

**Streaming reply.** While an answer streams, a frame's work stays off the rows it did not change. Text segments change only by append or replace, and an append feeds the prose and redaction projections only the new text ([assistant-prose.ts](../../src/core/assistant-prose.ts), [redaction.ts](../../src/domains/safety/redaction.ts)), so a frame neither flattens nor compares the whole reply. The gutter rows of unchanged leading rows are reused, and the suggestion and stray-mark checks follow the appended text instead of scanning the reply ([chat-panel.ts](../../src/interactive/chat-panel.ts)). Markdown itself re-lexes only the open tail ([5.1](#51-assistant-text-rendering)). In the regular screen, the pi-tui patch runs the OSC 133 prompt-marker strip only on rows that start with the marker, where stock pi-tui runs it on every row of every frame ([patch notes](https://github.com/iowarp/clio-coder/blob/main/patches/README.md)). The rendered rows are the same either way.

**Finished work.** A running turn's assistant entry keeps the rows of its finished calls, and a late result or an attached worker card drops them; a Minimal fold re-renders only when it grows. A worker card compares the telemetry values it prints, so a batch that moved none of them keeps its rows and the frozen prefix. Fullscreen composes its document only when the header or transcript changes, and a streamed token writes the header and tail into a pooled array that already holds the settled prefix.

**Pacing.** While pacing is active, a delta landing on an empty queue is released at once, and only a burst's excess is spread out, over a window of at most 250 ms that follows the provider's cadence ([stream-pacer.ts](../../src/interactive/stream-pacer.ts)). Past 20 KiB of open reply, answer text is applied no more often than keeps its Markdown layout under 30 percent of the main thread, at most 2 seconds apart, so a keystroke's frame reuses the last layout. Every ordered boundary releases the held text first ([chat-renderer.ts](../../src/interactive/chat-renderer.ts)).

**Measuring.** `src/interactive/render-trace.ts` records frames, panel `entriesRendered`, `segmentsRendered` and `cacheHit`, a chat submit's phases from Enter to admission, bytes written per commit, and `rowsChanged`: the number of root rows that differ from the previous frame at the same index. Set `CLIO_CODER_RENDER_TRACE` to a file path to arm the trace. `rowsChanged` is computed only while a trace file is armed and is an estimate of pi-tui's differential write, since a viewport move, a resize or an overlay can make pi-tui repaint more rows. `scripts/bench-tui.ts` drives provider-free render workloads, and `scripts/bench-tui-feedback.ts` measures feedback latency through a real PTY against a fake provider; neither includes terminal painting. Tests never assert wall-clock time.

### 3.6 Screen Modes

`interface.mode` selects the renderer: `regular` (default) preserves terminal scrollback and appends the dock after the transcript, and `fullscreen` uses the alternate screen with a scrolling transcript view above a pinned dock. In fullscreen the transcript view follows the end until the operator scrolls, `interface.fullscreenScrollbar` (`hidden`, `auto` default, `always`) controls the scrollbar, and a submission returns the view to the live edge. The scrollbar column is reserved whenever a scrollbar can appear, so it never reflows rows. Paging, search and mouse scrolling exist only in fullscreen; regular mode relies on the terminal's own scrollback and Find.

### 3.7 Overlay Input and the Mouse Wheel

One application input gate registers on the TUI before any other listener ([application-input-tui.ts](../../src/engine/application-input-tui.ts)), so Clio Coder's policy sees every key before Pi's viewport shortcuts and the focused widget. Key-release events are dropped there, and bracketed paste reaches the policy as literal data.

In fullscreen with any overlay visible, the mouse wheel scrolls the transcript and never moves list choices. Pi would offer the wheel to the overlay under the pointer, where its select and settings lists turn it into selection moves; the gate instead scrolls the transcript by one line per notch, five with Alt, and consumes the event. Choices move only on keys.

Ctrl+Z suspends Clio Coder from every modal owner: the suspend action is checked before transcript search, the side question, the context view, a permission card or the dispatch board can consume the key ([application-controller.ts](../../src/interactive/application-controller.ts)).

In fullscreen, a mouse selection copies through the system clipboard and the flash reports the outcome ([clipboard.ts](../../src/engine/clipboard.ts)). Pi's own copy writes only an OSC 52 sequence and says `Copied!`, which many terminals ignore. Clio Coder tries tools whose exit status confirms delivery: Pi's native clipboard on macOS and Windows, `clip.exe` (single-line ASCII only) and `powershell.exe` on Windows and WSL, `pbcopy` on macOS, and `wl-copy`, `xclip` or `xsel` on Linux when a Wayland or X display is set. Over SSH only a forwarded X11 display is tried, because a local tool would fill the remote machine's clipboard. When no tool confirms, the OSC 52 sequence still goes out and the flash reads `Copy unconfirmed: <reasons>; OSC 52 sent`. A newer selection supersedes a slower older copy instead of racing it.

A native `ask_user` interview holds a terminal-selection lease (`useTerminalSelection` in [instrumented-tui.ts](../../src/engine/instrumented-tui.ts)) for as long as it is open. The lease turns off mouse tracking (DECSET 1000, 1002, 1003 and 1006) so the terminal can select text on the stable interview screen, and it turns off alternate-scroll mode 1007. On the alternate screen without mouse tracking, mode 1007 makes a terminal send the wheel as arrow keys that arrive identical to real ones and would move the interview's choice. When the last lease releases, tracking comes back (1003 is skipped under tmux, zellij and screen) together with 1007, the common terminal default.

---

## 4. Screen Surfaces & State Choreography

The visual hierarchy coordinates four primary screen surfaces: Header, Transcript, Composer, and Footer.

### 4.1 Welcome Launchpad & Session Header

The header operates in two distinct modes:
- **Launchpad (before the first prompt)**: Default shows a seven-row titled panel with model, autonomy, awareness and one next action, plus an `Instructions` row when a project preload exists. Under 48 columns or 20 rows it keeps only the route and the next action. Detailed adds artwork, project facts, two reserved account-usage rows and a process-local tagline; below 48 columns or 30 rows it falls back to the Default panel. The next action names what blocks work (`/model` for an unset route, `/settings targets` for an unavailable or degraded one, then `/context init`, `/context refresh` or `/context` by awareness). Welcome-only reads happen off the render path. Minimal, demo-off, the ASCII glyph set (`CLIO_CODER_ASCII=1`, `TERM=dumb` or `TERM=unknown`) and screen-reader mode skip the launchpad and print a one-row identity header ([welcome-dashboard.ts](../../src/interactive/welcome-dashboard.ts)).
- **Session Header (after prompt admission)**: One live line with brand, version and active route. Workspace and Git facts stay in the footer instead of repeating above the transcript. `/new` restores the tier-appropriate welcome.

### 4.2 Composer (ClioEditor)

The input surface (`ClioEditor`) frames the operator's prompt:
- **Rails**: Framed by the static top and bottom rails of [1.3](#13-composer-rails). The empty composer reads `Ask Clio…  / for commands`, and its prompt changes while a parked call, a preparing turn or a compaction owns the composer (see [4.4](#44-composer-phases)).
- **Steering Affordance**: Messages queued for a live run show in a `Steering Queue` island above the composer, with its action hints: the queue key to review them (`a` in the navigator restores all to the composer) and the send-now key ([follow-up-queue-panel.ts](../../src/interactive/follow-up-queue-panel.ts)).
- **New lines**: `Shift+Enter`, `Ctrl+J` and `Alt+Enter` insert a newline. `Alt+Enter` is bound explicitly so it also works under the kitty keyboard protocol, which reports it as its own key ([keybindings.ts](../../src/domains/config/keybindings.ts)).
- **Slow attachments**: While a submitted `@file` PDF is being read, the footer shows `reading <path> · Esc cancels and keeps your message`. `Esc` or `Ctrl+C` aborts the read, sends nothing, prints no error and returns the line to the editor; a chat line enters history only after its expansion finishes.

### 4.3 Progressively Disclosed Footer

The compact footer uses one row when quiet and adds rows only for useful controls, facts or notices:
- **Line 1 (Workspace & Metrics)**: Effective autonomy first, then working directory and Git branch with a `*` when dirty, and right-hand context occupancy. Default and Detailed may add throughput; Minimal leaves it to inspection. Branch and context figures stay blank until known. Once metrics appear, the footer reserves their column and the dirty marker's space so changing numbers do not shift the path's cut point. A narrow row drops the percent, then states it as `ctx N%`.
- **Line 2 (Notices & Hints)**: One message, in this order of precedence: an armed quit or leader key, the top notice, setting feedback, a footer tip, then key hints. Beside it, when space permits, the tail shows active worker count, armed skill names and the selected model's weekly quota headroom. Key hints pin the keys that answer the moment and describe what the composer holds now ([key-hints.ts](../../src/interactive/footer/key-hints.ts)). While the composer is empty, one learning hint may sit beside them and changes once a minute, skipping keys the operator has already pressed (`harness-profile.json`); a draft, a narrow footer that already pins keys, Minimal output or `interface.demo` off drops it. A hint is shown whole or not at all, and a key whose target does not exist right now is never offered.
- **Notice Slot**: Line 2 has room for one notice. It shows the head of the notice center's order, most severe first and newest within a level, with the level's glyph and token. A notice that is multi-line or wider than its room is cut and ends in the dashboard key plus `more`; the expanded dashboard wraps it in full.
- **Narrow Terminals**: Secondary hints yield space to the context percentage and phase without wrapping; optional counts drop before a number is cut.

The expanded footer has three pages, Activity, Context and Status, which the dashboard key cycles through before closing ([pages.ts](../../src/interactive/footer/pages.ts)). Activity leads with the harness phase and live figures, then the session's totals and task board, one table row per worker with live runs first and at most four finished, and each live run's route, account, task, activity and `/view` reference. Context leads with the category meter and its figure, then headroom, the composition legend and cache facts. Status leads with spend and account meters, then workers and the worker cap, the machine and connections. Machine counters are sampled only while Status is visible. Worker counts in both footers include running, queued, cancelling, retrying and stale runs.

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
| Approval required | `needs approval`, with the keys the card's rows do not name on the bottom rail |
| Retrying | `is retrying <attempt>/<max>` |
| Compacting | `is compacting context` |
| No output | `has no output · <seconds>s` |
| Ended | `finished`, `failed`, `was cancelled`, `reached the output limit`, or `stopped generating tool arguments` |

While the composer is empty its placeholder follows the mode: `A parked call is waiting for your decision`, `Clio has your prompt and is preparing the turn`, or `Clio is compacting the session context`. The expanded Activity page's first row leads with the footer phase verb, or `Ready` when idle.

### 4.5 Exit Summary

A clean interactive exit prints a branded session summary in the island frame, per `interface.exitSummary` (`auto`, `brief`, `standard`, `report`, `off`; default `auto`). `auto` follows output detail: compact gives brief, standard gives standard, and detailed gives report. Legacy `full` normalizes to standard ([defaults.ts](../../src/core/defaults.ts)). Contents, timing and suppression are in [Exit summary](../guide/commands-and-modes.md#exit-summary).

---

## 5. Transcript & Gutter Grammar

Every transcript row follows a rigid 2-column gutter format:
```text
<gutter:2> <content>
```
- **Prose Head**: `✦ ` followed by text in standard color.
- **Prose Continuation**: `  ` indented 2 spaces.
- **Tool Action Row**: Class glyph (`▸`, `§`, `±`, `$`, `↗`, `?`, `⇢`) + verb + scalar target + outcome (`✓ Done · 12ms`).
- **Operator Grant**: A call that ran because the operator allowed it at a permission card keeps a rail row under its action row, `? allowed by you · safety-net rail <rule>` or `· autonomy level <level>`, with `?` in `warning`. Minimal never folds such a call into its neighbors. The row is live only, because the approval facts never reach the session ledger.
- **YOLO Receipt**: A risky call that actually started under `yolo` keeps `YOLO auto-approved · no prompt` under its action row, and a chain keeps it above its step rows. Minimal never folds it away. A local read, a call at `default`, a one-shot grant and a call refused before it started carry none. Unlike an operator grant, the mark is stored with the call, so it returns on replay and on resume after switching to `default`, and calls inside delegated runs and chains keep it.
- **Edit Preview**: An `edit` call shows its diff as soon as its arguments close, before it runs, in Default and Detailed. Minimal keeps the row alone. Long-running write, edit and command output streams in the fixed-height live windows of the output-style table.
- **Worker Rows**: The origin mark (`◆` model, `◇` operator) heads the worker block; a running tool inside it shows `⚙`.
- **Turn Settlement**: The final outcome closes the block with its mark in the gutter. Minimal ends with one dim row of the outcome glyph and duration (`✓ 900ms`), keeping the outcome word for anything but Done. Default prints the outcome and duration (`✓ Done · 14s`). A turn that ends while workers it or the operator started still run is not Done: it closes with the dispatch mark as `⇲ Turn ended · 2 workers running · 14s`, and the workers' own cards report when they settle. Detailed adds the call count when more than one, input and output tokens, cache read and write, reasoning (`≈` when estimated), why a cold cache was expected, and prewarm results (`✓ Done · 14s · 3 calls · in 100k · out 380`).
- **Context Progress**: Known stage counts fill the bar; unknown work advances an unfilled marker monotonically within the stage without claiming a percentage. Helper timing stays live, showing elapsed seconds, the limit and the run id.

### 5.1 Assistant Text Rendering

Assistant text renders through stock pi-tui `Markdown` ([chat-panel.ts](../../src/interactive/chat-panel.ts)): one component per finished text segment, and while a segment streams, a settled head of whole blocks rendered once per width plus the open tail, which is all a delta lexes again. A turn is a sequence of text and tool segments in event order, so a reply interleaved with tool calls has several segments. The head grows only at cuts [markdown-blocks.ts](../../src/interactive/renderers/markdown-blocks.ts) proves render the same apart as within the whole: after a blank-line run whose next line is complete, with no reference definition in the text and no display-math block or inline-math fence open across it. Markdown renders each top-level block independently and caches by text and width, which keeps the rows above the open block byte-stable while text arrives and lets a finished answer restyle at most the block that was still open. Clio Coder adds no second renderer or post-processor; the changes reach Markdown through its theme and transform hooks.

- **Code fences**: Ink comes through the theme's `highlightCode` hook, keyed on the first word of the info string, which is the only part used (`ts title="a.ts"` is read as `ts`). Pi draws the fence rows. The live transcript keeps top-level fence rows; `/export` drops them and labels the block with its language word.
- **Tables**: A pipe table is kept for Pi to draw while the width allows 15 cells per column plus one. Narrower than that, it becomes one block per row of `header: value` lines separated by rules.
- **Math**: `renderLatex` is on.
- **Mermaid**: A top-level fence whose language word is `mermaid` is drawn as a diagram with box-drawing rows ([mermaid.ts](../../src/interactive/renderers/mermaid.ts)). A flowchart or graph declared `LR` that is wider than the terminal is retried as `TD`. The fence falls back to its source only when the diagram cannot be drawn, is still wider than the terminal after the retry, or is taller than 120 rows. Once the fence is closed, the source is followed by `Mermaid diagram shown as source: it <reason>.`, with the reason stated as `could not be drawn`, `is N columns wide and the terminal fits M`, or `is N rows tall, over the 120-row limit`. A fence still streaming shows no note. Fences nested in lists or quotes are not drawn as diagrams.
- **Reasoning**: Supplied reasoning is a separate italic excerpt rail. Inline emphasis markers are dropped from it and its length follows the output style.

Clio cannot inspect how its replies render on the operator's screen. The surface lays out the generated text using the terminal width and the settings above; the drawn rows are not returned to the model. A report of an incorrect display therefore describes rendering that the model cannot inspect. Guidance for this limitation, including keeping diagrams top-to-bottom with short labels, is in the attended-only `identity.clio-attended` fragment, so headless runs and workers do not receive it.

### 5.2 Cards

A card is the block the TUI draws about one piece of work: a tool call, an approval, a question, a diff or a notice. Inline cards share one geometry from [card.ts](../../src/interactive/card.ts):

```text
$ ran `npm test` · exit 1 ✗ · 4.1s       head: hanging wrap, status tail never split
  │ not ok 3 - retries once               body: rail, budgeted by output style
  │ … 12 earlier lines · /view            what was cut, and where to read it
```

- **Head**: Wraps with a hanging indent in the content column. The status tail (glyph, duration) joins the last row when it fits and otherwise takes a row of its own, whole (`cardHead`).
- **Body**: Rows sit behind a `│` rail in `gutter`, or in `error` on a failed card so the whole block reads as the failure (`cardRail`, `cardRows`).
- **Callouts**: A framed notice is indented by the gutter and stops growing at 88 columns. Docked approval and question cards follow the same limit, so their sentences do not stretch across a wide dock; the approval's inspection keeps the dock's full width, because the column a character sits in is what it shows.
- **Foreground cards**: Approval and question cards wait on the operator. They show every decision input at every output style: the target, the reason, the effect, the mutation, the safety judge's advisory, the timer and the choices. Output style budgets apply to background cards only.
- **Nothing twice**: While an approval card is docked, its call's transcript row keeps only its head (`⏸ awaiting approval`). The reason and target return to the row if the card leaves unanswered or cannot mount. A single question has no `Question 1 of 1` row. A shell row names the model that asked for it only when the turn had more than one model, because `Reply from` already names it. A failed command that printed nothing shows `exit N ✗` with no body and no size.
- **Inspection**: `/view` and the inspect toggle show a card in full without changing the output style.

---

## 6. Overlays & Inspection

- **`/settings`**: The settings center is one docked surface over `SETTINGS_AREAS` in [settings-areas.ts](../../src/core/settings-areas.ts): Recent & Pinned, Connections, Models & Inference, Chat, Agents & Delegation, Fleet, Context & Memory, Workspace & Files, Permissions & Limits, Appearance, Integrations, Advanced. Control names and explanations come from the shared core catalog; live profile and node entries and guided actions stay beside their owning controls. Connections offers **Add a target** and an Edit action for URL, runtime and default model; the docked target wizard drives them through `src/cli/configure-host.ts`, loaded only when setup starts. Save writes global target settings; Esc goes back, and Ctrl+C cancels setup without quitting Clio Coder. Browser sign-in stores credentials immediately. Existing explicit routing defaults remain in place. Route model pickers offer **Use connection default**; proactive memory offers **Chat route (no memory model set)**. The [settings walkthrough](../guide/configuration-and-targets.md) explains navigation and the TUI's session/project/global save scopes.
- **`/config`**: Takes no arguments. It suspends the TUI, runs the full configure wizard on the plain terminal, then resumes, applies the saved routing change to the live session and prints the result as a notice. It refuses while a turn is running.
- **`/view transcript`**: Inspect retained transcript entries and tool results through the artifact providers.
- **`/usage`**: 5 tabs (Activity, Accounts, Session, Models, Workers) with consumption vs budget percentages. Activity opens first. In Detailed, and in Default once the workspace has a session, it leads with a Monday-first workspace session heatmap of up to 182 days (fewer weeks on small terminals); Activity also shows working-tree changes loaded asynchronously, session consumption and the first reported plan window. Session also counts verified outcomes and the tokens and cost per outcome, the figures the exit summary's `Verified` row prints ([usage-words.ts](../../src/interactive/usage-words.ts)). Every tab scrolls within the dock.
- **`/tasks`**: Session task board showing goals and subgoals, status, blockers, evidence and linked worker runs; the project operator inbox remains a separate store ([task-board.ts](../../src/domains/session/task-board.ts)).
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
| Cards | [card.ts](../../src/interactive/card.ts) | `cardHead`, `cardRail`, `cardRows` |
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
