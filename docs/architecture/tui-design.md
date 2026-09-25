# Clio TUI Design System

`ClioEditor` in [clio-editor.ts](../../src/interactive/clio-editor.ts) owns composer editing. The [commands and modes guide](../guide/commands-and-modes.md) lists operator controls.

This document is the reference specification for the Clio Coder TUI visual layout, styling, and behavior across [src/interactive/](../../src/interactive/interactive-shell.ts).

The governing architectural principle: **the user reads state from color, structure from frames, and identity from brand marks.** Everything that is not state or structure remains visually quiet.

---

## Output Styles

Toggle styles with **Alt+O** (`Compact` → `Standard` → `Detailed` → `Compact`). Standard is default. Configured via `/settings interface` or `clio-coder configure --section panes`.

| Content | Compact | Standard (Default) | Detailed |
| :--- | :--- | :--- | :--- |
| **Answers & Prompts** | Complete | Complete | Complete |
| **Supplied Reasoning** | Single fold marker per run | 3 rows before words, marker before action | 12 preview rows |
| **Reads & Searches** | Class fold (`▸ explored N files`) | Action and outcome | 8 result rows |
| **Knowledge Lookups** | Class fold (`§ consulted N`) | Action and outcome | 8 result rows |
| **File Mutations** | Class fold (`± edited N files`) | 8 diff rows | 20 diff rows |
| **User Questions** | Question and answer on 1 row | Question and answer on 1 row | Question and answer on 1 row |
| **Agent Shell Commands** | Command and outcome | Command and outcome | 12 output rows |
| **Operator Shell (`!`/`!!`)**| 3 output rows | 6 output rows | 12 output rows |
| **Dispatched Workers** | Live status line + outcome | Spend + 3 summary rows | 8 summary rows + call trail |
| **Helper / Shadow Work** | 1 row (`↳ role · task ✓`) | 1 row (`↳ role · task ✓`) | Full worker card |
| **Failures & Refusals** | Up to 4 rows actionable reason | Up to 4 rows actionable reason | Up to 12 rows with context |
| **Notices & Retries** | Level mark + bounded message | Level mark + bounded message | Diagnostic detail |
| **Turn Receipt** | None | Outcome + duration | Outcome, duration, tokens, cache, reasoning, prewarm |

- **Preview Budgets**: Counted *after terminal wrapping*. Narrow terminals scale budgets downward.
- **Worker Inspection**: Full unbounded output is inspectable via `/view transcript`.
- **Idle Pre-rendering**: Settled entries are pre-rendered into the two alternative styles during idle time, eliminating delay on Alt+O switching.

---

## 1. Color System

Tokens are defined in [src/interactive/theme/tokens.ts](../../src/interactive/theme/tokens.ts); canonical hex values in [src/core/theme-token-hex.ts](../../src/core/theme-token-hex.ts). Raw ANSI SGR escapes are forbidden outside the theme module.

### 1.1 Color Tokens

| Token | Hex | Role |
| :--- | :--- | :--- |
| `editor` | `#9acbb6` | Pastel sea-glass composer rails (active input only). |
| `editorDanger` | `#e08278` | Yolo autonomy rail caps and label. |
| `editorAction` | `#d7a16f` | Clay-orange preparation / compacting phase rails. |
| `accent` | `#79b29b` | Brand and interactivity: frames, selections, prompts, voice glyph (`✦`), active phases. |
| `accentDeep` | `#5f9687` | Bold CAPS section headers and structural tags. |
| `tool` | `#87aaa0` | Action-row verbs in the tool ledger. |
| `agent` | `#af7959` | Dispatch verbs and active worker counts. |
| `action` | `#bd8862` | Active operations: dispatch pills, running fleet badges, steering queue markers. |
| `success` | `#8eb99b` | Positive outcomes (`✓`), clean git state, added diff lines (`+`). |
| `warning` | `#d5b46f` | Critical warnings (`⚠`), dirty git trees, retry attempts, blocked tools. |
| `error` | `#d28b87` | Failures (`✗`), error rails, removed diff lines (`-`). |
| `info` | `#9bb9b1` | Informational messages, notices, system prompt indicators. |
| `reason` | `#bca993` | Sandstone reasoning indicators and thinking meter. |
| `dim` | `#78817e` | Scaffolding: separators, shortcuts, durations, timestamps. |
| `muted` | `#9ba6a1` | Secondary text: paths, previews, telemetry counts. |
| `title` | `#8ebfae` | Overlay and frame headers. |
| `frame` | `#466a61` | Borders, dividers, unused context meter space. |
| `frameStrong` | `#73a895` | Active input rail background. |

The palette has two hue families. Sea-glass teal carries identity, input, and ordinary success; clay, sandstone, and amber carry action, reasoning, and requests for attention. Coral marks `yolo` and errors. Within each family, the rail is lighter than its supporting text, while `frame` and `dim` stay quieter. State is also spelled by labels, meter fill, and motion, so a monochrome terminal does not have to infer it from hue.

### 1.2 Placement Invariants

- **State Indication**: Color is strictly functional. Telemetry and neutral numbers use `muted` or `dim`.
- **Orange Scarcity**: Clay orange marks live work and amber-orange marks a pending operator decision. Settled rows and idle borders stay teal or neutral.
- **Budgeting**: Max one non-neutral token per chip; max one status token per framed card.

### 1.3 Composer Rail States

| State | Rail treatment | Motion |
| :--- | :--- | :--- |
| `default`, idle | Pastel teal fill | Static |
| `yolo`, idle | Pastel teal with coral caps and `YOLO` label | Static |
| Working or steering | Teal fill with a travelling clay accent | Only when the composer is empty |
| Permission wait | Orange and amber spectrum with `CONFIRM` and decision keys | Moving spectrum, even with a draft |
| Reduced motion, screen reader, or `NO_COLOR` | Same labels and meter; static fill | None |

The top rail carries the effective thinking level: five cells for `off`, `minimal`/`low`, `medium`, `high`, `xhigh`, and `max`. Compact output shows `T` and the cells; standard spells `think`; detailed also spells the level. Binary or forced thinking capabilities use text because a five-step meter would misstate them. Thinking is absent from the footer.

---

## 2. Glyph Vocabulary

All symbols are defined in [src/interactive/theme/glyphs.ts](../../src/interactive/theme/glyphs.ts). A glyph means one thing everywhere; a surface that needs a new meaning asks for a new constant rather than borrowing a shape.

| Glyph | `GLYPH` key | Token | Meaning | Used by |
| :--- | :--- | :--- | :--- | :--- |
| `>C_` | `brand` | `accent` | Brand wordmark | Launchpad and session header only. |
| `✦` | `agent` | `accent` | Agent voice | First row of agent prose; `error` on a failed turn. |
| `▌` | `userBar` | `accent` | Operator input | Gutter of every prompt row. |
| `›` | `user` | `action` | Quoted operator text | Steering queue, command echoes. |
| `❯` | `cursor` | `accent` | Focus | Selected row in lists, menus and overlays. |
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
| `●` | `running` | `accent` | Running | Status pills, island rows. |
| `◌` | `queued` | `dim` | Queued or pending | Status pills, task island. |
| `⚙` | `phaseTool` | `muted` | Live tool activity | Running tool rows and the footer phase. |
| `✓` | `ok` | `success` | Done | Outcomes, reviewed trust verdicts. |
| `✗` | `error` | `error` | Failed | Outcomes, compromised trust verdicts. |
| `⊘` | `cancelled` | `dim` | Cancelled | Aborted turns and runs. |
| `↻` | `phaseRetry` | `warning` | Retry | Provider retries and failover. |
| `ℹ` | `info` | `info` | Notice | Info notices. |
| `⚠` | `warn` | `warning` | Warning | Warning notices, quota limits, stale state. |
| `│` | `rail` | `frame` | Rail | Island sides, column separators. |
| `╌` | `innerDivider` | `frame` | Inner divider | Rows inside an island. |
| `…` | `ellipsis` | inherits | Cut | Every truncation. |

Trust verdicts on a dispatch card print `✓` for reviewed and `✗` for compromised; grounded and unverified print the verdict word alone, because a diamond on that line would read as an origin.

---

## 3. Structural Layouts

### 3.1 The Island (Framed Block)
Every framed block is built by `frame()` and `innerDivider()` in [rules.ts](../../src/interactive/theme/rules.ts): the launchpad, the fleet and task islands, the council card, the dispatch cards and the steering queue. No surface draws its own corners, tees or rounded frame.
- **Header**: Embedded in the top border in the bold `title` token: `┌─ Title ─────────── meta ─┐`. Optional right metadata is `dim`. A title wider than the island is clipped with `…` before the corner.
- **Body**: `│ ` + content padded to the inner width + ` │`. Sections inside one island are separated by a full-width `╌` row, never by a `├┤` tee.
- **Width**: Every row is exactly the island width in visible cells. Content is truncated with `…`, never wrapped past the rail.

### 3.2 Overlays & Modals
Full-screen or docked panels for interactive workflows (`/settings`, `/view`, `/tasks`, `/usage`).
- Header: Centered or left-aligned title with category tabs.
- Navigation: `↑`/`↓` for items, `Tab` for sections, `Enter` to select, `Esc` to close.

### 3.3 Status Pills
Compact inline lifecycle indicators:
`[● running]` (`action`) · `[✓ ready]` (`success`) · `[⚠ blocked]` (`warning`) · `[✗ failed]` (`error`).

### 3.4 Width Degradation

No row exceeds the terminal width in visible cells at any width. The contracts in `tests/contracts/tui-island-frames.test.ts`, `tests/contracts/transcript-retry-prefix.test.ts` and `tests/contracts/footer-notice-priority.test.ts` render at 60, 80, 120 and 200 columns.

| Surface | 60 | 80 | 120 | 200 |
| :--- | :--- | :--- | :--- | :--- |
| Launchpad | Stacked details, no wordmark | Wordmark beside details (from 76) | Wide wordmark (from 100) | Hint column added (from 160) |
| Session header | One row | One row | One row | One row |
| Fleet or task island | Hidden | Shown at 48 cells when the screen has 18 rows | Same | Same |
| Context island | Hidden | Hidden | Shown at 52 cells when the screen has 20 rows (from 92) | Same |
| Council card | Stacked members | Stacked until each column holds 34 cells | Grid | Grid |
| Compact footer | Two rows, 8-cell context meter | Two rows, 8-cell meter | Two rows, 14-cell meter, full hints | Two rows, wider identity |
| Expanded footer | Pages stack | Context and Status split from 76 | Two columns | Two columns |
| Transcript | Prompt and prose wrap; action rows shorten paths first | Same | Rows at natural width | Same; extra columns never inflate rows |

The minimum supported width is 40 columns. Gutters stay 2 columns with hanging indents.

### 3.5 Pinned Islands and the Dynamic Transcript

The viewport has two kinds of content.

- **Pinned**: the composer and the footer dock below the transcript in [layout.ts](../../src/interactive/layout.ts). Two islands float at the top right as non-capturing overlays owned by `interactive-tickers.ts`: the fleet island (live dispatch rows and councils, one card per council) or, when no run is live, the task island, and the context island while a context operation runs. Only one island shows at a time, the context island taking precedence, and every island hides while an overlay is open or the footer is expanded. An island never takes the keyboard. Known gap: from 80 to 91 columns, context activity hides the fleet or task island while the context island still needs 92, so neither shows.
- **Dynamic**: everything in the transcript. Dispatch, council and worker state render as transcript blocks that update in place; the islands summarize them and never become a second history. The decision board stays a capturing overlay (`/decisions`), because a decision needs the keyboard and an island may not hold it.

**Hydration.** The instant shell paints `createBootWelcome` with the settings already read, at the same geometry as the hydrated launchpad. A resumed session replays its turns through the same panel operations a live turn uses (`rehydrateChatPanelFromTurns` in `chat-renderer.ts`), and the settled entries are pre-rendered in the other output styles while idle.

**Stream ticks.** The chat panel returns a frame as `ChatPanelRegions`: a frozen `prefix` of the contiguous settled entries from the top of the transcript, and a `tail`. The prefix array keeps its identity across stream ticks, and the regular-mode root skips rewriting it while it sits at the same row. A settled entry is a committed prompt, a non-live replay block, a finished worker, a retry row, or an assistant entry with no pending message and no running tool. A stream tick renders only the live entry: `ChatPanelRenderMetrics.entriesRendered` is 1 per tick. An entry that changes after it settles, such as a retry row for the same attempt, drops its cached render and the freeze behind it.

**Measuring.** `render-trace.ts` records frames, panel `entriesRendered` and `cacheHit`, and bytes written per commit. It has no count of terminal lines redrawn, so a claim about repainted rows needs a new counter at pi-tui's line-write path first. Tests never assert wall-clock time.

---

## 4. Screen Surfaces & State Choreography

The visual hierarchy coordinates four primary screen surfaces: Header, Transcript, Composer, and Footer.

### 4.1 Welcome Launchpad & Session Header

The header operates in two distinct modes:
- **Launchpad (before the first prompt)**: A standard island titled `Clio Coder v<version>`, with the action row under an inner divider. Displays model route status, workspace path, autonomy level, target inventory, fleet recipes, and cached subscription quotas.
- **Session Header (after prompt admission)**: Collapses into a single compact line showing the active route and directory, preserving vertical space for the transcript.

### 4.2 Composer (ClioEditor)

The input surface (`ClioEditor`) frames the operator's prompt:
- **Rails**: Framed with double vertical rails. Normal input uses pastel teal (`editor`); `yolo` adds muted coral caps (`editorDanger`); active work uses clay orange (`editorAction`). A permission wait carries a moving orange spectrum. The upper rail carries a five-cell thinking meter, with a text label in narrow and screen-reader views.
- **Steering Affordance**: Queued steering instructions display a `›` marker in `action` orange above the prompt.

### 4.3 Progressively Disclosed Footer

The footer anchors live system telemetry across two lines:
- **Line 1 (Activity & Model)**: Active tool or worker status, model identity, weekly quota headroom, throughput metrics, and context occupancy meter.
- **Line 2 (Environment & Hints)**: Working directory, Git branch / dirty status, and rotating context hints.
- **Notice Slot**: Line 2 has room for one notice. It shows the head of the notice center's order, most severe first and newest within a level, with the level's glyph and token (`✗`, `⚠`, `✓`, `ℹ`). An armed quit or leader key outranks any notice.
- **Narrow Terminals**: Secondary hints yield space to the context percentage and phase without wrapping; optional counts drop before a number is cut.

### 4.4 State Choreography Table

| Lifecycle State | Composer Rails | Gutter Mark | Footer Indicator |
| :--- | :--- | :--- | :--- |
| **Idle** | `editor` (Pastel teal) | ` ` | `ready` |
| **Typing / Input** | `editor` (Pastel teal) | `▌` (`accent`) | `editing` |
| **Thinking** | Teal with a travelling clay accent while the composer is empty; effort meter remains on the top rail | `│` (`reason`) | `thinking (r<tokens>)` |
| **Writing / Streaming** | Teal with a travelling clay accent while the composer is empty | `✦` (`accent`) | `writing` |
| **Tool Execution** | Teal with a travelling clay accent while the composer is empty | Action class glyph | `running <tool>` |
| **Worker Dispatched** | Teal with a travelling clay accent while the composer is empty | `◆` or `◇` by origin (`agent`) | `N workers active` |
| **Approval Required** | Moving orange and amber spectrum with `CONFIRM` and decision keys | `?` (`warning`) | `awaiting approval` |
| **Compacting** | Teal with a travelling clay accent and `COMPACTING` label | `§` (`reason`) | `compacting context` |
| **Terminal Error** | Teal idle rail after the turn ends; the failure stays in the transcript | `✦` (`error`) | `error` |

---

## 5. Transcript & Gutter Grammar

Every transcript row follows a rigid 2-column gutter format:
```text
<gutter:2> <content>
```
- **Prose Head**: `✦ ` followed by text in standard color.
- **Prose Continuation**: `  ` indented 2 spaces.
- **Tool Action Row**: Class glyph (`▸`, `§`, `±`, `$`, `↗`, `?`, `⇢`) + verb + scalar target + outcome (`✓ Done · 12ms`).
- **Worker Rows**: The origin mark (`◆` model, `◇` operator) heads the worker block; a running tool inside it shows `⚙`.
- **Turn Settlement**: Final turn outcome closes the block with outcome in gutter (`✓ Done · 14s · 3 calls · in 100k · out 380`).

---

## 6. Overlays & Inspection

- **`/view transcript`**: Inspect complete un-truncated output, tool payloads, and raw responses.
- **`/usage`**: 4 tabs (Accounts, Session, Models, Workers) with consumption vs budget percentages.
- **`/tasks`**: Interactive task board tracking parent/child subagent execution status.
- **`/doctor`**: In-session diagnostic reports with severity-ordered findings.

---

## 7. Source Implementation Map

| Subsystem | Source Location | Key Exports |
| :--- | :--- | :--- |
| Theme & Tokens | [tokens.ts](../../src/interactive/theme/tokens.ts) | `tokens`, `ColorToken`, `themeTokenHex` |
| Glyph Constants | [glyphs.ts](../../src/interactive/theme/glyphs.ts) | `glyphs`, `GlyphName` |
| Welcome Dashboard | [welcome-dashboard.ts](../../src/interactive/welcome-dashboard.ts) | `buildWelcomeDashboardLines` |
| Composer | [clio-editor.ts](../../src/interactive/clio-editor.ts) | `ClioEditor` |
| Session transcript | [session-transcript.ts](../../src/interactive/session-transcript.ts) | `createSessionTranscript` |
| Permission overlay | [permission-overlay.ts](../../src/interactive/permission-overlay.ts) | Permission presentation |
