# Clio TUI Design System

> [!TIP]
> **Interactive spec available:** The source checkout includes the
> [TUI design blueprint](html/tui_design_blueprint.html).

This document is the reference specification for the Clio Coder TUI visual layout, styling, and behavior. It describes color semantics, the glyph vocabulary, structural recipes, and state choreography for all surfaces under [src/interactive/](../src/interactive/).

The governing principle: **the user reads state from color, structure from frames, and identity from brand marks.** Everything that is not state or structure remains visually quiet.

---

## 1. Color System

All color styling is defined in [src/interactive/theme/tokens.ts](../src/interactive/theme/tokens.ts). No raw SGR sequences, `38;2;`/`38;5;` ANSI escape fragments, or hardcoded hex colors are allowed outside this theme module.

### 1.1 Color Tokens

| Token | Value (truecolor) | Role |
|---|---|---|
| `accent` | `rgb(70, 229, 208)` (Teal) | Brand and interactivity: frame titles, selection highlight, keybinding/slash-command affordances, agent voice glyphs, tool verbs, and active/writing phases. |
| `accentDeep` | `rgb(31, 183, 166)` | Structural emphasis only: bold CAPS section tags. |
| `action` | `rgb(255, 126, 41)` (Orange) | Active autonomous operations: dispatching phase pills, active fleet badges, running fleet indicators, running connect/probe indicators, and user-steering queues. |
| `success` | `rgb(87, 227, 137)` (Green) | Positive outcomes: success indicators (`✓`), ok health status, clean git trees, and output-token count updates. |
| `warning` | `rgb(255, 180, 84)` (Amber) | Real warnings only: stale data, dirty trees, retry status, blocked tools, and truncation. |
| `error` | `rgb(255, 92, 102)` (Red) | Failures: error indicators (`✗`), error rails, stuck states, and error message text. |
| `info` | `rgb(91, 168, 255)` (Blue) | Informational messages, notices, and system-prompt meters. |
| `reason` | `rgb(157, 140, 255)` (Purple) | Reasoning-related status: thinking phases, thinking rails, reasoning-token metrics, and context compacting. |
| `dim` | `rgb(106, 122, 133)` | Scaffolding elements: separators, key names, keyboard shortcut hints, durations, and timestamps. |
| `muted` | `rgb(138, 153, 164)` | Secondary content: paths, previews, counts, and non-status values. |
| `title` | alias of `accent` | Semantic title token mapping. |
| `frame` | `rgb(47, 93, 90)` | Borders, rules, inner dividers, and unused context space. |
| `frameStrong` | `rgb(42, 171, 158)` | The active editor input rail background. |

### 1.2 Placement Rules

- Color is used functionally to indicate state. If removing a color does not lose information, the text is colored using `dim`, `muted`, or left unstyled.
- `warning` amber is reserved for true warnings. Costs and neutral telemetry numbers use `muted`.
- `accentDeep` is used only in section tags. Metric values (such as TTFT, tokens-per-second, and autonomy status) use `muted`.
- `action` neon orange remains scarce and strictly disciplined: only while Clio is acting, for workspace-authority and worker-escalation decision frames, or in `STEER` mode. It is never used for idle decoration or settled telemetry, and never appears on more than one element per screen region. Outward, safety-net, and system decision frames use `warning`; conversational answers use `accent`.
- Per-surface color budgets limit noise: chip strips use at most one non-neutral token per chip, and framed cards use at most one status token alongside neutral colors.

---

## 2. Glyph Vocabulary

All symbols are defined as constants in [src/interactive/theme/glyphs.ts](../src/interactive/theme/glyphs.ts). Rendering code reference these names instead of embedding hardcoded glyph literals.

| Glyph | Name | Meaning | Used by |
|---|---|---|---|
| `>C_` | `brand` | Clio wordmark | Welcome launchpad header, session header, and dashboard header only. |
| `✦` | `agent` | Agent voice | Chat reply prefix (accent; error red on failed turns). |
| `›` | `user` | User voice | Chat user prefix (accent); steering queue marker (action). |
| `❯` | `cursor` | Selection focus | Settings, list overlays, selectors. |
| `▸` | `toolHeader` | Tool ledger line | Tool sublines and expanded tool headers. |
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
| `│` | `rail` | Body rail and section bar | Tool bodies, thinking rail, column separators. |
| `─` | (rules) | Horizontal rule and borders | Frames and rules. |
| `╌` | `innerDivider` | Divider inside a frame | Task island, any framed list. |
| `·` | (dotSep) | Chip separator (dim) | Everywhere. |
| `◆ ◇` | `active/scoped` | Active and scoped marks | Model selector, thinking selector, Settings profile workbench. |

---

## 3. Formatting Rules

Standardized formatters live in [src/interactive/theme/labels.ts](../src/interactive/theme/labels.ts) and other shared UI modules:

- **Duration**: `formatCompactMs` is the unified duration formatter, yielding compact outputs (`860ms`, `4.2s`, `42s`, `1m36s`).
- **Token Counts**: `formatFooterTokens` formats footer and chip counts (`842`, `12.4k`, `1.2M`). Full numeric strings via `toLocaleString` are reserved for detailed tables like the context legend.
- **Cost**: The shared `formatUsd` formatter handles dollar values, printing up to four decimal places when under one cent.
- **Model IDs**: `abbreviateModelId` keeps whole dash-separated parts of model names up to 18 characters; if the parts still overflow, it clips the ID at 18 characters.

---

## 4. Structural Layouts

### 4.1 The Island (Framed Block)

Rendered via `frame()` in [src/interactive/theme/rules.ts](../src/interactive/theme/rules.ts):

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

Fleet run cards add two bounded budget rows when native dispatch admission supplies an envelope. The `policy` row shows the recipe default or exact pin, its optional maximum, and the invocation request. The `budget` row shows the effective phase, the operator lifetime cap, and the clamp or retry/revision escalation reason. Historical or external-agent rows without this provenance omit both rows.

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

Permission confirmation and `ask_user` use one pure consequence presentation classifier while keeping separate input and execution protocols. The classifier supplies the tier title, semantic frame token, consequence and reversibility copy, requester attribution, and display actions. Permission keeps allow-once, deny, and stop behavior. `ask_user` keeps selection, free-text, cancellation, and its compact, panel, or interview layout chosen from question shape.

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

In fullscreen mode, `PageUp` and `PageDown` scroll one viewport, `Home` and `End` jump to its bounds, `Ctrl+Shift+Up` and `Ctrl+Shift+Down` jump between semantic prompts, and the mouse wheel scrolls the transcript. Dragging the scrollbar thumb moves the viewport directly. `interface.fullscreenScrollbar` is `hidden`, `auto` (visible during interaction), or `always`. Manual scrolling suspends follow-end so new output does not steal the operator's position; returning to the bottom resumes it. Both fullscreen settings are restart-scoped because Clio constructs its terminal renderer and component graph once at startup.

`interface.smoothStreaming` controls presentation-only pacing of derived assistant text and thinking. The shipped `off` value uses the immediate 16 ms coalescer. `auto` paces only on a capable local TTY and bypasses pacing for non-TTY, SSH, multiplexers, CI, screen-reader/reduced-motion markers, or observed stdout backpressure. `on` explicitly requests grapheme-safe pacing, while still stopping frame production behind stdout backpressure. Raw provider wrappers never enter the panel, canonical events and persistence remain synchronous, and tool/message/turn/abort/retry/submit/teardown boundaries drain visible state before they continue. `CLIO_CODER_SMOOTH_STREAM` is the one-process escape hatch and takes precedence over settings; invalid values resolve to `off`.

Interactive startup uses one terminal lease across both boot stages. Stage 0 owns the terminal, renderer, root host, exact editor instance, input decoder, raw mode, resize subscription, protocol queries, signals, and stop lifecycle, and commits a measured minimal frame while services hydrate. Hydration synchronously swaps the root and input/signal delegates without reconstructing the editor or initializing terminal protocols again. Early Enter submissions become immutable, visibly queued admissions and drain once through the ordinary command pipeline; a later draft and cursor stay in the same editor. Boot failure or an early signal closes the lease exactly once, restores the terminal, and prints recoverable queued input and draft text. `CLIO_CODER_INSTANT_SHELL=0` selects the legacy fully hydrated first frame; ACP, headless, ordinary non-TTY invocation, and subcommand execution never acquire the lease. An explicit `CLIO_CODER_INTERACTIVE=1` retains its established force-interactive behavior on a non-TTY stream.

### 5.1 Welcome Launchpad & Session Header

- **Pre-Submit Launchpad**: Before the first prompt, renders a compact launchpad at line 0 with bold CAPS section tags (`WORKSPACE`, `ROUTE`, `NEXT`), honest readiness state, and a context-sensitive next action (e.g. `ctx missing · /context init`, `ctx checking…`, or `ctx ready · type a task`). Asynchronous repository probes use height-stable dim placeholders (`factsPending`).
- **Session Header Collapse**: On first user submission, the launchpad deliberately collapses into an immutable, single-line session header (`>C_ Clio Coder vX.Y.Z · <workspace · git branch> · <target·model · ready> · ctx ready · type a task`) so the conversation transcript owns the viewport while the header keeps naming where Clio works, which route answers, and what the context is ready for.

### 5.2 Composer (ClioEditor)

- **Mode Section Tag**: The top rail features an explicit left section tag indicating prompt semantics:
  - `MESSAGE` (dim/teal) while idle.
  - `FOLLOW-UP` (muted) while Clio is actively processing a run.
  - `STEER` (neon orange) when Enter will actively steer in-flight work.
  - When the draft scrolls, the active mode folds into the scroll indicator row so the orange warning remains visible.
- **Top Rail Metadata**: The top rail right displays target/model and thinking level with two-step color hierarchy: `off` (dim), `minimal`/`low` (muted), `medium`/`high` (`reason` purple), and `xhigh`/`max`/`on` (bold `reason` purple).
- **Empty-State Placeholder**: Displays dim prompt `Ask Clio…  / for commands`.
- **Lower Rail Affordance**: On terminals at or above 60 columns, the bottom rail displays `Enter send · Shift+Enter newline` (or resolved keybindings).

### 5.3 Progressively Disclosed Footer

- **Compact Mode (Quiet Idle)**: Two always-on lines that eliminate idle telemetry noise (suppresses `tools none`, `◌ idle`, and default-output tags):
  - **Line 1 (Workspace & Readiness)**: CWD path, git branch/dirty state, and active phase pill only when meaningful.
  - **Line 2 (Context & Receipt)**: Context window meter and the best current/last-turn receipt.
- **Expanded Mode (`Alt+U`)**: Four responsive sections ordered by operational urgency rather than a static telemetry grid:
  1. `Activity`: Live agent phase, active workers, running tool calls.
  2. `Context`: Context window gauge, breakdown, token headroom.
  3. `Session`: Session cost, throughput, total token breakdown, leader key state.
  4. `Workspace`: CWD, branch, target, git dirty status.
  Empty rows collapse rather than occupying blank grid space.
- **Notification Badge & Degradation Ladder**: The footer notification badge reserves the severity head (`ℹ 1 notice`, `⚠ 1 warning`, `✗ 1 error`), separator, and `[Alt+X] dismiss` tail first, allocating the middle width to an ellipsized message. At narrow widths, it degrades gracefully down the ladder (`head · [Alt+X] dismiss` → `head · [Alt+X]` → `head` → glyph alone) without clipping the action key.

### 5.4 State Choreography Table

State is signaled through the status pill in the footer and matches the following table:

| State | Pill | Transcript Echo | Action Orange? |
|---|---|---|---|
| idle | Quiet (phase omitted; line 1 shows workspace, line 2 shows context/receipt) | None; last-turn telemetry on line 2 | No |
| preparing / waiting | spinner + `waiting` (info) | None | No |
| thinking | spinner + `thinking` (reason) | Dim `Thinking (N tokens)…` marker | No |
| writing | spinner + `writing` (accent) | Streaming markdown text | No |
| tool running | spinner + `tool <name>` (accent) | `▸` tool execution ledger line | No |
| blocked | `⏸ blocked` (warning) | Permission prompt surface | No |
| retrying | `↻ retry 2/5` (warning) | Dim retry details line | No |
| compacting | spinner + `compacting` (reason) | None | No |
| dispatching / fleet live | spinner + `dispatch` (action) | Task island status updates | Yes |
| stuck | `⚠ stuck 12s` (error) | Inline watchdog warning | No |
| done | `✓ done` (success), then quiet telemetry | Settled transcript blocks | No |

---

## 6. Agent and Transcript Formatting

### 6.1 Voices & Hanging Indent
- **User**: `› text` with the user glyph in `accent`.
- **Agent**: `✦ text` with the agent glyph in `accent` (turning `error` red on failed turns, along with the text message). Skill suggestions do not claim the `✦` reply glyph.
- **Two-Cell Hanging Indent**: User and assistant prose are rendered with a fixed two-cell gutter. The first line begins with the turn prefix (`› ` or `✦ `), while all wrapped continuation lines indent by two spaces (`PROSE_GUTTER = "  "`), keeping multiline text visibly attached to its voice glyph.

### 6.2 Thinking Blocks
Drawn as a folded dim marker (`Thinking (N tokens)…` or `Thinking…`), which expands into a body using the `reason` color vertical `│` rail. Cap of 12 lines.

### 6.3 Tool Ledger
Every tool call owns one stable transcript block for its complete lifecycle. Streamed
`toolcall_*` message updates first expose the call as `forming call`, the completed argument block
becomes `ready`, `tool_execution_start` changes the same row to `running`, and cumulative
`tool_execution_update` results replace the live body until `tool_execution_end` settles it. Rapid
tool updates are coalesced to terminal frame rate; settlement always renders immediately.

The collapsed form is one composed ledger line:
```
▸ verb(object) · resource · facts · size ✓ · 230ms · full: path (Alt+O)
```
- Verb is bold `accent`, tail details are `dim`, status glyph is semantic (`✓`/`✗`), and the keyboard shortcut hint is appended at the end. Tool ledgers maintain full terminal width and bypass the prose hanging indent.
- Expanded calls show the primary argument in the signature and every secondary argument as a typed field list. Multiline argument bodies become line and byte facts, nested objects retain structured rendering, and safety-sensitive values remain redacted.
- Running calls label `live output` and replace the cumulative partial result in place. Settled calls label `output` and show available exit status, result or observation counts, line count, displayed and total byte sizes, truncation, timeout, tool-token usage, dynamically added tools, context exclusion, and the full-output path. A blocked or aborted admission instead labels its `decision` and does not claim that the tool ran.
- A call parked for one-shot approval replaces its running timer with `awaiting approval` and shows the already-sanitized action class, asking safety axis, and target below the row. These facts are transient UI state: approval, denial, abort, or settlement clears them, and they are never reconstructed from the session ledger.
- The live permission frame derives its consequence tier from those typed facts and the authenticated origin. It anchors at bottom center with five rows reserved for the composer and footer, and it recomputes that anchor on resize. Each queued frame retains its own tier and requester.
- Text and image tool results keep their text while rendering images as MIME and byte-size placeholders; base64 image data is never written to the terminal.
- Successful `edit` and `write` calls render the bounded diff produced by the tool result. Live regular-screen and fullscreen rows color removed and added lines with the `error` and `success` tokens and emphasize changed words; `/resume` replay and `/export` keep the same numbered diff as plain text.
- Operator `!` and `!!` bash commands use the same running and settled block as model-initiated bash. The block appears before the process starts, streams the throttled cumulative stdout/stderr tail, and settles in place while the existing `bashExecution` session entry remains the durable record. `!!` continues to exclude that record from model context and says so in the block.

### 6.4 Editor Rail
The right-hand label shows `model · thinking`. Thinking level colors map as: `off` (dim), `minimal`/`low` (muted), `medium`/`high` (`reason` purple), and `xhigh`/`max`/`on` (bold `reason` purple).

### 6.5 Transcript Notices
Replay and system tags (e.g. `[retry]`, `[model]`) are wrapped in `dim` brackets with a `muted` message. Retry tags use `warning` amber.

### 6.6 Output Verbosity Receipts
Turn usage receipts rendered at the bottom of completed turns respect the output verbosity configuration:
- `minimal`: Omits the turn usage receipt entirely.
- `default`: Renders one compact dim receipt: `turn · in <N> · out <M>`.
- `verbose`: Renders the full receipt with model call counts (`over N calls`), cache reads/writes (`cache R/W`), reasoning tokens with provenance (`reasoning N provider` or `reasoning ≈N estimated`), and the verification caveat (`· reasoning text is a UI excerpt, not a verification`).

### 6.7 Code Ink (Syntax Highlighting)

Syntax highlighting within code blocks is handled by [src/interactive/renderers/code-ink.ts](../src/interactive/renderers/code-ink.ts). It maps a restricted set of four tokens to stay quiet:

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
- **Group Structure**: Sections are organized under non-selectable section headers:
  - `CORE`: Autonomy & Safety (`safety`), Orchestrator (`orchestrator`)
  - `ROUTING`: Fleet (`fleet`), Targets (`targets`), Models (`models`)
  - `RUNTIME`: Budget (`budget`), Compaction (`compaction`), Retry (`retry`)
  - `EXPERIENCE`: Terminal (`terminal`), Advanced (`advanced`)
- **Semantic Row Grammar**: Explicit presentation kinds (`setting`, `status`, `action`, `group-header`, `read-only-fact`, `destructive-action`) prevent confusion between focus (teal), health (green/amber/red), modified status (neutral/teal mark), and active operations (scarce orange).
- **Transactional Edits**: Selecting a row and pressing `Enter` opens a dedicated value picker, input dialog, or checklist rather than immediately toggling values. Edits construct an immutable `SettingsChangePlan` and present explicit destination choices:
  - `Apply this session` (for live-capable settings)
  - `Apply and save globally`
  - `Cancel` (or `Esc`)
  - Restart-required settings (`fleet.concurrency`, `integrations.runtimePlugins`, `interface.mode`, and `interface.fullscreenScrollbar`) offer only global save and announce `Saved to settings.yaml · restart Clio to apply`.
  - Destructive actions (target/profile removal) execute preflight analysis showing affected chat, fleet, and memory routes before confirmation.
- **Fleet Workbench**: Organizes fleet settings with dim group headers (`Defaults`, `Profiles`, `Agent routes`, `Placement`). Profiles render as one-row summaries with `◆ Edit` affordance; pressing `Enter` drills into profile fields (target, model, thinking level, placement) or destructive removal.
- **Targets Console Table**: Displays configured targets in an operational console table (`HEALTH`, `ID`, `ROLES`, `RUNTIME`, `LATENCY`) with an in-place action/detail drawer (URL, default model, last probe, failure reason). Actions include `Use`, `Connect`, `Probe`, and `Remove`. Active connect/probe operations show the single orange activity indicator.
- **Scoped Models Checklist**: Settings → `Models` provides a provider-backed checklist subview with target-level and target/model items, checked current selections, `Space` to toggle, and capability details in the inspector. Unresolved model references are preserved under an `Unavailable` group.
- **Narrow Terminal Drill-Down Navigation**: Below 72 columns, Settings transitions from a split view to a modal drill-down stack (section list → section rows → detail drawer) with a breadcrumb and `Esc` moving up one level before closing. Includes `/` filtering across label, path, and description, narrowing per keystroke like `/model` and `/resume`. Below 60 columns, side margins are removed for full-width presentation.

### 7.2 Fleet Runs Board

The `Alt+W` board renders one card per run. The default list is compact: run id, route, task, status, telemetry, retry, tool names, and proof. `Enter` opens the selected run's worker detail, which adds two rows to that card and nothing to any other:

- **`doing`**: the phase (`◐ thinking` in `reason`, `◑ writing` in `accent`, `⚙ tool` in `action`, `◔ waiting` in `info`) followed by the running call as `<tool> <verb> <object>`, or the last finished call as `last <tool> <verb> <object>`. The verb and object come from a descriptor composed at the worker seam; raw arguments never reach the renderer.
- **`answer`**: the newest rows of the worker's bounded prose on a `│` rail with a hanging indent under the key, then a dim row naming the lines and bytes the bounds refused and the `/view dispatch:<runId>` deep link.

Wrapping happens before the row cap, so the block is at most six rows tall at any width and a streaming answer cannot make the card grow under the operator. Detail follows the cursor rather than pinning to a run, and closing the board closes it. Reasoning text is never rendered; the `thinking` phase word is the whole of what the board says about it.

### 7.3 Task and Decision Boards

- **Composite Tasks Board (`/tasks`, `Alt+B`)**: Presents four sections in one reopenable overlay: the live session board, terminal task history, successful workspace artifacts, and project-scoped operator tasks. Selecting a workspace artifact opens the filtered `/view` path. Operator rows support add, hand, done, and drop actions; refresh is explicit for captured history and artifacts, while lightweight repaint reads the current board snapshot.
- **Settled Decisions Board (`/decisions`, `Alt+D`)**: Groups completed and cancelled interviews on the active branch, expands source questions and answers, and lets the operator supersede a value or submit a correction. Corrections travel through the ordinary operator-turn path after the durable decision snapshot is updated.
- **Approved editor overrides**: `Alt+B` and `Alt+D` are deliberate application-input boundary overrides of Pi's editor word-back and word-delete chords. Clio routes them before the editor so the two global boards remain one chord away. They are explicit exceptions to the general rule that Clio app bindings avoid Pi editor reserves, and users may rebind the Clio actions in `settings.yaml`.

### 7.4 Slash Autocomplete Command Palette
- **Grouped Palette**: Typing `/` opens a grouped command palette (ordered by `Run`, `Inspect`, `Configure`, `Sessions`) with compact argument hints and formatted descriptions.
- **One Canonical Spelling**: Autocomplete, help, and parsing expose the same unique slash-command names; no alias rows compete with canonical commands.

---

## 8. Shared Vocabulary

One quantity gets one word, and every surface that shows it uses that word. A user comparing the transcript, the footer, and an overlay is checking whether Clio is telling a consistent story; a synonym reads as a discrepancy. `tests/contracts/usage-vocabulary.test.ts` holds the pairs that had drifted.

| Concept | Word | Surfaces |
| --- | --- | --- |
| One model API call | `call` | Chat panel `turn · in N over M calls`, `/cost` `model calls`, `/cost` `(avg/call …)` |
| One user-to-assistant exchange | `turn` | Chat panel `turn · …`, `/cost` `turns` |
| Provider-reported reasoning tokens | `reasoning N provider` | Chat panel |
| Reasoning tokens estimated from displayed text | `reasoning ≈N estimated` | Chat panel; the footer carries the same `≈` on `r≈N` |
| Reasoning tokens in the cost tally | `reasoning N provider-reported only` | `/cost`. This tally never estimates, so it disagrees with the panel on a model that reports nothing, and the row says which one it is. |
| Thinking level a model cannot turn off | `forced` | Editor rail, model overlay, thinking cycle (`thinkingLevelDisplayWord`) |
| Thinking level on a model with only on and off | `on` / `off` | Same surfaces |

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
