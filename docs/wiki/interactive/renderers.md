---
title: "Interactive renderers"
summary: "Pure functions that transform session data, tool results, and worker answers into terminal-styled text rows for the Clio TUI."
sources:
  - "src/interactive/renderers/tool-execution.ts"
  - "src/interactive/renderers/worker-entry.ts"
  - "src/interactive/renderers/worker-answer.ts"
  - "src/interactive/renderers/code-ink.ts"
  - "src/interactive/renderers/diff.ts"
  - "src/interactive/renderers/structured.ts"
  - "src/interactive/renderers/compaction-summary.ts"
  - "src/interactive/renderers/provider-error.ts"
  - "src/interactive/renderers/notice.ts"
  - "src/interactive/renderers/skill-rows.ts"
  - "src/interactive/renderers/branch-summary.ts"
  - "src/interactive/renderers/doctor-report.ts"
  - "src/interactive/renderers/mermaid.ts"
  - "src/interactive/renderers/reference-card.ts"
  - "src/interactive/renderers/retry-status.ts"
  - "src/interactive/renderers/preview.ts"
symbols:
  - "renderToolExecution"
  - "renderToolSubline"
  - "renderToolPreview"
  - "renderToolArguments"
  - "renderWorkerEntryLines"
  - "presentWorkerContractAnswer"
  - "codeInk"
  - "renderDiffLines"
  - "tryRenderJson"
  - "tryRenderXml"
  - "renderCompactionSummaryEntry"
  - "presentProviderError"
  - "renderNoticeRow"
  - "renderSkillSurfaceRow"
  - "renderBranchSummaryEntry"
  - "renderDoctorReport"
  - "createMermaidMarkdownTransform"
  - "renderReferenceCard"
  - "formatRetryStatus"
  - "previewRows"
  - "previewBudget"
tests:
  - "tests/contracts/provider-error-presentation.test.ts"
  - "tests/contracts/worker-card-mutation-report.test.ts"
  - "tests/contracts/completed-worker-presentation.test.ts"
  - "tests/contracts/fleet-island-activity.test.ts"
  - "tests/contracts/tui-workbench-ergonomics.test.ts"
  - "tests/extended/rendering-invariants.test.ts"
invariants:
  - "Every renderer is a pure function: no I/O, no console writes, no module-level mutable state beyond the shared theme handle."
  - "codeInk only colors four tokens (comment, string, keyword, number) and never post-processes the result; unrecognized fence tags return plain text."
  - "Worker contract answers are admitted only when the receipt's integrity check passes and the contract kind matches one of the five recognized result envelopes."
  - "The transcript renders a two-cell gutter plus a content column; action rows hang their continuation in the content column so a long dispatch never wraps to column 0."
validate:
  - "pnpm test"
---

# Interactive renderers

## What this area does

The `src/interactive/renderers/` directory holds pure functions that transform structured session data into styled terminal rows for the Clio TUI. Each module covers one content kind: tool execution segments, worker run cards, fenced code highlighting, edit diffs, structured JSON/XML output, compaction and branch summaries, provider error presentation, transcript notices, skill surface rows, doctor reports, retry statuses, and reference cards. All renderers return `string[]` (one array element per terminal row) and carry no I/O, no console writes, and no mutable state beyond the module-level `clioTheme()` handle.

The primary consumer is the `ChatPanel` (`src/interactive/chat-panel.ts`), which composes these renderers into the live transcript. The replay path (`src/interactive/chat-renderer.ts`) reuses the same renderers so a saved session renders identically to a live one. The `DispatchBoard` (`src/interactive/dispatch-board.ts`) also calls `presentWorkerContractAnswer` for worker contract summaries.

## Ownership map

Each file owns one rendering concern:

| File | Key exports | Input | Output |
|---|---|---|---|
| `tool-execution.ts` | `renderToolExecution`, `renderToolSubline`, `renderToolPreview`, `renderToolArguments`, `renderToolAwaitingApproval`, `renderToolResultOnly`, `renderBashTranscriptExecution`, `hasToolBody`, `renderFoldedGroup`, `toolFoldFamily`, `toolRowTitle` | `ToolExecutionStart` / `ToolExecutionFinished` / `BashTranscriptExecution` | `string[]` rows |
| `worker-entry.ts` | `renderWorkerEntryLines` | `WorkerEntryState` | `string[]` rows |
| `worker-answer.ts` | `presentWorkerContractAnswer`, `safeWorkerAnswerText`, `exactWorkerAnswerObject` | `text`, `contract`, `complete`, `settled` | `PresentedContractAnswer \| null` |
| `code-ink.ts` | `codeInk` | `lang`, `lines` | `string[]` |
| `diff.ts` | `renderDiffLines`, `parseDiffLine`, `styleLine`, `renderIntraLineDiff` | `diffText`, `width`, `options` | `string[]` |
| `structured.ts` | `tryRenderJson`, `tryRenderXml` | `value`, `width`, `options` | `string[] \| null` |
| `compaction-summary.ts` | `renderCompactionSummaryEntry`, `renderCompactionSummaryLine`, `renderCompactionSummaryHeader`, `renderEvictionSkipLine` | `CompactionSummaryEntry` / line inputs | `string[]` / `string` |
| `provider-error.ts` | `presentProviderError`, `providerErrorEvidence`, `terminalSafePrefix` | `value` (error text) | `string` |
| `notice.ts` | `renderNoticeRow` | `text`, `mark`, `width` | `string[]` |
| `skill-rows.ts` | `renderSkillSurfaceRow`, `renderSkillSuggestionRow` | `SkillSurfaceChange` / `line` | `string[]` |
| `branch-summary.ts` | `renderBranchSummaryEntry`, `renderBranchSummaryHeader` | `BranchSummaryEntry`, `width` | `string[]` |
| `doctor-report.ts` | `renderDoctorReport` | `findings`, `width` | `string[]` |
| `mermaid.ts` | `createMermaidMarkdownTransform` | `theme` | `(markdown, width) => string` |
| `reference-card.ts` | `renderReferenceCard` | `card`, `width` | `string[]` |
| `retry-status.ts` | `formatRetryStatus`, `renderRetryStatus` | `status`, `width`, `detail`, `unbounded` | `string` / `string[]` |
| `preview.ts` | `previewRows`, `previewBudget` | `rows`, `limit`, `width`, `terminalRows` | `string[]` / `number` |

## Data flow: tool execution

The `ChatPanel` calls `renderToolExecution` (full render) and `renderToolPreview` (bounded preview) for tool segments. The flow through `renderToolExecution`:

1. **Header line**: `sublineParts` resolves the row via `resolveToolRow` (from `src/tools/presentation.ts`), which classifies the tool by name and admission action class. The header carries the class mark, verb, object, scope, inline scalar args, and resource label.
2. **Operator grant**: `operatorGrantRows` renders a dim `allowed by you · <axis>` row when the call was preceded by an operator approval (BT-003).
3. **Mutation diff**: For `mutate` class tools with a successful result, `renderMutationDiffBlock` calls `renderDiffLines` (`src/interactive/renderers/diff.ts`) to parse the diff text into numbered added/removed rows, optionally with intra-line diff highlighting.
4. **Bash echo**: For `execute` class tools with a `command` arg, `renderBashResultBlock` emits a `$ <cmd>` line with syntax highlighting via `highlightBashCommand`, then the unwrapped output.
5. **Result block**: `renderResultBlock` calls `unwrapResultEnvelope` (which handles the `{ content: [...] }` envelope from pi-agent-core), then `renderStructuredOutputRows` (which tries `tryRenderJson` and `tryRenderXml`) or falls back to `renderOutputRows`.
6. **Output footer**: `renderOutputFooter` states the offload path and follow-up hint.

The `renderToolPreview` variant budgets rows via `previewBudget` (from `src/interactive/renderers/preview.ts`), which caps the number of visible rows based on the `TranscriptDetailPolicy` and terminal height. Failed calls use the `errorRows` budget; bash uses `bashRows` or `operatorBashRows`.

**Wrapper vs. direct**: `renderToolResultOnly` is a wrapper that delegates to `renderToolPreview` when `opts.unbounded` is false and `opts.detail` is set. `renderBashTranscriptExecution` constructs a synthetic `ToolExecutionFinished` from a `BashTranscriptExecution` and delegates to either `renderToolExecution` or `renderToolPreview` depending on the `unbounded` flag.

## Data flow: worker answers

The `renderWorkerEntryLines` function in `worker-entry.ts` renders a worker run card from `WorkerEntryState`. When the worker has settled and carries a receipt, it calls `presentWorkerContractAnswer` (`worker-answer.ts`) to attempt a structured presentation:

1. **Gate**: The answer is admitted only when `settled` is true, `complete` is true, and `contract?.conformance === "pass"`.
2. **Parse**: `exactWorkerAnswerObject` extracts the JSON object from the text (optionally stripping one code fence).
3. **Validate**: For `scout-report`, every numeric token in the text must round-trip as a safe integer, preventing loss of precision in line numbers or large IDs.
4. **Dispatch**: A switch on `contract.kind` calls one of five report functions (`debuggerReport`, `verifierReport`, `researchReport`, `worldKnowledgeReport`, `scoutReport`).
5. **Sanitize**: Every line passes through `safeWorkerAnswerText`, which normalizes C1 control characters to their CSI/OSC equivalents, then redacts secrets and strips C0/Cf characters.

The `ChatPanel` also calls `presentWorkerContractAnswer` directly (via `dispatch-board.ts`) for the Fleet Runs board's contract summary.

## Data flow: code ink

`codeInk` (`src/interactive/renderers/code-ink.ts`) is wired into the markdown theme as the `highlightCode` hook. The `ChatPanel` composes:

```ts
const CHAT_MARKDOWN_THEME = markdownTheme(clioTheme(), (code, lang) => codeInk(lang, code.split("\n")));
```

`codeInk` resolves the fence tag to a `LangSpec` (TypeScript, JSON, Bash, Python, or Diff). For each line it runs a small scanner (`scanLine`) that identifies comments, strings, keywords, and numbers. The scanner carries state across lines for constructs that legally span lines: block comments, template literals, and triple-quoted strings. The mapping is closed to extension: comments map to `dim`, strings to `success`, keywords to `reason`, and numbers to `info`. Every other character stays plain.

## Extension seams

**New tool class or verb**: Add an entry to the tool registry in `src/tools/presentation.ts` (the `resolveToolRow` function). The renderers in `tool-execution.ts` read from `row.spec.class`, `row.spec.verbs`, and `row.spec.object`, so a new class is automatically picked up.

**New worker contract kind**: Add a case to the switch in `presentWorkerContractAnswer` (`worker-answer.ts`) and a corresponding report function that returns `PresentedContractAnswer | null`. The `WorkerPresentedResultContract` type in `worker-stream.ts` must also include the new kind.

**New notice mark**: Add a row to the `MARKS` record in `notice.ts` and import the glyph from `GLYPH`.

**New code-ink language**: Add a `LangSpec` constant and a case to `resolveSpec`. The spec controls line comments, block comments, templates, triples, quotes, and keywords.

**New fold family**: Add a case to `toolFoldFamily` (`tool-execution.ts`) and a corresponding verb in `renderFoldedGroup`.

## Enforced boundaries and lifecycle

### Purity

Every renderer is pure: no I/O, no console writes, no module-level mutable state beyond the shared `clioTheme()` handle. The `ChatPanel` owns the live loop; the renderers are called with data and return rows. This is asserted in the module docblocks and verified by the contract tests, which construct synthetic entries and assert on the rendered output without a running panel.

### Worker answer admission

The `presentWorkerContractAnswer` gate in `worker-answer.ts` enforces that a contract summary is shown only when the receipt's integrity check passes and the contract conformance is `"pass"`. The test `tests/contracts/completed-worker-presentation.test.ts` verifies that a `tampered` receipt (modified after sealing), a `missing-ledger` receipt, and a `retired` receipt all produce the raw output with a note that the seal is broken or unavailable, never the structured summary. The `worker-card-mutation-report.test.ts` test (BT-011) verifies that a mutation report that outgrew the live tail settles into prose, not raw JSON.

### Code-ink closed mapping

The `codeInk` module explicitly states: "The mapping is closed to extension. When the lexer is unsure it leaves text plain: under-highlighting is correct behavior, mis-highlighting is a defect." The `INK_TOKEN` record maps exactly four `InkKind` values to theme tokens, and no other path writes code color.

### Transcript gutter discipline

The transcript uses a two-cell gutter plus a content column. Action rows use the `▸` glyph in the gutter; their body nests under the rail (`  │ `). The `wrapHanging` function in `tool-execution.ts` ensures that a wrapped action row's continuation starts in the content column (indented two cells), never at column 0. The `renderFoldedGroup` function for Compact style folds runs the same discipline: the fold header row hangs, and the nested targets use `indentAndWrap` with the rail prefix.

### Provider error bounds

`presentProviderError` in `provider-error.ts` scans the error text for a terminal-safe prefix (up to `SCAN_LIMIT` characters), then applies a display limit (`DISPLAY_LIMIT`). The test `tests/contracts/provider-error-presentation.test.ts` verifies that huge malformed inputs (5 MB of `x` characters, 100,000 unterminated JSON objects) produce output under 700 characters with the `available diagnostic` marker. OSC and CSI sequences spanning the scan boundary are neutralized: the test `OSC and CSI spanning the scan boundary cannot expose payloads` verifies that a 9000-character OSC payload followed by `AFTER_CONTROL` yields only `HTTP 503 AFTER_CONTROL` in the primary projection, while the full evidence (via `providerErrorEvidence`) retains the tail.

## Focused tests

### `tests/contracts/provider-error-presentation.test.ts`

- **Production panel bounds a provider failure while View and export retain redacted evidence**: Constructs a chat panel, applies a 503 error with a 10,000-character payload, and asserts the rendered output is under 1,500 characters, does not contain the fixture secret or the evidence tail, and that the inspection artifact retains the evidence tail but not the secret.
- **Retry countdown replaces its row and preserves a visible final failure**: Applies four retry phases (`scheduled`, `waiting`, `retrying`, `exhausted`) and asserts one `↻` mark, no `[retry]` tag, and the exhausted message.
- **OSC and CSI spanning the scan boundary**: Verifies that five different OSC/CSI payloads (each 9,000 characters) are fully neutralized in both the primary and full evidence projections.
- **43-column primary failures and retries obey style row budgets**: For each style (`compact`, `standard`, `detailed`), asserts that the rendered rows at 43 columns stay within the style's budget (12 for detailed, 4 for others).

### `tests/contracts/worker-card-mutation-report.test.ts`

- **BT-011: A mutation report that outgrew the live tail settles into prose**: Constructs a ~5 KB mutation report, streams it through a worker stream (which cuts the live tail), then settles it. Asserts that `renderWorkerEntryLines` produces prose (`changed lib/math.js, test/math.test.js`) not raw JSON, and that the sealed answer lost no bytes.

### `tests/contracts/completed-worker-presentation.test.ts`

- **Recognized settled debugger reports share diagnosis and reproduction truth at narrow widths**: For widths 43, 80, and 120, asserts that both the transcript and the fleet board show the diagnosis and reproduction status, and that the raw JSON keys are not leaked.
- **Live, failed-contract, partial, malformed and unknown answers never acquire a contract summary**: Verifies that a `pending` worker, a `fail` contract, a truncated worker, a malformed JSON, and an unknown contract kind all produce raw output, never the structured summary.
- **Scout escaped and literal keys preserve unsafe numeric tokens**: Tests that escaped Unicode keys (`"\u006cine"`, `"li\u006ee"`) and tokens that cannot round-trip as safe integers (`1.00000000000000001`, `9007199254740993`, `1e400`, `-0`, `123456789012345678901234567890`) are preserved as source text, not coerced.

### `tests/contracts/fleet-island-activity.test.ts`

- **BT-007: The island and the card name the same activity**: For each progress phase (`starting`, `thinking`, `writing`, `tool`), asserts that the `formatTaskIslandLines` output and the `renderWorkerEntryLines` output both contain the phase word and neither says `· running ·`.

### `tests/contracts/tui-workbench-ergonomics.test.ts`

- **Worker preview favors current work and preserves pending input**: At widths 40, 44, 60, 92, and 120, asserts that `renderWorkerEntryLines` keeps the current action visible and preserves a `needs_input` checkpoint question.

### `tests/extended/rendering-invariants.test.ts`

- **Keeps reasoning, prose, and tools in stream order**: Asserts that the rendered output respects the event order: reasoning → prose → tool → reasoning → prose.
- **States a skill suggestion as a § row**: Asserts that `Suggested skill: /skill tdd` in the model's prose is rendered as a `§` row with the command in accent color, not as the agent's prose.
- **Changes the preset while a tool remains live**: Switches from `detailed` to `compact` mid-stream and asserts that the reasoning is folded to a marker while the tool command remains visible.
- **Marks every operator prompt row with the bar**: Asserts that pending prompts show `· preparing` and committed prompts are bold.

## Things to watch when editing

**Do not add module-level mutable state**: The purity contract is load-bearing. The `ChatPanel` and `ChatRenderer` assume that calling a renderer twice with the same arguments produces identical output. A mutable module variable would break the replay path and the test harness.

**Do not post-process `codeInk` output**: The `codeInk` function is the only module that composes code color. The `ChatPanel` wires it through the markdown theme's `highlightCode` hook. Adding a second pass that re-colors the result would double-apply ANSI sequences and break the `CHAT_MARKDOWN_THEME` invariant.

**Do not add a sixth `InkKind`**: The mapping is closed. If a new syntax category is needed, the correct approach is to map it to one of the existing four tokens (e.g., map function names to `keyword`) rather than adding a new token and color.

**Do not change the wrap discipline without updating `hasToolBody`**: The `hasToolBody` function in `tool-execution.ts` checks whether any row starts with `RAIL_DIM` or `RAIL_ERROR`. The `ChatPanel` uses it to decide whether to insert a blank line around a tool block. A change to the rail prefix (e.g., from `  │ ` to something else) must update `hasToolBody` in the same change.

**Do not weaken the `presentWorkerContractAnswer` gate**: The three-part gate (`settled && complete && contract.conformance === "pass"`) is the only thing preventing a live or partially-sealed worker from acquiring a structured summary. The `worker-card-mutation-report.test.ts` (BT-011) regression exists because a stale `droppedBytes` count caused a settled answer to be misclassified as truncated.

**Do not change the `MODEL_NOTE_LINE` regex without updating `splitModelNotes`**: The regex `/^\[middleware:[a-z-]+\] (.+)$/u` matches the tag format that the middleware domain writes. If the middleware changes its tag format, both the regex and the `splitModelNotes` function must change together, and the test in `rendering-invariants.test.ts` (`states guidance middleware attached for the model as one note`) must pass.

**Do not alter `BLOCK_REASON_LIMIT` or `INLINE_ARG_LIMIT` without checking the `statusGlyph` and `sublineParts` composition**: These limits control how much text rides on the status tail and the inline scalar args. The `wrapSublineWithTail` function assumes the tail is atomic (it wraps the lead and places the tail as a single unit). A longer limit would increase the probability of the tail not fitting beside the lead, causing it to fall to its own row.

**Do not remove the `terminalSafePrefix` scan from `providerErrorEvidence`**: The `SCAN_LIMIT` constant (200) bounds the scan for the terminal-safe prefix. The `providerErrorEvidence` function is called by the inspection artifact loader, which must retain the full safe evidence for the `/view` overlay. Removing the scan would let a 5 MB error text flood the artifact.
