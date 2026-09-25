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

All symbols are defined in [src/interactive/theme/glyphs.ts](../../src/interactive/theme/glyphs.ts).

| Glyph | Token | Meaning | Used by |
| :--- | :--- | :--- | :--- |
| `>C_` | `accent` | Brand wordmark | Welcome launchpad, session headers. |
| `✦` | `accent` | Agent voice | First row of agent prose blocks; error blocks (`error`). |
| `▌` | `accent` | Operator input | Left gutter of user prompt lines. |
| `›` | `action` | Quoted user text | Steering queues, command echoes in overlays. |
| `❯` | `accent` | Cursor | Focus selection in lists, menus, and overlays. |
| `▸` | `tool` | Observe / Search | File reads, listings, searches, grep, data inspections. |
| `§` | `tool` | Knowledge / Skill | Context, docs, library, evidence, skills, compaction. |
| `±` | `tool` | Mutate | File writes, patches, edits, artifacts. |
| `$` | `tool` | Execute | Shell commands, scripts, checks, git operations. |
| `↗` | `tool` | Network | Web fetches, URL reading. |
| `?` | `warning`| Question | Operator approvals, decision points, limitation notices. |
| `⇢` | `tool` | External Call | MCP tools, gateways, external extensions. |
| `⚙` | `agent` | Worker Run | Background dispatched worker activity. |
| `✓` | `success`| Done / OK | Successful outcomes, clean checks, settled runs. |
| `✗` | `error`  | Failed | Errors, rejected checks, failed runs. |
| `⊘` | `dim`    | Cancelled | User cancellation or aborted turns. |
| `↻` | `warning`| Retry | Provider retries, failover attempts. |
| `ℹ` | `info`   | Notice | Non-blocking system information. |
| `⚠` | `warning`| Warning | Action required, quota limits, stale states. |

---

## 3. Structural Layouts

### 3.1 The Island (Framed Block)
Bounded content blocks framed with single-line box drawing characters (`┌`, `┐`, `└`, `┘`, `─`, `│`).
- **Header**: Embedded in top border: `┌─ Title ────────────────────┐`.
- **Width**: Responsive; wraps or truncates content with `…`.

### 3.2 Overlays & Modals
Full-screen or docked panels for interactive workflows (`/settings`, `/view`, `/tasks`, `/usage`).
- Header: Centered or left-aligned title with category tabs.
- Navigation: `↑`/`↓` for items, `Tab` for sections, `Enter` to select, `Esc` to close.

### 3.3 Status Pills
Compact inline lifecycle indicators:
`[● running]` (`action`) · `[✓ ready]` (`success`) · `[⚠ blocked]` (`warning`) · `[✗ failed]` (`error`).

### 3.4 Narrow Terminal Adaptation
- **<84 columns**: Side-by-side panes collapse to stacked single-column layouts.
- **<60 columns**: Footer simplifies from 2 rows to essential meters; action rows drop scalar args before dropping command verbs.
- **40 columns**: Minimum supported width; gutters remain fixed at 2 columns with hanging indents.

---

## 4. Screen Surfaces & State Choreography

The visual hierarchy coordinates four primary screen surfaces: Header, Transcript, Composer, and Footer.

### 5.1 Welcome Launchpad & Session Header

The header operates in two distinct modes:
- **Launchpad (before the first prompt)**: A framed panel dashboard enclosed by `╭─ Clio Coder v<version> ─╮`. Displays model route status, workspace path, autonomy level, target inventory, fleet recipes, and cached subscription quotas.
- **Session Header (after prompt admission)**: Collapses into a single compact line showing the active route and directory, preserving vertical space for the transcript.

### 5.2 Composer (ClioEditor)

The input surface (`ClioEditor`) frames the operator's prompt:
- **Rails**: Framed with double vertical rails. Normal input uses pastel teal (`editor`); `yolo` adds muted coral caps (`editorDanger`); active work uses clay orange (`editorAction`). A permission wait carries a moving orange spectrum. The upper rail carries a five-cell thinking meter, with a text label in narrow and screen-reader views.
- **Steering Affordance**: Queued steering instructions display a `›` marker in `action` orange above the prompt.

### 5.3 Progressively Disclosed Footer

The footer anchors live system telemetry across two lines:
- **Line 1 (Activity & Model)**: Active tool or worker status, model identity, weekly quota headroom, throughput metrics, and context occupancy meter.
- **Line 2 (Environment & Hints)**: Working directory, Git branch / dirty status, and rotating context hints.
- **Narrow Terminals**: At narrow widths (<60 columns), secondary tips yield space to essential meters without wrapping.

### 5.4 State Choreography Table

| Lifecycle State | Composer Rails | Gutter Mark | Footer Indicator |
| :--- | :--- | :--- | :--- |
| **Idle** | `editor` (Pastel teal) | ` ` | `ready` |
| **Typing / Input** | `editor` (Pastel teal) | `▌` (`accent`) | `editing` |
| **Thinking** | Teal with a travelling clay accent while the composer is empty; effort meter remains on the top rail | `│` (`reason`) | `thinking (r<tokens>)` |
| **Writing / Streaming** | Teal with a travelling clay accent while the composer is empty | `✦` (`accent`) | `writing` |
| **Tool Execution** | Teal with a travelling clay accent while the composer is empty | Action class glyph | `running <tool>` |
| **Worker Dispatched** | Teal with a travelling clay accent while the composer is empty | `⚙` (`agent`) | `N workers active` |
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
- **Worker Rows**: `◆ delegated to <role>` leading into nested worker card (`⚙ running ...`).
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
