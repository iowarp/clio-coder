---
title: "Command-line surfaces: transcript renderers"
summary: "How Clio renders transcript rows for tool calls, worker entries, notices, diffs, provider errors and fenced code inside the interactive panel. Read this before changing how any transcript row is drawn or how untrusted text is bounded and redacted before display."
sources:
  - "src/interactive/renderers/tool-execution.ts"
  - "src/interactive/renderers/worker-entry.ts"
  - "src/interactive/renderers/code-ink.ts"
  - "src/interactive/renderers/worker-answer.ts"
  - "src/interactive/renderers/live-tool-view.ts"
  - "src/interactive/renderers/diff.ts"
  - "src/interactive/renderers/provider-error.ts"
  - "src/interactive/renderers/notice.ts"
symbols:
  - "renderNoticeRow"
  - "renderDiffLines"
  - "presentProviderError"
  - "providerErrorEvidence"
  - "LiveToolView"
  - "LiveTextTail"
  - "WorkerAnswerProjection"
  - "codeInk"
  - "shellCommandInk"
  - "toolOutputInk"
  - "renderToolPreview"
tests:
  - "tests/contracts/provider-error-presentation.test.ts"
  - "tests/extended/live-tool-view.test.ts"
invariants:
  - "A provider error shown in the primary transcript row is bounded to at most 600 characters of display text (DISPLAY_LIMIT) and carries an inspection hint; the full sanitized and redacted evidence stays available through the inspection artifact."
  - "Control sequences (CSI, OSC, DCS and their C1 forms) that are cut by the scan boundary are discarded with their payload, not displayed."
  - "A live tool preview redacts a secret whose flag sits on a line above the visible window, because the window is read with a margin of REDACTION_MARGIN_LINES lines."
  - "A notice with a source renders as a titled callout frame; a notice without a source renders as a single gutter-marked row. The choice depends only on whether a source is supplied, not on width."
validate:
  - "pnpm run test:file -- tests/contracts/provider-error-presentation.test.ts"
  - "pnpm run test:file -- tests/extended/live-tool-view.test.ts"
---

# Command-line surfaces: transcript renderers

This directory holds the functions that turn tool calls, worker runs, notices, diffs, provider errors and code blocks into the rows the interactive transcript draws. A reader needs this page when a row looks wrong, when a new kind of transcript row is added, or when untrusted text (provider payloads, command output, streamed tool arguments) must be bounded or redacted before it reaches the terminal. The panel that composes these rows is covered in [interactive/surfaces.md](../interactive/surfaces.md) and the notice source model in [session-control.md](../session-control.md).

## What the area does

Every renderer in this directory is a pure function of its inputs, or a small class that caches rows across frames. Each one returns an array of already-styled, width-bounded strings. None of them performs I/O. The main files and what they own:

- `src/interactive/renderers/tool-execution.ts`: the structured renderer for tool-call segments. It exports `ToolExecutionStart` and `ToolExecutionFinished` (the input shapes), `ToolBodyRenderOptions`, `renderToolAwaitingApproval`, `renderToolArguments`, `renderToolSubline` and `renderToolPreview`. It is the largest file in the directory (about 2,700 lines) and delegates diffs, code highlighting and live output to the three helpers below.
- `src/interactive/renderers/worker-entry.ts`: renders one worker's card in the dispatch view. Its exported entry is `renderWorkerEntryLines`, with `WorkerEntryRenderOptions`, `workerTelemetryDisplay` and `workerNeedsInput`. The answer text it shows is passed through `src/interactive/renderers/worker-answer.ts`.
- `src/interactive/renderers/worker-answer.ts`: sanitizes and redacts a worker's answer text. It exports `safeWorkerAnswerText`, `liveWorkerAnswerText` and the stateful `WorkerAnswerProjection` class.
- `src/interactive/renderers/live-tool-view.ts`: the incremental view of a call still in flight. It exports `LiveToolView` (per-call state) and `LiveTextTail` (an indexed, growing text), plus `LiveRowsOptions` and `LiveOutputOptions`.
- `src/interactive/renderers/code-ink.ts`: syntax coloring for fenced code. It exports `codeInk`, `codeInkLexer`, `codeInkLangForPath`, `shellCommandInk` and `toolOutputInk`.
- `src/interactive/renderers/diff.ts`: word-level diff rows. It exports `renderDiffLines` and `DiffRenderOptions`.
- `src/interactive/renderers/provider-error.ts`: the bounded primary projection of a provider error (`presentProviderError`) and the sanitized full evidence (`providerErrorEvidence`).
- `src/interactive/renderers/notice.ts`: one notice row or callout. It exports `renderNoticeRow` and the `NoticeMark` type.

## Notices

`renderNoticeRow(text, mark, width, source?)` in `src/interactive/renderers/notice.ts` has two shapes, selected by the presence of `source`:

1. With no `source`, the function sanitizes the text through `sanitizeCallTargetText`, drops a leading `[Clio Coder]` product tag, and draws a single row. The row's first line starts with the glyph for the `NoticeMark` (`info`, `success`, `warning`, `error`, `retry`, `cancelled`). A leading bracketed subsystem tag such as `[model]` is styled dim. Wrapped continuation rows are indented by two spaces.
2. With a `source` of type `NoticeSource`, it calls `renderCallout`. That function looks up a title and a body transform in the `CALLOUTS` table (`tip`, `reminder`, `memory`, `watchdog`, `images`, `approval`, `budget`, `safety`, `fleet`, `hooks`) and draws a titled frame, using `frame` from the theme module, indented by `CALLOUT_GUTTER`. Its width is capped at `CALLOUT_MAX_WIDTH`.

Callers pass a source for advisories. In `src/interactive/chat-renderer.ts`, a notice entry with `notice.source` is passed through, and reminders pass `source` as well. Entries such as `[model]`, `[thinking]` and `[handoff]` pass no source and render as plain rows. `src/interactive/command-output.ts` also passes a source for command output. Empty text returns no rows.

The notice module's comments state that the source, not width, selects the callout form. The code agrees: `renderNoticeRow` branches only on `source !== undefined`.

## Provider errors

`presentProviderError(value)` in `src/interactive/renderers/provider-error.ts` builds the primary row. It is called from `src/interactive/renderers/retry-status.ts` (for the diagnosis line of a retry) and from the chat panel. The steps, as read from the file:

1. `providerErrorEvidence(value, SCAN_LIMIT)` runs first. `SCAN_LIMIT` is 8192. The function removes terminal control sequences with `terminalSafePrefix`, redacts streaming secrets with `redactStreamingSecretString` (the `completed` flag is set when the scan covers the whole value), redacts `Bearer` and `Basic` tokens to `[redacted]`, applies `redactSecretsText`, and replaces remaining control and format characters with spaces. Newlines and tabs are kept.
2. If the value is longer than `SCAN_LIMIT`, a route-advice suffix is matched on the last `ROUTE_ADVICE_TAIL` (1024) characters. Otherwise it is matched in the scanned sample. The matched LiteLLM route sentence is kept and moved to the front of the summary.
3. If the sample looks like HTML, the summary is the text before the first `<`, the `<title>`, and a fixed sentence about the gateway endpoint (omitted when route advice is present). If the sample contains a JSON object, quoted `message`, `detail`, `type` and `code` string fields are decoded with `JSON.parse` on the quoted fragment and joined with `; `.
4. An HTTP status code (`HTTP 503`, `status: 429` and similar) is prefixed as `HTTP <status>; ` when the summary does not already contain it.
5. The result is truncated to `DISPLAY_LIMIT` (600) characters. When it was shortened, or the value exceeded `SCAN_LIMIT`, the text ends with ` ... [available diagnostic: /view transcript]`.

`providerErrorEvidence` is the same sanitization without the summarizing step. It is used for the full inspection artifact and for unbounded views in `src/interactive/renderers/retry-status.ts`.

The test `tests/contracts/provider-error-presentation.test.ts` exercises this with concrete inputs. One case passes a raw 503 JSON body containing `"api_key":"fixture-secret-value"` and a 10,000-word `payload` field followed by `END-EVIDENCE`. It asserts that the rendered panel contains `HTTP 503` and `Model unavailable`, that the rendered length is under 1500, that `fixture-secret-value` and `END-EVIDENCE` are absent from the primary render, and that the inspection artifact titled "Provider or terminal error" still contains `END-EVIDENCE` but not the secret. Another case in the same file feeds `"HTTP 503 " + OSC/CSI sequence of about 9000 characters + "AFTER_CONTROL"` in five encodings and asserts that `providerErrorEvidence` returns exactly `"HTTP 503 AFTER_CONTROL"`. A third case feeds unterminated fragments (`\u001b]0;HIDDEN`, `\u001b[123;`, `\u001b`) and asserts that each yields `"HTTP 503 "`. A fourth feeds 5 MB of `x`, unterminated JSON repeated 100,000 times, and 100,000 newline lines, and asserts each result is under 700 characters and contains `available diagnostic`.

Other test files import this module (`tests/contracts/provider-transport.test.ts`), but the grep for its exported names found only the presentation test file as a direct import in the test tree for `presentProviderError`.

## Live tool views

`LiveToolView` in `src/interactive/renderers/live-tool-view.ts` is created per call by the transcript segment. Its `tail(field, path)` method returns a `LiveTextTail` for each streamed field (for example a write's `content`). The tail's language is derived from the file extension through `codeInkLangForPath`. `outputRows` caches the newest rows of a running command's output.

`LiveTextTail.update(next)` assumes the text only grows. If the new text does not start with the previous text, or is shorter, the index is reset and rebuilt from the start. Each completed line gets a `carries` entry from the code-ink lexer so that a multi-line comment or string keeps its highlighting across lines. `rows(rows, width, options)` paints only the newest window. Completed lines are cached in `painted`, keyed by line index and a style key that includes `skinEpoch()`, width, sign and rail width. Redaction for a window is applied to the window plus `REDACTION_MARGIN_LINES` (3) lines above it, through `safeWindow` (`redactSecretString` followed by `sanitizeMultilineDisplayText`). The margin is dropped after redaction.

For a command's output, `liveOutputRows` scans backward from the end of the text, not forward, so it never splits the rest. When the tool has already truncated the output (`truncatedTotal` is set), the row above the window states the size of everything printed.

The test file `tests/extended/live-tool-view.test.ts` checks these behaviors with concrete inputs:

- A 300-line write streamed in steps of 97 characters renders the same rows whether they come from the `LiveToolView` cache or from a cold `renderToolPreview` call, at widths 75 and 120 and styles `standard` and `detailed`. Once the window is full, the height stays constant.
- With 300 lines and the `standard` style, the second row reads `  │ … 295 lines above` and the last row is `export const value299 = 299; /* note 299 */`. The total is seven rows. The `compact` style produces only the header row.
- A secret whose `--token` flag is on the line above the visible window renders as `[redacted]`, and neither `hunter2` nor `--token` appears in the output.
- A bash command whose tail is kept with `resultSize.bytes` of 2,500,000 and `truncated: true` shows `… earlier output above · 2.4MB so far` above the newest line `ok 49`.

## Diffs

`renderDiffLines(diffText, width, options)` in `src/interactive/renderers/diff.ts` takes Clio's numbered diff text. It parses each line with `parseDiffLine`, pairs a single removed line with a single added line to add word-level inverse highlighting through `renderIntraLineDiff`, and then wraps each row to `width`. A wrapped continuation keeps the gutter width as a hanging indent, unless the content column would drop below `MIN_HANGING_CONTENT`. Tabs are replaced by `replaceTabs`. `color: false` in the options removes the SGR styling.

The call site is in `src/interactive/renderers/tool-execution.ts` (around the `renderDiffLines(diff, bodyWidth, { color })` call), where the diff is prefixed with the normal rail. The file header of `src/interactive/renderers/diff.ts` says it is adapted from another project's diff component. No test in the repository directly imports `renderDiffLines`; the search covered `tests/` and found no match. Diff rendering is therefore described here from source only.

## Code highlighting

`codeInk(lang, lines)` in `src/interactive/renderers/code-ink.ts` highlights fenced code. `resolveSpec` maps a language tag to a `LangSpec` (TypeScript, Python, bash, JSON), or to `"diff"`, or to `null`. Unknown tags return the lines unpainted. `scanLine` produces spans for comments, strings, keywords and numbers, and carries state (`Carry`) across lines for block comments, template literals and triple-quoted strings. `codeInkLexer` exposes the same scanner incrementally to `LiveTextTail`.

`shellCommandInk(command)` highlights a shell command and paints an embedded Python snippet (inside `python -c` style quoting) with the Python spec. `toolOutputInk(text)` highlights tool output, coloring fenced blocks with their language and other lines with the `toolMetadata` token. These are used in `src/interactive/renderers/tool-execution.ts` for the command header and the result body.

## Worker entries and answers

`renderWorkerEntryLines` in `src/interactive/renderers/worker-entry.ts` renders a worker card. It reads telemetry through `workerTelemetryDisplay` and uses a bounded text cache (`workerTextCache`) for answer text. Answer text goes through `src/interactive/renderers/worker-answer.ts`: `safeWorkerAnswerText` and `liveWorkerAnswerText` both run `sanitizeAssistantProse`, convert the C1 control characters 0x9b, 0x9c and 0x9d to their ESC forms, sanitize multiline display text, and then redact streaming secrets. `liveWorkerAnswerText` holds back unresolved URL userinfo unless the stream has `completed`. `WorkerAnswerProjection` keeps the parser state across appended deltas, so a repeated call with the same source and completion flag returns its cached result.

`src/interactive/renderers/worker-entry.ts` imports `src/interactive/renderers/worker-answer.ts` and the `preview.ts` helpers. The worker-entry tests are in `tests/contracts/completed-worker-presentation.test.ts`, `tests/extended/worker-checkpoint.test.ts` and `tests/extended/rendering-invariants.test.ts` per the import index. This page does not open those files, so their assertions are not described here.

## Tool-call rows

`src/interactive/renderers/tool-execution.ts` is the single renderer for tool-call segments. It accepts `ToolExecutionStart` and `ToolExecutionFinished` and unwraps gateway `op=call` rows through `presentedCall`, so the row shows the capability that ran, marked as going through the gateway. A chain, find or describe call remains a gateway row (`isChainCall`). Body rendering is bounded by `resultRowLimit` and `resultCharLimit`, which both become unlimited when `ToolBodyRenderOptions.unbounded` is set (the export path). The `presentedCall` and rail helpers are the points where a change in tool-row shape would be made. This page does not read `renderToolPreview`'s body in detail, so the rest of that file is described only at the level of its exported names.

## Things to watch when editing

- `LiveTextTail.update` relies on the text being an extension of the previous text. A non-prefix change resets the whole index. Changing how a field is streamed (for example, rewriting an earlier line) causes a full re-index on every frame.
- Redaction of a live window depends on `REDACTION_MARGIN_LINES`. Reducing it below the distance a secret's flag can sit from its value would expose the value. The test above covers a flag one line above the window only.
- `presentProviderError` depends on `SCAN_LIMIT` and the 1024-character `ROUTE_ADVICE_TAIL`. The route advice is matched on the tail for values over `SCAN_LIMIT`. Changing either constant changes when the route sentence is found.
- `renderNoticeRow` chooses its form only from the `source` argument. A caller that omits `source` gets a gutter row even for an advisory. The callers listed above pass the source explicitly.
- Changing the mark glyph table `MARKS` or the `CALLOUTS` titles changes every notice of that kind in the transcript. The tests in `tests/contracts/provider-error-presentation.test.ts` assert the retry glyph `↻` and the phrase `provider retry exhausted`, so a change to the retry mark or wording will fail that file.
- `src/interactive/renderers/diff.ts` and `src/interactive/renderers/notice.ts` are not covered by a test that imports them directly. A change to those files should be checked by running the wider interactive tests named in the frontmatter's `validate` list, and by a manual review of the rendered rows.
