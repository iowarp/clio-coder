# Clio TUI Design System

Reference specification for the Clio Coder TUI visual layout, styling, and behavior across [src/interactive/](../../src/interactive/).

**Core Invariant**: *State from color, structure from frames, identity from brand marks. Everything else remains visually quiet.*

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

---

## 1. Color System

Tokens are defined in [src/interactive/theme/tokens.ts](../../src/interactive/theme/tokens.ts); hex values in [src/core/theme-token-hex.ts](../../src/core/theme-token-hex.ts). Raw ANSI SGR escapes are forbidden.

### 1.1 Color Tokens

| Token | Hex | Role |
| :--- | :--- | :--- |
| `editor` | `#40ffbf` | Neon teal composer rails (active input only). |
| `editorDanger` | `#ff5058` | Full-auto autonomy rail caps and label. |
| `editorAction` | `#ffab45` | Exceptional preparation / compacting phase rails. |
| `accent` | `#53b196` | Brand and interactivity: frames, selections, prompts, voice glyph (`✦`), active phases. |
| `accentDeep` | `#3e9389` | Bold CAPS section headers and structural tags. |
| `tool` | `#6fada5` | Action-row verbs in the tool ledger. |
| `agent` | `#cf905b` | Dispatch verbs and active worker counts. |
| `action` | `#d99b62` | Active operations: dispatch pills, running fleet badges, steering queue markers. |
| `success` | `#77b891` | Positive outcomes (`✓`), clean git state, added diff lines (`+`). |
| `warning` | `#d3b06b` | Critical warnings (`⚠`), dirty git trees, retry attempts, blocked tools. |
| `error` | `#db8289` | Failures (`✗`), error rails, removed diff lines (`-`). |
| `info` | `#80a7ce` | Informational messages, notices, system prompt indicators. |
| `reason` | `#af9bc9` | Reasoning indicators, thinking rail, compacting status. |
| `dim` | `#6a7a85` | Scaffolding: separators, shortcuts, durations, timestamps. |
| `muted` | `#8a99a4` | Secondary text: paths, previews, telemetry counts. |
| `title` | `#72b8ad` | Overlay and frame headers. |
| `frame` | `#2f5d5a` | Borders, dividers, unused context meter space. |
| `frameStrong` | `#2aab9e` | Active input rail background. |

### 1.2 Placement Invariants

- **State Indication**: Color is strictly functional. Telemetry and neutral numbers use `muted` or `dim`.
- **Neon Orange Scarcity**: `action` orange is reserved exclusively for actively executing operations. It never appears on settled rows, decorative borders, or more than one element per region.
- **Budgeting**: Max one non-neutral token per chip; max one status token per framed card.

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

## 4. State Choreography

| State | Composer Rails | Gutter Mark | Footer Indicator |
| :--- | :--- | :--- | :--- |
| **Idle** | `editor` (Neon teal) | ` ` | `ready` |
| **Typing / Input** | `editor` (Neon teal) | `▌` (`accent`) | `editing` |
| **Thinking** | `dim` rail | `│` (`reason`) | `thinking (r<tokens>)` |
| **Writing / Streaming** | `dim` rail | `✦` (`accent`) | `writing` |
| **Tool Execution** | `dim` rail | Action class glyph | `running <tool>` |
| **Worker Dispatched** | `dim` rail | `⚙` (`agent`) | `N workers active` |
| **Approval Required** | `warning` rail | `?` (`warning`) | `awaiting approval` |
| **Compacting** | `editorAction` (Orange) | `§` (`reason`) | `compacting context` |
| **Terminal Error** | `error` rail | `✦` (`error`) | `error` |

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
