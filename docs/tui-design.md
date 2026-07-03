# Clio TUI Design System

This document is the single source of truth for how the Clio Coder TUI looks.
It decides color semantics, the glyph vocabulary, the structural recipes, and
the state choreography, then lays out the build plan that brings every surface
in `src/interactive/` onto the system. Engine behavior, event contracts, and
the SafeEventBus architecture are out of scope; this is presentation only.

The governing idea: **the user reads state from color, structure from frames,
and identity from two brand marks.** Everything that is not state or structure
is quiet.

## 1. Color system

All color lives in `src/interactive/theme/tokens.ts`. No raw SGR sequences,
no `38;2;`/`38;5;` fragments, and no hex colors exist anywhere else under
`src/interactive/`. A contract test enforces this (slice 1).

### 1.1 Token table

| Token         | Value (truecolor)   | Job |
|---------------|---------------------|-----|
| `accent`      | 70,229,208 teal     | Brand and interactivity: frame titles, selection highlight, keybinding and slash-command affordances, the agent voice glyph, the tool verb anchor, the `writing` phase, the conversation share of context meters. |
| `accentDeep`  | 31,183,166          | Structure emphasis only: bold CAPS section tags. Never used for values or metrics. |
| `action`      | 255,126,41 orange   | Renamed from `highlight`. Fires only when Clio is autonomously acting: the `dispatching` phase pill, the active fleet badge, queued and running fleet markers, the steer marker, the `fleet` key-value when work is live. Never decoration, never a metric, at most one orange element per region of the screen. The token name teaches the rule: orange means Clio is acting. |
| `success`     | 87,227,137 green    | Positive outcomes: `✓`, ok health, clean git, output-token chips while streaming. |
| `warning`     | 255,180,84 amber    | Real warnings only: stale, dirty, retry, blocked, truncation. Never money, never neutral telemetry. |
| `error`       | 255,92,102 red      | Failures: `✗`, error rails, stuck state, error message text. |
| `info`        | 91,168,255 blue     | Informational level in notices; the system-prompt share of context meters. |
| `reason`      | 157,140,255 purple  | Everything reasoning-related: thinking phase, thinking rail, `rN` reasoning-token chips, the thinking-level value in the editor rail and dashboards, the compacting phase. |
| `dim`         | 106,122,133         | Scaffolding: separators, key names, hints, durations, ledger tails, timestamps. |
| `muted`       | 138,153,164         | Secondary content: values, paths, previews, counts. |
| `title`       | alias of `accent`   | Kept as a semantic alias so titles can diverge later without a sweep. |
| `frame`       | 47,93,90            | Borders, rules, inner dividers, the free share of context meters. |
| `frameStrong` | 42,171,158          | The editor rail fill only. It is the one always-bright horizontal on screen and marks where the user types. |

Retired tokens: `loop` (defined, never painted), `effortMedium`, `effortHigh`
(the three-step teal ramp is indistinguishable in practice; see section 6.4
for the replacement). `xterm` fallbacks stay as they are for surviving tokens.

### 1.2 Placement rules

- Color states a fact. If removing the color loses no information, the text is
  `dim`, `muted`, or unstyled.
- `warning` amber is never applied to costs, throughput, or other neutral
  numbers. Dispatch card costs are `muted`.
- `accentDeep` appears only in section tags. Its current uses as a value color
  (autonomy value, TTFT, tokens-per-second) move to `muted`.
- Per-surface color budgets: a chip strip uses at most one non-neutral token
  per chip; a framed card uses at most one status token plus neutrals.

## 2. Glyph vocabulary

One symbol per meaning, one meaning per symbol. All glyphs live in
`theme/glyphs.ts`; rendering code never embeds a status or structural literal.

| Glyph | Name | Meaning | Used by |
|-------|------|---------|---------|
| `>C_` | `brand` | Clio wordmark | Welcome header and dashboard header only. Painted as the logotype via `brandMark()`: dim `>` and `_` around a bold accent `C`; the plain string survives for width math. |
| `✦`   | `agent` | Agent voice | Chat reply prefix (accent; error red on failed turns). |
| `›`   | `user`  | User voice | Chat user prefix (accent); steering queue steer marker (action). |
| `❯`   | `cursor` | Selection focus | Settings, list overlays, view overlay, tree selector, providers overlay, fleet profile and binding rows. |
| `▸`   | `toolHeader` | Tool ledger line | Tool sublines and expanded tool headers only. |
| `✓`   | `ok` | Success | Everywhere. |
| `✗`   | `error` | Failure | Everywhere. |
| `⊘`   | `cancelled` | Cancelled or aborted | Everywhere. |
| `⚠`   | `warn` | Warning block | Notices, stuck phase. |
| `!`   | `warnInline` | Inline warning mark | Git dirty, stale rows, fleet row warnings. |
| `ℹ`   | `info` | Informational notice | Notification surfaces. |
| `●`   | `running` | Live run (static form) | Dispatch rows when not animated, health ok. |
| `◌`   | `queued` | Queued or idle | Queued dispatch rows, idle phase. |
| `⣾⣽⣻⢿⡿⣟⣯⣷` | `SPINNER_FRAMES` | Live activity | Phase pill and running dispatch rows. |
| `◔ ◐ ◑` | `phaseWaiting/phaseThinking/phaseWriting` | Turn progression | Phase pill. |
| `⚙`   | `phaseTool` | Tool executing | Phase pill. |
| `⏸`   | `phaseBlocked` | Awaiting confirmation | Phase pill. |
| `↻`   | `phaseRetry` | Retrying | Phase pill, retry notices. |
| `♻`   | `phaseCompact` | Compacting | Phase pill. |
| `⇲`   | `phaseDispatch` | Dispatching (action orange) | Phase pill. |
| `↑ ↓` | `up/down` | Input and output tokens; scroll | Everywhere. |
| `⚡`  | `speed` | Throughput | Everywhere. |
| `▰ ▱` | `contextFull/contextFree` | Context meter cells | Meters. |
| `█ ░` | `barFull/barEmpty` | Wide-glyph fallback | Meters. |
| `│`   | `rail` | Body rail and section bar | Tool bodies, thinking rail, column separators. |
| `─`   | (rules) | Horizontal rule and borders | Frames and rules. |
| `╌`   | `innerDivider` | Divider inside a frame | Task island, any framed list. |
| `·`   | (dotSep) | Chip separator (dim) | Everywhere. |
| `◆ ◇` | `active/scoped` | Active and scoped marks | Model selector, thinking selector. |

Removed: the `•` bullet (dispatch cards, task island, context activity all move
to `·`), the duplicate `noticeInfo/noticeSuccess/noticeWarn/noticeError`
family (surfaces use `ℹ ✓ ! ✗` from the table above; `⚠` is reserved for
block-level warnings like the notice panel and the stuck pill).

## 3. Formats

One formatter per quantity, all in `theme/labels.ts` or `footer-panel.ts`:

- **Duration**: `formatCompactMs` everywhere (`860ms`, `4.2s`, `42s`,
  `1m36s`). The variants in `renderers/tool-execution.ts`
  (`formatDurationMs`, which emits `1m05s`), `status/verbs.ts`
  (`formatStatusElapsed`, which emits `1m 5s`), and `fleet-overlay.ts`
  (`formatSeconds`) are deleted and their call sites converted.
- **Token counts**: `formatFooterTokens` (`842`, `12.4k`, `1.2M`) in every
  chip, pill, card, and island. Full `toLocaleString` numbers appear only in
  detail tables: the context overlay legend, the cost overlay, and fleet
  totals.
- **USD**: the shared `formatUsd` (`$1.23`, four decimals only under one
  cent). `fleet-overlay.ts` drops its four-decimal local copy.
- **Model ids**: `abbreviateModelId` must not amputate version suffixes.
  `claude-sonnet-5` renders as `claude-sonnet-5` and `claude-opus-4-8` as
  `claude-opus-4-8`. New rule: keep whole dash-separated parts while the
  result stays within 18 characters; if even two parts overflow, hard-clip at
  18.

## 4. Structural language

### 4.1 The island (framed in-flow block)

One recipe, produced by `frame()` in `theme/rules.ts`:

```
┌─ Title ──────────────────────────── meta ─┐
│ body line                                 │
│ body line                                 │
└───────────────────────────────────────────┘
```

- Corners and fill in `frame`; `Title` bold `title` with exactly one space on
  each side; optional right `meta` (dim) sits before the closing corner with
  one space each side.
- Body rows are `│ <padded content> │` with one space of padding.
- Inner dividers are full-width `╌` in `frame`.

Users: welcome dashboard, task island, steering queue, dispatch cards (meta =
elapsed time). The four local frame implementations (welcome-dashboard,
dispatch-board `frame()`, dispatch card borders, follow-up-queue inline
borders) are deleted in favor of this one. The current defects this removes:
the welcome title glued to its fill (`v0.2.8────`), the unstyled `─ ` around
`rules.ts` frame titles, and the missing spaces in `┌─Steering Queue───`.

### 4.2 The overlay

`overlay-frame.ts` keeps its recipe and becomes byte-compatible with the
island in the parts they share: same top border grammar, plus the dim hint
embedded in the bottom border:

```
└─ [Tab] mode · [Esc] close ─────────────────┘
```

### 4.3 Section headers

Two named recipes, each with one job:

- **Panel section tag** (dashboard quadrants): bold CAPS in `accentDeep`.
  All four quadrants use the same color; the current
  info/accent/reason/success carnival is decoration and goes away.
- **List group header** (inside list overlays): `── Label` in `dim`.

### 4.4 Key-value rows

`<key padded, dim> <value>`; value is `muted` unless it carries a semantic
token. Already the norm in the footer dashboard; dispatch cards, the cost
overlay, and the context overlay footer adopt it.

### 4.5 The status pill

```
<spinner|glyph> <label> [ · badge]
```

- When the phase is live, the animated spinner replaces the static phase
  glyph rather than sitting next to it. `⢿ thinking`, not `⢿ ◐ thinking`.
  Idle and terminal states show their static glyph (`◌ idle`, `✓ done`).
- Spinner, glyph, and label all take the phase token.
- Badges are dim-separated: `· fleet 2` (action), `· tools 1` (muted).
- The tool phase label is never padded. `⚙ tool bash · tools 1` with single
  spaces; the current `truncateToWidth(..., pad=true)` bug that renders
  `tool bash        · tools 1` is fixed by truncating without pad.

### 4.6 Tables

Fleet overlay and cost overlay tables: header row in `dim`, cells unstyled or
`muted`, status cells take the status token, numeric columns right-aligned.
Timestamps render as `HH:MM:SS` local, not raw ISO strings.

### 4.7 The rule

`rule()` output is flush left: no leading space before a left label. Labels
keep bold accent; fill is `frame`.

## 5. State choreography

The screen is a fixed stage: banner, transcript, editor rail, footer. The
editor rail (`frameStrong`) is the constant brightest line. State is read from
the footer pill plus at most one echo in the transcript:

| State | Pill | Transcript echo | Orange? |
|-------|------|-----------------|---------|
| idle | `◌ idle · tools none` muted | none; last turn chips on line 2 right | no |
| preparing / waiting | spinner + `waiting` info | none | no |
| thinking | spinner + `thinking` reason | dim `Thinking (N tokens)…` marker | no |
| writing | spinner + `writing` accent | streaming text | no |
| tool running | spinner + `tool <name>` accent | `▸` ledger line counting elapsed | no |
| blocked | `⏸ blocked` warning | permission surface | no |
| retrying | `↻ retry 2/5` warning | dim retry line | no |
| compacting | spinner + `compacting` reason | none | no |
| dispatching / fleet live | spinner + `dispatch` **action** + `· fleet N` **action** | task island rows | yes, only here |
| stuck | `⚠ stuck 12s` error | inline stuck verb | no |
| done | `✓ done` success, then last-turn chips | settled transcript | no |

Rules: exactly one spinner on screen (the pill owns it; dispatch rows may
animate their own glyph only inside the task island); orange appears if and
only if fleet work is queued or running or the user steered; red means
something failed, and nothing else is ever red.

Dispatch status presentation (single source `dispatchStatusPresentation`):
`running` spinner/`●` **action**, `enqueued` `◌` **action**, `completed` `✓`
success, `failed`/`dead` `✗` error, `aborted` `⊘` dim, `stale` `!` warning.
Running fleet work is Clio acting; it joins queued work under `action`
instead of the current teal-running/orange-queued split.

## 6. Agent output

### 6.1 Voices

- User: `› text` with accent glyph.
- Agent: `✦ text` with accent glyph; the glyph turns `error` red on a failed
  turn and the terminal error text itself renders in `error` red, not plain.
  The `>C_` wordmark stops being the reply prefix; it remains only in the
  welcome header and dashboard header.

### 6.2 Thinking

Unchanged in structure: folded dim marker by default (`Thinking (N tokens)…`
live, `Thinking...` settled), expanded body dim under a `reason` `│` rail,
12-line cap. No boxes, no color in the body.

### 6.3 Tool ledger

Collapsed subline grammar (one composed string, wrapped once):

```
▸ verb object · resource · facts · size ✓ · 230ms · full: path (ctrl+o)
```

- `▸` dim, verb bold accent, object plain, tail facts dim, status glyph
  semantic, duration dim.
- The expand-key hint is appended to the end of the composed line before
  wrapping. The current implementation re-wraps the first wrapped line and
  splits `✓ ·` / `(ctrl+o)` / `230ms` across three lines; that is a defect.
  After the fix, the status glyph and duration are never separated.
- Expanded blocks keep the `│` rail (dim normally, red on error), the `$ cmd`
  echo for bash, and the numbered unified diff for edits. Diff blocks
  suppress `\ No newline at end of file` markers.
- Queued/running lines show elapsed via `formatCompactMs`.

### 6.4 Editor rail

Right label: `model · thinking`. Model stays dim. Thinking level colors by a
two-step scale that survives squinting: `off` dim, `minimal`/`low` muted,
`medium` and above `reason` (bold at `xhigh`/`max`). The retired
`effortMedium`/`effortHigh` tokens die here.

### 6.5 Transcript notices

Replay and system lines (`[retry]`, `[model]`, `[thinking]`, `[file ...]`,
`[skill]`, `[checkpoint]`, `[session]`) render the bracketed tag in `dim` and
the message in `muted`; retry lines take `warning` on the tag. Today they are
completely unstyled.

### 6.6 Code ink

Code inside a fence is quoted material, not UI state, so it gets its own
quiet ink built entirely from existing tokens. The mapping is exactly four
tokens and closed to extension:

- comments: `dim`
- string literals: `success`
- language keywords: `reason`
- numeric literals: `info`

Everything else, including identifiers, types, function names, and
punctuation, stays plain. When the lexer is unsure it leaves text plain:
under-highlighting is correct behavior, mis-highlighting is a defect.

`renderers/code-ink.ts` owns the mapping: a dependency-free, line-oriented
tokenizer with a small carry state (block comment, template literal,
triple-quoted string) threaded between the lines of one fence. It covers
ts/tsx/js/jsx, json, bash/sh, and python; any other fence tag, and untagged
fences, render plain. Diff fences map semantically instead of lexically:
added lines `success`, removed lines `error`, hunk headers `dim`. Bash dims
a leading `$ ` prompt. The ink flows through the `MarkdownTheme`
`highlightCode` hook in the chat panel, so the fence lines, indentation, and
width behavior stay pi-tui's, and no module outside `code-ink.ts` composes
code color.

## 7. Build plan

Nine slices. Each is independently shippable, keeps `npm run ci` green, and
lands as one conventional commit. Contract tests are updated to pin the new
look; every changed assertion is replaced, never deleted. Every slice ends
with the two gauntlets: `npx biome check --write <touched files>` and
`npm run typecheck`, then the targeted contract tests, then `npm run ci`.

A render script lives at the reviewer's scratchpad (`render-audit.ts`); each
slice names the section of its output to eyeball.

### Slice 1: token rename, glyph registry, discipline test

Byte-identical rendering; this is the foundation refactor.

- `theme/tokens.ts`: rename `highlight` to `action` (same values, keep the
  scarcity comment, updated to name the rule "orange means Clio is acting");
  delete `loop`, `effortMedium`, `effortHigh`.
- `theme/glyphs.ts`: add `brand: ">C_"`, `cursor: "▸"` (the value is `❯`
  since slice 9), `warnInline: "!"`, `innerDivider: "╌"`, `active: "◆"`,
  `scoped: "◇"`,
  and the phase set `phaseWaiting: "◔"`, `phaseThinking: "◐"`,
  `phaseWriting: "◑"`, `phaseTool: "⚙"`, `phaseBlocked: "⏸"`,
  `phaseRetry: "↻"`, `phaseCompact: "♻"`, `phaseDispatch: "⇲"`. Delete
  `noticeInfo`, `noticeSuccess`, `noticeWarn`, `noticeError`, `thinkOn`,
  `thinkOff` and convert their consumers (`dispatch-board.ts` stale glyph to
  `warnInline`, `model-selector.ts`/`thinking-selector.ts` to
  `active`/`scoped` or `running`).
- Replace glyph literals with GLYPH references in `footer/widgets.ts`
  (phase presentation), `status/verbs.ts` (`⊘ ✓ ✗` in ended labels),
  `overlays/settings.ts`, `view/view-overlay.ts`, `providers-overlay.ts`,
  `overlays/tree-selector.ts`, `overlays/model-selector.ts`,
  `overlays/message-picker.ts`, `overlays/session-selector.ts`,
  `overlays/thinking-selector.ts`, `fleet-overlay.ts` row markers.
- Delete `palette.ts`; `chat-panel.ts` builds its prefixes and rails from
  `clioTheme()` (`fgSequence` composition is fine; the bytes must not
  change).
- New `tests/contracts/theme-discipline.test.ts`: walks
  `src/interactive/**/*.ts` excluding `theme/` and asserts no string literal
  matches an SGR color pattern (`[`/`\x1b[` followed by digits and
  terminated by `m`, or containing `38;2;`, `48;2;`, `38;5;`, `48;5;`) and no
  `#rrggbb` hex color appears. Input-decode literals such as `\x1b[5~` stay
  legal because they do not end in `m`.
- Tests to update: `footer-redesign.test.ts` (`fgSequence("highlight")`
  becomes `fgSequence("action")`), any other `"highlight"` reference in
  tests, imports of `palette.js` if any test uses it.
- Render check: `audit-annotated.txt` before and after diff shows zero
  changes.

### Slice 2: one formatter per quantity

- `renderers/tool-execution.ts`: replace `formatDurationMs` with
  `formatCompactMs`.
- `status/verbs.ts`: `formatStatusElapsed` delegates to `formatCompactMs`
  (public name may stay as a thin wrapper for callers).
- `fleet-overlay.ts`: drop `formatSeconds`/local `formatUsd`, use
  `formatCompactMs` and the shared `formatUsd`.
- `dispatch-board.ts` cards and island rows: token counts through
  `formatFooterTokens`.
- `theme/labels.ts`: `abbreviateModelId` keeps whole parts up to 18 chars.
- Acceptance: `1m36s` never renders as `1m 36s` or `1m36s`-with-zero-pad
  anywhere; dispatch card telemetry reads `↑12k · ↓3k`; welcome and context
  overlay show `claude-sonnet-5` unabbreviated.
- Tests: `dispatch-board.test.ts` (token count strings),
  `status-tool-timer.test.ts` and `footer-redesign.test.ts` (elapsed
  strings), `fleet-overlay.test.ts` (cost format), `welcome-dashboard.test.ts`
  (model label).
- Render check: dispatch cards, task island, tool sublines sections.

### Slice 3: one island frame

- `theme/rules.ts`: `frame(theme, title, lines, width, opts?)` becomes the
  canonical island with bold accent title, correct spacing, optional dim
  right meta, and `╌` inner-divider helper.
- `welcome-dashboard.ts`: use it (drops `framedTopBorder`/
  `framedBottomBorder`); title keeps `GLYPH.brand + Clio Coder + version`;
  hint line truncates with `…`.
- `dispatch-board.ts`: task island and dispatch cards use it (card meta =
  elapsed).
- `follow-up-queue-panel.ts`: uses it; title `Steering Queue` properly
  spaced.
- Acceptance: at width 80 all four surfaces show `┌─ Title ` with one space
  each side of the title, fully frame-colored fills, and aligned right
  corners; the welcome hint line ends in `…` instead of a mid-word cut.
- Tests: `welcome-dashboard.test.ts`, `dispatch-board.test.ts`.
- Render check: welcome, task island, steering queue, dispatch cards.

### Slice 4: transcript and tool ledger polish

- `chat-panel.ts`: agent prefix becomes `GLYPH.agent = "✦"` (update
  `theme/glyphs.ts` value); terminal error text (`[error] ...`,
  `[aborted] ...`, `[stopped: length] ...`) renders in `error` red as its own
  styled segment rather than plain markdown text.
- `renderers/tool-execution.ts`: compose the full subline (including the
  ` (key)` hint) before wrapping so `✓ · 230ms` never splits; suppress
  `\ No newline at end of file` rows in edit diff blocks (filter in
  `renderEditDiffBlock`).
- `chat-renderer.ts` replay lines and `renderers/retry-status.ts`: bracketed
  tag dim (warning for `[retry]`), message muted.
- Acceptance: the width-80 subline
  `▸ reading src/interactive/chat-panel.ts · lines 100-219 of 787 · 23.4KB ✓ · 230ms (ctrl+o)`
  renders on at most two lines with the tail intact; error turns show red
  message text; a replayed `[model]` line shows a dim tag.
- Tests: `chat-panel.test.ts`, `resume-replay.test.ts`,
  `edit-diff-matching.test.ts` if it pins diff output.
- Render check: chat panel sections, tool sublines, edit diff.

### Slice 5: footer pill and compact footer

- `footer/widgets.ts`: `shortToolLabel` truncates without pad; live phases
  show spinner + label (no duplicate static glyph); static glyphs only for
  `idle` and `ended`; glyphs come from the GLYPH phase set; running fleet
  badge stays `action`.
- Acceptance: width-80 tool_running line reads
  `⢿ tool bash · tools 1` with single spaces; thinking reads `⢿ thinking`;
  idle reads `◌ idle · tools none`; dispatching reads `⢿ dispatch · fleet 2`
  in orange.
- Tests: `footer-redesign.test.ts` (phase pill assertions),
  `footer-last-turn.test.ts` unchanged unless strings shift.
- Render check: footer compact per state section.

### Slice 6: expanded dashboard

- `footer/widgets.ts` + `footer/dashboard.ts`: all four quadrant tags bold
  `accentDeep`; autonomy value and any remaining `accentDeep` values become
  `muted`; header uses `GLYPH.brand`; worker lines take
  `dispatchStatusPresentation` (running rows in `action` per section 5).
- Acceptance: at width 120 the four CAPS tags carry identical color; the only
  orange in the idle dashboard is none, and in the dispatching dashboard is
  the pill, the fleet kv, and running/queued worker markers.
- Tests: `footer-redesign.test.ts` quadrant assertions,
  `dispatch-board.test.ts` if worker glyph assertions live there.
- Render check: footer expanded section.

### Slice 7: dispatch cards and task island content

- `dispatch-board.ts`: card body becomes kv rows (`target`, `status`,
  `telemetry`, optional `detail`) with dim keys; `·` separators replace `•`;
  TTFT and cost `muted`; tokens-per-second `muted`; queued rows show no
  throughput and no telemetry rate; island rows drop the bold accent agent
  label in favor of plain bold, status word in status token.
- Acceptance: a failed card shows exactly one red element (`✗ failed`); a
  queued island row shows `◌ reviewer · queued · 3.0s` with no `(N/s)`;
  no `•` remains anywhere under `src/interactive/`.
- Tests: `dispatch-board.test.ts` (separator and label assertions).
- Render check: dispatch cards and task island sections.

### Slice 8: fleet and cost overlays join the system

- `fleet-overlay.ts`: `generated` line dim with `HH:MM:SS`; section headers
  via the list-group recipe (`── running (1)` dim); table header rows dim;
  status-ish cells (`hb`, `phase`, `reason`) tokened (alive/running muted,
  stale warning, failed error); totals as kv rows; row warnings use
  `warnInline` in `warning`; shared `formatUsd`.
- `cost-overlay.ts`: summary and per-model blocks as kv rows with dim keys;
  provider · model line bold accent; divider in `frame`; numbers right-ish
  aligned within their labels.
- Acceptance: no unstyled line remains in either overlay body (every line
  carries at least one token or is intentionally plain content); `$0.4200`
  is gone.
- Tests: `fleet-overlay.test.ts` updated; add cost overlay body assertions
  (new coverage, since none exists).
- Render check: fleet and cost sections.

### Slice 9: selection cursor, editor rail, rule alignment

- `theme/glyphs.ts`: `cursor` value flips to `❯`; consumers from slice 1
  pick it up automatically; `settingsListTheme.cursor` reads from GLYPH.
- `clio-editor.ts`: thinking hint scale per section 6.4 (dim / muted /
  reason / reason bold); drop retired-token references.
- `theme/rules.ts`: left rule label flush (no leading space); notification
  panel and any `rule(...)` headers align flush left.
- Acceptance: every list overlay shows `❯` on the focused row and `▸` only
  on tool lines; the editor rail renders `off` dim and `xhigh` bold purple;
  the notices panel header starts at column 0.
- Tests: `overlay-polish.test.ts`, `view-overlay.test.ts`,
  `settings-center.test.ts`, `tree-selector.test.ts`, `hint-builder.test.ts`
  as pinned strings shift; `footer-redesign.test.ts` for the rule change.
- Render check: overlay frame, notifications, theme primitives sections.

## 8. Non-goals for this pass

- No layout re-architecture: banner/transcript/editor/footer stacking stays.
- No new information: this pass restyles what already renders.
- The wordmark decision is made: `>C_` is the logotype, composed from tokens
  by `brandMark()` in the two headers (section 2). No image logo is planned.
