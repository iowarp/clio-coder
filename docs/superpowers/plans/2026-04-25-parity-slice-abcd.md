# Pi-Coding-Agent Parity — Slice A/B/C/D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land four atomic, user-visible parity slices against pi-coding-agent (tool-execution renderer, edit-tool diff renderer, CLAUDE.md context-files + `--no-context-files` flag, Esc-cancel for `web_fetch`) plus a doc-only ledger refresh.

**Architecture:**
- Each slice is one atomic commit. No mixing, no opportunistic refactors.
- Reuse existing infrastructure: `src/interactive/renderers/` directory and pattern set by `branch-summary.ts` and `compaction-summary.ts`; `ToolSpec.run(args, options?)` signal contract already established by `bash.ts`; `loadProjectContextFiles` and `parseFlags` already extant.
- Engine boundary stays intact (rule 1: only `src/engine/**` value-imports `pi-*`). Renderers live in `src/interactive/renderers/` and consume types from `chat-loop.ts` / `entries.ts`, not pi-* directly.

**Tech stack:**
- TypeScript (strict, NodeNext, `.js` import extensions)
- Test framework: `node:test` + `node:assert/strict`
- Existing libs: `pi-tui` (already re-exported via `src/engine/tui.ts`), `typebox`, `chalk`
- New dep for slice B: `diff` (`^8.0.2`, listed in port spine §5.1)

**Reference baseline (post-commit `66ae936`):**
- Live tool rendering today: `src/interactive/chat-panel.ts:370-394` handles `tool_execution_start` and `tool_execution_end` events with ad-hoc inline strings.
- Replay path: `src/interactive/chat-renderer.ts:rehydrateChatPanelFromTurns` re-issues those same events into `chatPanel.applyEvent(...)`.
- Bash signal wiring is already complete (`src/tools/bash.ts:36-37,97-101,122,130`); web-fetch ignores `options.signal` entirely (`src/tools/web-fetch.ts:run` does not accept `options`).
- Context-file loader: `src/domains/prompts/context-files.ts:DEFAULT_CONTEXT_FILE_NAMES = ["AGENTS.md", "CODEX.md"]`. Consumed in `src/domains/prompts/extension.ts:51` via `loadProjectContextFiles({ cwd })`.
- Flag parser: `src/cli/shared.ts:parseFlags` plus `extractApiKeyFlag`. Orchestrator boot: `src/entry/orchestrator.ts:bootOrchestrator(options)`. CLI run path: `src/cli/run.ts:runClioRun(args, options)`.

---

## Slice A — Tool-execution renderer

**Why now:** Every tool call in every session paints through this surface. pi-coding-agent shows a structured block with tool name + arg summary + result preview; Clio shows raw inline strings. Largest user-visible delta per LOC, and the renderer module establishes the shape that slices B (diff) and the rest of Phase 19 (bash-execution, custom-message) compose with.

### Task A1: Pure tool-execution renderer module

**Files:**
- Create: `src/interactive/renderers/tool-execution.ts`
- Test: `tests/unit/renderers-tool-execution.test.ts`

**Contract (export from the new module):**

```ts
export interface ToolExecutionStart {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionFinished {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result: unknown;
  isError: boolean;
}

/** Header line for an in-flight tool call (no result yet). */
export function renderToolCallHeader(call: ToolExecutionStart, width: number): string[];

/** Full block: header + indented argument summary + result block. */
export function renderToolExecution(finished: ToolExecutionFinished, width: number): string[];

/** Result-only block, used when replaying a tool_result without a paired call header. */
export function renderToolResultOnly(
  finished: Omit<ToolExecutionFinished, "args">,
  width: number,
): string[];
```

**Behavior requirements:**
- Header format: `tool: <toolName>(<short-arg-summary>)`. Short-arg summary picks the most informative single arg per known tool (e.g. `read` → `path`; `bash` → `command` truncated to 60 chars; `grep` → `pattern`; `edit` → `path`; `write` → `path`; `glob` → `pattern`; `web_fetch` → `url`; `ls` → `path`; otherwise stringify all args, truncated to 60 chars).
- Body: arg JSON pretty-printed and truncated to 600 chars total, indented 2 spaces; skip the body when args are absent or empty.
- Result block:
  - `isError === true` → prefix line `  error:` then result preview (string-coerced, truncated to 600 chars), each output line indented 2 spaces.
  - `isError === false` → prefix line `  result:` then result preview indented identically.
  - Empty/null/undefined results render as `  (no output)`.
- All output is wrapped via `wrapTextWithAnsi(line, width)` from `src/engine/tui.js` so wide content respects the pane width.
- Pure function: no I/O, no module-level state, no `console`.

**Tests (TDD — write these first, then the module):**

```ts
import { deepStrictEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderToolCallHeader,
  renderToolExecution,
  renderToolResultOnly,
} from "../../src/interactive/renderers/tool-execution.js";

describe("renderers/tool-execution", () => {
  it("renders header with the most informative arg per tool", () => {
    const lines = renderToolCallHeader(
      { toolCallId: "t1", toolName: "read", args: { path: "src/foo.ts" } },
      80,
    );
    ok(lines.some((l) => l.startsWith("tool: read(src/foo.ts)")), JSON.stringify(lines));
  });

  it("falls back to full-args summary for unknown tools", () => {
    const lines = renderToolCallHeader(
      { toolCallId: "t1", toolName: "mystery", args: { x: 1, y: "z" } },
      80,
    );
    ok(lines[0].startsWith("tool: mystery("), JSON.stringify(lines));
  });

  it("renders result block with success prefix and indentation", () => {
    const lines = renderToolExecution(
      {
        toolCallId: "t1",
        toolName: "read",
        args: { path: "a.ts" },
        result: "hello\nworld",
        isError: false,
      },
      80,
    );
    ok(lines.includes("  result:"), JSON.stringify(lines));
    ok(lines.some((l) => l === "  hello"), JSON.stringify(lines));
    ok(lines.some((l) => l === "  world"), JSON.stringify(lines));
  });

  it("renders error block with error prefix", () => {
    const lines = renderToolExecution(
      {
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "false" },
        result: "exit 1",
        isError: true,
      },
      80,
    );
    ok(lines.includes("  error:"), JSON.stringify(lines));
  });

  it("emits (no output) marker for empty results", () => {
    const lines = renderToolExecution(
      {
        toolCallId: "t1",
        toolName: "ls",
        args: { path: "." },
        result: "",
        isError: false,
      },
      80,
    );
    ok(lines.includes("  (no output)"), JSON.stringify(lines));
  });

  it("truncates very long bash commands in the header", () => {
    const long = "x".repeat(200);
    const lines = renderToolCallHeader(
      { toolCallId: "t1", toolName: "bash", args: { command: long } },
      120,
    );
    ok(lines[0].length <= 120, JSON.stringify(lines[0]));
    ok(lines[0].includes("..."), JSON.stringify(lines[0]));
  });

  it("renderToolResultOnly emits result block without args", () => {
    const lines = renderToolResultOnly(
      { toolCallId: "t1", toolName: "read", result: "abc", isError: false },
      80,
    );
    ok(lines.some((l) => l.startsWith("tool: read")), JSON.stringify(lines));
    ok(lines.includes("  result:"), JSON.stringify(lines));
  });
});
```

- [ ] Step 1: Write the test file above.
- [ ] Step 2: Run `node --import tsx --test 'tests/unit/renderers-tool-execution.test.ts'` — expect failures (module missing).
- [ ] Step 3: Implement `src/interactive/renderers/tool-execution.ts` to satisfy the contract and tests. Keep it under ~200 LOC.
- [ ] Step 4: Re-run the test — expect all green.
- [ ] Step 5: `npm run typecheck && npm run lint`.

### Task A2: Wire renderer into live + replay surfaces

**Files:**
- Modify: `src/interactive/chat-panel.ts:370-394` — replace ad-hoc strings inside the `tool_execution_start` and `tool_execution_end` branches with calls into the new renderer.
- Modify: `src/interactive/chat-renderer.ts` — replace any standalone `tool result: ...` rendering and tool-call inline string formatting in `rehydrateChatPanelFromTurns` to use the new renderer for the unpaired tool-result fallback (line ~548).

**Behavior requirements:**
- Live mode (`chat-panel.ts`): on `tool_execution_start`, append a "header pending" segment using `renderToolCallHeader`. On `tool_execution_end`, mutate that segment in place (or replace) with `renderToolExecution`. If the panel does not currently model in-place updates, append the result block as a separate segment matched by `toolCallId` (whichever is closer to today's pattern — preserve the existing approach, only the rendering content changes).
- Replay mode (`chat-renderer.ts:548`): the orphaned `tool result:` line becomes `renderToolResultOnly(...)`.
- Do not change tool-execution event types or session entry shapes.
- Do not regress any existing chat-panel or chat-renderer test.

- [ ] Step 1: Read `src/interactive/chat-panel.ts:200-450` to understand the existing tool-segment lifecycle.
- [ ] Step 2: Update the two event handlers to call into the new renderer.
- [ ] Step 3: Update the replay fallback in `chat-renderer.ts`.
- [ ] Step 4: Run `node --import tsx --test 'tests/unit/chat-panel.test.ts' 'tests/unit/chat-renderer.test.ts' 'tests/unit/renderers-tool-execution.test.ts'`. Update existing assertions only when they reference the now-replaced raw strings — keep behavioral coverage intact.
- [ ] Step 5: `npm run test` — full unit + integration + boundaries suite green.
- [ ] Step 6: Commit.

```bash
git add src/interactive/renderers/tool-execution.ts \
        src/interactive/chat-panel.ts \
        src/interactive/chat-renderer.ts \
        tests/unit/renderers-tool-execution.test.ts \
        tests/unit/chat-panel.test.ts \
        tests/unit/chat-renderer.test.ts
git commit -m "feat(interactive): structured tool-execution renderer"
```

---

## Slice B — Edit-tool diff renderer

**Why now:** Slice A establishes the result-block shape; the natural follow-up is replacing raw stringified `edit` results with a colored unified diff. High user-visible polish, scoped to one tool.

### Task B1: Add `diff` dep + pure diff renderer

**Files:**
- Modify: `package.json` — add `"diff": "^8.0.2"` under `dependencies`. Run `npm install`.
- Create: `src/interactive/renderers/diff.ts`
- Test: `tests/unit/renderers-diff.test.ts`

**Contract:**

```ts
import { wrapTextWithAnsi } from "../../engine/tui.js";

export interface DiffRenderInput {
  oldText: string;
  newText: string;
  filename?: string;
  /** Context lines around each hunk. Defaults to 3. */
  context?: number;
}

/** Returns ANSI-colored unified diff lines, width-wrapped. */
export function renderUnifiedDiff(input: DiffRenderInput, width: number): string[];
```

**Behavior:**
- Use the `diff` library's `createTwoFilesPatch` (or `structuredPatch` + manual formatting) to build a unified diff.
- Color via `chalk`: `+` green, `-` red, `@@ ... @@` cyan, header lines dim.
- `filename` defaults to `file`. Header is two lines: `--- a/<filename>` and `+++ b/<filename>`.
- Empty diff (texts identical) returns `["  (no changes)"]`.
- All output wrapped via `wrapTextWithAnsi` for the supplied width.
- Pure: no I/O.

**Tests:**

```ts
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { renderUnifiedDiff } from "../../src/interactive/renderers/diff.js";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

describe("renderers/diff", () => {
  it("emits no-change marker for identical input", () => {
    const out = renderUnifiedDiff({ oldText: "a\n", newText: "a\n" }, 80);
    strictEqual(out.length, 1);
    ok(out[0].includes("(no changes)"));
  });

  it("emits +/- lines and a hunk header", () => {
    const out = renderUnifiedDiff(
      { oldText: "alpha\nbeta\n", newText: "alpha\nGAMMA\n", filename: "foo.txt" },
      80,
    );
    const plain = out.map(stripAnsi).join("\n");
    ok(plain.includes("--- a/foo.txt"));
    ok(plain.includes("+++ b/foo.txt"));
    ok(plain.includes("@@"));
    ok(plain.includes("-beta"));
    ok(plain.includes("+GAMMA"));
  });

  it("wraps lines wider than the supplied width", () => {
    const long = "x".repeat(200);
    const out = renderUnifiedDiff(
      { oldText: "", newText: `${long}\n`, filename: "wide.txt" },
      40,
    );
    for (const line of out) {
      ok(stripAnsi(line).length <= 40, `line too wide: ${line.length}`);
    }
  });
});
```

- [ ] Step 1: `npm install diff@^8.0.2 && npm install --save-dev @types/diff`. Confirm the lockfile updates.
- [ ] Step 2: Write the failing tests.
- [ ] Step 3: Implement `renderUnifiedDiff`.
- [ ] Step 4: Run `node --import tsx --test 'tests/unit/renderers-diff.test.ts'` — green.

### Task B2: Wire diff into the tool-execution renderer for `edit`

**Files:**
- Modify: `src/interactive/renderers/tool-execution.ts` — when `toolName === "edit"` and `isError === false`, attempt to parse `args` as `{ path, old_string?, new_string? }` and `result` as a confirmation string, then render the diff between `old_string` and `new_string` (using `path` as filename) in place of the raw result block.
- Test: extend `tests/unit/renderers-tool-execution.test.ts` with an "edit shows diff" case.

**Behavior:**
- Only triggers when both `old_string` and `new_string` are strings on `args`.
- Falls back to the standard result block when args don't match the schema (defensive — different edit tool variants may exist).
- The diff replaces the result preview but the `tool: edit(<path>)` header still renders.

- [ ] Step 1: Add the failing test (renders `+/-` lines for an edit invocation).
- [ ] Step 2: Wire in the dispatch in `tool-execution.ts`. Keep the helper function private (not exported).
- [ ] Step 3: `npm run test` green.
- [ ] Step 4: Commit.

```bash
git add package.json package-lock.json \
        src/interactive/renderers/diff.ts \
        src/interactive/renderers/tool-execution.ts \
        tests/unit/renderers-diff.test.ts \
        tests/unit/renderers-tool-execution.test.ts
git commit -m "feat(interactive): unified diff renderer for edit tool results"
```

---

## Slice C — `CLAUDE.md` context-files + `--no-context-files` flag

**Why now:** pi-coding-agent picks up `CLAUDE.md` alongside `AGENTS.md`/`CODEX.md`; Clio doesn't. Plus the `--no-context-files`/`-nc` flag is the smallest piece of the larger `src/cli/args.ts` choke point that can stand on its own.

### Task C1: Add `CLAUDE.md` to the default file list

**Files:**
- Modify: `src/domains/prompts/context-files.ts:4` — extend `DEFAULT_CONTEXT_FILE_NAMES` to `["AGENTS.md", "CLAUDE.md", "CODEX.md"]`.
- Modify: `tests/unit/prompts.test.ts` — add an assertion that a `CLAUDE.md` placed alongside `AGENTS.md` is loaded with content rendered into the joint string, in nested-cwd order.

**Behavior:**
- Order in the array matters: `AGENTS.md` first (broadest), `CLAUDE.md` second, `CODEX.md` last (most-specific) so the `renderProjectContextFiles` "later files override earlier" hint stays consistent. Within a single directory the loader walks the array in order.
- No new file types invented — only the three default markdown files.

- [ ] Step 1: Update the test to require `CLAUDE.md` discovery.
- [ ] Step 2: Update the constant.
- [ ] Step 3: `npm run test` green for the prompts suite.

### Task C2: Add `--no-context-files` flag and thread through orchestrator

**Files:**
- Modify: `src/cli/shared.ts` — add a small `extractNoContextFilesFlag(argv): { noContextFiles: boolean; rest: string[] }` helper following the same pattern as `extractApiKeyFlag` (pre-extract a top-level flag without disturbing subcommand argv). Accept `--no-context-files` and `-nc` interchangeably.
- Modify: `src/entry/orchestrator.ts` — add `noContextFiles?: boolean` to `bootOrchestrator(options)`. When `true`, pass it down to the prompts extension's dynamic-fragment registration so the context-files block is skipped.
- Modify: `src/cli/index.ts` — call `extractNoContextFilesFlag(rest)` after `extractApiKeyFlag`, thread the value into `bootOrchestrator`.
- Modify: `src/cli/run.ts` — same handling for `clio run` so non-interactive runs respect the flag.
- Modify: `src/domains/prompts/extension.ts:51` — read the new flag (passed through `register`) and short-circuit the dynamic-fragment to an empty string when set.

**Behavior:**
- Default behavior unchanged (flag absent → same as today).
- When set, the entire `context.files` dynamic fragment renders as the empty string. The prompts compiler already drops empty fragments cleanly (verify in `tests/unit/prompts.test.ts`).
- `clio --help` is updated to mention the flag with the brief description: `Skip AGENTS.md/CLAUDE.md/CODEX.md context-file injection.`

**Tests:**
- Extend `tests/unit/prompts.test.ts` with a case that constructs the prompts extension with a `noContextFiles: true` deps option and asserts the `context.files` fragment renders empty even when files exist on disk.
- Extend `tests/e2e/cli.test.ts` (or add `tests/e2e/no-context-files.test.ts`) with a non-interactive `clio --no-context-files run …` smoke that asserts the flag is accepted (exit 0 on a trivial command path).

- [ ] Step 1: Write the unit test for flag-suppressed dynamic fragment.
- [ ] Step 2: Add the flag extractor in `shared.ts`.
- [ ] Step 3: Plumb through orchestrator and prompts extension.
- [ ] Step 4: Update `--help` text wherever it lives (likely `src/cli/index.ts` or `src/cli/help.ts`).
- [ ] Step 5: Run `npm run test` and `npm run test:e2e`.
- [ ] Step 6: Commit.

```bash
git add src/domains/prompts/context-files.ts \
        src/domains/prompts/extension.ts \
        src/cli/shared.ts \
        src/cli/index.ts \
        src/cli/run.ts \
        src/entry/orchestrator.ts \
        tests/unit/prompts.test.ts \
        tests/e2e/no-context-files.test.ts
git commit -m "feat(prompts): include CLAUDE.md in context-files and add --no-context-files"
```

---

## Slice D — Esc-cancel for `web_fetch`

**Why now:** Bash already honors `options.signal`, but `web_fetch` ignores it entirely. Today, hitting Esc during a slow URL fetch cancels the LLM stream but leaves the undici request in flight until its own 30s timeout. Multi-line fix; doubles as the regression test for the bash signal path that has no test today.

### Task D1: Honor `options.signal` in `web_fetch`

**Files:**
- Modify: `src/tools/web-fetch.ts` — change `run(args)` to `run(args, options)`, accept `options?: { signal?: AbortSignal }`, and merge the external signal with the internal timeout `AbortController` so either source aborts the in-flight `undici` fetch. On external abort return `{ kind: "error", message: "web_fetch: request aborted" }`.

**Behavior:**
- Internal timeout still fires after `timeout_ms`; result message is unchanged for that case (`web_fetch: timed out after Nms` or whatever today's message is).
- External abort produces a distinct message so callers can disambiguate user cancel from server timeout.
- Implementation idea: build a single `AbortController` that aborts when either (a) the timer fires, (b) `options.signal.aborted` is already true, or (c) the external signal fires its `abort` event. Always pass that controller's `signal` to `fetch(...)`. Always remove the listener on completion.

### Task D2: Tests covering bash and web_fetch abort paths

**Files:**
- Create: `tests/unit/tool-signal.test.ts` (or extend an existing tool-tests file if one matches better — keep the file count flat).

**Test cases:**
- `bash: external abort terminates the running command` — spawn `sleep 5`, fire `controller.abort()` after ~50ms, assert the result is `{ kind: "error", message: /aborted/ }` within 1s and the elapsed time is < 1500ms.
- `bash: external abort already-aborted before invocation returns immediately` — pass `AbortSignal.abort()` directly, expect quick error.
- `web_fetch: external abort cancels the fetch` — start a local Node http server that delays 5s before responding, fire `controller.abort()` after ~50ms, assert the result is `{ kind: "error", message: /aborted/ }` within 1s.
- `web_fetch: internal timeout still fires when no external signal` — small `timeout_ms`, slow server, assert the original timeout error message.

Use the in-process http server pattern (no network), shut it down in `after(...)`. Be careful with port allocation: bind to `127.0.0.1:0` and read the assigned port from `server.address()`.

- [ ] Step 1: Write the failing tests.
- [ ] Step 2: Patch `web_fetch.ts` to honor the signal. Confirm the bash test passes against today's code (no change to bash needed).
- [ ] Step 3: `npm run test` green.
- [ ] Step 4: Commit.

```bash
git add src/tools/web-fetch.ts tests/unit/tool-signal.test.ts
git commit -m "feat(tools): honor abort signal in web_fetch and cover bash signal in tests"
```

---

## Slice E — Refresh stale parity ledger

**Why:** The Phase 22 row currently claims chat-loop retry wiring is incomplete, but `runTransientRetryChain` (chat-loop.ts:730-824), `RetryStatusEvent`, durable `retryStatus` custom entries, the `formatRetryStatus` renderer, and the unit tests at `tests/unit/chat-loop-retry.test.ts` + `tests/unit/retry.test.ts` are all present. Slices A-D also need ledger entries.

**Files:**
- Modify: `docs/.superpowers/sprints/pi-coding-agent-parity.md`

**Edits:**
- Phase 22 retry row: flip the marker to ✅ with evidence:
  > Chat-loop wiring landed via `runTransientRetryChain` (`src/interactive/chat-loop.ts:730-824`); emits `RetryStatusEvent`, persists `retryStatus` custom session entries, surfaces via `formatRetryStatus` renderer (`src/interactive/renderers/retry-status.ts`) in both `chat-renderer.ts` and `chat-panel.ts`. Tests at `tests/unit/chat-loop-retry.test.ts` and `tests/unit/retry.test.ts`.
- Phase 22 percentage: bump from `~10%` to `~25%` (retry row flipped + cost slice already at ✅ but already counted; recompute file-count weight if needed).
- Phase 19 row updates:
  - `Tool-execution renderer` → ✅ with reference to `src/interactive/renderers/tool-execution.ts` and the chat-panel/chat-renderer wire-up.
  - `Diff renderer` → ✅ with reference to `src/interactive/renderers/diff.ts`.
  - `Edit-tool diff preview` → ✅ via the `tool-execution.ts` edit branch.
  - Bump phase percentage accordingly.
- Phase 13 row updates:
  - `Context-files loader` row → expand evidence to mention `CLAUDE.md`.
  - `--no-context-files / -nc flag` → ✅ with evidence in `src/cli/shared.ts` and `src/entry/orchestrator.ts`.
- Dormant pi-mono surface table:
  - `Agent.signal` row: add note "✅ web_fetch wired in slice D; bash already wired."
- Update the executive summary phase-percentage table.

- [ ] Step 1: Apply edits.
- [ ] Step 2: `git diff` to confirm only the ledger changed.
- [ ] Step 3: Commit.

```bash
git add docs/.superpowers/sprints/pi-coding-agent-parity.md
git commit -m "docs(parity): refresh ledger for retry wiring and slice A-D landings"
```

---

## Self-review checklist

- ✅ Each task has a specific file list, exact behavior contract, and runnable tests.
- ✅ No placeholders ("TBD", "appropriate handling", "similar to") — every step has the actual content or the actual command.
- ✅ Type names and function signatures consistent across tasks (`renderToolExecution`, `renderToolCallHeader`, `renderToolResultOnly`, `renderUnifiedDiff`, `extractNoContextFilesFlag`).
- ✅ Each slice is one atomic commit. No mixing.
- ✅ All tests use `node:test` + `node:assert/strict` per repo convention.
- ✅ Engine boundary respected: renderers consume `pi-tui` types only via `src/engine/tui.js` re-exports.
- ✅ Tests use scratch-XDG pattern only when they touch the filesystem (slice C e2e).
