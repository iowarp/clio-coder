/**
 * Structured renderer for tool-execution chat segments (Slice A of the
 * pi-coding-agent parity work). pi-coding-agent renders every tool call as
 * a header line plus an optional args body and a result/error block. Clio
 * previously emitted a single inline string per call, which collapsed
 * structure (multi-line outputs vanished) and prevented the live and replay
 * paths from sharing one renderer.
 *
 * Pure functions: no I/O, no console writes, no module-level mutable state.
 * The chat-panel tool segment renderer (live path) and the chat-renderer
 * orphan tool-result fallback (replay path) both consume this module so the
 * two surfaces stay byte-identical.
 */

import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString, redactToolArgs } from "../../domains/safety/redaction.js";
import { formatSize } from "../../engine/truncate.js";
import { visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { classifyResourceRead, toolPresentationPolicy } from "../../tools/presentation.js";
import { toolResultPresentationPolicy, toolResultPresentationText } from "../../tools/result-disposition.js";
import { mutationFactsLine } from "../mutation-preview.js";
import type { ApprovalRequestView } from "../permission-overlay.js";
import { clioTheme, formatCompactMs, GLYPH } from "../theme/index.js";
import { renderDiffLines } from "./diff.js";
import { tryRenderJson, tryRenderXml } from "./structured.js";

// The argument projection lives in the safety domain so the worker tool seam
// scrubs by the same rules; re-exported here because this renderer is where
// callers and tests have always reached for it.
export { classifyResourceRead, redactToolArgs };

const theme = clioTheme();
const dim = (text: string): string => theme.fg("dim", text);
const red = (text: string): string => theme.fg("error", text);
const green = (text: string): string => theme.fg("success", text);
const yellow = (text: string): string => theme.fg("warning", text);
const cyan = (text: string): string => theme.fg("accent", text);
const cyanBold = (text: string): string => theme.style("accent", text, { bold: true });

// Visible width of the rail prefix is 2 columns (`│ `). Width budgets and
// diff renderers compute against the visible length, not the styled length,
// so the constant is kept as the plain-text representation.
const BODY_INDENT_PLAIN = "│ ";
const BODY_INDENT_VISIBLE_WIDTH = 2;
const HEADER_PREFIX_PLAIN = "▸ ";
const ARG_PREVIEW_LIMIT = 60;
const WEB_FETCH_ARG_PREVIEW_LIMIT = 140;
const FULL_RESULT_PREVIEW_LIMIT = 60_000;
const FULL_RESULT_ROW_LIMIT = 120;
const STREAMING_RESULT_ROW_LIMIT = 20;
const ARGS_BODY_LINE_LIMIT = 24;
/** Rows of mutation diff a folded edit/write row keeps visible before it defers to the body. */
const FOLDED_DIFF_ROW_LIMIT = 24;
const STATUS_OK_GLYPH = GLYPH.ok;
const STATUS_ERROR_GLYPH = GLYPH.error;

// Hoisted rail prefixes. `indentAndWrap` would otherwise allocate two fresh
// styled strings per rendered line; by precomputing the dim and error variants
// once at module scope, repeated rendering of long result blocks stays cheap.
const RAIL_DIM = dim(BODY_INDENT_PLAIN);
const RAIL_ERROR = red(BODY_INDENT_PLAIN);

export interface ToolExecutionStart {
	toolCallId: string;
	toolName: string;
	args: unknown;
	/** Live elapsed time supplied by the panel for running segments. */
	elapsedMs?: number | undefined;
	/** Pi may stream a tool call's arguments before execution starts. */
	phase?: "forming" | "ready" | "running" | undefined;
}

export interface ToolExecutionFinished {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	result: unknown;
	isError: boolean;
	durationMs?: number | undefined;
	/** Persisted summary (bytes, truncated, offloadPath, observation counts). */
	resultSummary?: Record<string, unknown> | undefined;
	/** Honest terminal outcome for synthetic/or permission-blocked calls. */
	outcome?: "blocked" | "aborted" | "orphaned" | undefined;
	/**
	 * Why admission refused this call, from the registry verdict. A blocked row
	 * that states only that something was refused leaves the operator, and the
	 * model reading the same transcript, to guess at the rule.
	 */
	blockReason?: string | undefined;
	/**
	 * Working-set eviction reason, when the projection has replaced this
	 * result's body for the model. The transcript still renders the full body:
	 * the ledger is what the operator scrolls, the projection is only what the
	 * next request carries. The tag says the two now differ here.
	 */
	evictedReason?: string | undefined;
	/** Structured exit status when the caller has one; text parsing is legacy fallback only. */
	exitCode?: number | string | null | undefined;
	/** Local `!!` bash output is visible to the operator but excluded from model context. */
	excludeFromContext?: boolean | undefined;
}

export interface ToolBodyRenderOptions {
	/**
	 * Render the full tool result body with no middle-elision and no character
	 * truncation. The live view keeps bodies bounded so a single tool cannot
	 * flood the pane; `/export` sets this so the written transcript reproduces
	 * the complete tool output the model actually received.
	 */
	unbounded?: boolean;
	/** Live rows color mutation diffs; replay and export deliberately use plain text. */
	diffStyle?: "color" | "plain";
}

/** Row cap for a tool body: unbounded lifts both the row and char limits. */
function resultRowLimit(opts: ToolBodyRenderOptions): number {
	return opts.unbounded === true ? Number.POSITIVE_INFINITY : FULL_RESULT_ROW_LIMIT;
}

function resultCharLimit(opts: ToolBodyRenderOptions): number {
	return opts.unbounded === true ? Number.POSITIVE_INFINITY : FULL_RESULT_PREVIEW_LIMIT;
}

// Counts UTF-16 code units; can split a surrogate pair on non-BMP input. Acceptable for ASCII paths/commands.
function truncate(value: string, limit: number): string {
	if (value.length <= limit) return value;
	const cut = Math.max(0, limit - 3);
	return `${value.slice(0, cut)}...`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringField(args: unknown, key: string): string | null {
	if (!isPlainObject(args)) return null;
	const value = args[key];
	return typeof value === "string" ? redactSecretString(value) : null;
}

function isEmptyArgs(args: unknown): boolean {
	if (args === undefined || args === null) return true;
	if (isPlainObject(args) && Object.keys(args).length === 0) return true;
	return false;
}

function jsonStringifySafe(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		return typeof text === "string" ? text : String(value);
	} catch {
		return String(value);
	}
}

function unquoteShellScript(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const quote = trimmed.charAt(0);
	if ((quote !== "'" && quote !== '"') || trimmed.charAt(trimmed.length - 1) !== quote) return trimmed;
	const inner = trimmed.slice(1, -1);
	if (quote === "'") return inner.replace(/'\\''/g, "'");
	return inner.replace(/\\"/g, '"').replace(/\\`/g, "`").replace(/\\\$/g, "$").replace(/\\\\/g, "\\");
}

function stripShellWrapperForDisplay(command: string): string {
	const trimmed = command.trim();
	const match = /^(?:(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh))\s+-lc\s+([\s\S]+)$/u.exec(trimmed);
	if (!match?.[1]) return command;
	return unquoteShellScript(match[1]);
}

function displayArg(toolName: string, value: string): string {
	return toolName === "bash" ? stripShellWrapperForDisplay(value) : value;
}

/**
 * Optional-duration guard around the single duration formatter. formatCompactMs
 * is the one formatter for elapsed time, but these call sites carry a
 * `number | undefined` that may be missing, non-finite, or negative and must
 * then omit the ` · <dur>` segment entirely. Returns null in those cases and
 * delegates every real value to formatCompactMs, so durations render as
 * `860ms`, `4.2s`, `42s`, and `1m36s` with no zero padding on the seconds.
 */
function optionalCompactMs(durationMs: number | undefined): string | null {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
	return formatCompactMs(durationMs);
}

function bashExitCodeFromResult(result: unknown): string | null {
	const unwrapped = unwrapResultEnvelope(result);
	const text = typeof unwrapped === "string" ? unwrapped : jsonStringifySafe(unwrapped);
	const match =
		/\bcommand failed \(exit (?<paren>[^)]+)\)/iu.exec(text) ??
		/\bcommand exited with code (?<code>[0-9?]+)/iu.exec(text) ??
		/\bexit (?<short>[0-9?]+)\b/iu.exec(text);
	return match?.groups?.paren ?? match?.groups?.code ?? match?.groups?.short ?? null;
}

/**
 * Map of known tools to their canonical "primary" arg field. When the arg is
 * a string the header summarises it directly and the expanded argument list
 * omits only that repeated field. Tools not in this map (or with an unexpected
 * arg shape) fall back to a JSON summary plus their complete redacted fields.
 */
const PRIMARY_ARG_FIELD: Record<string, string> = {
	read: "path",
	edit: "path",
	write: "path",
	ls: "path",
	bash: "command",
	grep: "pattern",
	find: "pattern",
	web_fetch: "url",
	git: "op",
	verify: "check",
	code_nav: "query",
	context: "scope",
	artifact: "kind",
	monitor: "run_id",
	steer: "run_id",
	tasks: "action",
};

/**
 * Returns the captured primary-arg string when the header successfully used a
 * known tool's canonical arg, otherwise null. The argument renderer uses the
 * same map to omit that one repeated field below `read(README.md)`.
 */
function capturedPrimaryArg(toolName: string, args: unknown): string | null {
	const field = PRIMARY_ARG_FIELD[toolName];
	if (field === undefined) return null;
	return readStringField(args, field);
}

/**
 * Pick the most informative single-line summary of a tool's arguments for
 * the header line. Known tools have a canonical "primary" arg (path,
 * command, pattern, url); unknown tools or unexpected shapes fall back to a
 * truncated JSON dump. Returns an empty string when args are absent so the
 * header renders as `tool: <name>()`.
 */
function summarizeWebFetchArgs(args: unknown): string {
	if (!isPlainObject(args)) return summarizeArgs("", args);
	const compact: Record<string, unknown> = {};
	for (const key of ["url", "format", "max_bytes", "timeout_ms", "method"] as const) {
		if (args[key] !== undefined) compact[key] = args[key];
	}
	return truncate(jsonStringifySafe(Object.keys(compact).length > 0 ? compact : args), WEB_FETCH_ARG_PREVIEW_LIMIT);
}

function summarizeArgs(toolName: string, args: unknown): string {
	if (isEmptyArgs(args)) return "";
	const safeArgs = redactToolArgs(args);
	if (toolName === "web_fetch") return summarizeWebFetchArgs(safeArgs);
	const primary = capturedPrimaryArg(toolName, args);
	if (primary !== null) return truncate(displayArg(toolName, primary), ARG_PREVIEW_LIMIT);
	return truncate(jsonStringifySafe(safeArgs), ARG_PREVIEW_LIMIT);
}

function detailsOf(result: unknown): Record<string, unknown> | null {
	if (!isPlainObject(result)) return null;
	return isPlainObject(result.details) ? result.details : null;
}

function observationOf(finished: ToolExecutionFinished): Record<string, unknown> | null {
	const fromDetails = detailsOf(finished.result)?.observation;
	if (isPlainObject(fromDetails)) return fromDetails;
	const fromSummary = finished.resultSummary?.observation;
	return isPlainObject(fromSummary) ? fromSummary : null;
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function countSummary(observation: Record<string, unknown>): string | null {
	const unit = stringField(observation, "unit") ?? "results";
	const shown = numberField(observation, "shownCount");
	if (shown === null) return null;
	const total = numberField(observation, "totalCount");
	if (total === null) return `${shown}+ ${unit}`;
	if (total === shown) return `${shown} ${unit}`;
	return `${shown}/${total} ${unit}`;
}

/**
 * Outcome facts for the collapsed ledger line, derived from the observation
 * envelope (OBSERVE plane), the exec record (git/verify), or the dispatch
 * receipt counts. Returns null when the result carries no recognizable facts.
 */
function outcomeSummary(finished: ToolExecutionFinished): string | null {
	const observation = observationOf(finished);
	if (observation !== null) {
		if (finished.toolName === "read") {
			const shown = numberField(observation, "shownCount");
			const total = numberField(observation, "totalCount");
			if (shown !== null && total !== null) {
				const offsetRaw = isPlainObject(finished.args) ? finished.args.offset : undefined;
				const start = typeof offsetRaw === "number" && offsetRaw > 0 ? Math.floor(offsetRaw) : 1;
				return shown > 0 ? `lines ${start}-${start + shown - 1} of ${total}` : `0 of ${total} lines`;
			}
		}
		return countSummary(observation);
	}
	const details = detailsOf(finished.result);
	if (finished.toolName === "git" || finished.toolName === "verify") {
		const exitCode = numberField(details, "exitCode");
		if (exitCode !== null) return `exit ${exitCode}`;
		const status = stringField(details, "status");
		if (status !== null) return status;
		return null;
	}
	if (finished.toolName === "dispatch") {
		const receipts = numberField(details, "receiptCount");
		const failed = numberField(details, "failedCount") ?? 0;
		if (receipts !== null) return `${receipts} task${receipts === 1 ? "" : "s"} -> ${receipts - failed} ok`;
		return null;
	}
	if (finished.toolName === "tasks") {
		const rawCounts = details?.counts;
		const counts = isPlainObject(rawCounts) ? rawCounts : null;
		const completed = numberField(counts, "completed");
		const total = numberField(counts, "total");
		if (completed !== null && total !== null) {
			const blocked = numberField(counts, "blocked") ?? 0;
			return `${completed}/${total} done${blocked > 0 ? ` · ${blocked} blocked` : ""}`;
		}
		return null;
	}
	return null;
}

function offloadPathOf(finished: ToolExecutionFinished): string | null {
	const observation = observationOf(finished);
	const fromObservation = stringField(observation, "offloadPath");
	if (fromObservation !== null) return fromObservation;
	const summary = finished.resultSummary ?? null;
	const fromSummary = stringField(summary, "offloadPath");
	if (fromSummary !== null) return fromSummary;
	const resultSize = detailsOf(finished.result)?.resultSize;
	return isPlainObject(resultSize) ? stringField(resultSize, "offloadPath") : null;
}

function offloadFileMissing(finished: ToolExecutionFinished): boolean {
	return finished.resultSummary?.offloadFileMissing === true;
}

function shownBytesOf(finished: ToolExecutionFinished): number | null {
	const observation = observationOf(finished);
	const fromObservation = numberField(observation, "shownBytes");
	if (fromObservation !== null) return fromObservation;
	const resultSize = detailsOf(finished.result)?.resultSize;
	const fromResultSize = isPlainObject(resultSize) ? numberField(resultSize, "shownBytes") : null;
	if (fromResultSize !== null) return fromResultSize;
	return numberField(finished.resultSummary ?? null, "bytes");
}

function totalBytesOf(finished: ToolExecutionFinished): number | null {
	const observation = observationOf(finished);
	const fromObservation = numberField(observation, "totalBytes");
	if (fromObservation !== null) return fromObservation;
	const resultSize = detailsOf(finished.result)?.resultSize;
	if (isPlainObject(resultSize)) {
		const total = numberField(resultSize, "bytes");
		if (total !== null) return total;
	}
	return shownBytesOf(finished);
}

function resultSizeOf(finished: ToolExecutionFinished): Record<string, unknown> | null {
	const value = detailsOf(finished.result)?.resultSize;
	return isPlainObject(value) ? value : null;
}

function isTruncatedResult(finished: ToolExecutionFinished): boolean {
	const observation = observationOf(finished);
	if (observation?.truncated === true) return true;
	if (resultSizeOf(finished)?.truncated === true) return true;
	const truncation = detailsOf(finished.result)?.truncation;
	if (isPlainObject(truncation) && truncation.truncated === true) return true;
	return finished.resultSummary?.truncated === true;
}

function structuredExitCode(finished: ToolExecutionFinished): string | null {
	if (isNonExecutedOutcome(finished.outcome)) return null;
	if (finished.exitCode !== undefined && finished.exitCode !== null) return String(finished.exitCode);
	const exitCode = detailsOf(finished.result)?.exitCode;
	if (typeof exitCode === "number" || typeof exitCode === "string") return String(exitCode);
	return finished.toolName === "bash" && finished.isError ? bashExitCodeFromResult(finished.result) : null;
}

/**
 * The dim ledger tail appended to a finished collapsed subline: outcome facts,
 * then byte size (duration rides on the status glyph), then the offload path
 * for truncated calls. One line of plain text carries signature and outcome
 * when copied.
 */
function ledgerTail(finished: ToolExecutionFinished): { facts: string; offload: string } {
	const parts: string[] = [];
	const outcome = outcomeSummary(finished);
	if (outcome !== null) parts.push(outcome);
	const executed = !isNonExecutedOutcome(finished.outcome);
	// A folded bash row is the only view of the call the operator gets by
	// default, so its settlement facts have to be here rather than only in the
	// expanded body. A failed row already carries `(exit N)` on the status glyph.
	if (executed && finished.toolName === "bash" && !finished.isError) {
		parts.push(`exit ${structuredExitCode(finished) ?? "0"}`);
	}
	const bytes = executed ? shownBytesOf(finished) : null;
	if (bytes !== null && bytes > 0) {
		const total = totalBytesOf(finished);
		parts.push(
			total !== null && total > bytes ? `${formatSize(bytes)} shown / ${formatSize(total)} total` : formatSize(bytes),
		);
	}
	if (executed) {
		if (isTruncatedResult(finished)) parts.push("truncated");
		const details = detailsOf(finished.result);
		if (details?.timedOut === true) parts.push("timed out");
		if (details?.outputCapped === true) parts.push("output capped");
	}
	if (finished.excludeFromContext === true) parts.push("not sent to model");
	if (finished.evictedReason !== undefined) parts.push("evicted", finished.evictedReason);
	const offloadPath = executed ? offloadPathOf(finished) : null;
	return {
		facts: parts.length > 0 ? dim(` · ${parts.join(" · ")}`) : "",
		offload:
			offloadPath === null
				? ""
				: offloadFileMissing(finished)
					? dim(" · full: gone after the 14-day retention sweep")
					: dim(` · full: ${offloadPath}`),
	};
}

/** Longest diagnostic excerpt a folded failure row may carry. */
const FAILURE_EXCERPT_LIMIT = 80;

/**
 * Last non-empty output line of a failed call, bounded so the folded row stays
 * diagnostically useful without opening the body. Sanitized to one line: the
 * source is raw tool output. The tool's presentation policy decides whether
 * its failures carry one; the renderer never names a tool here.
 */
function failureExcerpt(finished: ToolExecutionFinished, width: number): string {
	const presentation =
		toolResultPresentationPolicy(finished.result) ?? toolPresentationPolicy(finished.toolName, finished.args);
	if (!finished.isError || !presentation.failureExcerpt) return "";
	if (isNonExecutedOutcome(finished.outcome)) return "";
	const text = unwrapResultEnvelope(finished.result);
	if (typeof text !== "string") return "";
	let excerpt: string | undefined;
	for (const raw of text.split("\n")) {
		const line = sanitizeCallTargetText(raw).trim();
		if (line.length > 0) excerpt = line;
	}
	if (excerpt === undefined) return "";
	const limit = Math.min(FAILURE_EXCERPT_LIMIT, Math.max(20, width - 20));
	return dim(` · ${truncate(excerpt, limit)}`);
}

/**
 * Marker for a call parked at admission awaiting operator approval. Rendered
 * in place of the elapsed counter so a parked call never reads as executing
 * work; the ⏸ glyph matches the footer's blocked phase.
 */
const AWAITING_APPROVAL_TAIL = ` ${yellow(GLYPH.phaseBlocked)}${dim(" awaiting approval")}`;

/**
 * Subline for an in-flight call whose body is parked at the permission gate.
 * No elapsed counter (nothing is running) and no status glyph (nothing has
 * finished): the awaiting-approval tail is the segment's whole state.
 */
export function renderToolAwaitingApproval(
	call: ToolExecutionStart,
	width: number,
	view?: ApprovalRequestView,
): string[] {
	const parts = sublineParts({ toolCallId: call.toolCallId, toolName: call.toolName, args: call.args }, undefined, {});
	const lines = wrapSublineWithTail(parts.lead, AWAITING_APPROVAL_TAIL, width);
	if (view === undefined) return lines;
	const axis = view.axis.kind === "net" ? `safety-net rail ${view.axis.ruleId}` : `autonomy level ${view.axis.level}`;
	const facts = [
		["action", view.actionClass],
		["axis", axis],
		...(view.target !== undefined && view.target.length > 0 ? [["target", view.target]] : []),
		// Size and digest, never the mutation text: this row is the transcript,
		// which is written, replayed, and shared (issue #254).
		...(view.mutation !== undefined ? [["mutation", mutationFactsLine(view.mutation)]] : []),
	] as const;
	for (const [label, value] of facts) {
		lines.push(...indentAndWrap(`${dim(`${label} ·`)} ${value}`, width, false));
	}
	return lines;
}

/**
 * Header status follows Pi's call lifecycle before and during execution, then
 * becomes `"ok"` or `"error"` at settlement. The
 * glyph hangs off the right of the header line so the tool name + args read
 * left-to-right without extra punctuation.
 */
type HeaderStatus = "forming" | "ready" | "running" | "ok" | "error" | undefined;

/** Keeps a refusal reason to one scannable clause on the status tail. */
const BLOCK_REASON_LIMIT = 72;

interface StatusMeta {
	durationMs?: number | undefined;
	elapsedMs?: number | undefined;
	exitCode?: string | null;
	outcome?: ToolExecutionFinished["outcome"];
	/** Refusal reason, rendered only alongside a non-executed outcome. */
	blockReason?: string | undefined;
}

function statusGlyph(status: HeaderStatus, meta: StatusMeta = {}): string {
	if (status === undefined) return "";
	if (status === "forming") return ` ${dim(GLYPH.queued)}${dim(" forming call")}`;
	if (status === "ready") return ` ${dim(GLYPH.queued)}${dim(" ready")}`;
	if (status === "running") {
		const elapsed = optionalCompactMs(meta.elapsedMs);
		return ` ${cyan(GLYPH.running)}${dim(elapsed === null ? " running" : ` running · ${elapsed}`)}`;
	}
	const duration = optionalCompactMs(meta.durationMs);
	const durationSuffix = duration ? dim(` · ${duration}`) : "";
	if (status === "ok") return ` ${green(STATUS_OK_GLYPH)}${durationSuffix}`;
	const exitSuffix = meta.exitCode ? dim(` (exit ${meta.exitCode})`) : "";
	const outcomeSuffix = meta.outcome ? dim(` ${meta.outcome}`) : "";
	// A refusal that names no rule tells the operator only that something was
	// stopped. The reason rides the same tail as the outcome word so the
	// collapsed subline and the expanded header state it identically.
	const reason = meta.outcome !== undefined ? meta.blockReason?.trim() : undefined;
	const reasonSuffix = reason ? dim(` · ${truncate(reason, BLOCK_REASON_LIMIT)}`) : "";
	return ` ${red(STATUS_ERROR_GLYPH)}${outcomeSuffix}${reasonSuffix}${exitSuffix}${durationSuffix}`;
}

function headerLine(toolName: string, args: unknown, status: HeaderStatus, meta: StatusMeta = {}): string {
	const body = styleSublineBody(buildSublineBody(toolName, args, status, undefined, meta.outcome));
	const head = `${dim(HEADER_PREFIX_PLAIN)}${body}`;
	return `${head}${statusGlyph(status, meta)}`;
}

function sublineLead(token: string, rest: string): string {
	return `${cyanBold(token)}${rest}`;
}

function styleSublineBody(body: string): string {
	const match = /^(?<lead>[^ (]+)(?<rest>.*)$/u.exec(body);
	if (match?.groups?.lead === undefined || match.groups.rest === undefined) return body;
	return sublineLead(match.groups.lead, match.groups.rest);
}

function buildGenericToolBody(toolName: string, args: unknown): string {
	const summary = summarizeArgs(toolName, args);
	return summary.length > 0 ? `tool action ${summary}` : "tool action";
}

function buildFieldSublineBody(
	args: unknown,
	key: string,
	lead: string,
	options: { wrapInBackticks?: boolean } = {},
): string | null {
	const value = readStringField(args, key);
	if (value === null) return null;
	const preview = truncate(key === "command" ? stripShellWrapperForDisplay(value) : value, ARG_PREVIEW_LIMIT);
	if (options.wrapInBackticks) return `${lead}\`${preview}\``;
	return `${lead}${preview}`;
}

function dispatchSublineBody(args: unknown): string | null {
	if (!isPlainObject(args)) return null;
	if (args.list === true) return "listing fleet agents";
	const sharedAgent =
		(typeof args.agent === "string" && args.agent.trim()) ||
		(typeof args.agent_id === "string" && args.agent_id.trim()) ||
		"coder";
	let rawTasks: unknown = args.tasks;
	if (typeof rawTasks === "string") {
		const trimmed = rawTasks.trim();
		if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
			try {
				rawTasks = JSON.parse(trimmed) as unknown;
			} catch {
				// Keep the string as one plain task; dispatch itself reports malformed JSON.
			}
		}
	}
	const tasks = Array.isArray(rawTasks) ? rawTasks : rawTasks === undefined ? [] : [rawTasks];
	if (tasks.length === 0) return null;
	const first = tasks[0];
	const record = isPlainObject(first) ? first : null;
	const agent =
		(record && typeof record.agent === "string" && record.agent.trim()) ||
		(record && typeof record.agent_id === "string" && record.agent_id.trim()) ||
		sharedAgent;
	const taskText = typeof first === "string" ? first : record && typeof record.task === "string" ? record.task : "";
	const taskPreview = truncate(sanitizeCallTargetText(taskText), ARG_PREVIEW_LIMIT);
	const more = tasks.length > 1 ? ` +${tasks.length - 1} more` : "";
	if (taskPreview.length === 0) return `dispatching ${tasks.length} task${tasks.length === 1 ? "" : "s"}${more}`;
	return `dispatching ${agent}: ${taskPreview}${more}`;
}

const SUBLINE_BODY_BUILDERS: Readonly<Record<string, (args: unknown) => string | null>> = {
	read: (args) => buildFieldSublineBody(args, "path", "reading "),
	edit: (args) => buildFieldSublineBody(args, "path", "editing "),
	write: (args) => buildFieldSublineBody(args, "path", "writing "),
	ls: (args) => buildFieldSublineBody(args, "path", "listing "),
	bash: (args) => buildFieldSublineBody(args, "command", "running ", { wrapInBackticks: true }),
	grep: (args) => buildFieldSublineBody(args, "pattern", "searching for ", { wrapInBackticks: true }),
	find: (args) => buildFieldSublineBody(args, "pattern", "finding ", { wrapInBackticks: true }),
	web_fetch: (args) => buildFieldSublineBody(args, "url", "fetching "),
	git: (args) => buildFieldSublineBody(args, "op", "git "),
	verify: (args) => buildFieldSublineBody(args, "check", "verifying "),
	code_nav: (args) => {
		const mode = readStringField(args, "mode");
		const query = readStringField(args, "query")?.trim() ?? "";
		const queryPart = query.length > 0 ? ` \`${truncate(query, ARG_PREVIEW_LIMIT)}\`` : "";
		if (mode !== null && mode.length > 0) return `navigating ${mode}${queryPart}`;
		return queryPart.length > 0 ? `navigating${queryPart}` : null;
	},
	context: (args) => {
		const scope = readStringField(args, "scope");
		if (scope === null || scope.length === 0) return null;
		const query = readStringField(args, "query")?.trim() ?? "";
		const name = readStringField(args, "name")?.trim() ?? "";
		if (scope === "docs" && query.length > 0) return `context docs \`${truncate(query, ARG_PREVIEW_LIMIT)}\``;
		if (scope === "skills" && name.length > 0) return `context skills ${truncate(name, ARG_PREVIEW_LIMIT)}`;
		return `context ${scope}`;
	},
	artifact: (args) => buildFieldSublineBody(args, "kind", "writing "),
	monitor: (args) => buildFieldSublineBody(args, "run_id", "monitoring "),
	steer: (args) => buildFieldSublineBody(args, "run_id", "steering "),
	tasks: (args) => {
		const action = readStringField(args, "action");
		if (action === null) return null;
		if (action === "plan") {
			const title = readStringField(args, "title");
			return title === null ? "tasks plan" : `tasks plan ${truncate(`"${title}"`, ARG_PREVIEW_LIMIT)}`;
		}
		const id = readStringField(args, "id");
		return id === null ? `tasks ${action}` : `tasks ${action} ${id}`;
	},
	dispatch: dispatchSublineBody,
};

/**
 * Per-tool subline templates. Maps a tool name to a function that builds the
 * verb-led subline body without the leading glyph and without the trailing
 * status glyph. Unknown tools fall back to a tool-neutral action summary.
 */
function webFetchMeta(result: unknown): string | null {
	if (!isPlainObject(result) || !isPlainObject(result.details)) return null;
	const status = typeof result.details.status === "number" ? String(result.details.status) : null;
	const format = typeof result.details.format === "string" ? result.details.format : null;
	const bytesRead = typeof result.details.bytesRead === "number" ? result.details.bytesRead : null;
	const truncated = result.details.truncated === true ? "truncated" : null;
	const bytes = bytesRead === null ? null : bytesRead >= 1024 ? `${(bytesRead / 1024).toFixed(1)}KB` : `${bytesRead}B`;
	const parts = [status, format, bytes, truncated].filter(
		(part): part is string => typeof part === "string" && part.length > 0,
	);
	return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * A call the permission gate blocked never executed, so the collapsed row must
 * not claim it did. Blocked calls keep the ordinary operator-facing action
 * description but use a neutral noun for commands; the status tail supplies the
 * blocked outcome. The ledger byte count is suppressed elsewhere because those
 * bytes are the denial text, not output.
 */
function isNonExecutedOutcome(outcome: ToolExecutionFinished["outcome"]): boolean {
	return outcome === "blocked";
}

function buildSublineBody(
	toolName: string,
	args: unknown,
	status: HeaderStatus,
	result?: unknown,
	outcome?: ToolExecutionFinished["outcome"],
): string {
	if (isNonExecutedOutcome(outcome)) {
		if (toolName === "bash") {
			return (
				buildFieldSublineBody(args, "command", "command ", { wrapInBackticks: true }) ??
				buildGenericToolBody(toolName, args)
			);
		}
		return SUBLINE_BODY_BUILDERS[toolName]?.(args) ?? buildGenericToolBody(toolName, args);
	}
	if (toolName === "web_fetch") {
		const meta = status === undefined ? null : webFetchMeta(result);
		const body = SUBLINE_BODY_BUILDERS.web_fetch?.(args) ?? buildGenericToolBody(toolName, args);
		return `${body}${meta ? dim(` · ${meta}`) : ""}`;
	}
	if (toolName === "bash") {
		const lead = status === "ok" || status === "error" ? "ran " : "running ";
		return (
			buildFieldSublineBody(args, "command", lead, { wrapInBackticks: true }) ?? buildGenericToolBody(toolName, args)
		);
	}
	const body = SUBLINE_BODY_BUILDERS[toolName]?.(args);
	if (body !== null && body !== undefined) return body;
	return buildGenericToolBody(toolName, args);
}

interface SublineParts {
	/** Verb, object, and ledger facts. Breakable across wraps. */
	lead: string;
	/**
	 * Status glyph, duration, and any offload path, composed as one unit. The
	 * caller appends the expand hint here so the whole tail stays atomic: a wrap
	 * may fall before the status glyph but never between the glyph, the
	 * duration, and the hint. Begins with a joining space so it attaches to the
	 * lead's last line when they share a row. Empty for in-flight calls, which
	 * carry no status glyph.
	 */
	tail: string;
}

function sublineParts(
	call: ToolExecutionStart | ToolExecutionFinished,
	status: HeaderStatus,
	meta: StatusMeta,
): SublineParts {
	const finished = "result" in call ? call : null;
	const body = styleSublineBody(buildSublineBody(call.toolName, call.args, status, finished?.result, finished?.outcome));
	const resourceLabel = classifyResourceRead(call.toolName, call.args);
	const resource = resourceLabel !== null ? dim(` · ${resourceLabel}`) : "";
	if (finished !== null) {
		const ledger = ledgerTail(finished);
		return {
			lead: `${dim(HEADER_PREFIX_PLAIN)}${body}${resource}${ledger.facts}`,
			tail: `${statusGlyph(status, meta)}${ledger.offload}`,
		};
	}
	return { lead: `${dim(HEADER_PREFIX_PLAIN)}${body}${resource}`, tail: statusGlyph(status, meta) };
}

/**
 * Wrap a collapsed subline while keeping its status tail atomic. The lead wraps
 * normally; the tail (status glyph, duration, offload, and the optional expand
 * hint) is placed as a single unit. When the whole line fits it renders on one
 * row; otherwise the tail joins the lead's last wrapped line if it fits there,
 * and only falls to its own row when it cannot, so the status glyph and
 * duration are never separated by a wrap.
 */
function wrapSublineWithTail(lead: string, tail: string, width: number): string[] {
	if (tail.length === 0) return wrap(lead, width);
	if (visibleWidth(`${lead}${tail}`) <= width) return [`${lead}${tail}`];
	const leadLines = wrap(lead, width);
	const last = leadLines[leadLines.length - 1];
	if (last !== undefined && visibleWidth(`${last}${tail}`) <= width) {
		leadLines[leadLines.length - 1] = `${last}${tail}`;
		return leadLines;
	}
	// The tail cannot sit beside the lead: give it its own row, dropping the
	// joining leading space so it starts flush at the left.
	return [...leadLines, ...wrap(tail.replace(/^ +/u, ""), width)];
}

function wrap(line: string, width: number): string[] {
	return wrapTextWithAnsi(line, width);
}

/**
 * Apply the body rail to a line and wrap it. The rail (`│ `) is dim by
 * default and red on error so the tool block reads as a single visual unit
 * even when its result spans many lines. Uses the hoisted `RAIL_DIM` /
 * `RAIL_ERROR` constants so we do not allocate a fresh styled prefix per
 * wrapped line.
 */
function indentAndWrap(line: string, width: number, isError: boolean): string[] {
	const rail = isError ? RAIL_ERROR : RAIL_DIM;
	const bodyWidth = Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH);
	const out: string[] = [];
	for (const wrapped of wrap(line, bodyWidth)) {
		out.push(`${rail}${wrapped}`);
	}
	return out;
}

function scalarArgValue(value: unknown): string | null {
	if (typeof value === "string") {
		const lines = value.split("\n").length;
		const bytes = Buffer.byteLength(value, "utf8");
		if (lines > 1 || value.length > 160) return dim(`<${lines} lines · ${formatSize(bytes)} text>`);
		return green(JSON.stringify(value));
	}
	if (typeof value === "number") return cyan(String(value));
	if (typeof value === "boolean") return yellow(String(value));
	if (value === null) return dim("null");
	return null;
}

/**
 * Render secondary arguments as a compact typed field list. The primary path,
 * command, pattern, or query already lives in the call signature; keeping the
 * rest means `cwd`, timeout, range, glob, and flags no longer disappear merely
 * because one field was important enough for the header. Nested values retain
 * the structured JSON renderer, while large strings become byte/line facts
 * instead of flooding the transcript.
 */
function renderArgsBody(toolName: string, args: unknown, width: number, isError: boolean): string[] {
	if (isEmptyArgs(args)) return [];
	const safeArgs = redactToolArgs(args);
	if (!isPlainObject(safeArgs)) {
		const bodyWidth = Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH);
		const lines = tryRenderJson(safeArgs, bodyWidth, { lineLimit: ARGS_BODY_LINE_LIMIT });
		return lines?.flatMap((line) => indentAndWrap(line, width, isError)) ?? [];
	}
	const primary = PRIMARY_ARG_FIELD[toolName];
	const entries = Object.entries(safeArgs).filter(([key]) => key !== primary);
	if (entries.length === 0) return [];
	const out: string[] = [];
	const bodyWidth = Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH);
	out.push(...indentAndWrap(`${cyanBold("args")}${dim(` · ${entries.length}`)}`, width, isError));
	const keyWidth = Math.min(18, Math.max(...entries.map(([key]) => visibleWidth(key))));
	for (const [key, value] of entries) {
		const label = `${cyan(key.padEnd(keyWidth))}  `;
		const scalar = scalarArgValue(value);
		if (scalar !== null) {
			out.push(...indentAndWrap(`${label}${scalar}`, width, isError));
			continue;
		}
		out.push(...indentAndWrap(cyan(key), width, isError));
		const lines = tryRenderJson(value, Math.max(1, bodyWidth - 2), { lineLimit: ARGS_BODY_LINE_LIMIT });
		for (const line of lines ?? [jsonStringifySafe(value)]) {
			out.push(...indentAndWrap(`  ${line}`, width, isError));
			if (out.length >= ARGS_BODY_LINE_LIMIT) break;
		}
		if (out.length >= ARGS_BODY_LINE_LIMIT) break;
	}
	if (out.length >= ARGS_BODY_LINE_LIMIT) out.push(...indentAndWrap(dim("… more arguments hidden"), width, isError));
	return out;
}

/**
 * pi-agent-core wraps tool results in `{ content: [{ type: "text", text }, ...] }`
 * envelopes. Rendering that JSON verbatim hides the actual output and, for a
 * mixed result, can dump a base64 image into the terminal. Text blocks are
 * joined, image blocks become compact MIME/size placeholders, and unknown
 * content blocks are named without serializing their payload.
 */
function unwrapResultEnvelope(result: unknown): unknown {
	if (typeof result === "string" || result === null || result === undefined) return result;
	const presentationText = toolResultPresentationText(result);
	if (presentationText !== null) return presentationText;
	const blocks = Array.isArray(result)
		? result
		: isPlainObject(result) && Array.isArray(result.content)
			? result.content
			: null;
	if (blocks === null) return result;
	const parts: string[] = [];
	for (const block of blocks) {
		if (!isPlainObject(block)) return result;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
			continue;
		}
		if (block.type === "image" && typeof block.data === "string") {
			const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image/unknown";
			const padding = block.data.endsWith("==") ? 2 : block.data.endsWith("=") ? 1 : 0;
			const bytes = Math.max(0, Math.floor((block.data.length * 3) / 4) - padding);
			parts.push(`[image ${mimeType} · ${formatSize(bytes)}]`);
			continue;
		}
		if (typeof block.type === "string") {
			parts.push(`[${block.type} content]`);
			continue;
		}
		return result;
	}
	if (parts.length === 0) return result;
	return parts.join("\n");
}

function isEmptyResult(result: unknown): boolean {
	if (result === null || result === undefined) return true;
	if (typeof result === "string" && result.length === 0) return true;
	return false;
}

function resultText(result: unknown, limit = FULL_RESULT_PREVIEW_LIMIT): string {
	if (typeof result === "string") return truncate(result, limit);
	return truncate(jsonStringifySafe(result), limit);
}

function truncateRowsMiddle(rows: ReadonlyArray<string>, rowLimit: number, isError: boolean): string[] {
	if (rows.length <= rowLimit) return [...rows];
	if (rowLimit <= 1) return [`${isError ? RAIL_ERROR : RAIL_DIM}${dim(`... ${rows.length} lines hidden`)}`];
	const available = rowLimit - 1;
	const head = Math.floor(available / 2);
	const tail = available - head;
	const hidden = Math.max(0, rows.length - head - tail);
	return [
		...rows.slice(0, head),
		`${isError ? RAIL_ERROR : RAIL_DIM}${dim(`... ${hidden} lines hidden`)}`,
		...rows.slice(-tail),
	];
}

function renderOutputRows(text: string, width: number, isError: boolean, rowLimit: number): string[] {
	const rows: string[] = [];
	for (const raw of text.split("\n")) {
		rows.push(...indentAndWrap(raw, width, isError));
	}
	return truncateRowsMiddle(rows, rowLimit, isError);
}

function renderStructuredOutputRows(
	value: unknown,
	width: number,
	isError: boolean,
	rowLimit: number,
): string[] | null {
	const bodyWidth = Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH);
	const unwrapped = unwrapResultEnvelope(value);
	const structured =
		typeof unwrapped === "string"
			? (tryRenderJson(unwrapped, bodyWidth, { lineLimit: rowLimit }) ??
				tryRenderXml(unwrapped, bodyWidth, { lineLimit: rowLimit }))
			: tryRenderJson(unwrapped, bodyWidth, { lineLimit: rowLimit });
	if (!structured) return null;
	const out: string[] = [];
	for (const row of structured) out.push(...indentAndWrap(row, width, isError));
	return out;
}

function highlightBashCommand(command: string): string {
	const tokens = command.match(/'[^']*'|"[^"]*"|\|\||&&|[|;()<>]|[^\s|;&()<>]+|\s+/gu) ?? [command];
	return tokens
		.map((token) => {
			if (/^\s+$/u.test(token)) return token;
			if (/^'[^']*'$|^"[^"]*"$/u.test(token)) return green(token);
			if (/^(?:\|\||&&|[|;()<>])$/u.test(token)) return dim(token);
			if (/^-{1,2}[\w-]+/u.test(token)) return yellow(token);
			return token;
		})
		.join("");
}

function resultDiff(result: unknown): string | null {
	const value = detailsOf(result)?.diff;
	return typeof value === "string" && value.length > 0 ? value : null;
}

function renderMutationDiffBlock(diff: string, width: number, color: boolean): string[] {
	const bodyWidth = Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH);
	return renderDiffLines(diff, bodyWidth, { color }).map((line) => `${RAIL_DIM}${line}`);
}

interface BashArgs {
	command: string;
}

/**
 * Defensive shape check: bash-tool args must carry a string `command` for the
 * `$ <cmd>` echo line to render. Anything else falls through to the standard
 * result block so the dispatch is opportunistic and never throws.
 */
function asBashArgs(args: unknown): BashArgs | null {
	if (!isPlainObject(args)) return null;
	const command = args.command;
	if (typeof command !== "string") return null;
	return { command: redactSecretString(command) };
}

function resultLineCount(result: unknown): number {
	const unwrapped = unwrapResultEnvelope(result);
	if (typeof unwrapped !== "string" || unwrapped.length === 0) return 0;
	const normalized = unwrapped.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const withoutTerminator = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
	return withoutTerminator.split("\n").length;
}

function toolUsageFact(result: unknown): string | null {
	if (!isPlainObject(result) || !isPlainObject(result.usage)) return null;
	const total = numberField(result.usage, "totalTokens");
	if (total === null || total <= 0) return null;
	return `${total} tool token${total === 1 ? "" : "s"}`;
}

function outputFacts(finished: ToolExecutionFinished): string[] {
	const parts: string[] = [];
	if (isNonExecutedOutcome(finished.outcome)) {
		if (finished.excludeFromContext === true) parts.push("not sent to model");
		return parts;
	}
	const exitCode = structuredExitCode(finished) ?? (finished.toolName === "bash" && !finished.isError ? "0" : null);
	if (exitCode !== null) parts.push(`exit ${exitCode}`);
	const observation = observationOf(finished);
	const count = observation === null ? null : countSummary(observation);
	if (count !== null) parts.push(count);
	const lines = resultLineCount(finished.result);
	if (count === null && lines > 0) parts.push(`${lines} line${lines === 1 ? "" : "s"}`);
	const shownBytes = shownBytesOf(finished);
	const totalBytes = totalBytesOf(finished);
	if (shownBytes !== null && shownBytes > 0) {
		parts.push(
			totalBytes !== null && totalBytes > shownBytes
				? `${formatSize(shownBytes)} shown / ${formatSize(totalBytes)} total`
				: formatSize(shownBytes),
		);
	}
	if (isTruncatedResult(finished)) parts.push("truncated");
	const details = detailsOf(finished.result);
	if (details?.timedOut === true) parts.push("timed out");
	if (details?.outputCapped === true) parts.push("output capped");
	const usage = toolUsageFact(finished.result);
	if (usage !== null) parts.push(usage);
	if (isPlainObject(finished.result) && Array.isArray(finished.result.addedToolNames)) {
		const added = finished.result.addedToolNames.filter((name): name is string => typeof name === "string");
		if (added.length > 0) parts.push(`added ${added.join(", ")}`);
	}
	if (isPlainObject(finished.result) && finished.result.terminate === true) parts.push("terminal result");
	if (finished.excludeFromContext === true) parts.push("not sent to model");
	if (finished.evictedReason !== undefined) parts.push("evicted", finished.evictedReason);
	return parts;
}

function renderOutputMeta(
	finished: ToolExecutionFinished,
	width: number,
	isError: boolean,
	label = "output",
): string[] {
	const facts = outputFacts(finished);
	const suffix = facts.length > 0 ? dim(` · ${facts.join(" · ")}`) : "";
	return indentAndWrap(`${cyanBold(label)}${suffix}`, width, isError);
}

function renderOutputFooter(finished: ToolExecutionFinished, width: number, isError: boolean): string[] {
	const out: string[] = [];
	const offloadPath = isNonExecutedOutcome(finished.outcome) ? null : offloadPathOf(finished);
	if (offloadPath !== null) {
		const pointer = offloadFileMissing(finished) ? "gone after the 14-day retention sweep" : offloadPath;
		out.push(...indentAndWrap(`${yellow("full output")}  ${pointer}`, width, isError));
	}
	const hint =
		stringField(resultSizeOf(finished), "followUpHint") ?? stringField(finished.resultSummary ?? null, "followUpHint");
	if (hint !== null) out.push(...indentAndWrap(`${dim("next")}  ${hint}`, width, isError));
	return out;
}

/**
 * Bash subrenderer: emits `$ <cmd>` (full command) on its own line under the
 * rail, then the unwrapped output via the same chain as `renderResultBlock`.
 * Mirrors pi-coding-agent's bash component shape so users see exactly what
 * was executed before the output. Failures use the same command and output
 * body while the caller selects the red rail and error status.
 */
function renderBashResultBlock(
	args: BashArgs,
	result: unknown,
	width: number,
	isError: boolean,
	opts: ToolBodyRenderOptions = {},
): string[] {
	const out: string[] = [];
	const commandLine = `${cyanBold("$")} ${highlightBashCommand(stripShellWrapperForDisplay(args.command))}`;
	out.push(...indentAndWrap(commandLine, width, isError));
	const unwrapped = unwrapResultEnvelope(result);
	if (isEmptyResult(unwrapped)) {
		out.push(...indentAndWrap(dim("(no output)"), width, isError));
		return out;
	}
	out.push(...renderOutputRows(resultText(unwrapped, resultCharLimit(opts)), width, isError, resultRowLimit(opts)));
	return out;
}

function renderResultBlock(
	result: unknown,
	isError: boolean,
	width: number,
	opts: ToolBodyRenderOptions = {},
): string[] {
	const unwrapped = unwrapResultEnvelope(result);
	if (isEmptyResult(unwrapped)) {
		return indentAndWrap(dim("(no output)"), width, isError);
	}
	const structured = renderStructuredOutputRows(unwrapped, width, isError, resultRowLimit(opts));
	if (structured) return structured;
	return renderOutputRows(resultText(unwrapped, resultCharLimit(opts)), width, isError, resultRowLimit(opts));
}

/**
 * Header-only render for a tool call that has not yet finished. Used by the
 * live chat panel from streamed argument formation through execution. The
 * lifecycle tail distinguishes a forming call, a ready call, and a running
 * call without inventing execution time before Pi starts the tool.
 */
export function renderToolCallHeader(call: ToolExecutionStart, width: number): string[] {
	return wrap(
		headerLine(call.toolName, call.args, call.phase ?? "running", {
			elapsedMs: call.elapsedMs,
		}),
		width,
	);
}

/** Running-only footer used when an operator pauses live output; execution continues. */
export function renderToolRunningStatus(call: ToolExecutionStart, width: number): string[] {
	const elapsed = optionalCompactMs(call.elapsedMs);
	return [
		...renderToolCallHeader(call, width),
		...indentAndWrap(dim(elapsed ? `live output paused · ${elapsed}` : "live output paused"), width, false),
	];
}

function sublineStatus(call: ToolExecutionStart | ToolExecutionFinished): HeaderStatus {
	// Discriminate on `result` rather than `isError`: only `ToolExecutionFinished`
	// carries a `result` field, so a `ToolExecutionStart` with a stray
	// `isError: false` (e.g. from a future event-shape change) cannot trip the
	// finished path. `result` is the type's load-bearing field.
	if (!("result" in call)) return call.phase ?? "running";
	return call.isError ? "error" : "ok";
}

/**
 * One-line subline form of a tool call. Format:
 *   ▸ <body><status>
 * `status` is "" for in-flight, " ✓" green for success, " ✗" red for error.
 * Output is width-wrapped via wrapTextWithAnsi.
 *
 * When `expandKey` is supplied AND the call has finished, a dim ` (<key>)`
 * discoverability hint rides at the very end of the atomic status tail so users
 * see how to expand the collapsed block. Composing the full line (facts, status
 * glyph, duration, offload, and hint) before wrapping keeps the status glyph
 * and duration together on one row. The hint is suppressed for in-flight calls
 * (still running, no useful body to expand yet) and when `expandKey` is
 * empty/undefined (no key bound, hint would be misleading). The renderer never
 * imports the keybindings manager directly; the caller resolves the key string
 * and passes it in to keep this module pure.
 */
export interface ToolSublineRenderOptions {
	/** Live rows color the folded mutation diff; replay and export request plain rows. */
	diffStyle?: "color" | "plain";
	/**
	 * Whether the folded row carries the extras its tool's presentation asks
	 * for (today the bounded mutation diff). The bare subline level drops them;
	 * the failure excerpt is not one of them and always rides the row.
	 */
	foldedExtras?: "per-tool" | "none";
}

/**
 * The bounded diff a folded mutation row keeps under itself, when the tool's
 * presentation asks for one and the result carries one. A folded `edit` that
 * hid its change told the operator nothing they could act on.
 */
function foldedDiffRows(finished: ToolExecutionFinished, width: number, opts: ToolSublineRenderOptions): string[] {
	if (opts.foldedExtras === "none") return [];
	if (finished.isError || isNonExecutedOutcome(finished.outcome)) return [];
	const presentation =
		toolResultPresentationPolicy(finished.result) ?? toolPresentationPolicy(finished.toolName, finished.args);
	if (!presentation.showDiffWhenFolded) return [];
	const diff = resultDiff(finished.result);
	if (diff === null) return [];
	return truncateRowsMiddle(
		renderMutationDiffBlock(diff, width, opts.diffStyle !== "plain"),
		FOLDED_DIFF_ROW_LIMIT,
		false,
	);
}

export function renderToolSubline(
	call: ToolExecutionStart | ToolExecutionFinished,
	width: number,
	expandKey?: string,
	opts: ToolSublineRenderOptions = {},
): string[] {
	const status = sublineStatus(call);
	const meta: StatusMeta =
		"result" in call
			? {
					durationMs: call.durationMs,
					exitCode: structuredExitCode(call),
					outcome: call.outcome,
					blockReason: call.blockReason,
				}
			: { elapsedMs: call.elapsedMs };
	const parts = sublineParts(call, status, meta);
	const excerpt = "result" in call ? failureExcerpt(call, width) : "";
	const showHint = "result" in call && expandKey !== undefined && expandKey.length > 0;
	const tail = showHint ? `${parts.tail}${dim(` (${expandKey})`)}` : parts.tail;
	const lines = wrapSublineWithTail(`${parts.lead}${excerpt}`, tail, width);
	if ("result" in call) lines.push(...foldedDiffRows(call, width, opts));
	return lines;
}

/**
 * Full render: header + args body (if non-empty) + result block. Used by
 * the live chat panel on `tool_execution_end` and by the replay path when a
 * tool result can be paired with its prior call's args. Header carries a
 * green check on success and a red cross on error so the user can scan tool
 * outcomes without reading the body.
 */
export function renderToolExecution(
	finished: ToolExecutionFinished,
	width: number,
	opts: ToolBodyRenderOptions = {},
): string[] {
	const status: HeaderStatus = finished.isError ? "error" : "ok";
	const statusMeta: StatusMeta = {
		durationMs: finished.durationMs,
		exitCode: structuredExitCode(finished),
		outcome: finished.outcome,
		blockReason: finished.blockReason,
	};
	const out: string[] = [];
	out.push(...wrap(headerLine(finished.toolName, finished.args, status, statusMeta), width));

	// Edit and write tools produce one bounded numbered diff on result.details.
	// It is the authority because canonical edit args can contain multiple
	// replacements and fuzzy matching can change the actual base text. Live rows
	// receive Pi's word-level styling; replay and export request plain rows.
	if ((finished.toolName === "edit" || finished.toolName === "write") && finished.isError === false) {
		const diff = resultDiff(finished.result);
		if (diff !== null) {
			out.push(...renderOutputMeta(finished, width, false, "change"));
			out.push(...renderMutationDiffBlock(diff, width, opts.diffStyle !== "plain"));
			out.push(...renderOutputFooter(finished, width, false));
			return out;
		}
	}

	// Bash-tool dispatch: when `args.command` is a string, prefix the result
	// body with `$ <cmd>` on its own line so the user sees the display command
	// above its output. Failures use the red rail and expose the parsed exit
	// code in the header when the result includes one.
	if (finished.toolName === "bash") {
		const bashArgs = asBashArgs(redactToolArgs(finished.args));
		if (bashArgs !== null) {
			out.push(...renderArgsBody(finished.toolName, finished.args, width, finished.isError));
			out.push(
				...renderOutputMeta(
					finished,
					width,
					finished.isError,
					isNonExecutedOutcome(finished.outcome) ? "decision" : "output",
				),
			);
			out.push(...renderBashResultBlock(bashArgs, finished.result, width, finished.isError, opts));
			out.push(...renderOutputFooter(finished, width, finished.isError));
			return out;
		}
	}

	// The primary argument already lives in the signature. Keep the secondary
	// fields below it so flags, ranges, working directories, and timeouts remain
	// inspectable without repeating the primary value.
	out.push(...renderArgsBody(finished.toolName, finished.args, width, finished.isError));
	out.push(
		...renderOutputMeta(
			finished,
			width,
			finished.isError,
			isNonExecutedOutcome(finished.outcome) ? "decision" : "output",
		),
	);
	out.push(...renderResultBlock(finished.result, finished.isError, width, opts));
	out.push(...renderOutputFooter(finished, width, finished.isError));
	return out;
}

/**
 * Result-only render for replayed tool results that arrived without a
 * matching prior tool-call entry (orphan results in the session log).
 * Identical to `renderToolExecution` minus the args body.
 */
export function renderToolResultOnly(
	finished: Omit<ToolExecutionFinished, "args">,
	width: number,
	opts: ToolBodyRenderOptions = {},
): string[] {
	const status: HeaderStatus = finished.isError ? "error" : "ok";
	const statusMeta: StatusMeta = {
		durationMs: finished.durationMs,
		exitCode: structuredExitCode(finished),
		outcome: finished.outcome,
		blockReason: finished.blockReason,
	};
	const out: string[] = [];
	out.push(...wrap(headerLine(finished.toolName, undefined, status, statusMeta), width));
	out.push(...renderOutputMeta(finished, width, finished.isError));
	out.push(...renderResultBlock(finished.result, finished.isError, width, opts));
	out.push(...renderOutputFooter(finished, width, finished.isError));
	return out;
}

/**
 * Streaming render for an in-flight tool call whose expanded block should
 * surface the latest partial output. Used by the chat panel between
 * `tool_execution_start` and `tool_execution_end` when the user has expanded
 * the tool segment. The header carries the running lifecycle tail, secondary
 * arguments remain visible, and the latest cumulative Pi result renders under
 * a labeled live-output rail capped at the streaming row limit. An empty result renders
 * `(no output yet)` so the user can distinguish a slow start from a stalled
 * call.
 */
export function renderToolStreamingExecution(
	call: ToolExecutionStart,
	width: number,
	partialResult: unknown,
): string[] {
	const out: string[] = [];
	out.push(...renderToolCallHeader({ ...call, phase: "running" }, width));
	out.push(...renderArgsBody(call.toolName, call.args, width, false));
	const partial: ToolExecutionFinished = {
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		args: call.args,
		result: partialResult,
		isError: false,
	};
	out.push(...renderOutputMeta(partial, width, false, "live output"));
	const partialOutput = unwrapResultEnvelope(partialResult);
	if (isEmptyResult(partialOutput)) {
		out.push(...indentAndWrap(dim("(no output yet)"), width, false));
	} else {
		if (call.toolName === "bash") {
			const bashArgs = asBashArgs(redactToolArgs(call.args));
			if (bashArgs !== null) {
				const commandLine = `${cyanBold("$")} ${highlightBashCommand(stripShellWrapperForDisplay(bashArgs.command))}`;
				out.push(...indentAndWrap(commandLine, width, false));
			}
		}
		out.push(
			...renderOutputRows(resultText(partialOutput, FULL_RESULT_PREVIEW_LIMIT), width, false, STREAMING_RESULT_ROW_LIMIT),
		);
	}
	return out;
}

/** Display-only lifecycle for operator-issued `!` and `!!` bash commands. */
export interface BashTranscriptExecution {
	command: string;
	output: string;
	running: boolean;
	elapsedMs?: number | undefined;
	totalBytes?: number | undefined;
	exitCode?: number | null | undefined;
	cancelled?: boolean | undefined;
	truncated?: boolean | undefined;
	fullOutputPath?: string | undefined;
	excludeFromContext?: boolean | undefined;
	error?: string | undefined;
	/**
	 * Whether the block draws its one-line row instead of the full body. The
	 * caller resolves this from the transcript detail policy and the operator's
	 * override, the same way the panel resolves a model bash call. Omitted means
	 * folded.
	 */
	folded?: boolean | undefined;
}

/**
 * Render local bash with the same call, argument, output, and settlement grammar
 * as model-initiated bash. This is a view projection only; callers keep Clio's
 * existing immutable `bashExecution` ledger entry.
 */
export function renderBashTranscriptExecution(
	execution: BashTranscriptExecution,
	width: number,
	expandKey?: string,
	bodyOptions: ToolBodyRenderOptions = {},
): string[] {
	const shownBytes = Buffer.byteLength(execution.output, "utf8");
	const totalBytes = execution.totalBytes ?? shownBytes;
	const args: Record<string, unknown> = { command: execution.command };
	if (execution.excludeFromContext === true) args.context = "not sent to model";
	const details = {
		resultSize: {
			bytes: totalBytes,
			shownBytes,
			truncated: execution.truncated === true,
			policy: "tail",
			...(execution.fullOutputPath !== undefined ? { offloadPath: execution.fullOutputPath } : {}),
		},
	};
	const result = {
		content: [{ type: "text", text: execution.output }],
		details,
	};
	const folded = execution.folded !== false;
	if (execution.running) {
		if (folded) {
			return renderToolSubline(
				{
					toolCallId: "local-bash",
					toolName: "bash",
					args,
					elapsedMs: execution.elapsedMs,
					phase: "running",
				},
				width,
			);
		}
		return renderToolStreamingExecution(
			{
				toolCallId: "local-bash",
				toolName: "bash",
				args,
				elapsedMs: execution.elapsedMs,
				phase: "running",
			},
			width,
			result,
		);
	}
	const message = execution.error?.trim();
	const output = message
		? `${execution.output}${execution.output.length > 0 ? "\n\n" : ""}${message}`
		: execution.output;
	const finished: ToolExecutionFinished = {
		toolCallId: "local-bash",
		toolName: "bash",
		args,
		result: { ...result, content: [{ type: "text", text: output }] },
		isError: execution.cancelled === true || execution.error !== undefined || (execution.exitCode ?? 0) !== 0,
		exitCode: execution.exitCode,
		...(execution.cancelled === true ? { outcome: "aborted" as const } : {}),
		excludeFromContext: execution.excludeFromContext,
		resultSummary: {
			bytes: shownBytes,
			truncated: execution.truncated === true,
			...(execution.fullOutputPath !== undefined ? { offloadPath: execution.fullOutputPath } : {}),
		},
	};
	return folded ? renderToolSubline(finished, width, expandKey) : renderToolExecution(finished, width, bodyOptions);
}
