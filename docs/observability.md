# Observability Viewer

`/view` is the interactive artifact viewer for a Clio session. It keeps the live transcript compact while preserving a full inspection path for durable artifacts.

```text
/view
/view <id-or-filter>
/view verify <runId>
```

`/view` opens a full-screen split viewer. The left pane groups artifacts by category and supports type-to-filter. The right pane renders the selected artifact with pager controls. `Tab` switches panes. `v` verifies a selected receipt. `o` shows the absolute backing path through the notice channel so the file can be opened outside the TUI.

## Artifact Categories

| Category | Source | Backing path |
| --- | --- | --- |
| Receipts | Dispatch ledger entries with completed receipt files | `<dataDir>/receipts/<runId>.json` |
| Dispatch outputs | Dispatch ledger rows plus matching session dispatch tool results when present | `<dataDir>/state/runs.json`, receipt path, or the current session transcript |
| Tool outputs | Current-session durable output references, including `bashExecution.fullOutputPath` and tool-result detail paths such as `outputPath` | The referenced absolute path |
| Compaction summaries | Current-session `compactionSummary` entries | `<dataDir>/sessions/<cwdHash>/<sessionId>/current.jsonl` |

Receipts and dispatch rows are global ledger artifacts so historical runs remain inspectable. Tool output and compaction categories are session-local because they are stored inside the active session transcript or referenced from it.

## Rendering

Receipt JSON is pretty-printed before rendering. Plain text is rendered without stripping ANSI sequences. Markdown summaries render through the shared TUI Markdown component. Large file-backed artifacts are read incrementally and capped at the first 50,000 lines with a footer that points to the original path.

The dispatch domain does not currently persist a separate worker terminal log. `/view` therefore renders the durable ledger and receipt metadata, then adds the matching dispatch tool result from the active session when that result is present.

The generic tool result shaper in this branch truncates oversized tool results in memory. It does not write a generic offload directory. `/view` supports the durable output paths that do exist, especially `bashExecution.fullOutputPath` and tool-result detail paths written by tools that create files.

## Verification

`/view verify <runId>` and `v` on a receipt both run the same read-only verification path:

1. Read `<dataDir>/receipts/<runId>.json`.
2. Validate the required receipt fields and basic value ranges.
3. Read `<dataDir>/state/runs.json` and find the matching run envelope.
4. Recompute receipt integrity with the dispatch receipt integrity helper.

Verification never mutates the receipt, ledger, or session transcript. It reports one success or failure notice in headless mode, and paints the result into the viewer header in interactive mode.

## Minimal Transcript

Clio keeps routine transcript output short so the active conversation stays readable and inexpensive to replay. `/view` is the detailed inspection surface: receipts, worker outputs, file-backed tool output, and compaction summaries remain available on demand without forcing every byte into the main chat panel.
