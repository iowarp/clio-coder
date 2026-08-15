# Clio TUI Design System

> [!TIP]
> **Interactive Spec Available:** An interactive color/glyph token laboratory and terminal transcript preview renderer is located at [docs/html/tui_design_blueprint.html](html/tui_design_blueprint.html) (Version: 0.3.0).

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
| `action` | `rgb(255, 126, 41)` (Orange) | Active autonomous operations: dispatching phase pills, active fleet badges, running fleet indicators, and user-steering queues. |
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
- Per-surface color budgets limit noise: chip strips use at most one non-neutral token per chip, and framed cards use at most one status token alongside neutral colors.

---

## 2. Glyph Vocabulary

All symbols are defined as constants in [src/interactive/theme/glyphs.ts](../src/interactive/theme/glyphs.ts). Rendering code reference these names instead of embedding hardcoded glyph literals.

| Glyph | Name | Meaning | Used by |
|---|---|---|---|
| `>C_` | `brand` | Clio wordmark | Welcome header and dashboard header only. |
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
| `◆ ◇` | `active/scoped` | Active and scoped marks | Model selector, thinking selector. |

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
- Split overlays such as `/view` fall back to a single pane layout with `[Tab]` switching between the artifact list and details.
- Keybinding hints, cards, and markdown detail text wrap fluidly without horizontal clipping.


---

## 5. State Choreography

The Clio screen maintains a fixed structure: banner, transcript, editor rail, and footer. State is signaled through the status pill in the footer and matches the following table:

| State | Pill | Transcript Echo | Action Orange? |
|---|---|---|---|
| idle | `◌ idle · tools none` (muted) | None; last-turn telemetry on line 2 | No |
| preparing / waiting | spinner + `waiting` (info) | None | No |
| thinking | spinner + `thinking` (reason) | Dim `Thinking (N tokens)...` marker | No |
| writing | spinner + `writing` (accent) | Streaming markdown text | No |
| tool running | spinner + `tool <name>` (accent) | `▸` tool execution ledger line | No |
| blocked | `⏸ blocked` (warning) | Permission prompt surface | No |
| retrying | `↻ retry 2/5` (warning) | Dim retry details line | No |
| compacting | spinner + `compacting` (reason) | None | No |
| dispatching / fleet live | spinner + `dispatch` (action) | Task island status updates | Yes |
| stuck | `⚠ stuck 12s` (error) | Inline watchdog warning | No |
| done | `✓ done` (success), then telemetry | Settled transcript blocks | No |

---

## 6. Agent and Transcript Formatting

### 6.1 Voices
- **User**: `› text` with the user glyph in `accent`.
- **Agent**: `✦ text` with the agent glyph in `accent` (turning `error` red on failed turns, along with the text message).

### 6.2 Thinking Blocks
Drawn as a folded dim marker (`Thinking (N tokens)...` or `Thinking...`), which expands into a body using the `reason` color vertical `│` rail. Cap of 12 lines.

### 6.3 Tool Ledger
Tool lines wrap as a single composed block:
```
▸ verb object · resource · facts · size ✓ · 230ms · full: path (ctrl+o)
```
- Verb is bold `accent`, tail details are `dim`, status glyph is semantic (`✓`/`✗`), and the keyboard shortcut hint is appended at the end.

### 6.4 Editor Rail
The right-hand label shows `model · thinking`. Thinking level colors map as: `off` (dim), `minimal`/`low` (muted), and `medium` and above (purple `reason`).

### 6.5 Transcript Notices
Replay and system tags (e.g. `[retry]`, `[model]`) are wrapped in `dim` brackets with a `muted` message. Retry tags use `warning` amber.

### 6.6 Code Ink (Syntax Highlighting)

Syntax highlighting within code blocks is handled by [src/interactive/renderers/code-ink.ts](../src/interactive/renderers/code-ink.ts). It maps a restricted set of four tokens to stay quiet:

- **Comments**: `dim`
- **String Literals**: `success`
- **Language Keywords**: `reason`
- **Numeric Literals**: `info`

All other code elements (identifiers, types, function names, punctuation) remain plain. Diff blocks highlight added lines with `success` green and removed lines with `error` red.

---

## 7. v0.2.9 TUI & Cost Provenance Transformations

### 7.1 Fleet Visibility Across Surfaces
- **Dispatch Board**: Displays per-run status cards with node assignments (`local` vs remote node ID), reroute badges, gate indicators (`gate reviewer c2`), live tool activity, and context occupancy meters.
- **Settings → Fleet** (`/fleet`): Editable fleet defaults, profile rows including node pins, agent bindings, and read-only node placement rows.
- **Parked Tools & Approvals**: Parked tool calls awaiting permission are rendered as `⏸ awaiting approval` with explicit approval prompts. Input overlays stay modal during active runs so background completions do not displace open dialogs.

### 7.2 Cost Provenance & Evidence Rendering
- **Session vs Run Provenance**: The Activity footer renders session token/cost totals, while the dispatch board renders per-run worker tokens and cost with `known`, `estimated`, or `unknown` provenance markers. The current surfaces do not present a separate orchestrator-versus-worker algebra.
- **Proof Markers**: Dispatch cards render evidence readiness as `proof` markers (`pending`, `ready`, or `failed`) from the observability projection. Model-facing dispatch and monitor output use `receipt_integrity=verified/v15/sha256` and a separate `evidence_verification` label; the TUI does not emit a `[VERIFIED_RECEIPT_OK]` badge.

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
