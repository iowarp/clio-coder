# Clio TUI Design System

This document is the reference specification for the Clio Coder TUI visual layout, styling, and behavior. It describes color semantics, the glyph vocabulary, structural recipes, and state choreography for all surfaces under [src/interactive/](../../src/interactive/).

The governing principle: **the user reads state from color, structure from frames, and identity from brand marks.** Everything that is not state or structure remains visually quiet.

---

## Output styles

**Alt+O** cycles **Compact → Standard → Detailed → Compact**. Standard is the default, so the first press reveals Detailed. The current style appears in the footer. Cycling applies immediately to the current session, including streaming output and history. Settled entries are rendered ahead in the two styles not on screen during idle time, so the first press into a style costs what a return to one costs. Save a preferred startup style through **/settings interface → Output style → Apply and save globally**, or `clio-coder configure --section panes`.

| Content | Compact | Standard | Detailed |
| --- | --- | --- | --- |
| Answers and user messages | Complete | Complete | Complete |
| Supplied reasoning | Marker | 3 rows | 12 rows |
| Reads and searches | A run of them folds into one `explored` row | Action and outcome | 8 result rows |
| Knowledge lookups | A run of them folds into one `consulted` row | Action and outcome | 8 result rows |
| File changes | A run of them folds into one `edited` row with each file's change facts | 8 diff rows | 20 diff rows |
| Questions to you | Question and answer on one row; a round nests one answer per row | Same | Same |
| Agent shell commands | Command and outcome | Command and outcome | 12 output rows |
| Your `!` / `!!` shell commands | 3 output rows | 6 output rows | 12 output rows |
| Workers | Identity, execution and validation outcome | 3 summary rows and the current action while running | 8 summary rows and bounded tool activity |
| Failures and refusals | Actionable reason, up to 4 rows | Actionable reason, up to 4 rows | Up to 12 rows |
| Turn receipt | None | Outcome and available duration | Outcome, duration, usage and model-call facts |

Preview budgets count terminal rows **after wrapping**, including the `/view` overflow hint, and shrink on short terminals. Reasoning previews retain the newest text when streaming stops. Detailed remains bounded: a successful `cat` or file read cannot fill the transcript with the entire file.

Detailed worker activity puts `now:` operations before newest-first `last:` calls; settled entries do not advertise stale current work. Pending checkpoint questions remain visible even in Compact.

Use **/view transcript** to select full available reasoning, tool arguments/results, local shell output, or worker details. Search the list, press Enter to inspect, and Escape to return. Offloaded tool and dispatch output remains available in the other `/view` categories; missing or truncated captured content is identified. Inspection applies secret redaction, and `!!` output remains excluded from model context.

Output style changes presentation only. **Shift+Tab** still changes the model's thinking effort. It does not reveal unavailable reasoning; Clio shows only reasoning supplied by the provider. The previous Alt+R, Alt+P, and expand-all rendering shortcuts are retired. `/output` now explains how to reach Alt+O and Settings. Existing `minimal`, `default`, and `verbose` preferences map to `compact`, `standard`, and `detailed` without rewriting other preferences.

The footer owns live activity. Transcript actions have static running or outcome markers and update in place. Background workers add a count without replacing the main agent's current phase; a completed worker cannot clear a sibling's active state. Approval and user-input waits do not spin. Failed and cancelled turns retain their actual outcome, and an elapsed wait is described as silence rather than proof that a process is stuck. A worker's successful execution remains separate from its validation result.

---

## 1. Color System

All color styling is defined in [src/interactive/theme/tokens.ts](../../src/interactive/theme/tokens.ts). No raw SGR sequences, `38;2;`/`38;5;` ANSI escape fragments, or hardcoded hex colors are allowed outside this theme module.

### 1.1 Color Tokens

| Token | Value | Role |
|---|---|---|
| `editor` | `#40ffbf` (Neon teal) | The composer rails alone own the neon intensity tier. |
| `editorDanger` | `#ff5058` | Composer rail endcaps and label under full-auto autonomy. |
| `editorAction` | `#ffab45` | Composer rail during exceptional preparation and compacting phases. |
| `accent` | `#53b196` (Teal) | Brand and interactivity: frame titles, selection highlight, keybinding/slash-command affordances, the operator prompt bar, the agent voice glyph, and active/writing phases. |
| `accentDeep` | `#3e9389` | Structural emphasis only: bold CAPS section tags. |
| `tool` | `#6fada5` | Action-row verbs in the tool ledger. |
| `agent` | `#cf905b` | Dispatch verbs and active worker counts. |
| `action` | `#d99b62` (Orange) | Active autonomous operations: dispatching phase pills, active fleet badges, running fleet indicators, running connect/probe indicators, and user-steering queues. |
| `success` | `#77b891` (Green) | Positive outcomes: success indicators (`✓`), ok health status, clean git trees, added-line counts, and output-token count updates. |
| `warning` | `#d3b06b` (Amber) | Real warnings only: stale data, dirty trees, retry status, blocked tools, and truncation. |
| `error` | `#db8289` (Red) | Failures: error indicators (`✗`), error rails, failed outcomes, removed-line counts, and error message text. |
| `info` | `#80a7ce` (Blue) | Informational messages, notices, and system-prompt meters. |
| `reason` | `#af9bc9` (Purple) | Reasoning-related status: thinking phases, the reasoning rail, reasoning-token metrics, and context compacting. |
| `dim` | `#6a7a85` | Scaffolding elements: separators, key names, keyboard shortcut hints, durations, and timestamps. |
| `muted` | `#8a99a4` | Secondary content: paths, previews, counts, and non-status values. |
| `title` | `#72b8ad` | Overlay and frame titles. |
| `frame` | `#2f5d5a` | Borders, rules, inner dividers, and unused context space. |
| `frameStrong` | `#2aab9e` | The active editor input rail background. |

The canonical hex values live in [src/core/theme-token-hex.ts](../../src/core/theme-token-hex.ts); terminals without truecolor get each token's nearest xterm-256 color from `tokens.ts`.

### 1.2 Placement Rules

- Color is used functionally to indicate state. If removing a color does not lose information, the text is colored using `dim`, `muted`, or left unstyled.
- `warning` amber is reserved for true warnings. Costs and neutral telemetry numbers use `muted`.
- `accentDeep` is used only in section tags. Metric values (such as TTFT, tokens-per-second, and autonomy status) use `muted`.
- `action` neon orange remains scarce and strictly disciplined: only while Clio is acting, for workspace-authority and worker-escalation decision frames, or during exceptional composer preparation/compacting phases. It is never used for idle decoration or settled telemetry, and never appears on more than one element per screen region. Outward, safety-net, and system decision frames use `warning`; conversational answers use `accent`.
- Per-surface color budgets limit noise: chip strips use at most one non-neutral token per chip, and framed cards use at most one status token alongside neutral colors.

---

## 2. Glyph Vocabulary

All symbols are defined as constants in [src/interactive/theme/glyphs.ts](../../src/interactive/theme/glyphs.ts). Rendering code reference these names instead of embedding hardcoded glyph literals.

| Glyph | Name | Meaning | Used by |
|---|---|---|---|
| `>C_` | `brand` | Clio wordmark | Welcome launchpad header, session header, and dashboard header only. |
| `✦` | `agent` | Agent voice | First row of every agent prose block (accent); the terminal error block (error). |
| `▌` | `userBar` | Operator input | Every row of a transcript prompt (accent); command echoes (dim). |
| `›` | `user` | Quoted operator text | Steering queue marker (action); request echoes in overlays. |
| `❯` | `cursor` | Selection focus | Settings, list overlays, selectors. |
| `▸` | `toolHeader` | Observe or search | Action rows for reads, listings, data inspection and searches. |
| `§` | `classKnowledge` | Consult Clio's knowledge | Action rows for context, docs, library, evidence, ledger and compaction calls, and skill loads. |
| `±` | `classMutate` | Change files | Action rows for edits, writes and artifacts. |
| `$` | `classExecute` | Execute | Action rows for commands, scripts, checks, git and panes. |
| `↗` | `classNetwork` | Reach the network | Action rows for web fetches and reads. |
| `?` | `classInteraction` | Ask the operator | Action rows for questions, decisions and noted limitations. |
| `⇢` | `classExternal` | Call outside Clio | Gateway, MCP and extension calls. |
| `✓` | `ok` | Success | Everywhere. |
| `✗` | `error` | Failure | Everywhere. |
| `⊘` | `cancelled` | Cancelled or aborted | Everywhere. |
| `⚠` | `warn` | Warning block | Notices, stuck phase. |
| `!` | `warnInline` | Inline warning mark | Git dirty, stale rows, fleet row warnings. |
| `ℹ` | `info` | Informational notice | Notification surfaces. |
| `●` | `running` | Live run (static form) | Dispatch rows when not animated, health ok. |
| `◌` | `queued` | Queued or idle | Queued dispatch rows, idle phase. |
| `⣾⣽⣻⢿⡿⣟⣯⣷` | `SPINNER_FRAMES` | Live activity | Phase pill and running dispatch rows. |
| `◔ ◐ ◑` | `phaseWaiting/phaseThinking/phaseWriting` | Turn progression | Phase pill. |
| `⚙` | `phaseTool` | Tool executing | Phase pill. |
| `⏸` | `phaseBlocked` | Awaiting confirmation | Phase pill. |
| `↻` | `phaseRetry` | Retrying | Phase pill, retry notices. |
| `♻` | `phaseCompact` | Compacting | Phase pill. |
| `⇲` | `phaseDispatch` | Dispatching (action orange) | Phase pill. |
| `↑ ↓` | `up/down` | Input and output tokens; scroll | Everywhere. |
| `⚡` | `speed` | Throughput | Everywhere. |
| `▰ ▱` | `contextFull/contextFree` | Context meter cells | Meters. |
| `▒` | `contextReserve` | Autocompact reserve cells | Context meters. |
| `█ ░` | `barFull/barEmpty` | Wide-glyph fallback | Meters. |
| `│` | `rail` | Rail | Reasoning in the transcript gutter (reason); tool and worker bodies nested in the content column; column separators. |
| `─` | (rules) | Horizontal rule and borders | Frames and rules. |
| `╌` | `innerDivider` | Divider inside a frame | Task island, any framed list. |
| `·` | (dotSep) | Chip separator (dim) | Everywhere. |
| `◆ ◇` | `active/scoped` | Active and scoped marks | Model selector, thinking selector, Settings profile workbench. |
| `◆ ◇` | `workerAgent/workerHuman` | Who started a run | Delegate action rows and worker cards: `◆` the model, `◇` the operator (`/run`, `/delegate`). |
| `↳` | `subProcess` | Clio's own helper work | Helper and shadow worker rows. |

---

## 3. Formatting Rules

Standardized formatters live in [src/interactive/theme/labels.ts](../../src/interactive/theme/labels.ts) and other shared UI modules:

- **Duration**: `formatCompactMs` is the unified duration formatter, yielding compact outputs (`860ms`, `4.2s`, `42s`, `1m36s`).
- **Token Counts**: `formatFooterTokens` formats footer and chip counts (`842`, `12.4k`, `1.2M`). Full numeric strings via `toLocaleString` are reserved for detailed tables like the context legend.
- **Cost**: The shared `formatUsd` formatter handles dollar values, printing up to four decimal places when under one cent.
- **Model IDs**: `abbreviateModelId` fits the model label to 24 terminal cells, allocating space to the model family and suffix before shortening its placement prefix. It preserves complete graphemes and marks omissions with `…`. The hydrated presentation passes raw, structured target/model fields through the editor callback; the composer formats them once at its actual width, retaining the full route when it fits and letting placement yield to target, family and variant when it does not. Raw identity and workspace text is sanitized before width measurement or grapheme splitting, so OSC/CSI payloads and control bytes cannot become visible label fragments. Abbreviations are display labels; full routes remain available in model/settings inspection and Fleet Runs detail.

---

## 4. Structural Layouts

### 4.1 The Island (Framed Block)

Rendered via `frame()` in [src/interactive/theme/rules.ts](../../src/interactive/theme/rules.ts):

```
┌─ Title ──────────────────────────── meta ─┐
│ body line                                 │
│ body line                                 │
└───────────────────────────────────────────┘
```

- Corners and borders use `frame`.
- `Title` is written in bold `title` color, padded with exactly one space on each side.
- The right-aligned `meta` field is drawn in `dim` color before the closing corner.
- Body rows use the vertical rail `│` with one space of padding.
- Inner dividers use `╌` in `frame` color.

### 4.2 The Overlay

Overlay frames share the island's top border rules and include keyboard shortcut hints in the bottom border:

```
└─ [Tab] mode · [Esc] close ─────────────────┘
```

Expanded Fleet run cards show available policy and budget details when native dispatch admission supplies an envelope. These values wrap and may occupy several rows; the default card omits them. The `policy` row shows the recipe default or exact pin, its optional maximum, and the invocation request. The `budget` row shows the effective phase, the operator lifetime cap, and the clamp or retry/revision escalation reason. Historical or external-agent rows without this provenance omit both rows.

### 4.3 Section Headers

- **Panel Section Tag**: Bold CAPS in `accentDeep`.
- **List Group Header**: A leading rule followed by the label, e.g. `── Label` in `dim`.

### 4.4 Key-Value Rows

Drawn as `<key padded, dim> <value>`, where the value defaults to `muted` unless a semantic token applies.

### 4.5 The Status Pill

```
<spinner|glyph> <label> [ · badge]
```

- For active phases, the animated spinner frames replace the static phase glyph.
- Spinner, glyph, and label all use the current phase's token color.
- Badges are separated by dim dots: `· fleet 2` (action), `· tools 1` (muted).

### 4.6 Narrow Terminal Behavior

All TUI overlays and cards support compact widths down to 40 columns:
- Split overlays such as `/view` fall back to a single-pane layout with `[Tab]` switching between the artifact list and details.
- Keybinding hints, cards, and markdown detail text wrap fluidly without horizontal clipping.
- Settings provides a dedicated drill-down stack below 72 columns.

### 4.7 Decision Consequence Frames

Permission confirmation and `ask_user` use one pure consequence presentation classifier while keeping separate input and execution protocols. The classifier supplies the tier title, semantic frame token, consequence and reversibility copy, requester attribution, and display actions. Permission keeps allow-once, deny, and stop behavior. `ask_user` keeps selection, free-text, cancellation, and a single bottom-anchored, content-sized interview frame sized directly to the round.

| Tier | Title | Token | Plain-text identity |
| --- | --- | --- | --- |
| Conversation | `Answer a question` | `accent` | `Conversational answer` |
| Workspace | `Approve workspace action` | `action` | `Workspace authority` |
| Outward | `Confirm outward consequence` | `warning` | `Outward consequence` |
| Safety net | `Safety-net confirmation` | `warning` | `Safety-net confirmation` |
| System | `Approve system change` | `warning` | `System change` |
| Worker | `Worker needs approval` | `action` | `Worker escalation` |

The words carry the meaning when color is disabled. Permission copy states the exact one-shot authority, whether effects are reversible, the authenticated requester and axis, and what deny and stop do. The classifier never consumes question, reason, summary, option-label, or requested-title prose, so those strings cannot select or lower a tier.

---

## 5. Screen Surfaces & State Choreography

The Clio screen maintains a responsive, four-zone structure: the launchpad / session header, transcript, composer, and footer. `interface.mode` chooses the renderer at startup. The default `regular` mode uses terminal scrollback. Opt-in `fullscreen` mode uses the alternate screen: the launchpad/header and transcript occupy an independently scrollable viewport while the follow-up queue, composer, and footer remain docked at the bottom.

In fullscreen mode, `PageUp` and `PageDown` scroll one viewport, `Ctrl+G Home` and `Ctrl+G End` jump to its bounds, `Ctrl+Up` and `Ctrl+Down` jump between semantic prompts; plain Home/End edit the composer, and the mouse wheel scrolls the transcript. Dragging the scrollbar thumb moves the viewport directly. `interface.fullscreenScrollbar` is `hidden`, `auto` (visible during interaction), or `always`. Manual scrolling suspends follow-end so new output does not steal the operator's position; returning to the bottom resumes it. Both fullscreen settings are restart-scoped because Clio constructs its terminal renderer and component graph once at startup.

`interface.smoothStreaming` controls presentation-only pacing of derived assistant text and thinking. The default `auto` paces only on a capable local TTY and bypasses pacing for non-TTY, SSH, multiplexers, CI, screen-reader/reduced-motion markers, or observed stdout backpressure. `on` explicitly requests grapheme-safe pacing, while still stopping frame production behind stdout backpressure. `off` uses the 16 ms coalescer alone. Paced or not, the first delta of a stream is shown whole in the frame it arrives, and the coalescer asks for a frame on the leading edge of a quiet window, so only the deltas inside one window wait for its end. Raw provider wrappers never enter the panel, canonical events and persistence remain synchronous, and tool/message/turn/abort/retry/submit/teardown boundaries drain visible state before they continue.

Interactive startup uses one terminal lease across both boot stages. Stage 0 owns the terminal, renderer, root host, exact editor instance, input decoder, raw mode, resize subscription, protocol queries, signals, and stop lifecycle, and commits a measured minimal frame while services hydrate. Hydration synchronously swaps the root and input/signal delegates without reconstructing the editor or initializing terminal protocols again. Early Enter submissions become immutable, visibly queued admissions and drain once through the ordinary command pipeline; a later draft and cursor stay in the same editor. Boot failure or an early signal closes the lease exactly once, restores the terminal, and prints recoverable queued input and draft text. `CLIO_CODER_INSTANT_SHELL=0` selects the legacy fully hydrated first frame; ACP, headless, ordinary non-TTY invocation, and subcommand execution never acquire the lease. An explicit `CLIO_CODER_INTERACTIVE=1` retains its established force-interactive behavior on a non-TTY stream.

### 5.1 Welcome Launchpad & Session Header

The header has two operational modes: a framed launchpad dashboard on fresh start, and a single live session row after prompt admission. Source: `src/interactive/welcome-dashboard.ts`; contracts: `tests/extended/welcome-boot-header.test.ts`.

- **Launchpad (before the first prompt): framed panel dashboard.** A boxed container (`buildWelcomeDashboardLines`) enclosed by `╭─ Clio Coder v<version> ─╮` and `╰─╯`:
  - **11 Detail Rows:** Subhead/title ("Built for the code behind science."), model route status (`routeRow`), workspace path, permissions/autonomy (`stats.autonomy`), guidance ("Ask Clio how to use or extend her."), target inventory (`stats.targets`), and fleet recipes inventory (`stats.fleet`). A `Subscriptions` field (`stats.quota`) joins the list between Targets and Fleet once a cached quota reading exists, wrapping at the detail-column width rather than clipping, and is absent entirely when no account is connected.
  - **Responsive Layout:** Renders wordmark ASCII art on the left at ≥76 columns (`sideBySide`), and rotating hint cards on the right at ≥160 columns (`WELCOME_HINT_MIN_WIDTH`) cycling commands and shortcuts every 15 seconds.
  - **Action Row:** A horizontal rule (`├─┤`) separates details from the action row (`actionRow`), which prints the next step or work blocker: no route or model (`/model`), route unavailable or degraded (`/settings targets`), malformed handbook (`CLIO-CODER.md malformed · /context to inspect`), uninitialized handbook (`describe a task · /context init to index this repo`), stale handbook (`describe a task · /context refresh to update it`), or default `describe a task · <SubmitKey> to send · / for commands`.

- **Route row.** `✓ <target> · <model>` healthy, `! …` degraded, `✗ …` unavailable, `◌ …` configured but not yet probed, `not configured` when neither is set. Healthy routes omit latency; failing routes display sanitized failure reasons. Under width constraints, route text shrinks before dropping error reasons.

- **Session header (after the first prompt): exactly one row, and live.**
  ```
  >C_ Clio Coder v0.5.1 · dynamo · qwen3.8-27b · ~/iowarp/clio-coder · main*
  ```
  Collapsed via `sessionRow`, this line tracks mid-session model or branch mutations. It preserves identity (`>C_ Clio Coder v<version>`), active route, workspace tail, and git dirty state (`*`), dropping readiness and onboarding hints owned by the footer. Under extreme width pressure, the route is preserved longest, outliving workspace and version labels.

- **Transitions.** The first prompt submission collapses the launchpad before transcript appending. `/new` restores the framed launchpad. `/resume`, `/tree`, `/fork`, and `/handoff` collapse it after transition. Interactive resume uses `/resume`; headless runs use `--continue` or `--session <id>`. Transitions are idempotent.

- **No filesystem work on the render path**, in any state, including the first
  frame and render-cache hits. Project-context state comes from the context
  domain's own reader, refreshed off the frame; until the first reading lands
  the header shows `describe a task` rather than asserting a state it does not
  know. A read that throws never becomes `ok` or `none` and never renews the
  trust window, so once reads have been failing longer than the 10s window the
  header stops asserting the last value, and a reading is only ever served for
  the directory it was taken in. This is a change to per-frame render I/O; it is
  not a claim that process startup got faster.

- **Text safety.** Provider reasons, model ids, branch names and paths pass
  through the project's one-line sanitizer (`sanitizeCallTargetText`,
  `src/domains/safety/call-target.ts`) before styling: OSC and CSI stripped, C0
  and DEL neutralized, whitespace collapsed. A hostile upstream error cannot
  retitle the terminal, clear the screen, move the cursor, or inject colour
  through the header. Wide Unicode, emoji and ZWJ sequences are preserved and
  measured in terminal columns.

Stage 0, before hydration, renders the same wordmark helper over three rows so
the footprint matches the hydrated header, then the editor, then a footer line
that stays blank until `Ctrl+C` arms the exit:

```
>C_ Clio Coder
Starting Clio · you can type now

```

### 5.2 Composer (ClioEditor)

- **Clean Normal Rails**: Normal composition keeps both top and bottom rails quiet without duplicate identity or keyboard hints (the footer owns target/model identity, thinking level, and keyboard affordance).
- **Exceptional State Elevation**: The top rail only renders exceptional admission, safety, or compaction states:
  - `CONFIRM` (`warning` token, or `CONFIRM · FULL-AUTO` in `editorDanger` token) when an approval prompt owns operator input.
  - `PREPARING` (`action` token) while Clio prepares turn admission and dispatch.
  - `COMPACTING` (`action` token) while compacting session context before prompt submission.
  - `FULL-AUTO` (`editorDanger` token) when the session runs in full-auto autonomy.
  - When a draft scrolls vertically, the base editor's native scroll indicator (`↑/↓` line counts) is preserved on line 0.
- **Context-Aware Empty Placeholder**: When the draft is empty, line 1 displays dim placeholder text matching the active state:
  - Idle / running: `Ask Clio…  / for commands`
  - Awaiting approval: `A parked call is waiting for your decision`
  - Preparing turn: `Clio has your prompt and is preparing the turn`
  - Compacting: `Clio is compacting the session context`
- **Bottom Rail Affordance**: During normal drafting, the bottom rail remains clean. In `CONFIRM` mode, the bottom rail displays fitted decision keys (`confirmRailHint` via `src/interactive/permission-hint.ts`: `Enter allow`, or `Backspace clear draft to allow` if a draft is present; `Esc deny`; `s stop turn`; `v inspect mutation`; standing approval terms toggle via `?` on the permission card itself).
- **Rail Dynamics & Safety Accents**: `renderEditorRail` renders subtle pulse animations when Clio is working or in attention phase (unless reduced motion or dumb terminal is detected), and applies fixed bold `editorDanger` endcaps whenever `fullAuto` is active. The pulse steps on the same 120 ms animation clock as the footer spinner (`animationStep` in `theme/glyphs.ts`), so a frame that only appends streamed text leaves the rail untouched.

### 5.3 Progressively Disclosed Footer

Source: `src/interactive/footer/dashboard.ts`, `src/interactive/footer/pages.ts`.

- **Compact Mode (Two-Line Ambient Strip)**:
  - **Line 1 (Workload & Identity)**: Active phase (`accent` e.g. `Ready`) and worker counts (`agent` e.g. `· 2 active`) · Target/model identity (`fitIdentityLabel`) · Selected model’s weekly quota (`weekly N% left`, when the local credential owner and model group are known) · Thinking level (`reason`) on the left; Context meter bar (8–14 cells) and token occupancy (`used / contextWindow`) on the right. The phase spinner steps once per 120 ms animation step, however often the footer refreshes, and a live elapsed counter shows whole seconds (`Writing · 3s`) and nothing under one second.
  - **Line 2 (Status & Hints)**: Persistent workspace cwd and Git branch/dirty (`*`) on the left; rotating shortcut hints on the right. Urgent input prompts (`Ctrl+C again to quit`, `Ctrl+G → choose key`), active notices (`• text`), and demo tips borrow only the hint area. Quota never occupies this row.
- **Expanded Mode (`Alt+U`)**: Renders across one-quarter of the viewport (minimum 8 rows), keeping the composer anchored below. Repeated presses cycle through three responsive pages (`DASHBOARD_PAGES`) and closed:
  1. `Activity`: Live agent phase, tool counts, session metrics, active worker cards (route, task, token usage, tool calls, timing, budget, `/view dispatch:<id>`), and finished worker history.
  2. `Context`: Context meter bar and category occupancy grid (system, tools, files, turns, memory), compaction/cache telemetry, headroom.
  3. `Status`: A session line (recorded tokens and tracked cost) above one compact row per connected subscription account (`renderQuotaAccounts`, `src/interactive/quota-view.ts`), then Cost & Connections (session cost, MCP servers, plugins, extensions) and Local Machine metrics (CPU, memory, disk I/O sampled on 2s cadence), plus memory bank entries and free tokens.

### 5.4 Frame Cost

A frame costs the rows that changed, not the length of the session.

- The transcript hands the layout its settled prefix and its live tail as two arrays. The prefix is the same array from frame to frame until another entry settles, the regular-screen root keeps its row buffer and skips the prefix rows it already holds, and pi-tui's `Container.render` returns one exact-size copy (tracked patch). At 2,000 entries a streamed frame allocates 231 KB on the regular screen and 405 KB fullscreen, down from 3.2 MB and 2.1 MB.
- Every settled entry, replay blocks included, keeps its render for the last three layouts (width, height budget and style). Idle time renders settled entries ahead in the two styles not on screen, a few milliseconds per step and never while a turn streams.
- The transcript renderers are warmed once after the first hydrated frame, so the first Markdown render in the process, 13 to 17 ms cold, does not land inside the first answer.
- Live marks step on one 120 ms clock: the footer spinner, the composer rail pulse, and the 100 ms tick that advances a running tool's, live reasoning's or a pending worker's elapsed. A streamed token's frame rewrites only the transcript rows that changed.

### 5.5 State Choreography Table

State is signaled through the status pill in the footer and matches the following table:

| State | Pill | Transcript Echo | Action Orange? |
|---|---|---|---|
| idle | Quiet (phase omitted; line 1 shows workspace, line 2 shows context/receipt) | None; last-turn telemetry on line 2 | No |
| preparing / waiting | spinner + `waiting` (info) | None | No |
| thinking | spinner + `thinking` (reason) | Bounded supplied reasoning | No |
| writing | spinner + `writing` (accent) | Streaming markdown text | No |
| tool running | spinner + `Running <name>` (accent) | `▸` tool execution ledger line | No |
| blocked | `⏸ blocked` (warning) | Permission prompt surface | No |
| retrying | `↻ retry 2/5` (warning) | Dim retry details line | No |
| compacting | spinner + `compacting` (reason) | None | No |
| dispatching / fleet live | Main phase plus worker count | Task island status updates | Yes |
| prolonged silence | `⚠ No output · 12s` (warning) | No duplicate status | No |
| ended | Ready, Failed, Cancelled, or Output limit | Settled transcript blocks | No |

---

## 6. Agent and Transcript Formatting

### 6.1 Gutter Grammar

Every transcript row belongs to a two-cell gutter and a content column. The gutter holds exactly one mark per block, and every wrapped row of a block hangs in the content column, so the left edge alone tells whose words a block is and where it starts.

| Gutter | Block | Content |
| --- | --- | --- |
| `▌` (accent, every row) | Operator prompt | Bold text. A prompt Clio has not committed yet shows a dim bar, plain text and `· preparing`; a refused one `· not sent`. |
| `✦` (accent) | Agent prose | Each prose block, not only the first of a turn, so narration that resumes after actions reads as the agent speaking again. Skill suggestion lines do not claim it. |
| `│` (reason) | Supplied reasoning | Dim italic excerpt, or the folded `Thinking · /view` marker. No other block uses a gutter rail. |
| `▸` `§` `±` `$` `↗` `◆` `?` `⇢` | Action | One row per call, marked by its class ([6.3](#63-tool-ledger)); its body nests beneath it (`  │ `). |
| `◆` / `◇` / `↳` | Worker | The card body nests beneath the header (`  │ `), closing on `  └ `. |
| `✦` (error) | Terminal error | Clio's account of why the turn ended, in the error token. |
| `✓` / `✗` / `⊘` / `⚠` | Receipt | Closes a settled turn with its outcome. |

Blocks of different kinds are separated by one blank row inside a turn, as turns and workers are separated from each other. Consecutive actions without a body stack as one run, even when a narrow terminal wraps one of their rows; an action with a body (arguments, output, a diff, approval facts) gets a blank row on both sides. The same rule applies in every output style: Compact saves rows by folding bodies and grouping observations, not by removing the separation between what the agent said and what it did.

```text
▌ The retry test is flaky on CI. Find out why and fix it.

│ Flaky timing tests usually come from real timers or randomness.

✦ I'll read the retry module and its test first.

▸ read src/net/retry.ts · lines 1-10 of 10 ✓ · 42ms
▸ searched for `Math.random` in src · 1 match ✓ · 42ms

✦ Found it. The test races the jitter; I'll make it injectable.

± edited src/net/retry.ts · +5 -2 ✓ · 18ms
  │ - 1 export async function retry<T>(fn, attempts = 3) {
  │ + 1 export async function retry<T>(
  │ … 8 rows · /view

✦ The first backoff includes up to 50ms of jitter...

✓ Done · 58s
```

### 6.2 Thinking Blocks

Supplied reasoning stays in stream order on the `reason` gutter rail, dim and italic. Compact shows the folded marker on the same rail; Standard and Detailed show the bounded tail defined in [Output styles](#output-styles), with the overflow hint on the rail. The footer alone reports current activity.

### 6.3 Tool Ledger

Each call owns one stable action row. Argument fragments stay hidden until the call is formed. A formed call becomes ready, then running, then settles with its actual outcome. Cumulative output replaces the live preview; late partials cannot overwrite a settled result. The same policy applies during replay.

Every call belongs to one class, resolved by the registry in [src/tools/presentation.ts](../../src/tools/presentation.ts). The class gives the row its gutter mark, its verbs and the facts it may state, and the renderers read the class instead of branching on a tool name. A running row uses the progressive verb and ends in the live mark and its elapsed time (`● 3.4s`); a settled row uses the past tense, even when it failed. Marks are `dim`, so the shape tells the acts apart and color only confirms the outcome.

| Class | Tools | Mark | Running / settled | Row facts |
| --- | --- | --- | --- | --- |
| observe | read, ls, data, credential_present | `▸` | reading / read | path, `lines a-b of N`, size, resource kind |
| search | grep, find, code_nav | `▸` | searching / searched | pattern, scope, inline flags, match count |
| knowledge | context, clio_docs, clio_library, evidence, ledger, self_compact | `§` | consulting / consulted | scope, query, section count |
| mutate | edit, write, artifact | `±` | editing / edited, writing / wrote | path, `+a -r`, `new file` |
| execute | bash, run_script, verify, git, panes | `$` | running / ran | command, exit code, lines or bytes |
| network | web_fetch, web_read | `↗` | fetching / fetched | host and path tail, status, type, bytes |
| delegate | dispatch, monitor, steer, tasks, consult | `◆` | delegating / delegated | agent, task, run id, execution tally |
| interaction | ask_user, decide, limitation | `?` | asking / asked | the question and its answer |
| external | gateway find, describe and call; `mcp_*`; `extension_*` | `⇢` | calling / called | server and tool, `via gateway`, count or bytes |

Per-tool verbs refine a class where the act differs: `listed`, `found`, `navigated`, `inspected`, `checked`, `wrote`, `steered`, `planned`/`started`/`completed` for tasks, `decided`, `noted`, and `searched capabilities` for a gateway find. Verbs also follow the operation a call's arguments name: a web request other than GET is `sent`, a steer that cancels reads `cancelled`, a monitor call `waited on`, `collected` or `peeked at` its runs, a data call `selected from` or `validated` its file, and a dispatch `listed fleet agents` or `applied` a compete winner. A flag that is on reads as its name (`ignore_case`, `detach`). A gateway `call` reads as the capability it reached: a builtin keeps its own class and adds `via gateway`, and an MCP or extension capability reads `server › tool`. Names in the MCP and extension namespaces are external wherever they appear. An unknown dynamic tool falls back by the action class admission gave it: read observes, write mutates, execute and system changes execute, dispatch delegates, and anything else is external. The action class is persisted with the result, so `/resume` classifies the call the way the live row did.

```text
▸ read src/net/retry.ts · lines 1-40 of 120 · 1.4KB of 4.3KB ✓ · 42ms
▸ searched for `Math.random` in src · context 2 · glob *.ts · 1 match ✓ · 42ms
± edited tests/net/retry.test.ts ✗ · 42ms
$ ran `pnpm run lint` · exit 1 ✗ · 4.1s
↗ fetched nodejs.org/api/globals.html · 200 · markdown · 12.1KB ✓ · 820ms
§ consulted evidence list ✓ · 42ms
? asked Delete src/net/legacy-retry.ts or keep it deprecated? → Keep deprecated ✓ · 9.4s
⇢ called github › search_issues · query "flaky retry test" · state open · via gateway ✓ · 1.9s
```

The row states the facts the call's arguments and structured result carry. Scalar arguments up to 40 characters ride the row as `key value` (`context 2`, `glob *.ts`, quoted when they contain spaces); only long, multiline or structured arguments become `key ›` rows, and a list of short values reads as one `a · b` row. A field the row states is never repeated beneath it unless the row had to cut or flatten it, so a dispatch whose task the row shortened lists `task ›` and never `agent ›`. The row's object grows with the terminal from 60 characters to 120, and a question to the operator runs to 160. A URL reads as its host and path tail and shortens to fit a narrow row (`github.com/…/issues/412` at 40 columns) rather than splitting mid-path. A settled read drops its requested `offset`/`limit` because the row states the range it returned, and a fetch drops the `format` its facts state.

A failed command states its exit status once, as the `exit N` fact, and its body drops the status line (`bash: command failed (exit 1)`, `Command exited with code 1`, a timeout or an abort) unless that line carries the only diagnosis. A row states an exit code only when the result carries one. A blocked call's verb is `blocked` and its tail names the refusal. A failed call always shows its bounded body, so the row never excerpts it. A successful edit or write carries its change facts (`+5 -2`) on the row in every style and never previews its replacement payload; a failed one keeps the payload, bounded, because the text that did not match is the diagnosis. A question to the operator reads `question → answer`; a round of several questions, or an interview's closing decisions, nests one `question → answer` row each, and the model's copy of the interview never renders. A dispatch row states its execution tally (`3 ok`, `4 ok, 1 failed`) and the validation quality of its receipts. A row too long for the terminal wraps with a hanging indent into the content column.

A skill load is its own action identity. A settled `context(scope="skills")` load reads `§ loaded skill <name>` with the name in `accent`, states who asked for it (`by operator` for `/skill`, the selector or a marketplace install; `by recipe` for a bound worker; `by model` under model activation), `narrows tools` when the skill declares a tool surface, and `drifted` in `warning` when its content no longer matches its recorded hash. Standard and Detailed add the skill's description as one nested row. A load refused for trust, installation or activation reasons settles as a failed row carrying the refusal. An operator prompt that starts with `/skill <name>` leads with that command in `accent`.

Successful reads and shell commands keep raw content out of Standard. Mutations show bounded diffs, and failures keep actionable context in every preset. Compact folds by class: a run of consecutive successful observations and searches becomes one `▸ explored 3 files, 2 searches ✓` row, knowledge lookups one `§ consulted 5 sources ✓` row, and changes one `± edited 2 files · +6 -2 ✓` row with each file's change facts; the targets nest beneath the row. Commands, fetches, delegations and questions never fold, and a failure, a skill load, and a call whose result was cut, offloaded or evicted keep their own rows. `/view transcript` exposes full available arguments and results. Approval rows show the sanitized action and target, with no running spinner. Truncation, context exclusion, offload paths, refusal, cancellation, and missing results remain visible.

### 6.4 Editor Rail
The right-hand label shows `model · thinking`. Thinking level colors map as: `off` (dim), `minimal`/`low` (muted), `medium`/`high` (`reason` purple), and `xhigh`/`max`/`on` (bold `reason` purple).

### 6.5 Transcript Notices
Replay and system tags (e.g. `[retry]`, `[model]`) are wrapped in `dim` brackets with a `muted` message. Retry tags use `warning` amber.

Provider failures use a bounded, sanitized diagnosis in the primary transcript,
retaining available HTTP status and actionable route advice. Provider retry labels
identify their layer; running and waiting phases do not repeat the same error body.
Live and replay previews use the current terminal height and output-style row
budget. `/view transcript` and export retain the available redacted diagnostic;
upstream SDK truncation cannot be undone by the presentation layer.

### 6.6 Output Style Receipts

Compact omits the separate turn receipt. Standard closes a settled turn with its outcome glyph in the gutter and a dim line naming the outcome and available duration (`✓ Done · 58s`, `✗ Failed`, `⊘ Cancelled`, `⚠ Output limit`). A run that a worker block or a notice split across several transcript entries keeps one receipt, after its last output. Replay treats tool-use messages as intermediate; they cannot create a successful receipt on an earlier failed or cancelled turn. Detailed adds model calls, input/output tokens, cache usage, and supplied reasoning usage with provenance to the same line. Reasoning text is an excerpt, not verification. The quiet footer keeps the style and session cost visible; detailed telemetry is available through Detailed or the expanded dashboard.

### 6.7 Code Ink (Syntax Highlighting)

Syntax highlighting within code blocks is handled by [src/interactive/renderers/code-ink.ts](../../src/interactive/renderers/code-ink.ts). It maps a restricted set of four tokens to stay quiet:

- **Comments**: `dim`
- **String Literals**: `success`
- **Language Keywords**: `reason`
- **Numeric Literals**: `info`

All other code elements (identifiers, types, function names, punctuation) remain plain. Diff blocks highlight added lines with `success` green and removed lines with `error` red.

### 6.8 Mermaid and LaTeX

Finalized assistant Markdown renders inline and display LaTeX as terminal-friendly Unicode through
the Markdown renderer. For example, `$x^2$` becomes `x²` without requiring an image-capable
terminal.

Top-level fenced `mermaid` blocks pass through the width-aware Markdown `transform` hook and the
engine's Unicode-diagram strategy. Supported flowcharts, state diagrams,
class diagrams, entity-relationship diagrams, and sequence diagrams render with quiet `frame`
borders, plain labels, and `accent` connectors. If a diagram is invalid, unsupported, or wider than
the transcript content width, Clio leaves the original Mermaid fence visible instead of clipping or
silently dropping it. Mermaid transformation runs only after an assistant text segment is finalized,
so partial fences never flicker into incomplete diagrams while streaming.

---

## 7. Settings Center & Command Overlays

### 7.1 Settings Center Architecture
The `/settings` overlay is a full-screen transactional control center:
- **Shared navigation**: `src/core/settings-navigation.ts` defines Connections, Chat, Fleet, Context & Memory, Permissions & Limits, Appearance, Integrations, and Advanced for both configure and `/settings`. `src/core/settings-controls.ts` supplies the searchable control catalog, validation, descriptions and application timing. Legacy section spellings resolve to the corresponding current section.
- **Semantic Row Grammar**: Explicit presentation kinds (`setting`, `status`, `action`, `group-header`, `read-only-fact`, `destructive-action`) prevent confusion between focus (teal), health (green/amber/red), modified status (neutral/teal mark), and active operations (scarce orange).
- **Transactional Edits**: Selecting a row and pressing `Enter` opens a dedicated value picker, input dialog, or checklist rather than immediately toggling values. Edits construct an immutable `SettingsChangePlan` and present explicit destination choices:
  - `Apply this session` (for live-capable settings)
  - `Apply and save globally`
  - `Cancel` (or `Esc`)
  - Restart-required settings (`fleet.concurrency`, `integrations.runtimePlugins`, `interface.mode`, and `interface.fullscreenScrollbar`) offer only global save and announce `Saved to settings.yaml · restart Clio to apply`.
  - Destructive actions (target/profile removal) execute preflight analysis showing affected chat, fleet, and memory routes before confirmation.
- **Fleet Workbench**: Organizes fleet settings with dim group headers (`Defaults`, `Profiles`, `Agent routes`, `Placement`). Profiles render as one-row summaries with `◆ Edit` affordance; pressing `Enter` drills into profile fields (target, model, thinking level, placement) or destructive removal.
- **Targets Console Table**: Displays configured targets in an operational console table (`HEALTH`, `ID`, `ROLES`, `RUNTIME`, `LATENCY`) with an in-place action/detail drawer (URL, default model, last probe, failure reason). Actions include `Use`, `Connect`, `Probe`, and `Remove`. Active connect/probe operations show the single orange activity indicator.
- **Scoped Models Checklist**: Settings → `Chat` → model favorites provides a provider-backed checklist subview with target-level and target/model items, checked current selections, `Space` to toggle, and capability details in the inspector. Unresolved model references are preserved under an `Unavailable` group.
- **Narrow Terminal Drill-Down Navigation**: Below 72 columns, Settings transitions from a split view to a modal drill-down stack (section list → section rows → detail drawer) with a breadcrumb and `Esc` moving up one level before closing. Includes `/` filtering across label, path, and description, narrowing per keystroke like `/model` and `/resume`. Below 60 columns, side margins are removed for full-width presentation.

Internal warnings and errors use `src/core/diagnostics.ts`. The active terminal
owner installs a sink that presents them through the notice area instead of raw
stderr writes over the frame; headless processes retain stderr. This covers Clio’s
routed diagnostics, not arbitrary third-party code writing directly to the terminal.

### 7.2 Fleet Runs Board

`/fleet` and `Alt+W` open Fleet Runs; `/settings fleet` opens fleet configuration. The board consumes the observability run projection, which owns lifecycle, worker progress, receipt trust, retries, cancellation, fleet positions and evidence readiness. The board owns selection and rendering; council members remain grouped in a council card.

An ordinary card defaults to run identity, abbreviated route, a task preview, status, trust/evidence, telemetry and one current-operation row when available. A long task keeps two wrapped rows plus an Enter-detail disclosure. Fleet phase appears only when the run has a recorded fleet position. Route abbreviation preserves its distinguishing suffix. Retry, control and evidence warnings remain visible when present. An ordinary completed, sealed and mediated run with no validation or independent review shows `unverified; no validation observed` in its compact trust row. Enter restores every canonical provenance clause. This shortening applies only when context is recorded and completion evidence is absent; exceptional, unknown or failed states keep the full trust summary visible. Execution completion and receipt sealing do not establish scientific validation.

- **`doing`** shows `now <tool> <verb> <object>` for the current call. Between calls it can show the worker phase and `last <tool> <verb> <object>` for its most recent completed call. Descriptors come from the worker seam; raw arguments never reach the renderer. A thinking phase exposes no reasoning text.
- **Enter detail** restores the full wrapped route and task, exposes policy and budget facts, and adds the available answer. The answer uses a `│` rail, retaining up to six wrapped prose rows plus an overflow disclosure for omitted lines/bytes and the `/view dispatch:<runId>` inspection route. This cap applies to the answer preview, not to the complete expanded card. Recognized complete results use the same readable contract presentation as the transcript only when an integrity-verified receipt supplies the declared kind and passing conformance. Partial, malformed, unknown or nonconforming output remains an honest excerpt. Contract conformance does not imply validation; reproduction and other qualification facts remain visible, and inspection retains the available raw output.

Detail follows selection rather than pinning to a run. Empty boards show `Use /run or /delegate to start a run.` and advertise only closing. Narrow active hints prioritize supported steering and cancellation over navigation/detail hints; Enter remains available to expand. HTTP/SDK runs expose steering only in supported live states, ACP and subprocess runs do not, and terminal rows expose neither steering nor cancellation.

### 7.3 Task and Decision Boards

- **Composite Tasks Board (`/tasks`)**: Presents four sections in one reopenable overlay: the live session board, terminal task history, successful workspace artifacts, and project-scoped operator tasks. Selecting a workspace artifact opens the filtered `/view` path. Operator rows support add, hand, done, and drop actions; refresh is explicit for captured history and artifacts, while lightweight repaint reads the current board snapshot.
- **Settled Decisions Board (`/decisions`)**: Groups completed and cancelled interviews on the active branch, expands source questions and answers, and lets the operator supersede a value or submit a correction. Corrections travel through the ordinary operator-turn path after the durable decision snapshot is updated.
- **Editing and focus**: Alt+B/D keep word movement/deletion. Ctrl+G shows a persistent contextual action menu. The application policy runs before viewport shortcuts; release events are discarded first. Search and modal children own cancellation. Permission deletions and local undo use semantic component operations. See the complete [keyboard contract](../guide/commands-and-modes.md#keybindings).

### 7.4 Slash Autocomplete Command Palette
- **Grouped Palette**: Typing `/` opens a grouped command palette (ordered by `Run`, `Inspect`, `Configure`, `Sessions`) with compact argument hints and formatted descriptions.
- **One Canonical Spelling**: Autocomplete, help, and parsing expose the same unique slash-command names; no alias rows compete with canonical commands.

### 7.5 View Artifact Inspection

View uses explicit list/preview focus labels and match/total counts. Search requires every whitespace-separated term to occur literally, case-insensitively, in resource identity or available provenance; paths remain intact terms. Category prefixes such as `dispatch:<runId>` constrain the same search. Left/Right selects among nonempty categories in the current results; it does not remove the filter. Filtering does not change provider scope or discard global evidence. Initial query editing starts at the end, and selection is retained by resource identity across refresh. Filters persist within one overlay lifetime. In list focus, Ctrl+U uses Input's semantic clear operation without synthesized movement keys: it saves one undo snapshot and the complete killed value, so undo restores query and cursor and yank can restore the full query. Clearing an empty filter changes neither history nor the kill ring.

Workspace outputs lead with their basename and workspace-relative path. In preview, `i` toggles scrollable provenance including the full backing path and available session, run and correlation identities; `o` keeps its backing-path notice and `v` retains available verification. Toggling provenance resets that pane's scroll offset. At narrow widths, Enter opens preview and Esc returns to the list before closing; empty results cannot acquire preview focus. Content loading is deferred off the synchronous render stack, and stale loads or refreshes cannot replace newer selection/results.

### 7.6 Library Browsing and Notices

Library status and footer counts distinguish Browse packages, Installed entries and inspected members, with correct singular/plural forms, separately from discovery notices. From browse focus, `n` opens the searchable child notice view and returns from it to resources. While search has edit focus, `n` is filter text; Esc clears a filter or leaves search focus before returning to the parent browser. Returning restores the original browser's selection, filter draft, browse focus and detail position. Notices retain their individual evidence and offer no package mutation or recipe-use action. Count units describe the selected inventory view, not the number of runnable recipes; unavailable Installed entries remain visible.

Agents and Fleets label plugin provider packages as `[plugin]` and show only the selected category's catalog hints. Those hints do not claim a recipe is loaded. `b` switches Browse/Installed; `Actions: User/Project` (or the compact `s:User/Project` label) identifies the destination for package lifecycle actions, not an inventory scope filter. Narrow status lines retain the `n` notice affordance. The selected inspector opens below the split threshold as well as beside the list at wider widths, puts applicable actions before long provenance, and retains Tab and page-scroll navigation. Enter says `members` only when it opens package members, otherwise `detail`. Plain external metadata is sanitized before composition with trusted semantic state colors, so available, unavailable and other states retain their theme styling. All lifecycle actions retain their existing review paths.

---

## 8. Shared Vocabulary

One quantity gets one word, and every surface that shows it uses that word. A user comparing the transcript, the footer, and an overlay is checking whether Clio is telling a consistent story; a synonym reads as a discrepancy. The current vocabulary is owned by `src/interactive/chat-panel.ts`, `src/interactive/usage-overlay.ts`, `src/interactive/status/reasoning.ts`, and `src/interactive/thinking-level-policy.ts`; there is no standalone `usage-vocabulary` contract test in the current tree.

| Concept | Word | Surfaces |
| --- | --- | --- |
| One model API call | `call` | Chat panel `turn · in N over M calls`, `/usage` `model calls`, `/usage` `(avg/call …)` |
| One user-to-assistant exchange | `turn` | Chat panel `turn · …`, `/usage` `turns` |
| Provider-reported reasoning tokens | `reasoning N provider` | Chat panel |
| Reasoning tokens estimated from displayed text | `reasoning ≈N estimated` | Chat panel; the footer carries the same `≈` on `r≈N` |
| Reasoning tokens in the cost tally | `reasoning N provider-reported only` | `/usage`. This tally never estimates, so it disagrees with the panel on a model that reports nothing, and the row says which one it is. |
| Thinking level a model cannot turn off | `forced` | Editor rail, model overlay, thinking cycle (`thinkingLevelDisplayWord`) |
| Thinking level on a model with only on and off | `on` / `off` | Same surfaces |
| Consumed share of a subscription window | `N% used` | `/usage` Accounts, dashboard Status, welcome `Subscriptions`. A filled meter cell always means consumed capacity. |
| Unconsumed share of the same window | `N% remaining` in a detailed meter, `N% left` in a compact badge | `/usage` Accounts and Status print `remaining` beside `used`; the compact footer, worker cards, and fleet islands carry `weekly N% left`. |
| A limit belonging to the account rather than to this session | `Shared <account>` | Worker cards, fleet islands, `/usage` Workers. Never a measured per-worker share. |

### 8.1 Slash-Command Failures

Two shapes, both ending at something the user can act on.

- A command that exists but was called wrongly prints the reason and then that command's usage line: `<reason>. usage: /<name> …`.
- A command-shaped token that is not a command prints `/<token> is not a command. Type /help for the list.` and is never sent to the model as chat. The escape for a line that starts with a slash is a leading backslash, so `\/tmp is full` reaches the model as `/tmp is full`. A leading space does not work and never did, because the editor trims the submitted line before the parser sees it.

### 8.2 Memory Step Rows

`/memory` activity rows read `<trigger> <decision> <reason>`, followed by `<N>w` when the step wrote to the bank and `<N> cited` when it cited entries, then the tier and latency. `describeTaskMemoryActivity` is the one place that builds this string.

Knowledge and procedural task-bank rows expose `p` to propose the selected
entry for the active canonical repository and `g` to propose it globally.
Global scope requires a second `g` press on the same entry after the warning
line appears. Status rows are labeled private and neither action can promote
them. Both actions create unapproved durable proposals, show the resulting
memory ID, and leave approval to the separate reviewed memory lifecycle.

## Keyboard engine compatibility

Clio pins pi-tui 0.87.1 with a tracked pnpm patch for one pre-viewport input
policy, public existing search focus/operations, and semantic Editor/Input
edits, including atomic Input clear with native undo and kill-ring preservation. Production consumes these only through src/engine. The patch adds no
renderer, decoder or search implementation. Published dist bundles patched
JavaScript and the pure JavaScript transitive dependencies; the pinned installed
Pi package supplies native Darwin/Windows helpers through its package resolver.
MIT notices ship beside the bundle. A frozen contributor install and an ordinary
npm consumer install are separate acceptance checks.
