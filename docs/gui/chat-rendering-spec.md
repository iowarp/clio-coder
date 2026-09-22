# Chat rendering specification

> **Historical design record.** This blueprint describes the GUI at an earlier
> stage, before much of the conversation view shipped. Its proposed work, paths,
> and counts are historical. For current behavior, read the [GUI reference](README.md).

Use this page for the rationale behind conversation layouts, label taxonomies,
and empty states. Expand the background and implementation sketches as needed.

<details>
<summary>Original scope and relationship to the current GUI</summary>

The blueprint covers the conversation view and the thirteen domain inspectors. It
was recovered from `apps/workbench` before that application was deleted, and its
quoted paths and taxonomies were checked against `contracts/` and `src/` at that
time rather than against the workbench's own wire format. Treat every path and
count below as a dated citation, not as a present-tense claim.

Seventeen artifacts follow, each with a named destination file. When this was
written, two had landed and fifteen had not. Several of the fifteen have shipped
since, including `client/chat/turns.ts`, `client/chat/ActivityGroup.tsx`,
`client/chat/Diff.tsx`, `client/chat/Approval.tsx`, `client/chat/live-status.ts`
and `client/chat/tool-cards.tsx`. The list is kept in its original form because
the rationale under each artifact is the reason to read it.

The central finding was that the chat gap is not a protocol gap. `TimelineItem.rawInput`
and `rawOutput` already carry the harness's full tool argument object and result, and
`src/tools/edit-diff.ts` already emits a capped unified diff at
`rawOutput.result.details.diff`, so per-tool-kind cards and diff rendering were
buildable with no ACP change. What was missing then was conversational
architecture: turn grouping, the collapsing activity group, the live status chip,
approval anchoring, and roughly forty closed label taxonomies that the GUI at the
time replaced with `JSON.stringify` dumps inside `<details>` at fourteen call
sites.

---


The prior audit's claim was correct on data but wrong in emphasis. Every inspector's *payload*
is reproduced by the new route table, but the workbench's value was never the payload: it was
~40 closed label taxonomies (gate reasons, evidence trust axes, customization
categories, recovery sections, verifier rejections), a consistent tone function per domain, and a
rigorously-worked empty-state grammar that distinguishes "not read yet" from "store missing" from
"store present but empty" from "record predates this schema". Those taxonomies are the part of this
document that survives; the rendering that carries them has since been built.

On chat, the finding was sharper than expected: the workbench had NO per-tool-kind rendering and NO diff
rendering at all, because its wire (`TurnToolPayload`) carried only `{kind, title, summary, locations, status}`.
The new GUI's wire is strictly richer — `TimelineItem.rawInput`/`rawOutput` already carry the harness's
full tool argument object and result, and `src/tools/edit-diff.ts` already produces a capped unified diff
at `rawOutput.result.details.diff` — so per-tool-kind cards and diffs were buildable with no ACP change.

What had to be *ported* from the workbench was the conversational architecture the
GUI lacked at the time: turn grouping into request/response/activity segments, the
collapsing activity group with its disclosure policy, the live status chip,
follow-latest scrolling, the frame-coalescing event buffer, and the approval
anchoring/escalation/keyboard model. 17 artifacts follow, 11 of them chat.


---

</details>

## Conversation projection: groupTurns and the ChatSegment model

- **priority**: must-keep
- **from**: apps/workbench/src/chat.ts:20-126
- **to**: apps/clio-coder-gui/client/chat/turns.ts
- **value**: The single largest gap. `apps/clio-coder-gui/client/pages/sessions.tsx:270` renders `snapshot.timeline.map(item => <Timeline item/>)` — a flat list of undifferentiated cards. The workbench instead grouped the flat timeline into turns, and within a turn interleaved prose, reasoning, and *runs* of tool activity, so a turn that ran 14 tools between two paragraphs shows as: paragraph, one collapsed activity group, paragraph. Without this the chat is unreadable at real tool volume. It also carries the referential-identity trick that makes memoization work: a turn whose items are element-wise identical keeps its object identity, so settled turns never re-render while a later turn streams.

Port verbatim in behavior, retyped for `contracts/sessions.ts` `TimelineItem` (kinds are `user|text|thought|tool|notice`, not the workbench's 8-kind set).

<details>
<summary>`ChatSegment`, `ChatTurn`, `buildTurn`, and the `sameItems` identity check</summary>

```ts
import type { TimelineItem } from "../../contracts/sessions.js";

export type ChatSegment =
	| Readonly<{ kind: "response"; item: TimelineItem }>
	| Readonly<{ kind: "reasoning"; item: TimelineItem }>
	| Readonly<{ kind: "activity"; items: readonly TimelineItem[] }>;

export interface ChatTurn {
	readonly turnId: string;
	readonly origin: "live" | "replay";
	readonly request: TimelineItem | null;
	readonly segments: readonly ChatSegment[];
	readonly items: readonly TimelineItem[];
	/** True when nothing in this turn can still change. */
	readonly settled: boolean;
}

function sameItems(previous: readonly TimelineItem[], next: readonly TimelineItem[]): boolean {
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length; index += 1) if (previous[index] !== next[index]) return false;
	return true;
}

function buildTurn(turnId: string, items: readonly TimelineItem[], turnStatus: string | undefined): ChatTurn {
	let request: TimelineItem | null = null;
	const segments: ChatSegment[] = [];
	let activity: TimelineItem[] | null = null;
	const flush = () => {
		if (activity !== null && activity.length > 0) segments.push({ kind: "activity", items: activity });
		activity = null;
	};
	for (const item of items) {
		switch (item.kind) {
			case "user":
				request = item;
				break;
			case "text":
				flush();
				segments.push({ kind: "response", item });
				break;
			case "thought":
				flush();
				segments.push({ kind: "reasoning", item });
				break;
			case "tool":
			case "notice":
				(activity ??= []).push(item);
				break;
		}
	}
	flush();
	const origin = items[0]?.origin ?? "live";
	return { turnId, origin, request, segments, items, settled: origin === "replay" || (turnStatus !== undefined && turnStatus !== "running") };
}

/**
 * Groups timeline items into turns. A turn whose items are all identical to the
 * previous grouping keeps its object identity, so settled turns never re-render
 * while a later one streams.
 */
export function groupTurns(
	timeline: readonly TimelineItem[],
	turnStatus: ReadonlyMap<string, string>,
	previous: readonly ChatTurn[] = [],
): readonly ChatTurn[] {
	const order: string[] = [];
	const byTurn = new Map<string, TimelineItem[]>();
	for (const item of timeline) {
		let bucket = byTurn.get(item.turnId);
		if (bucket === undefined) {
			bucket = [];
			byTurn.set(item.turnId, bucket);
			order.push(item.turnId);
		}
		bucket.push(item);
	}
	const previousByTurn = new Map(previous.map((turn) => [turn.turnId, turn] as const));
	let unchanged = previous.length === order.length;
	const turns = order.map((turnId, index) => {
		const items = byTurn.get(turnId) ?? [];
		const prior = previousByTurn.get(turnId);
		if (prior !== undefined && sameItems(prior.items, items) && prior.settled === (turnStatus.get(turnId) !== "running")) {
			if (previous[index] !== prior) unchanged = false;
			return prior;
		}
		unchanged = false;
		return buildTurn(turnId, items, turnStatus.get(turnId));
	});
	return unchanged ? previous : turns;
}
```

Difference from the workbench that the port must handle: the workbench's turn outcome was a *timeline item* (`kind: "outcome" | "failure"`), so `settled` fell out of the item list. The new GUI keeps outcome on `SessionSnapshot.turns[]` instead, so `groupTurns` takes a `turnStatus` map built as `new Map(snapshot.turns.map(t => [t.id, t.status]))` and the outcome footer reads the `Turn` row. Build the map with `useMemo` keyed on `snapshot.turns`.

Call site in `SessionView`, replacing the flat `.map`:

```tsx
const previousTurns = useRef<readonly ChatTurn[]>([]);
const statuses = useMemo(() => new Map(snapshot.turns.map((t) => [t.id, t.status] as const)), [snapshot.turns]);
const turns = useMemo(() => {
	const next = groupTurns(snapshot.timeline, statuses, previousTurns.current);
	previousTurns.current = next;
	return next;
}, [snapshot.timeline, statuses]);
```

Memo comparator for the turn view (workbench `Chat.tsx:400-405`), which is what actually buys the render savings:

```ts
(previous, next) => {
	if (previous.turn !== next.turn) return false;
	if (previous.turn.settled) return true;
	return previous.pendingPermission === next.pendingPermission && previous.nowMs === next.nowMs && previous.onResolve === next.onResolve;
}
```

And pass `nowMs={turn.settled ? 0 : nowMs}` down, so the once-a-second clock tick cannot invalidate a settled turn (`Chat.tsx:429`). This is the reason the workbench resumed a 64-turn session in 119–172 ms with 683 DOM nodes.

</details>

---

## Activity group: summarizeActivity and the disclosure policy

- priority: must-keep
- from: apps/workbench/src/chat.ts:128-208 and apps/workbench/src/Chat.tsx:177-281
- to: apps/clio-coder-gui/client/chat/activity.ts + client/chat/ActivityGroup.tsx
- value: This is the mechanism that keeps a 40-tool turn readable. It derives a one-line label and a tone from item statuses alone (no new server field), decides whether the group opens itself, shows the currently-running tool's title on the collapsed summary line so a silent run still tells the operator what is happening, and respects a manual toggle forever after. `apps/clio-coder-gui` has no equivalent; every tool is a permanently-expanded card.

<details>
<summary>`summarizeActivity`, the `ActivityTone` scale, and the group component</summary>

```ts
export type ActivityTone = "neutral" | "info" | "action" | "success" | "warning" | "error";

export interface ActivitySummary {
	readonly label: string;
	readonly tone: ActivityTone;
	readonly total: number;
	readonly running: number;
	readonly waiting: number;
	readonly completed: number;
	readonly failed: number;
	readonly canceled: number;
	/** True when something in the group needs the operator's eyes right now. */
	readonly attention: boolean;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function summarizeActivity(items: readonly TimelineItem[]): ActivitySummary {
	let running = 0, waiting = 0, completed = 0, failed = 0, canceled = 0, onlyTools = true;
	for (const item of items) {
		if (item.kind !== "tool") onlyTools = false;
		switch (item.status) {
			case "in_progress": case "pending": running += 1; break;
			case "escalated": waiting += 1; break;
			case "failed": failed += 1; break;
			case "cancelled": case "rejected": case "expired": canceled += 1; break;
			default: completed += 1; break; // completed, allowed
		}
	}
	const noun = onlyTools ? "tool" : "step";
	let label: string, tone: ActivityTone;
	if (waiting > 0) { label = "Approval needed"; tone = "warning"; }
	else if (running > 0) { label = `${plural(running, noun)} running${completed > 0 ? ` · ${completed} done` : ""}`; tone = "action"; }
	else if (failed > 0) { label = `${plural(failed, noun)} failed${completed > 0 ? ` · ${completed} completed` : ""}`; tone = "error"; }
	else if (canceled > 0 && completed === 0) { label = `${plural(canceled, noun)} stopped`; tone = "neutral"; }
	else { label = `${plural(completed, noun)} completed${canceled > 0 ? ` · ${canceled} stopped` : ""}`; tone = "success"; }
	return { label, tone, total: items.length, running, waiting, completed, failed, canceled, attention: waiting > 0 || running > 0 || failed > 0 };
}
```

Status-mapping note: the workbench's 7-value `status` union does not exist in the new contract — `TimelineItem.status` is an open `Type.String()` carrying the raw ACP status. Map as above; add a shared `TOOL_STATUS_LABELS` for the per-row state text:

```ts
export const TOOL_STATUS_LABELS: Readonly<Record<string, string>> = {
	pending: "queued", in_progress: "running", completed: "done",
	cancelled: "stopped", failed: "failed", escalated: "waiting",
	allowed: "allowed", rejected: "rejected", expired: "expired",
};
export const STATUS_GLYPHS: Readonly<Record<string, string>> = {
	pending: "…", in_progress: "◐", escalated: "!", completed: "✓",
	cancelled: "–", failed: "✕", allowed: "✓", rejected: "✕", expired: "–",
};
```

Disclosure policy, the part that matters (`Chat.tsx:249-267`):

```tsx
const [userOpen, setUserOpen] = useState<boolean | null>(null);
// Default: open only while something still needs attention. Once the operator
// toggles it, their choice wins forever — `userOpen` is never reset.
const open = userOpen ?? ((!settled && summary.attention) || summary.failed > 0 || summary.waiting > 0);
const running = items.find((item) => item.status === "in_progress");
```

```tsx
<details className={`activity activity--${summary.tone}${open ? " is-open" : ""}`} open={open}
	onToggle={(e) => { if (e.currentTarget.open !== open) setUserOpen(e.currentTarget.open); }}>
	<summary className="activity__summary">
		<span className="activity__glyph" aria-hidden="true">
			{summary.waiting > 0 ? "!" : summary.running > 0 ? "◐" : summary.failed > 0 ? "✕" : "✓"}
		</span>
		<span className="activity__label">{summary.label}</span>
		{/* The one fact that makes a collapsed group still informative. */}
		{running !== undefined && summary.waiting === 0 && <span className="activity__current">{running.title}</span>}
		<span className="activity__count" aria-hidden="true">{summary.total}</span>
	</summary>
	<ul className="activity__rows">{items.map((item) => <ToolRow key={item.id} item={item} … />)}</ul>
</details>
```

Row layout is a 4-column grid: glyph, kind label, title (with agent tag + notes stacked under it), state + elapsed. Elapsed is only printed when the row is running AND `>= 2` seconds, so short calls do not flicker a timer (`Chat.tsx:207`). Kind label for a tool row comes from the tool kind; for a notice row it is `"approval"` or `"safety"`.

Agent attribution tag (`Chat.tsx:63-77`) — take the LAST entry of `item.provenance`, and render only when its `role === "worker"`, so a delegated agent wins over the orchestrator and an unattributed call stays attributed to the product:

```ts
export function workerLabel(provenance: Provenance | undefined): string | null {
	const last = provenance?.at(-1);
	if (last === undefined || last.role !== "worker") return null;
	return last.node == null ? last.agentId : `${last.agentId} · ${last.node}`;
}
```

Title attribute on the tag: `"Reported by Clio Coder as the agent that ran this call"`.

</details>

---

## Per-tool-kind tool call rendering

- priority: must-keep
- from: apps/workbench/src/Chat.tsx:177-239 (what existed) + clio-host.ts:303-335 (safeToolTitle/presentableToolTitle) + iowarp/clio-coder/src/engine/acp/server.ts:235-252,915-985 (the wire that makes the new version possible)
- to: apps/clio-coder-gui/client/chat/tool-cards.tsx
- value: The highest-value item in this lens, and the one the audit could not have found by reading the workbench, because the workbench DID NOT HAVE IT. Its wire (`TurnToolPayload` in src/protocol.ts:2264) carried only `{toolCallId, title, kind, status, summary, locations, agents}` — no arguments, no output. Every tool therefore rendered as one identical grey row. The new GUI's wire is strictly richer: `TimelineItem.rawInput` is the harness's literal tool argument object and `rawOutput` is `{result, isError}` where `result` is the full `ToolResult` including `details`. It is currently thrown into `JSON.stringify(…)` inside a `<details>` at sessions.tsx:197. This spec defines the card per tool, keyed on the harness's real tool names, using fields that exist today. No ACP change needed.

The ACP `kind` enum is a coarse UI hint only. `src/engine/acp/server.ts:235` maps Clio tool names onto it and the mapping is lossy — `git`, `dispatch`, `steer` all become `other`; `read`, `ls`, `context`, `monitor` all become `read`. So **key the renderer on `item.title`, which is the canonical Clio tool name** (`server.ts:933` sets `title: boundString(toolName)`), and fall back to `item.toolKind` for MCP/dynamic tools.

The canonical name set (from `iowarp/clio-coder/src/tools/`): `read ls context write edit artifact grep find code_nav bash verify web_fetch git dispatch monitor steer ask_user decide evidence ledger panes run_script safe_exec task`.

<details>
<summary>The `ToolPresenter` type every per-kind card implements</summary>

```ts
export type ToolPresenter = {
	/** Short kind chip, lowercase. */ chip: string;
	/** One line, always visible, ~72 chars. Never JSON. */ headline(raw: Record<string, unknown>): string;
	/** Body renderer for the expanded row, or null for headline-only tools. */
	body: "diff" | "terminal" | "matches" | "file" | "fetch" | "dispatch" | "json" | null;
};
```

</details>

**Per-tool contract.** `in` = `item.rawInput`; `out` = `item.rawOutput.result` (`{ output?: string, details?: Record<string, unknown> }`), `err` = `item.rawOutput.isError === true`.

| title | chip | headline | body | key fields read |
| --- | --- | --- | --- | --- |
| `read` | `read` | `` `${basename(in.path)}` `` + `` ` · lines ${in.offset ?? 1}–${(in.offset ?? 1) + (in.limit ?? n) - 1}` `` when either is set | `file` | `out.details.file` (`bytes`, `lines`, `truncated`), `out.details.totalLines`, `out.details.code === "read_past_eof"` |
| `ls` | `list` | `` `${in.path || "."}` `` | `file` | entry count from `out.output` line count |
| `edit` | `edit` | `` `${basename(in.path)} · ${in.edits?.length ?? 1} replacement${s}` `` | **`diff`** | `out.details.diff` (unified), `out.details.firstChangedLine` |
| `write` | `write` | `` `${basename(in.path)}${out.details.diff ? "" : " · new file"}` `` | **`diff`** | `out.details.diff` |
| `artifact` | `edit` | `` `${in.op ?? "artifact"} ${basename(in.path ?? "")}` `` | `diff` | as `edit` |
| `bash` | `bash` | first line of `in.command`, capped 72 chars with `…` | **`terminal`** | `out.details.exitCode`, `.signal`, `.timedOut`, `.aborted`, `.outputCapped`, `.stdoutBytes`, `.stderrBytes`, `.outcome` |
| `run_script` / `verify` / `safe_exec` | `run` | `` `${in.script ?? in.id ?? in.op}` `` | `terminal` | same as bash |
| `grep` | `grep` | `` `/${in.pattern}/ in ${in.path ?? "."}${in.glob ? ` (${in.glob})` : ""}` `` | **`matches`** | `out.details.search` (`{ matches, filesSearched, truncated }`), `out.output` as `path:line:text` rows |
| `find` | `find` | `` `${in.pattern ?? in.glob}` `` | `matches` | `out.details.search` |
| `code_nav` | `nav` | `` `${in.op} ${in.symbol ?? in.path}` `` | `matches` | — |
| `web_fetch` | `fetch` | hostname + pathname of `in.url` (parse with `URL`; if it throws, show the raw string escaped) | **`fetch`** | `out.details` (`status`, `contentType`, `bytes`, `redirects`, `blocked`) |
| `dispatch` | `dispatch` | `` `${in.agent ?? in.recipe} · ${in.task ? truncate(in.task, 60) : "no task preview"}` `` | **`dispatch`** | correlate with `SessionSnapshot.fleet[]` on `runId` |
| `git` | `git` | `` `git ${in.op}` `` | `terminal` | — |
| `monitor` / `steer` / `panes` | `control` | `` `${in.op ?? title}` `` | `json` | — |
| `ask_user` / `decide` | `ask` | `in.question ?? in.prompt`, capped 72 | null | — |
| anything else | `item.toolKind ?? "tool"` | `item.title` | `json` | — |

**Body renderers.**

- `terminal`: a monospace block showing `out.output` (already the harness's bounded tail) in `<pre>` with `overflow-x:auto`, preceded by a fact strip `exit ${exitCode} · ${formatBytes(stdoutBytes)} out · ${formatBytes(stderrBytes)} err` and, when `outputCapped`, the line `Output hit the 16 MiB cap and the command was stopped.` A `timedOut` run reads `Timed out.`; `aborted` reads `Cancelled.` Tone: `error` when `err` or `exitCode !== 0`.
- `matches`: parse `out.output` as `path:line:text` rows, group by `path`, render as a `<details>` per file with the file's match count on the summary; each row is `<span class="line">{line}</span><code>{text}</code>`. Cap at 200 rendered rows with `and N more matches` (the harness already bounds the payload; this is a DOM bound). Fact strip: `${matches} matches in ${filesSearched} files${truncated ? " · truncated by Clio" : ""}`.
- `file`: fact strip only — `${lines} lines · ${formatBytes(bytes)}${truncated ? " · truncated" : ""}`; when `out.details.code === "read_past_eof"`, the line `Requested range is past end of file (${totalLines} lines).` No content body: a read's content is what the assistant then talks about, and duplicating it doubles the transcript.
- `fetch`: fact strip `${status} · ${contentType} · ${formatBytes(bytes)}${redirects ? ` · ${redirects} redirect(s)` : ""}`; a `blocked` result renders as a warning row naming the policy that blocked it, never the URL's query string.
- `dispatch`: see the fleet strip artifact; render the matching `FleetItem` rows inline under the call.
- `json`: last resort — the current `<pre>{JSON.stringify(…)}</pre>`, but inside a closed `<details>` labelled `Tool input and result`, and only when the row is expanded.

<details>
<summary>`SAFE_TOOL_TITLES` and the path-shortening rules</summary>

**Path presentation.** Port `presentableToolTitle` (clio-host.ts:320): replace every occurrence of the workspace root with `[project]`, strip every code point `< 0x20` and `0x7f`, trim, and cap at 511 UTF-8 bytes with a trailing `…`. Empty after stripping falls back to a generic label. The generic labels (clio-host.ts:303) are worth keeping as the fallback when `title` is missing:

```ts
export const SAFE_TOOL_TITLES: Readonly<Record<string, string>> = {
	read: "Read project content", edit: "Edit project content", delete: "Delete project content",
	move: "Move project content", search: "Search project content", execute: "Run a project command",
	think: "Reason about the task", fetch: "Fetch external content",
	switch_mode: "Change work mode", other: "Use a Clio Coder tool",
};
```

</details>

**Locations.** `item.locations` is `[{path, line?}]`. Render each as `path` with `:${line + 1}` appended when `line` is an integer (ACP lines are zero-based; the current code at sessions.tsx:190 already does the `+1`). Show at most 3 inline; the rest behind `+N more`.

**Long-running.** Port `LONG_RUNNING_TOOL_SECONDS = 30` (App.tsx:1156): a tool row whose status is `in_progress` and whose elapsed exceeds 30 s gets a `still running · ${formatDuration(s)}` marker and a distinct class, so a hung bash is visible without expanding the group.

---

## Diff rendering for edit and write

- priority: must-keep
- from: NOT in apps/workbench (it had no diff surface). Source of truth: iowarp/clio-coder/src/tools/edit-diff.ts:18-24, src/tools/edit.ts:187-211, src/tools/write.ts:56-78
- to: apps/clio-coder-gui/client/chat/Diff.tsx
- value: The workbench never showed a diff, which is the largest single functional gap against every comparable GUI. It is buildable today with zero wire changes: the harness already generates a unified diff and ships it inside rawOutput. Recording it here because the fact that the diff already exists on the wire is exactly the thing a reader of the deleted workbench would never learn.

**Where the diff lives.** `item.rawOutput.result.details.diff` is a unified-diff string; `item.rawOutput.result.details.firstChangedLine` is a 1-based line number. Produced by `generateDiffString()` in `src/tools/edit-diff.ts`, which caps each rendered line at `MAX_DIFF_LINE_CHARS = 500` (appending `… (+N chars)`) and the whole diff at `MAX_DIFF_BYTES = 32_768`. **It is `undefined` when the previous or new file exceeds 1 MiB** — in that case `out.output` contains the literal sentence `note: diff skipped because the previous or new file exceeds 1 MiB`, and the card must say so rather than showing an empty diff.

<details>
<summary>`parseUnifiedDiff`, the `DiffLine` union, and hunk-header handling</summary>

```ts
export type DiffLine =
	| { kind: "hunk"; text: string; oldStart: number; newStart: number }
	| { kind: "add" | "del" | "ctx"; text: string; oldLine: number | null; newLine: number | null };

export function parseUnifiedDiff(source: string): readonly DiffLine[] {
	const out: DiffLine[] = [];
	let oldLine = 0, newLine = 0;
	for (const raw of source.split("\n")) {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
		if (hunk !== null) {
			oldLine = Number(hunk[1]); newLine = Number(hunk[2]);
			out.push({ kind: "hunk", text: raw, oldStart: oldLine, newStart: newLine });
			continue;
		}
		if (raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
		if (raw.startsWith("+")) { out.push({ kind: "add", text: raw.slice(1), oldLine: null, newLine: newLine++ }); continue; }
		if (raw.startsWith("-")) { out.push({ kind: "del", text: raw.slice(1), oldLine: oldLine++, newLine: null }); continue; }
		if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
		out.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldLine: oldLine++, newLine: newLine++ });
	}
	return out;
}
```

</details>

**Rendering.** A two-gutter table-free grid (`grid-template-columns: 3.5rem 3.5rem 1fr`) so copy-paste yields only the code:
- old line number, new line number, then `<code>` with the text;
- `add` rows: green-tinted ground, `+` marker in a `::before` that is `user-select: none`; `del`: red-tinted, `−` marker; `ctx`: transparent;
- `hunk` rows span all three columns, dimmed, monospace;
- the whole block sits in `overflow-x: auto` with `white-space: pre` so long lines scroll rather than wrap;
- syntax highlight the text column by reusing `client/render/highlight.ts` with the grammar inferred from the file extension of `in.path` via `codeLanguage()` — **only when the call is settled and the diff is under `HIGHLIGHT_MAX_CHARS = 60_000`**, matching the existing `CodeBlock` policy, and only when the row is expanded and near the viewport (`useNearViewport`, `rootMargin: "600px"`).

**Header strip:** `${basename(in.path)} · +${adds} −${dels}` and a `Copy diff` button reusing the existing `CopyButton` from `client/render/Markdown.tsx:107`.

**Collapse policy:** a diff of more than 40 rendered lines opens showing the hunk containing `firstChangedLine` plus 3 lines of context, with `Show all ${n} lines` expanding it. A diff of 40 or fewer lines is fully open. This is the only place in the chat where an expensive body opens by default, because the diff is the thing the operator is deciding about.

**Before vs after approval.** The ACP permission request carries the same `toolCall` object the client already drew (`apps/clio-coder-gui/server/acp/permissions.ts:36-58` asserts `rawInput` is byte-identical to the drawn call). So:
- **Before approval** — status is `pending`/`in_progress` and `rawOutput` is absent. There is no diff yet because the harness has not applied the edit. Render the *intent* from `rawInput`: for `edit`, one block per `in.edits[i]` showing `oldText` as deletions and `newText` as additions, synthesized locally with the same grid, labelled `Proposed · not yet applied`. For `write`, show `in.content` as an all-additions block labelled `Proposed new contents`. Cap each synthesized block at 400 lines.
- **After approval** — the terminal `tool_call_update` arrives with `rawOutput`; swap the synthesized intent for the real `details.diff` in place, keeping the same DOM node so the card does not jump. Label changes to `Applied`. A `failed` status keeps the proposed block and adds the error line from `out.output`.
- **After rejection** — the permission resolves `rejected`, the tool call settles `cancelled`, and the proposed block stays visible, dimmed, labelled `Not applied · you rejected this`.

---

## Permission card: anchoring, escalation, countdown, keyboard, notification

- priority: must-keep
- from: apps/workbench/src/App.tsx:1212-1316 (PermissionCard, ApprovalBanner), 8046-8054 (escalation), 8330-8384 (title, Alt+A/Alt+R, notification), src/Chat.tsx:185-236 (anchored row)
- to: apps/clio-coder-gui/client/chat/Approval.tsx
- value: The new GUI's PermissionCards (session-controls.tsx:11-49) is a flat list above the transcript that says 'Review the tool input and locations in the conversation' — it never links to the call it gates, has no countdown, no escalation state, no keyboard path, and no title/notification signal. The workbench solved all of that, and its comment records why: the card the operator missed in a recorded session was anchored wherever the timeline happened to be. This carries the full model.

**Two surfaces, one decision.** The workbench rendered the approval twice and kept both live:
1. An **anchored row** inside the activity group, attached to the exact tool call — the workbench matched on `item.id.endsWith(':' + permissionId)`. In the new contract the link is direct and exact: `permission.toolCallId === item.toolCallId`. Use that. The anchored row carries the Allow/Reject buttons and a facts line.
2. A **banner** pinned above the scrolling transcript (never inside it), `role="region"`, **not focus-trapping**: the operator may keep reading, scrolling and typing while an approval waits. The banner is shown unconditionally; when the anchored row exists too, both are live and either answers.

**Escalation** is a state, not a timeout. `Permission` already carries `requestedAt`, `escalateAt`, `expiresAt`, and `status: "pending" | "escalated"`. Derive locally rather than waiting for the `permission.escalated` delta so the UI never lags the clock:

```ts
const escalated = permission.status === "escalated" || nowMs >= Date.parse(permission.escalateAt);
const waited = Math.max(0, Math.floor((nowMs - Date.parse(permission.requestedAt)) / 1000));
const remaining = Math.max(0, Math.floor((Date.parse(permission.expiresAt) - nowMs) / 1000));
```

Banner eyebrow: `escalated ? "APPROVAL WAITING · ESCALATED" : "APPROVAL NEEDED"`. Card eyebrow: `"APPROVAL NEEDED · ONE USE"` — the `ONE USE` is load-bearing, because the only two options on the wire are `allow-once` and `reject` (`contracts/permissions.ts:4`); there is deliberately no allow-always.

**Safety facts the card must carry**, in this order:
1. `permission.title` as the heading (this is the canonical tool name, e.g. `edit`).
2. `${permission.kind} access to ${locations.length === 0 ? "this turn" : locations.join(", ")}.` — locations come from the **gated tool call's** `item.locations`, not from the permission, which carries none.
3. The countdown, phrased as consequence, not as a timer: `"If unanswered, this turn stops in ${formatDuration(remaining)} (at ${formatTime(permission.expiresAt)})."` Update on the shared 1 s clock.
4. `"Nothing runs until you answer. The GUI never answers for you."` — keep this sentence verbatim; it is the product's whole safety posture in one line.
5. Waited: `"Waiting ${formatDuration(waited)}."`
6. **New, and the reason the card should be anchored:** the diff or command being gated, inline. For an `edit`/`write` call render the proposed-diff block from the diff artifact; for `bash` render the command in a `<code>`; for `web_fetch` the host. This is what 'review the tool input in the conversation' was asking the operator to do by hand.

**Actions:** `Reject` (quiet button) then `Allow once` (primary), in that order — destructive-safe first, affirmative last. Disable both while the mutation is in flight.

**Keyboard** (`App.tsx:8340-8365`): `Alt+A` allows once, `Alt+R` rejects, from anywhere in the document. Suppressed while any modal or dialog is open, so a dialog's own controls stay unambiguous. Print the hint on the banner: `"Alt+A allows once · Alt+R rejects"`. Declare the bindings once in a `KEYBINDINGS` table and match handlers against the table, never against literals — the workbench enforced this so the help reference could not drift from the handlers.

**Document title** (`App.tsx:8331-8337`): while any permission is pending, set `document.title = "● Approval needed — Clio Coder"`; restore the previous title on cleanup. Keyed on `permissionId` so a second card re-fires it.

**Desktop notification** (`App.tsx:8369-8384`): one per card, and **only if `Notification.permission === "granted"` already** — this effect never asks for the permission; a settings toggle does. Body is `permission.title` only. A path in a notification would leave the project boundary. Wrap the constructor in try/catch; a browser that refuses is not a failure. Return `() => posted.close()`.

<details>
<summary>`RESOLUTION_SUMMARY`, the exact wording for each approval outcome</summary>

**Resolution wording** for the settled notice row (workbench `timeline.ts:180-193`), which the new GUI currently renders as the bare string `Permission ${status}: ${title}`:

```ts
export const RESOLUTION_SUMMARY: Readonly<Record<string, string>> = {
	allowed: "Allowed once by the operator.",
	rejected: "Rejected by the operator. Clio Coder was told no.",
	cancelled: "Withdrawn when the turn was cancelled. Clio Coder was not told no.",
	expired: "Nobody answered. The turn was stopped; Clio Coder was not told no.",
};
```

The distinction between 'told no' and 'not told no' is a real difference in what the model sees and must survive the port.

</details>

---

## Live status chip: the nine-state turn state machine

- priority: must-keep
- from: apps/workbench/src/chat.ts:210-258 and src/Chat.tsx:154-175
- to: apps/clio-coder-gui/client/chat/live-status.ts
- value: The new GUI's entire liveness signal is the string `" · Clio Coder is working…"` appended to a status line (sessions.tsx:257). The workbench derived nine distinct states from facts it already had and, critically, carried the *exact Clio-reported title* of the running tool as the chip's detail — so during a silent run the chip is the only place the operator learns which command is running. Cheap to port, disproportionate effect on perceived speed.

<details>
<summary>`liveStatus`, the nine `LiveState` values, `LIVE_GLYPHS`, and the `useNow` tick</summary>

```ts
export type LiveState = "starting" | "thinking" | "writing" | "acting" | "waiting" | "stopping" | "done" | "failed" | "stopped";
export interface LiveStatus { readonly state: LiveState; readonly label: string; readonly detail: string | null; }

export function liveStatus(turn: ChatTurn, row: Turn | undefined, pending: Permission | null): LiveStatus {
	if (row !== undefined && row.status !== "running") {
		if (row.status === "failed") return { state: "failed", label: "Failed", detail: row.problem?.detail ?? null };
		if (row.status === "cancelled") return { state: "stopped", label: "Stopped", detail: null };
		return { state: "done", label: "Complete", detail: null };
	}
	if (turn.origin === "replay") return { state: "done", label: "Earlier record", detail: null };
	if (pending !== null && pending.turnId === turn.turnId) {
		return { state: "waiting", label: "Waiting for your approval", detail: pending.title };
	}
	const last = turn.items.at(-1);
	if (last === undefined || last.kind === "user") return { state: "starting", label: "Starting", detail: null };
	if (last.kind === "tool" && last.status === "in_progress") return { state: "acting", label: "Running", detail: last.title ?? null };
	if (last.kind === "thought") return { state: "thinking", label: "Thinking", detail: null };
	if (last.kind === "text") return { state: "writing", label: "Writing", detail: null };
	if (last.kind === "notice") return { state: "waiting", label: "Waiting for your approval", detail: last.title ?? null };
	return { state: "acting", label: "Working", detail: null };
}
```

The workbench also had a `cancelling` phase from a session-level `WireClioPhase`. The new contract has no such phase, so drive `stopping` from the cancel mutation's own `isPending` in `CancelTurn` and pass it in as an override.

Glyph table (`Chat.tsx:154-164`), single-codepoint so it never reflows:
```ts
export const LIVE_GLYPHS: Readonly<Record<LiveState, string>> = {
	starting: "◌", thinking: "◔", writing: "◑", acting: "◐",
	waiting: "!", stopping: "–", done: "✓", failed: "✕", stopped: "–",
};
```

**Shared clock implementation.** One `useNow(active)` hook for the whole view, ticking at 1000 ms and only while `activeTurn !== null || pendingPermission !== null`, so the banner, the tool rows and the outcome footer can never disagree (`App.tsx:224-233`):
```ts
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}
```
Use `clock.now()` from `client/api/clock.ts` instead of `Date.now()` so the server-clock offset applies. And remember to pass `nowMs={turn.settled ? 0 : nowMs}` per the groupTurns artifact.

</details>

Chip markup (`Chat.tsx:166-175`): `role="status"`, glyph `aria-hidden`, label, optional detail, optional elapsed. Elapsed is only passed while the turn is live. Place it in the response header next to `Clio Coder`, not in a global status bar — it belongs to the turn.

The empty-response placeholder (`Chat.tsx:392`): while a turn is live and has produced no segments yet, render `<p className="chat-response__placeholder">{status.label}…</p>` so the response block is never a blank box.

---

## Chat turn layout: request, response, reasoning disclosure, outcome footer

- priority: must-keep
- from: apps/workbench/src/Chat.tsx:283-437
- to: apps/clio-coder-gui/client/chat/ChatTurn.tsx
- value: The actual DOM shape of the conversation and the interleaving rules for text/thinking/tools/notices. Includes the reasoning disclosure (thinking is collapsed behind a one-line preview, never inline prose) and the outcome footer that carries tool count and token usage per turn rather than only for the last turn as the new GUI does at sessions.tsx:276.

<details>
<summary>The turn component, its settled-segment rule, and the reasoning preview</summary>

```tsx
<article className={`chat-turn${live ? " is-live" : " is-settled"}${turn.origin === "replay" ? " is-replay" : ""}`}
	data-turn-id={turn.turnId}
	aria-label={turn.request === null ? "Turn" : `Request: ${turn.request.text.slice(0, 80)}`}>
	{turn.request !== null && (
		<div className="chat-request">
			<div className="chat-request__meta">
				<span className="chat-request__who">You</span>
				{turn.origin === "replay" && <span className="chat-request__replay">earlier record</span>}
				<time dateTime={startedAt}>{formatClock(startedAt)}</time>
			</div>
			<p className="chat-request__prompt">{turn.request.text}</p>
		</div>
	)}
	<div className="chat-response">
		<div className="chat-response__meta">
			<span className="chat-response__who">Clio Coder</span>
			<LiveChip status={status} elapsed={live ? elapsed : null} />
		</div>
		<div className="chat-response__body">{/* segments */}</div>
		{row !== undefined && row.status !== "running" && <TurnOutcome turn={row} toolCount={toolCount} />}
	</div>
</article>
```

**The user prompt is rendered as plain text, not Markdown.** A `<p>` with `white-space: pre-wrap`. Deliberate: the operator's own text must never be reinterpreted.

**Segment dispatch** with the streaming-tail rule (`Chat.tsx:365-391`) — only the LAST segment of a LIVE turn is treated as unsettled:
```tsx
turn.segments.map((segment, index) => {
	const settledSegment = !live || index < turn.segments.length - 1;
	switch (segment.kind) {
		case "response":
			return <MarkdownContent key={segment.item.id} source={segment.item.text}
				complete={settledSegment} deferDiagrams={live} />;
		case "reasoning": return <ReasoningDisclosure key={segment.item.id} item={segment.item} />;
		case "activity": return <ActivityGroup key={segment.items[0]?.id ?? index} items={segment.items} settled={settledSegment} … />;
	}
})
```

**`deferDiagrams={live}` is currently never passed** — `sessions.tsx:180` calls `<MarkdownContent source complete>` with no third prop. The renderer supports it (`client/render/Markdown.tsx:566`) and it matters: Mermaid lays a diagram out in one synchronous main-thread task (76 ms measured for a seven-node flowchart), so a diagram inside a completed narrative must still wait for the whole *turn* to settle, because Clio finishes a narrative before every tool burst and per-item completion is not a quiet moment.

**Reasoning disclosure** (`Chat.tsx:283-295`) — thinking is never inline prose:
```tsx
const preview = item.text.trim().split("\n", 1)[0] ?? "";
<details className="reasoning">
	<summary className="reasoning__summary">
		<span className="reasoning__label">Reasoning</span>
		<span className="reasoning__preview">{preview.length > 140 ? `${preview.slice(0, 140)}…` : preview}</span>
		<span className="reasoning__source">reported by Clio Coder</span>
	</summary>
	<p className="reasoning__body">{item.text}</p>
</details>
```
Closed by default, always. The 140-character first-line preview is the whole affordance.

**Outcome footer** (`Chat.tsx:305-323`), driven off the `Turn` row:
```tsx
<footer className={`turn-outcome${failed ? " is-failed" : stopped ? " is-stopped" : ""}`}>
	<span className="turn-outcome__glyph" aria-hidden="true">{failed ? "✕" : stopped ? "–" : "✓"}</span>
	<span className="turn-outcome__label">{failed ? "Turn failed" : stopped ? "Turn stopped" : "Turn complete"}</span>
	{(failed || stopped) && row.problem !== null && <span className="turn-outcome__detail">{row.problem.detail}</span>}
	{failed && <code className="turn-outcome__code">{row.stopReason}</code>}
	{toolCount > 0 && <span className="turn-outcome__fact">{toolCount} tool {toolCount === 1 ? "call" : "calls"}</span>}
	{row.usage !== null && <span className="turn-outcome__fact" title={usageTitle(row.usage)}>tokens {usageSummary(row.usage)}</span>}
	{row.finishedAt !== null && <time dateTime={row.finishedAt}>{formatClock(row.finishedAt)}</time>}
</footer>
```
with
```ts
const usageSummary = (u: Usage) => `${u.input.toLocaleString()} in · ${u.output.toLocaleString()} out`;
const usageTitle = (u: Usage) => `input ${u.input} · output ${u.output} · cache read ${u.cacheRead} · cache write ${u.cacheWrite} · reasoning ${u.reasoning}`;
```
Two numbers visible, five in the tooltip. The current GUI shows all five in a wall of text under the transcript, for the last turn only.

</details>

**Truncation note** (`Chat.tsx:423`), verbatim: `"Earlier turns are not shown; Clio Coder still has the full context."` — the current wording at sessions.tsx:263 says content "was omitted from this view to keep it bounded", which reads like data loss.

**Empty transcript** (`App.tsx:5966-5992`): a reticle glyph `◎`, eyebrow `NEW RESEARCH THREAD`, heading `What would you like to understand or change?`, and three starter prompts that fill the composer and focus it:
```ts
const STARTER_PROMPTS = [
	"Map this project and explain how its parts fit together.",
	"Run the existing checks and summarize what the evidence shows.",
	"Help me plan a careful change without editing anything yet.",
] as const;
```

---

## useFollowLatest: autoscroll that does not fight the operator

> Already shipped. Landed as `apps/clio-coder-gui/client/render/follow-latest.ts` with `FollowLatest.tsx` and `follow-latest.css`. No page mounts it yet.

- priority: must-keep
- from: apps/workbench/src/Chat.tsx:439-593
- to: apps/clio-coder-gui/client/chat/use-follow-latest.ts
- value: Absent from the new GUI. The hard part is not pinning to the bottom; it is distinguishing a scroll event caused by the hook's own write from one caused by the operator, so that content growth landing between a write and its event never reads as a scroll-away. The workbench solved this with a programmatic-top watermark plus a settling window for smooth scrolls, and used a ResizeObserver so no layout is read on the token path. The measured result: the transcript stayed put through the rest of a fast stream after a manual scroll, in every run.

Constants: `BOTTOM_TOLERANCE_PX = 32`, `SETTLE_TIMEOUT_MS = 1_200`.

<details>
<summary>`useFollowLatest`, the `following`/`unseen` state, and the jump button</summary>

```ts
export interface ScrollPosition { readonly top: number; readonly following: boolean; }
export interface FollowLatest {
	readonly following: boolean;
	/** Timeline activity arrived while the operator was scrolled away. */
	readonly unseen: boolean;
	jumpToLatest(): void;
	snapshot(): ScrollPosition;
	restore(position: ScrollPosition): void;
}

export function useFollowLatest(scrollRef: RefObject<HTMLElement | null>, enabled: boolean, activityKey: unknown): FollowLatest {
	const [following, setFollowing] = useState(true);
	const [unseen, setUnseen] = useState(false);
	const followingRef = useRef(true);
	const programmaticTop = useRef(0);
	const settling = useRef<{ lastTop: number; startedAt: number } | null>(null);

	const setFollow = useCallback((next: boolean) => {
		followingRef.current = next;
		setFollowing((current) => (current === next ? current : next));
		if (next) setUnseen(false);
	}, []);

	// Activity, not layout growth, is what marks something as unseen.
	useEffect(() => { if (!followingRef.current) setUnseen(true); }, [activityKey]);

	useEffect(() => {
		const element = scrollRef.current;
		if (element === null || !enabled) return;
		const atBottom = () => element.scrollHeight - element.scrollTop - element.clientHeight <= 32;
		const pin = () => { element.scrollTop = element.scrollHeight; programmaticTop.current = element.scrollTop; };
		const onScroll = () => {
			const top = element.scrollTop;
			const settle = settling.current;
			if (settle !== null) {
				const movedUp = top < settle.lastTop - 1;
				const expired = Date.now() - settle.startedAt > 1200;
				if (atBottom()) { settling.current = null; programmaticTop.current = top; setFollow(true); return; }
				if (!movedUp && !expired) { settle.lastTop = top; return; }
				settling.current = null;
			}
			if (atBottom()) { programmaticTop.current = top; setFollow(true); return; }
			if (top < programmaticTop.current - 1 || !followingRef.current) setFollow(false);
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { if (followingRef.current) pin(); });
		// The transcript element is replaced when a session or view changes, so the
		// size observation follows whichever child is current.
		let observed: Element | null = null;
		const observeContent = () => {
			const content = element.firstElementChild;
			if (content === observed) return;
			if (observed !== null) observer?.unobserve(observed);
			observed = content;
			if (content !== null) observer?.observe(content);
		};
		observeContent();
		const children = typeof MutationObserver === "undefined" ? null : new MutationObserver(observeContent);
		children?.observe(element, { childList: true });
		return () => { element.removeEventListener("scroll", onScroll); observer?.disconnect(); children?.disconnect(); };
	}, [scrollRef, enabled, setFollow]);

	const snapshot = useCallback((): ScrollPosition => ({ top: scrollRef.current?.scrollTop ?? 0, following: followingRef.current }), [scrollRef]);

	const restore = useCallback((position: ScrollPosition) => {
		const element = scrollRef.current;
		if (element === null) return;
		settling.current = null;
		setFollow(position.following);
		element.scrollTop = position.following ? element.scrollHeight : position.top;
		programmaticTop.current = element.scrollTop;
	}, [scrollRef, setFollow]);

	const jumpToLatest = useCallback(() => {
		const element = scrollRef.current;
		if (element === null) return;
		const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
		setFollow(true);
		if (reduced) { element.scrollTop = element.scrollHeight; programmaticTop.current = element.scrollTop; return; }
		settling.current = { lastTop: element.scrollTop, startedAt: Date.now() };
		element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
	}, [scrollRef, setFollow]);

	return { following, unseen, jumpToLatest, snapshot, restore };
}
```

Pass `activityKey = snapshot.timeline` (the array identity changes on every delta).

Companion affordance:
```tsx
export function JumpToLatest({ follow }: { follow: FollowLatest }) {
	if (follow.following) return null;
	return (
		<button type="button" className={`jump-to-latest${follow.unseen ? " has-unseen" : ""}`} onClick={follow.jumpToLatest}>
			<span aria-hidden="true">↓</span>
			{follow.unseen ? "New activity below" : "Jump to latest"}
		</button>
	);
}
```

</details>

**Per-route scroll memory** (`App.tsx:5919-5933`): keep a `Map<string, ScrollPosition>` keyed by route, snapshot on navigate away, and `restore()` in a `useLayoutEffect` on arrival. Restoring through the hook is what keeps the scroll event caused by swapping content from reading as the operator's — a transcript left scrolled up stays there even after a short page clamped the region to the top in between.

**On send**, call `jumpToLatest()` — the operator asking a question is consent to follow the answer.

---

## Frame-coalesced event delivery and the 120 Hz path

> Already shipped. Landed as `apps/clio-coder-gui/client/api/frame-buffer.ts`, wired through `client/api/events.ts`. `scripts/perf-workload.ts` is still unported.

- priority: must-keep
- from: apps/workbench/src/event-buffer.ts (whole file) + apps/workbench/PERFORMANCE.md
- to: apps/clio-coder-gui/client/api/frame-buffer.ts + docs/gui-performance.md
- value: Directly serves the 120 fps ask. The new GUI applies every SSE delta synchronously in the EventSource handler (client/api/events.ts:22-30) and calls setQueryData per event, so a 1,358-event turn is 1,358 React renders. The workbench coalesced high-frequency text into one batch per animation frame while keeping every control event immediate, and the measured result is in PERFORMANCE.md: frame p95 16.7-16.8 ms, keystroke-to-input p95 2-3 ms, zero frames over 33 ms during streaming in the quiet runs. That is the HPC feel the product is claiming.

<details>
<summary>`FrameEventBuffer`, the injectable `FrameClock`, and the 128-event batch cap</summary>

```ts
import type { Event } from "../../contracts/events.js";

export const MAX_FRAME_EVENT_BATCH = 128;

export interface FrameClock { request(cb: FrameRequestCallback): number; cancel(handle: number): void; }
const browserFrameClock: FrameClock = { request: requestAnimationFrame, cancel: cancelAnimationFrame };

/** Only text and thought deltas may wait for the next paint. */
function mayWaitForPaint(event: Event): boolean {
	return event.type === "turn.text" || event.type === "turn.thought";
}

export class FrameEventBuffer {
	readonly #deliver: (events: readonly Event[]) => void;
	readonly #clock: FrameClock;
	readonly #maximumBatch: number;
	#pending: Event[] = [];
	#frameHandle: number | null = null;
	#closed = false;

	constructor(deliver: (events: readonly Event[]) => void, clock: FrameClock = browserFrameClock, maximumBatch = MAX_FRAME_EVENT_BATCH) {
		if (!Number.isSafeInteger(maximumBatch) || maximumBatch < 1) throw new Error("Frame event batch size must be a positive safe integer.");
		this.#deliver = deliver; this.#clock = clock; this.#maximumBatch = maximumBatch;
	}

	push(event: Event): void {
		if (this.#closed) return;
		this.#pending.push(event);
		// Tool, permission, fleet, terminal and error events remain immediate. Any
		// text already waiting precedes them in this same delivery.
		if (!mayWaitForPaint(event) || this.#pending.length >= this.#maximumBatch) { this.flush(); return; }
		if (this.#frameHandle !== null) return;
		this.#frameHandle = this.#clock.request(() => { this.#frameHandle = null; this.#deliverPending(); });
	}

	flush(): void { if (this.#closed) return; this.#cancelFrame(); this.#deliverPending(); }
	close(): void { if (this.#closed) return; this.#closed = true; this.#cancelFrame(); this.#pending = []; }
	#cancelFrame(): void { if (this.#frameHandle === null) return; this.#clock.cancel(this.#frameHandle); this.#frameHandle = null; }
	#deliverPending(): void { if (this.#pending.length === 0) return; const events = this.#pending; this.#pending = []; this.#deliver(events); }
}
```

**Wiring into `subscribe()`** (`client/api/events.ts`): construct one buffer per subscription; `receive` pushes into it; the deliver callback runs the *entire batch* through `SessionBuffer.event()` and calls `queries.setQueryData` **once**, with the final snapshot. Return `() => { buffer.close(); stream.close(); }`. Ordering is preserved because a control event flushes any pending text before itself — this invariant is why the buffer is safe, and it must be kept under test.

</details>

**Why this gives 120 Hz and not just 60 Hz:** `requestAnimationFrame` fires at the display's refresh rate. At 120 Hz the buffer simply delivers twice as often with half the batch, so the per-frame cost halves rather than the frame rate. The work that must NOT be on this path is layout reads and synchronous parsing — which is why the follow-latest hook uses a ResizeObserver rather than reading `scrollHeight` per token, and why the incremental Markdown lexer re-lexes only the tail after the last block boundary.

**Budget to hold, from PERFORMANCE.md** (headless Chrome 151, 24 CPUs, WSL2, 60 Hz compositor, ~16 KB of Markdown per turn streamed in 5-char chunks, 1,358 `turn.text` events/turn, tool bursts between blocks, 64 keystrokes typed during the stream):

| Metric | Target |
| --- | --- |
| Frame p95 during stream | ≤ 16.8 ms (≤ 8.3 ms at 120 Hz) |
| Tasks > 50 ms during stream | 0 |
| Keystroke → `input` p95 | ≤ 3 ms |
| Keystroke → next frame p95 | ≤ 19 ms |
| Event → paint p50 / p95 | ≤ 27 / 35 ms |
| DOM nodes after 2 turns | ≤ 2,100 |
| Heap peak | ≤ 20 MB |
| 64-turn session resume | ≤ 175 ms, ≤ 700 nodes |
| Draft survives the turn | always |
| Manual scroll held through stream | always |

**Known remaining long task:** Mermaid diagram layout, ~49-79 ms, deliberately moved to *after* the stream settles by the `deferDiagrams` mechanism, rendering one diagram at a time with a macrotask between them. Do not regress this by rendering diagrams inline during a turn.

**Explicitly not measured** (carry into the doc so nobody claims it): real 120 Hz or 144 Hz displays, any GPU-composited path, long code fences that never close during a stream (the tail re-lex grows with the unsettled block), diagrams larger than a seven-node flowchart, an unloaded machine, and real Clio output rather than a fixture.

The workbench's harness (`scripts/perf-workload.ts`, 510 lines) is worth reimplementing against the new stack with playwright-core, which is already a devDependency; it drove headless Chrome at 1600×1100, paced the fixture at 4 ms, captured a Chrome trace, and emitted the JSON these tables were generated from.

---

## Stream-run splitting and bounded text accumulation

- priority: must-keep
- from: apps/workbench/src/timeline.ts:99-165, 275-293
- to: apps/clio-coder-gui/contracts/session-projection.ts (amendment)
- value: A correctness bug the new GUI inherits from a simplification. `applySessionDelta` keys a text run on `${turnId}:${kind}${identity}` — one bucket per (turn, kind, agent) for the whole turn. So a turn that writes prose, runs three tools, then writes more prose appends the second paragraph onto the first, and the tool group ends up rendered AFTER both paragraphs instead of between them. The workbench keyed a run on whether the immediately-preceding timeline item was the same run, which is what produces correct interleaving.

**The rule** (`timeline.ts:275-293`): a text or thought delta continues the previous run only if the LAST item in the timeline is already that run; otherwise it starts a new run with a fresh ordinal.

<details>
<summary>How a stream run is keyed and split, and the safety card's summary line</summary>

```ts
case "turn.text":
case "turn.thought": {
	const streamKind = event.type === "turn.thought" ? "thought" : "text";
	const prefix = `${turnId}:${streamKind}${identity}:`;
	const prior = state.timeline.at(-1);
	const streamId = prior?.id.startsWith(prefix) === true ? prior.id : `${prefix}${nextOrdinal}`;
	upsert({ id: streamId, … }, /* append */ true);
	break;
}
```

Keep the agent identity in the prefix (the new GUI's `identity` suffix is a genuine improvement — a worker's prose must not merge into the orchestrator's), but move it before the ordinal so the prefix test still works.

**Loop/safety card summary string:**
```
Repeated ${repeatCount} times; ${blocksThisTurn} of ${budget} blocks used this turn (${disposition}).${interrupted ? " Clio Coder interrupted the turn." : ""}
```

</details>

**Bounded append** — the workbench's version, which the new GUI already has as `boundedText` but applies with a different marker and limit. Reconcile on one:
- `MAX_TIMELINE_STREAM_BYTES = 64 * 1024` per run (the new GUI uses 65536 — same number, keep it);
- marker `"\n[… stream truncated by GUI …]"` — the new GUI's `"\n[… stream truncated …]"` loses the attribution; prefer the explicit one so the operator knows it was the GUI and not Clio;
- once a run ends with the marker, further appends are dropped entirely rather than re-bounded (`timeline.ts:118-121`). The new GUI already does this correctly.
- Truncation is UTF-8-byte-exact and code-point-aligned: iterate `for (const character of value)`, accumulate `encoder.encode(character).byteLength`, break before exceeding `limit - markerBytes`. Never slice by JS string index — that splits surrogate pairs.

**Ordinal minting.** The workbench kept a monotonic `ordinal` that is the max `sequence` in the timeline, so new items take `ordinal + 1` and ids never collide after the timeline is bounded. The new GUI's `upsert` computes `(state.timeline.at(-1)?.sequence ?? 0) + 1`, which regresses after the head is dropped by the byte bound — two runs can then collide on the same id. Use `state.timeline.reduce((m, i) => Math.max(m, i.sequence), 0) + 1`, or better, carry the running maximum on the snapshot.

**Loop/safety cards.** The workbench minted a first-class timeline item for `safety.loopBlocked` (`timeline.ts:325-342`) with the title `Clio Coder blocked a repeated ${tool} call`. The new GUI routes `fleet.loopBlocked` into the fleet strip as a JSON blob (`session-controls.tsx:281`), where it is invisible in the conversation. It belongs in the activity group as a `notice` item with `kind: "safety"`, because it is the one thing that explains why a turn stopped making progress. `FleetPayloads["fleet.loopBlocked"]` already carries every field the sentence needs.

---

## Message-level actions and composer behavior

- priority: should-keep
- from: apps/workbench/src/App.tsx:5750-5828 (PromptEditor), src/Markdown.tsx:83-128 (CopyButton), src/markdown.ts:206-216 (tokenText)
- to: apps/clio-coder-gui/client/chat/message-actions.tsx
- value: Records honestly what existed (little) and specifies what should. The workbench had only per-code-block copy; there was no copy-message, retry, branch, or per-message collapse. The composer, by contrast, had three behaviors worth keeping that the new one lacks: Ctrl/Cmd+Enter to send, a Stop button that replaces Send in place while a turn runs, and a draft that provably survives a full streaming turn.

**What existed.** `CopyButton` (already ported to `client/render/Markdown.tsx:107`) with a `navigator.clipboard.writeText` primary path, a hidden-textarea + `document.execCommand("copy")` fallback, and a 1,600 ms `Copied` / `Copy failed` state that clears itself. Every fenced code block and every Mermaid source carries one. `tokenText(tokens)` flattens a marked token tree to plain text and exists precisely to give a copy action and an accessible name the same string.

**What to add, in priority order.**

1. **Copy response.** A quiet button in the `chat-response__meta` row, visible on hover and always visible on focus. Copies the concatenation of the turn's `response` segment texts joined by `"\n\n"` — the raw Markdown, not the rendered text, because the operator is almost always pasting into another Markdown surface. Reuse `CopyButton`.
2. **Copy request.** Same, on `chat-request__meta`, copying `turn.request.text` verbatim.
3. **Retry.** On a turn whose `Turn.status` is `failed` or `cancelled` only. Fills the composer with `turn.request.text` and focuses it — it does NOT auto-send. Label `Try again`. Rationale: a failed turn usually needs the prompt edited, and auto-sending an identical prompt into a failing route is the loop the safety system exists to break.
4. **Collapse turn.** A chevron on `chat-turn` that collapses the whole response to its outcome footer, defaulting open. Per-turn local state, not persisted. Useful on a long session; do not over-invest.
5. **Branch — do not build for v0.5.0.** There is no wire affordance: `routes.turn` posts into the session's single linear timeline and `SessionSnapshot` has no branch identity. It would need a new ACP concept (fork a session at a turn), which is a larger change than the MVP carries. Record it as deliberately deferred.

**Composer** (`App.tsx:5750-5828`), replacing `client/pages/sessions.tsx`'s form:
- `Ctrl`/`Cmd`+`Enter` submits (`matchesKeybinding(KEYBINDINGS.send, event)` then `event.currentTarget.form?.requestSubmit()`), with the hint `Ctrl or Cmd + Enter sends` in the footer. Plain `Enter` inserts a newline.
- While a turn is running, the submit button is **replaced in place** by a `Stop` button wired to `routes.cancelTurn` — same grid cell, same size, no layout shift. The current GUI disables Send and puts Cancel in a separate control strip above the transcript.
- The textarea is **never disabled while a turn runs** — only the submit is. The operator drafts the next prompt while Clio works; the perf harness asserts the draft survives the turn. The current code sets `disabled={busy || snapshot.state !== "open"}`, which throws the draft away and blurs focus mid-thought. Change to `disabled={snapshot.state !== "open"}`.
- Footer notice when the session is occupied but no turn id is available yet: `"Clio Coder is finishing the previous prompt."`
- Footer privacy line: `"Prompts go only to the Clio Coder target you configured."`
- Placeholder: `"Ask Clio Coder to do something in this project"`, or `"Open a project first"` when there is no workspace.

<details>
<summary>The `KEYBINDINGS` registry and the `Keybinding` shape behind the help sheet</summary>

**Keybinding registry** (`apps/workbench/src/help-reference.ts:27`). Keep the pattern: one exported table, handlers match against entries rather than literals, and the in-app help reference is generated from the same table so it cannot drift.

```ts
export interface Keybinding { readonly id: string; readonly key: string; readonly modifiers: readonly ("primary" | "alt" | "shift")[]; readonly action: string; readonly where: string; }
export const KEYBINDINGS = {
	send:      { id: "send",      key: "Enter",  modifiers: ["primary"], action: "Send the request in the composer", where: "While the composer has focus" },
	allowOnce: { id: "allowOnce", key: "a",      modifiers: ["alt"],     action: "Allow the pending approval once",  where: "Anywhere, while an approval is waiting and no dialog is open" },
	reject:    { id: "reject",    key: "r",      modifiers: ["alt"],     action: "Reject the pending approval",      where: "Anywhere, while an approval is waiting and no dialog is open" },
	escape:    { id: "escape",    key: "Escape", modifiers: [],          action: "Close the open dialog or drawer",   where: "While a dialog or a drawer is open" },
} as const;
```

`primary` is Ctrl on Linux/Windows and Cmd on macOS; single-character keys compare case-insensitively.

</details>

---

## Fleet strip: dispatch runs in the conversation

- priority: should-keep
- from: apps/workbench/src/Chat.tsx:79-152
- to: apps/clio-coder-gui/client/chat/FleetStrip.tsx
- value: The new GUI's FleetStrip (session-controls.tsx:270-286) prints `fleet.enqueued` and a JSON payload per row. The workbench folded every dispatch event into ONE row per run, keyed on runId, showing the agent, state, task preview, node, progress count, outcome and duration — a live fleet view inside the chat. It also carried a Running-only filter that is off by default, with the reasoning recorded: a settled row must never disappear unannounced.

<details>
<summary>`FleetRun`, the five run states, their glyphs, and the folding rule</summary>

**Fold events into runs.** `SessionSnapshot.fleet` is an append-only list of `FleetItem { id, at, sourceSequence, fact }`. Reduce it to one row per `runId`:

```ts
export type FleetRunState = "queued" | "running" | "progress" | "done" | "failed";
export interface FleetRun {
	readonly runId: string; readonly agentId: string; readonly state: FleetRunState;
	readonly taskPreview: string | null; readonly node: string | null; readonly attempt: number | null;
	readonly progressCount: number; readonly progressTruncated: boolean;
	readonly outcome: string | null; readonly durationMs: number | null; readonly tokenCount: number | null;
	readonly updatedAt: string;
}
```

Fold rules, by `fact.type`: `fleet.enqueued` → `queued` (sets agentId, taskPreview, node, attempt); `fleet.started` → `running`; `fleet.progress` → `progress` and sets `progressCount`/`progressTruncated` (note `progress` is deliberately NOT a phase of its own — it is a running run that has reported activity, kept distinct so the strip can show that a run is doing work rather than merely admitted); `fleet.completed` → `done` with `outcome`, `durationMs`, `tokenCount`; `fleet.failed` → `failed` with `outcome`/`reason`, `durationMs`. Cap at 64 runs, dropping the oldest **settled** one first. `evidence.ready` and `fleet.loopBlocked` are not runs — route the first to the evidence surface and the second into the activity group (see the stream-splitting artifact).

Glyph and state label mappings:
```ts
const FLEET_GLYPHS = { queued: "…", running: "◐", progress: "◑", done: "✓", failed: "✕" };
const FLEET_STATE_LABELS = { queued: "queued", running: "running", progress: "working", done: "done", failed: "failed" };
```

</details>

**Presentation** (`Chat.tsx:85-152`):
- Container is `<details className="activity" open={live > 0}>` where `live = runs.filter(r => r.state === "queued" || r.state === "running" || r.state === "progress").length`. Summary: glyph `⛭`, label `Fleet · ${live} running of ${runs.length}`, count badge.
- Filter chip `Running only` with `aria-pressed`, **off by default**, and a `role="status"` line reading either `` `${shown} of ${total} reported ${total === 1 ? "run" : "runs"} shown` `` or `` `All ${total} reported ${total === 1 ? "run" : "runs"} shown` ``.
- Empty-with-filter: `"No run is running right now. Every reported run has settled."`
- Row: glyph, `agentId` as the kind column, then title column = `taskPreview ?? "No task preview was reported."` with `node ${node}` as a note beneath, then state column = state label plus, appended as `· `-separated fragments in this order: `outcome`, `${progressCount}${progressTruncated ? "+" : ""} steps` (only when `> 0`), `formatDuration(durationMs)`.
- Every value shown is a reported fact. Nothing is derived and nothing is shown for a run that was never reported. `taskPreview` is Clio's own sanitized 160-byte prefix, never the exact task.

**Correlate with the dispatch tool call.** When a `tool` item has `title === "dispatch"`, render its matching fleet rows inline in the tool card body (match on the `runId` in `rawOutput.result.details` or, failing that, on agent + time proximity). This is the link the workbench could not make and is the single biggest readability win for orchestration sessions.

---

## Inspector presentation atlas: what each of the thirteen showed, in what order

- priority: must-keep
- from: apps/workbench/src/App.tsx (the 13 panels) cross-referenced with apps/workbench/clio-*-inspector.ts
- to: docs/gui-inspector-presentation.md
- value: This is the answer to the audit question. The DATA claim is verified — every field each inspector produced has a home in contracts/*.ts. What is not reproduced is the ordering, grouping, disclosure and empty-state grammar, which is where all the design work went. One table per inspector so an implementer can rebuild a panel without the original.

**Verification of the audit's data claim, per inspector → new route:**

| Inspector | Data reproduced by | Verdict |
| --- | --- | --- |
| catalog (26K) | `contracts/library.ts` | yes, with agents/skills/verifiers/extensions collapsed into one `Library` shape |
| config (16K) | `contracts/settings.ts` + `settings-safe.ts` | partial: `WireCustomizationEntry.contextCostTokens` and `reloadClass` have no counterpart — add them |
| decisions (12K) | `contracts/evidence.ts` (`gate`) | yes, but shape is opaque (`JSON.stringify(gate)` at evidence.tsx:226) |
| dispatch (8K) | `contracts/fleet.ts` | yes |
| evidence (17K) | `contracts/evidence.ts` | yes |
| fleet (25K) | `contracts/fleet.ts` + `fleet-events.ts` | yes |
| interop (11K) | `contracts/targets.ts` + `targets-cli.ts` | partial: the four wiring states (configured / not-ACP / proposed / decided) are not modelled |
| recovery (10K) | `contracts/system.ts` | yes |
| routing (12K) | `contracts/targets.ts` | yes |
| toolchain (9K) | `contracts/toolchain.ts` | yes |
| trace (15K) | `contracts/traces.ts` | yes |
| usage (16K) | `contracts/reports.ts` | partial: the 5-field token split + origin split (turns/sideQuestions/handoffs) is not modelled |

**The empty-state grammar — the most reusable thing here.** Every panel distinguished four states and used different words for each. Reproduce this everywhere:
1. *Not read in this session* — `"The durable evidence inventory has not been read in this session."` / `"No diagnostic sweep has run in this desktop session. Nothing is inferred from a successful conversation."`
2. *Store missing* — `"This installation has never built evidence, so it has no evidence store at all. That is a missing store, not an empty one."` A dash in a figure means the store was not found: `"A dash means Clio Coder could not find that local history store. It does not mean zero activity."`
3. *Store present, nothing in it* — `"Clio Coder has built no evidence bundles on this installation. This is an empty record, not a health claim."`
4. *Record predates the schema* — `"This bundle predates the canonical trust projection, so it records no axes to open."`

And a fifth, for every bounded list: `"Older evidence bundles are outside this bounded window."` / `"Later phases are outside this bounded index."` / `"rarer kinds not shown"`. Every truncation flag on the wire gets a sentence; none is silently dropped.

<details>
<summary>The fact order and grouping each of the thirteen inspectors used</summary>

- **config** → *Effective Clio Map*. Four summary figures first: effective setting facts, customization surfaces, estimated context cost (`~` + locale-formatted sum of `contextCostTokens`), needs-a-restart count. Then a three-stage "influence path" diagram: **01 Sources** (scope + setting-source counts, merged into one map, sorted by count descending then name, top 8) → **02 Loaded layers** (categories in `CUSTOMIZATION_CATEGORY_ORDER`, shown as a 3-4 letter code plus label) → **03 Behavior**. Then settings grouped by *family* (`key.split(/[.[]/, 1)[0]`), families sorted alphabetically. Entry source line: the project-relative path, or `"project root"` when the path is `/`, or `` `${scope} scope` `` when no path.
- **catalog** → tabbed (Agents / Skills / Verifiers / Library / Extensions) with arrow-key tab navigation. Agent card facts in order: capability, project context tier, tool-call budget (`min–max` or bare `min`), read reserve; bound skills as chips; declared tool surfaces behind `<details>` with the count on the summary; footer = result contract + `"Text synthesis at boundary"` / `"Stops at boundary"`. Skill card leads with the *reach sentence* — `"The model can load this by name"` / `"Its root is not trusted, so the model never sees it"` / `"Its frontmatter reserves it for you"` — then precedence, root trust, model invocation; footer counts issues and flags `installed by a dispatched worker` / `has an upstream`. Free-text query filters across all string fields, case-folded with `toLocaleLowerCase("en-US")`.
- **usage** → 30-day window, stated as `from … through …`. Summary: total tokens (+ API calls), Clio-reported cost (`"Recorded cost, never a GUI estimate"`), sessions, dispatch runs. Then token composition as five comparative bars — **`"Bars compare token fields with one another; they are not additive percentages. Provider accounting can overlap cache and reasoning fields."`** Then origin split (turns / side questions / handoffs), models sorted by tokens, skills split into activated vs dormant.
- **trace** → per run: status mark, four totals (tokens, cost, wall time, runtime), then an ordered phase list with name / `kind · owner` / `tokens · cost · duration · N retries` / status, then event-kind and process-kind histograms. Boundary line: `"Event payloads, event names, and process command lines stay on the host by design. What crosses is how many of each kind there were."`
- **toolchain** → one resolution label per item, with a deliberate three-way split: `!supported → "Platform unsupported"/neutral`; `source === "path" → "Using PATH"/success`; `source === "vendored" → "Using pinned copy"/success`; otherwise `"Not available"/warning`.
- **interop** → summary (detected of known kinds, wired as peers, would be offered, detected-at), then one row per agent with the wiring sentence. Boundary: detection reads files only, starts no agent, and the version shown is the last one Clio recorded — `"opening this panel cannot become 'execute every coding agent installed on this machine'"`.
- **routing** → target selector (targets derived client-side from the model rows, deduped and `localeCompare`-sorted), then a filtered model grid. Filter is a `useDeferredValue` over the lowercased query, matched against `[modelId, runtimeId, residency, ...capabilities]`. Zero values render `"Not reported"`, never `0`.
- **dispatch** → installation-wide, explicitly not project-scoped and not a live stream: `"This is global installation state, not a fact about the selected project and not a live event stream."`
- **recovery**, **evidence**, **fleet**, **decisions** → see their own artifacts.

</details>

**Shared idioms worth extracting into `client/design/`:**
- `<StatusMark tone label>` — a glyph + label pair with tones `success | warning | error | neutral | info | action`. Used by every panel; there is no other status primitive.
- A `PanelHeading` with `eyebrow` (all-caps, wide-tracked), `title`, optional action slot. Every panel opens with an eyebrow that names the data's *scope and mutability*: `EVIDENCE BUNDLES · INSTALLATION-WIDE`, `DURABLE ACCOUNTING · TRACE DATABASE`, `INSTALLATION · REDACTED DIAGNOSTICS`, `MODELS · WORKER ROUTING`, `GATE DECISIONS · SEALED COORDINATOR VERDICTS`, `COUNCIL TOPOLOGY · SEATED VOICES AND ROUNDS`, `APPROVAL NEEDED · ONE USE`.
- A closing **boundary paragraph** on every panel naming exactly what stays on the host. These are not boilerplate; each one is specific and each should survive.
- Formatters: `formatTokens(v) = v === null ? "not recorded" : v.toLocaleString("en-US")`; `formatCostUsd(v) = v === null ? "not recorded" : "$" + v.toFixed(v > 0 && v < 0.01 ? 4 : 2)` — **exactly zero prints as `$0.00`, not "free", because a local runtime that prices at zero and a run whose cost was never recorded are different facts and only the second is null**. `client/api/clock.ts` already has `formatCost` and `formatTokens` matching this; keep them.

---

## Evidence trust record: axes, verdicts, and tone

- priority: must-keep
- from: apps/workbench/src/App.tsx:4556-4630 and 4633-4770 (EvidenceInventory)
- to: apps/clio-coder-gui/client/pages/evidence.tsx (replacing JSON dumps at :201,:226,:231)
- value: Six named trust axes with a three-way tone function that distinguishes a stated negative from a stated absence from a qualified positive. This distinction is the whole point of the evidence system and is currently invisible — evidence.tsx renders `JSON.stringify(run.status)`.

<details>
<summary>`EVIDENCE_VERDICT_PRESENTATION`, the axis labels, and `evidenceAxisTone`</summary>

```ts
export const EVIDENCE_VERDICT_PRESENTATION: Record<string, { label: string; tone: string }> = {
	reviewed:    { label: "Reviewed",      tone: "success" },
	grounded:    { label: "Grounded",      tone: "success" },
	unverified:  { label: "Unverified",    tone: "warning" },
	compromised: { label: "Compromised",   tone: "error"   },
	unknown:     { label: "Trust unknown", tone: "neutral" },
};

export const EVIDENCE_AXIS_LABEL: Record<string, string> = {
	artifactIntegrity:   "Artifact integrity",
	validationGrounding: "Validation grounding",
	independentReview:   "Independent review",
	contextProvenance:   "Context provenance",
	autonomyEnforcement: "Autonomy enforcement",
	completionEvidence:  "Completion evidence",
};

/** States that are a stated negative rather than a stated absence. */
const EVIDENCE_AXIS_FAULTS = new Set(["failed", "ungrounded", "not_independent", "invalid", "bypassed", "incomplete"]);

export function evidenceAxisTone(state: string): string {
	if (EVIDENCE_AXIS_FAULTS.has(state)) return "error";
	if (state === "absent" || state === "unknown" || state === "not_applicable") return "neutral";
	if (state === "approximated" || state === "limited" || state === "inconclusive") return "warning";
	return "success";
}
```

Axis state values render with `state.replaceAll("_", " ")`. Axes are rendered in the declaration order of `EVIDENCE_AXIS_LABEL` — iterate `Object.keys(EVIDENCE_AXIS_LABEL)`, never the payload's key order, so a bundle missing an axis still shows the slot.

</details>

**Bundle card, fact order:** id + `sourceKind · generatedAt` in the header with the verdict `StatusMark`; then a four-cell `<dl>`: Runs / Tool calls (with ` · N blocked` appended only when `> 0`) / Tokens / Cost; then tags as chips; then a row of run-id buttons, **each disabled when the run is outside the current run window** with `title="This run is outside the current run window"` — a disabled-but-present button is how the panel says "this exists, you just cannot get there from here"; then `and more` when `runIdsTruncated`.

**Trust record disclosure:** a button whose label is a three-state machine — `Open trust record` → `Reading trust record…` (while `pendingReadId === evidenceId`) → `Trust record open`, with `aria-expanded`. Disabled when `artifact.trust.historical` (there is nothing to open) or while any read is in flight.

**The note line under each bundle**, assembled from three optional clauses in this order:
- `trust.historical ? "Built before the canonical trust projection, so it carries no verdict of its own." : \`Trust recorded for ${runsCovered.toLocaleString()} run${s}.\``
- when `redactionCount > 0`: `` ` ${n.toLocaleString()} secret-shaped value${n === 1 ? " was" : "s were"} redacted at build time.` ``
- when `totals.protectedArtifacts > 0`: `` ` ${n.toLocaleString()} protected artifact event${s} recorded.` ``

**Panel-level copy** (keep verbatim): `"Each bundle's shape and how far it can be trusted. A bundle covering several runs takes the verdict of its weakest run. Task text, working directories, and the files inside a bundle stay on the host."` The weakest-run rule is a semantic the reader cannot infer from the number.

<details>
<summary>`FLEET_VERIFY_PRESENTATION` and the reason text for each receipt verdict</summary>

**Receipt verification**, a separate four-state axis with its own reason taxonomy:

```ts
export const FLEET_VERIFY_PRESENTATION = {
	pending:     { label: "Not sealed yet",                 tone: "neutral" },
	verified:    { label: "Receipt authenticates",          tone: "success" },
	failed:      { label: "Receipt did not authenticate",   tone: "error"   },
	unavailable: { label: "Nothing to authenticate",        tone: "warning" },
};
export const FLEET_VERIFY_REASON_TEXT = {
	"integrity-mismatch":      "The receipt's own seal does not cover its current contents.",
	"ledger-mismatch":         "The receipt no longer agrees with its ledger entry.",
	"integrity-invalid":       "The receipt's integrity record is not readable.",
	"execution-role-invalid":  "The receipt records an execution role Clio Coder does not recognise.",
	"routing-intent-invalid":  "The receipt records a routing intent Clio Coder does not recognise.",
	"route-decision-invalid":  "The receipt records a route decision Clio Coder does not recognise.",
	"receipt-unreadable":      "Clio Coder could not read the stored receipt.",
	"envelope-unavailable":    "Clio Coder has no ledger entry to check the receipt against.",
	unclassified:              "Clio Coder refused the receipt for a reason this build does not classify.",
};
```

</details>

---

## Gate decisions and council topology taxonomies

- priority: must-keep
- from: apps/workbench/src/App.tsx:4004-4235 (labels, tones, GateDecisions) and 4247-4445 (CouncilTopology)
- to: apps/clio-coder-gui/client/pages/fleet.tsx + client/pages/evidence.tsx
- value: Five closed label taxonomies that translate enum identifiers into operator English, plus the independence rule, which is a genuine piece of domain reasoning encoded in four lines. All of it is currently `JSON.stringify(gate)` at evidence.tsx:226 and `JSON.stringify(artifact)` at fleet.tsx:238.

<details>
<summary>Gate outcome and reason labels, `gateOutcomeTone`, and the council taxonomies</summary>

```ts
export const GATE_OUTCOME_LABELS: Readonly<Record<string, string>> = {
	pass: "passed", fail: "failed", revise: "sent back for revision",
	exhausted: "ran out of cycles", winner: "picked a winner", "no-winner": "picked nobody",
	"operator-confirmed": "confirmed by the operator", "full-auto-applied": "applied under full-auto",
};

export const GATE_REASON_LABELS: Readonly<Record<string, string>> = {
	"all-candidates-failed": "every candidate builder failed, so there was nothing to judge",
	"builder-run-failed": "the builder run did not finish",
	"reviewer-run-failed": "the reviewer run did not finish",
	"reviewer-checks-failed": "the reviewer reported failed checks",
	"reviewer-report-invalid": "the reviewer did not answer under its typed contract",
	"judge-run-failed": "the judge run did not finish",
	"judge-result-invalid": "the judge did not answer under its typed contract",
	"judge-winner-out-of-range": "the judge named a candidate that does not exist",
	"judge-picked-failed-candidate": "the judge picked a candidate whose builder had failed",
	"winner-touches-protected-artifact": "the winning candidate changed a protected artifact",
	"operator-confirmed-winner": "an operator confirmed the prior judge decision",
	"full-auto-applied-winner": "full-auto applied the prior judge decision",
	unclassified: "Clio Coder recorded a reason this GUI does not classify",
};

export function gateOutcomeTone(outcome: string): string {
	if (outcome === "pass" || outcome === "winner" || outcome === "operator-confirmed") return "success";
	if (outcome === "fail" || outcome === "exhausted" || outcome === "no-winner") return "error";
	return "action";
}

export const COUNCIL_OUTCOME_LABELS: Readonly<Record<string, string>> = {
	succeeded: "answered", failed: "failed", timed_out: "timed out", stalled: "stalled",
	canceled: "canceled", denied_by_policy: "denied", spawn_failed: "never started",
};
export const COUNCIL_ORIGIN_LABELS: Readonly<Record<string, string>> = {
	user: "the operator asked for it", agent: "Clio Coder asked for it", internal: "the runtime started it",
};
export const COUNCIL_SYNTHESIS_LABELS: Readonly<Record<string, string>> = {
	none: "none; the members' answers stand alone",
	vote: "a majority over the members' own verdicts",
	judge: "a judge dispatched to synthesize the answers",
};
export const councilTurnLabel = (turn: { terminal: boolean; round: number; outcome: string | null }) =>
	!turn.terminal ? `round ${turn.round} · in flight`
		: `round ${turn.round} · ${turn.outcome === null ? "no outcome recorded" : COUNCIL_OUTCOME_LABELS[turn.outcome] ?? turn.outcome}`;
```

**Independence definition and helper:**
> Independence is defined as sharing neither the agent nor the model family: a shared target, runtime, or node is an operational fact about a small fleet, while a shared agent or model family is a shared failure mode, and only those two can make a verdict self-confirming.

```ts
export function gateIndependenceText(decision: { correlation: { independent: boolean; agent: boolean; modelFamily: boolean } | null }): string {
	if (decision.correlation === null) return "no decider ran";
	if (decision.correlation.independent) return "independent of the route it graded";
	const shared = [...(decision.correlation.agent ? ["the same agent"] : []), ...(decision.correlation.modelFamily ? ["the same model family"] : [])];
	return `not independent: ${shared.join(" and ")}`;
}
```

</details>

**Card shape.** Header: `` `${topology === "review" ? "Review" : "Compete"} gate ${GATE_OUTCOME_LABELS[outcome] ?? outcome}` `` plus the group id as `<code>`, with a `StatusMark` carrying `cycle ${n}`. `<dl>`: Sealed (timestamp) / Independence / Winner (`"not a winner-picking outcome"` when null, else `candidate ${index}`) / Confirms (`"not a confirmation"` when null). Then a run list: each subject with role `graded` or `graded · winner`, then the decider with role `reviewer` or `judge`; each is a button, **disabled and suffixed `· outside this run window`** when not in the known-run set, `aria-current` when selected. Then the classified reason plus the fixed clause `". The exact text Clio Coder recorded stays on the host."`

**Two bound notes:** `"This gate graded more runs than the bounded list names."` and, at panel level, the alarm variant `` `${unverifiable} sealed decision file(s) in this scan no longer authenticate against their own integrity digest and are not shown.` ``

**Why this surface exists** (keep verbatim in the panel): `"A review or compete gate seals its verdict beside the receipts it graded, because writing it into them would invalidate their evidence. This is that verdict, who it graded, and whether the grader was independent of the route it was grading. The reasoning behind it stays on the host."`

**Council panel:** `"A council writes no record of its own; it is a set of ordinary runs sharing one group stamp. This is who was seated, where each voice ran, and how many rounds it took. What each member said and how the synthesis read stay on the host."` Empty: `"Clio Coder reports no councils in this ledger window. Councils dispatched longer ago than the scanned window are not indexed here."` Turn tone: not terminal → `action`; `succeeded` → `success`; `null` outcome → `neutral`; anything else → `error`.

**Step tone**, with its reasoning: outcome text on a step comes from the ledger and is open rather than an enum, so only the two words the scheduler writes for a settled step get a verdict tone; everything else stays neutral rather than guessing a colour for a state this build has not seen. `runId === null → neutral`; `"succeeded" → success`; `"failed" → error`; otherwise `action`.

---

## Config, recovery and verifier taxonomies

- priority: must-keep
- from: apps/workbench/src/App.tsx:332-397, 400-430, 7212-7264, 4847-4855, 2686-2760
- to: apps/clio-coder-gui/client/pages/settings.tsx, system.tsx, library.tsx
- value: Three more closed taxonomies with their descriptions. settings.tsx:107 currently renders setting values as `JSON.stringify(row.value)`, library.tsx:173 dumps skill detail. Without these tables the panels are unreadable enum soup.

<details>
<summary>Customization categories, reload classes, setting sources, and scope labels</summary>

**Customization categories** (declaration order IS the display order — it traces the load path from settings outward to memory):
```ts
export const CUSTOMIZATION_CATEGORY_PRESENTATION: Record<string, { label: string; short: string; description: string }> = {
	settings:           { label: "Settings",         short: "SET",  description: "Layered values that shape Clio Coder's behavior." },
	"clio-md":          { label: "Project context",  short: "CTX",  description: "CLIO-CODER.md context Clio Coder can add to the next turn." },
	rule:               { label: "Rules",             short: "RUL",  description: "Project rules and conditional context boundaries." },
	"operator-profile": { label: "Operator profile",  short: "OPR",  description: "Declared operator preferences added to context." },
	hook:               { label: "Hooks",             short: "HOK",  description: "Middleware reactions loaded by Clio Coder." },
	extension:          { label: "Extensions",        short: "EXT",  description: "Installed packages and their effective precedence." },
	"skill-root":       { label: "Skill roots",       short: "SKL",  description: "Locations Clio Coder searches for skills." },
	"prompt-root":      { label: "Prompt roots",      short: "PMT",  description: "Locations Clio Coder searches for saved prompts." },
	agents:             { label: "Agents",            short: "AGT",  description: "Agent recipe sources visible to this project." },
	safety:             { label: "Safety",            short: "SAFE", description: "Effective working-freedom and safety facts." },
	memory:             { label: "Memory",            short: "MEM",  description: "The durable memory surface Clio Coder can consult." },
};
export const CUSTOMIZATION_CATEGORY_ORDER = Object.keys(CUSTOMIZATION_CATEGORY_PRESENTATION);

/** When a change takes effect — the question every settings panel is really answering. */
export const RELOAD_PRESENTATION: Record<string, { label: string; description: string }> = {
	hot:         { label: "Now",           description: "Clio Coder reports this surface as hot-reloadable." },
	"next-turn": { label: "Next turn",     description: "Clio Coder reads this surface when the next turn begins." },
	restart:     { label: "Restart",       description: "A new Clio Coder process is required before this changes." },
	"n/a":       { label: "Informational", description: "No apply timing is attached to this entry." },
};

export const SETTING_SOURCE_LABELS: Record<string, string> = {
	"built-in": "Built in", user: "User", project: "Project",
	"project.local": "Project local", cli: "Command line",
};
export const scopeLabel = (scope: string) => ({
	project: "Project", "project.local": "Project local", user: "User",
	package: "Package", extension: "Extension", cli: "Command line",
}[scope.toLocaleLowerCase("en-US")] ?? scope);
```

The session settings panel at `session-controls.tsx:120-180` should carry `RELOAD_PRESENTATION` per field; right now it says only `"Changes are available between turns"` as a blanket statement, which is wrong for the hot-reloadable ones.

</details>

<details>
<summary>The recovery section and check taxonomies with their tones</summary>

**Recovery sections** — order matters, it is outermost dependency first:
```ts
export const RECOVERY_SECTION_PRESENTATION: Record<string, { label: string; description: string }> = {
	runtime:          { label: "Runtime",            description: "Clio Coder, Node, platform, and engine readiness." },
	storage:          { label: "Local layout",       description: "The four resolved configuration, data, state, and cache roots." },
	configuration:    { label: "Configuration",      description: "Settings validity and credential-store posture." },
	history:          { label: "History stores",     description: "State metadata, sessions, and cache telemetry availability." },
	models:           { label: "Targets & models",   description: "Configured runtime fingerprints and model availability." },
	interoperability: { label: "Interoperability",   description: "Detected and configured external agent surfaces." },
	toolchain:        { label: "External toolchain", description: "Pinned optional programs and the managed file-picker profile." },
	panes:            { label: "Panes host",         description: "Multiplexer mode, reachability, protocol level, and journal writability." },
	fleet:            { label: "Fleet preflight",    description: "Configured node eligibility checks for the selected project." },
	other:            { label: "Other checks",       description: "Additional checks introduced by this Clio Coder version." },
};
export const RECOVERY_CHECK_PRESENTATION: Record<string, { label: string; tone: string }> = {
	ok: { label: "Passed", tone: "success" }, warn: { label: "Warning", tone: "warning" }, error: { label: "Failed", tone: "error" },
};
```

Each section is a `<details>` that **opens itself when `failures > 0 || warnings > 0`** — that is the row the operator came here to read. Section summary right-hand text: `` `${passed}/${checks} passed${warnings ? ` · ${warnings} warn` : ""}${failures ? ` · ${failures} fail` : ""}` ``. Verdict banner: `NO FAILURES` vs `ATTENTION REQUIRED`, with the headline `"All reported checks passed"` / `"${n} reported warning(s)"` / `"${n} reported failure(s)"`. Sub-line: `` `Inspected ${ts} · ${projectContext ? "selected-project context" : "installation context"}` ``. Versions strip: Clio Coder / Node / Platform / `Resolved roots ${pathsResolved}/4`, each `"not reported"` when absent. Boundary: the check crosses as name and verdict only, `"a check whose name is not name-shaped arrives unnamed rather than blanking the sweep"`, and the sweep passes no `--fix` flag.

</details>

<details>
<summary>Verifier origin, rejection and block copy, plus invalid-skill wording</summary>

**Verifier and skill catalog rejection taxonomies** (library page):
```ts
export const VERIFIER_ORIGIN_COPY = {
	"package-script": { eyebrow: "Package script",        signal: "Runs today",  note: "Verify runs npm with this script name and may pass extra argv" },
	catalog:          { eyebrow: "Project catalog",       signal: "Runs today",  note: "Verify pins argv, working directory, and timeout through safe-exec" },
	proposed:         { eyebrow: "Toolchain declaration", signal: "Not adopted", note: "Authoring would offer this check; nothing runs it until you write the catalog" },
};
export const VERIFIER_REJECTION_COPY = {
	unreadable: "the catalog file could not be read as a regular file inside this repository",
	"invalid-yaml": "the catalog is not valid YAML",
	"unsupported-version": "the catalog declares a schema version this Clio Coder does not support",
	"unknown-field": "the catalog declares a field the schema does not define",
	"missing-field": "a required field is missing",
	"duplicate-id": "two declarations claim the same identifier",
	"shell-command": "a check tries to run through a shell instead of an exact argument vector",
	"too-large": "a value passed one of the schema's size caps",
	"invalid-cwd": "a check names a working directory outside this repository",
	"invalid-value": "a value does not match the shape the schema requires",
	unclassified: "the parser refused it for a reason this read could not classify",
};
export const VERIFIER_BLOCK_COPY = {
	"catalog-rejected": "the project catalog did not parse, so no check plane could be read",
	"id-collision": "a package.json script and a catalog check claim the same identifier",
	unclassified: "Clio Coder refused the read for a reason this projection could not classify",
};
export const SKILL_INVALID_COPY = {
	"load-error": "a skill file could not be read",
	collision: "two skills of the same name were found and one lost",
	"unloadable-file": "a scanned file produced no skill",
	"no-skills": "no skill loaded at all",
};
```

Skill-catalog summary sentence, assembled: `` `${valid ? "Clio Coder's loader accepts this installation's skills." : `Clio Coder's loader does not consider this catalog valid, because ${SKILL_INVALID_COPY[invalidReason ?? "no-skills"]}.`} ${hidden === 0 ? "The model can load every one of them by name." : `${hidden} of ${total} ${hidden === 1 ? "is" : "are"} yours alone; the model never sees them.`}` `` where `hidden = total - modelVisible`.

Library boundary: `"Skill bodies, file paths, base directories, content hashes, install URLs, and the loader's own diagnostic text stay on the host. Whether a skill has an upstream to update from crosses; where that upstream is does not. Installing, updating, and evaluating a skill stay explicit terminal operations."`

</details>

---

## Provenance labelling rule and the source taxonomy

- priority: should-keep
- from: apps/workbench/src/chat.ts:12-18, src/timeline.ts:217-227, src/App.tsx:231-260
- to: apps/clio-coder-gui/client/chat/provenance.ts
- value: One rule and one four-value table that together decide whose name appears on every card in the product. The new contract carries `provenance` on TimelineItem and renders it nowhere. The source taxonomy has no counterpart in the new contract at all and needs adding, because 'Clio told us this' and 'we measured this ourselves' are different warranties and the whole evidence posture depends on the reader being able to tell.

<details>
<summary>`agentLabel`, `SOURCE_LABELS`, and the guidance string per source</summary>

**The attribution rule** (`timeline.ts:217-227`): take the LAST entry of the provenance array — the most specific identity Clio reported, so a delegated agent wins over the orchestrator that dispatched it. Render it only when `role === "worker"`. An empty array means nothing was reported and the card falls back to the product name. The GUI never guesses; an unattributed card stays attributed to the product.

```ts
export function agentLabel(provenance: Provenance | undefined): string | null {
	const last = provenance?.at(-1);
	if (last === undefined || last.role !== "worker") return null;
	return last.node == null ? last.agentId : `${last.agentId} · ${last.node}`;
}
```

Use it in two places: as the *response author name* (replacing `"Clio Coder"` in `chat-response__meta`) when a whole narrative segment is attributed, and as the per-row `agent ${label}` tag inside the activity group.

**Source taxonomy — add to the wire.** `contracts/sessions.ts` has no `source` field. Add `source: Type.Optional(Type.Union([…]))` to `TimelineItem` and set it in `server/acp/supervisor.ts` (everything from `session/update` is `observed-on-acp`, everything from a replay is `replayed-from-clio`, anything the server itself synthesizes is `observed-by-server`). The four values and their words:

```ts
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
	"reported-by-clio":    "Reported by Clio Coder",
	"observed-on-acp":     "Observed on ACP",
	"observed-by-server":  "Observed by the GUI server",
	"replayed-from-clio":  "Replayed from Clio Coder",
};
export const SOURCE_GUIDANCE: Readonly<Record<string, string>> = {
	"reported-by-clio":   "Clio Coder supplied this fact; the GUI did not measure it independently.",
	"observed-on-acp":    "The GUI received this event on Clio Coder's live control channel.",
	"observed-by-server": "The GUI observed this fact in its own project or process boundary.",
	"replayed-from-clio": "Clio Coder replayed this from its own stored session history.",
};
```

Show the label on the forensic timeline card and as a `title=` tooltip elsewhere; do not put it on every chat row, which would be noise.

</details>

**Replay origin.** `TimelineItem.origin` already exists. The workbench used it for three visible things and all three are worth keeping: the request heading becomes `"Earlier request"`, a `earlier record` chip appears in the request meta, and a replayed turn is permanently `settled` so it is never re-rendered or clock-ticked. A replayed turn also has `startedAt === null` — the host deliberately refuses to stamp a replayed item with the current wall clock, because that would be inventing a time. Render `"unavailable"` rather than a fabricated timestamp; the new GUI's `formatTime` already returns `"not recorded"` for an unparseable value, which is the right behavior.

**Replay prompt fallback.** When a replayed turn group opens without its user prompt, the workbench still minted a request card, truthfully empty: `"(earlier prompt not replayed)"`, and for a replayed-but-blank prompt, `"(empty prompt)"`. The new `applySessionDelta` skips the user item entirely when `turn.prompt` is falsy (`session-projection.ts`, `case "turn.started"`), leaving a headless response. Add the fallbacks.

---

## Dropped deliberately

- apps/workbench/src/protocol.ts (8,230 lines, 255 KB): a hand-written runtime validator for every wire type, duplicating what TypeBox + the route table now do declaratively in contracts/*.ts. The type shapes are worth reading once while porting the taxonomies above; the validator code is dead weight against a TypeBox stack.
- apps/workbench/clio-host.ts (2,456 lines) and clio-read-command.ts: the Deno subprocess supervisor, permission timer machinery, and bounded stdout/stderr readers. apps/clio-coder-gui/server/acp/ is the same architecture on Node and is already more capable (it carries rawInput/rawOutput, which the workbench host stripped). Only three functions were worth lifting and they are quoted in the artifacts above: safeToolTitle, presentableToolTitle, and consumeProjectRedaction's streaming-safe root-replacement (which retains a partial prefix match across chunk boundaries so a workspace path split across two deltas is still redacted).
- apps/workbench/acp-client.ts (1,705 lines): the JSON-RPC-over-stdio client with frame bounds and pending-request accounting. Fully superseded by server/acp/. Its constants were checked and are either already matched or deliberately different in the new server.
- apps/workbench/project-store.ts (933 lines): a Deno-KV-backed project registry. server/services/workspaces.ts replaces it.
- apps/workbench/src/state.ts (1,193 lines) and workbench-state.ts: a hand-rolled reducer + action-creator layer. @tanstack/react-query plus SessionBuffer covers it. The one idea worth keeping is already captured in the groupTurns artifact (referential stability as the memoization contract).
- apps/workbench/src/markdown.ts, Markdown.tsx, highlight.ts, mermaid.ts: verified already ported to apps/clio-coder-gui/client/render/ with the IncrementalMarkdown settled/tail lexer, the 60,000-char highlight cap, the lazy Prism grammar loaders, the DOMPurify-sanitized Mermaid path, and the 16 KiB / 400-line Mermaid source bounds all intact. The only live gap is that sessions.tsx never passes deferDiagrams, noted in the chat-turn artifact.
- apps/workbench/src/styles.css (197,874 bytes) and DESIGN_SYSTEM.md: the new app has client/design/tokens.css with the green palette already established and the user explicitly wants that kept. The workbench stylesheet is a different layout system (rails and drawers) and porting it would fight react-router. The class names quoted in the artifacts above are the contract worth preserving; the CSS behind them should be rewritten.
- apps/workbench/src/AboutRecord.tsx, HelpReference.tsx, FleetFilterBar.tsx, startup.ts, main.tsx: shell chrome specific to the Deno single-window app. help-reference.ts's KEYBINDINGS table survives, quoted in the message-actions artifact; the rest does not.
- apps/workbench/tests/ (about 18,000 lines across 40 files): fixture-driven tests against the deleted modules. Three are worth reimplementing rather than porting and are called out in the artifacts: timeline_test.ts's ordering invariants (a control event never overtakes buffered text), event-buffer_test.ts's flush-ordering assertions, and chat_test.tsx's groupTurns identity-preservation assertions.
- apps/workbench/PARITY.md (60 KB) and HARNESS_COVERAGE.md (67 KB): feature-by-feature matrices against a harness that has since moved. Superseded by the new route table; re-deriving them from contracts/routes.ts is cheaper and more honest than porting stale rows.
- apps/workbench/artifact-allowlist.ts and scripts/visual-probe.ts, gui-lifecycle.ts: Deno-specific launch and screenshot plumbing. scripts/perf-workload.ts is the exception and is called out for reimplementation in the frame-buffer artifact.
