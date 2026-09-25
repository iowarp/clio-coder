import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import { transcriptDetail } from "../transcript-detail.js";
import { previewBudget, previewRows } from "./preview.js";
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

import { isSkillLoadRefusal, type SkillLoadRefusal } from "../../core/skill-activation.js";
import { trustStateWord } from "../../domains/evidence/trust-projection.js";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../../domains/safety/call-target.js";
import { redactSecretString, redactToolArgs } from "../../domains/safety/redaction.js";
import { formatSize } from "../../engine/truncate.js";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import {
	CLASS_NOUNS,
	classifyResourceRead,
	type ResolvedToolRow,
	resolveToolRow,
	type ToolClass,
	type ToolRowPair,
} from "../../tools/presentation.js";
import { toolResultPresentationText } from "../../tools/result-disposition.js";
import { mutationFactsLine } from "../mutation-preview.js";
import type { ApprovalRequestView } from "../permission-overlay.js";
import { clioTheme, formatCompactMs, GLYPH, holdFact, joinFacts, releaseSpaces } from "../theme/index.js";
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

// The transcript is a two-cell gutter plus a content column. The action row
// puts `▸` in the gutter; its body nests under it with the rail in the content
// column (`  │ `), so arguments, output, and diffs read as belonging to the row
// above them instead of as more gutter-level blocks. Width budgets and diff
// renderers compute against the visible length, not the styled length, so the
// constant is kept as the plain-text representation.
const BODY_INDENT_VISIBLE_WIDTH = 4;
/** Hanging indent for a wrapped action row: continuation rows start in the content column. */
const CONTENT_INDENT = "  ";
const CONTENT_INDENT_WIDTH = 2;
const ARG_PREVIEW_LIMIT = 60;
const FULL_RESULT_PREVIEW_LIMIT = 60_000;
const FULL_RESULT_ROW_LIMIT = 120;
const STATUS_OK_GLYPH = GLYPH.ok;
const STATUS_ERROR_GLYPH = GLYPH.error;

// Hoisted rail prefixes. `indentAndWrap` would otherwise allocate two fresh
// styled strings per rendered line; by precomputing the dim and error variants
// once at module scope, repeated rendering of long result blocks stays cheap.
const RAIL_DIM = `${CONTENT_INDENT}${dim("│ ")}`;
const RAIL_ERROR = `${CONTENT_INDENT}${red("│ ")}`;

export interface ToolExecutionStart {
	toolCallId: string;
	toolName: string;
	args: unknown;
	/** Live elapsed time supplied by the panel for running segments. */
	elapsedMs?: number | undefined;
	/** Pi may stream a tool call's arguments before execution starts. */
	phase?: "forming" | "ready" | "running" | undefined;
	/** Admission's action class, once known; an unknown dynamic tool is classified by it. */
	actionClass?: string | undefined;
	/** Local `!!` bash output is visible to the operator but excluded from model context. */
	excludeFromContext?: boolean | undefined;
	/** A worker card sits under this dispatch call and states its task and outcome. */
	cardAttached?: boolean | undefined;
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
	/** Admission's action class; an unknown dynamic tool is classified by it. */
	actionClass?: string | undefined;
	/**
	 * A worker card sits under this dispatch call and states the run's outcome,
	 * so the row does not repeat it.
	 */
	cardAttached?: boolean | undefined;
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
	detail?: TranscriptDetailPolicy;
	terminalRows?: number;
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
	const cut = Math.max(0, limit - 1);
	return `${value.slice(0, cut)}${GLYPH.ellipsis}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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

/**
 * The status line a failed command's error text ends with: `bash: command
 * failed (exit 1)`, `Command exited with code 1`, a timeout or an abort. The
 * row states it as a fact, so the body leaves it out. A status that carries the
 * only diagnosis (`bash: command failed (exit 127): not found`) keeps that
 * diagnosis as the body line.
 */
const COMMAND_STATUS_LINE =
	/^(?:bash: command failed \(exit (?<exit>[^)]+)\)(?:: (?<message>.+))?|Command exited with code (?<code>[0-9?]+)|bash: command (?<timeout>timed out) after \d+ms|bash: command (?<aborted>aborted))$/u;

interface CommandStatus {
	/** Index of the status line in the result text's lines. */
	index: number;
	exit: string | null;
	timedOut: boolean;
	aborted: boolean;
	/** Text the status line carried beyond the status itself. */
	message: string | null;
}

function commandStatusLine(result: unknown): CommandStatus | null {
	const text = unwrapResultEnvelope(result);
	if (typeof text !== "string") return null;
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = (lines[index] ?? "").trim();
		if (line.length === 0) continue;
		const match = COMMAND_STATUS_LINE.exec(line);
		if (match?.groups === undefined) return null;
		return {
			index,
			exit: match.groups.exit ?? match.groups.code ?? null,
			timedOut: match.groups.timeout !== undefined,
			aborted: match.groups.aborted !== undefined,
			message: match.groups.message ?? null,
		};
	}
	return null;
}

/** A failed command's output without the status line its row already states. */
function withoutCommandStatus(result: unknown): unknown {
	const status = commandStatusLine(result);
	const text = unwrapResultEnvelope(result);
	if (status === null || typeof text !== "string") return result;
	const lines = text.split("\n");
	if (status.message !== null) lines[status.index] = status.message;
	else lines.splice(status.index, 1);
	return lines.join("\n").replace(/\n+$/u, "");
}

/** The longest argument value a row states inline rather than as a `key ›` row. */
const INLINE_ARG_LIMIT = 40;

/**
 * One scalar argument as the row states it: `context 2`, `glob *.ts`,
 * `query "flaky retry test"`. Long, multiline and structured values are not
 * inline; they stay `key ›` rows under the action.
 */
function inlineArgValue(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	if (typeof value !== "string" || /[\r\n\t]/u.test(value)) return null;
	const clean = sanitizeCallTargetText(redactSecretString(value)).trim();
	if (clean.length === 0 || clean.length > INLINE_ARG_LIMIT) return null;
	return /\s/u.test(clean) ? JSON.stringify(clean) : clean;
}

/** Longest URL label a row states; a narrower row gets a shorter one. */
const URL_LABEL_LIMIT = 48;

/**
 * A URL as a row names it: the host and the tail of the path, never the whole
 * URL. The label keeps as much of the path's tail as fits `budget`, so at 40
 * columns it still wraps as one token instead of splitting mid-path.
 */
function urlLabel(raw: string, budget = URL_LABEL_LIMIT): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return truncate(sanitizeCallTargetText(raw), ARG_PREVIEW_LIMIT);
	}
	const host = sanitizeCallTargetText(url.host);
	const segments = url.pathname
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => sanitizeCallTargetText(segment));
	if (segments.length === 0) return host;
	const whole = `${host}/${segments.join("/")}`;
	if (whole.length <= budget) return whole;
	for (const keep of [2, 1]) {
		if (segments.length <= keep) continue;
		const tail = `${host}/${GLYPH.ellipsis}/${segments.slice(-keep).join("/")}`;
		if (tail.length <= budget || keep === 1) return truncate(tail, Math.max(budget, 24));
	}
	return truncate(whole, Math.max(budget, 24));
}

/** The URL label budget for a row `width` columns wide: its content column, capped. */
function urlBudget(width: number | undefined): number {
	return width === undefined ? URL_LABEL_LIMIT : Math.max(24, Math.min(URL_LABEL_LIMIT, contentWidth(width)));
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

/** Observation units are plural nouns (`entries`, `lines`); one of them is singular. */
function unitFor(count: number, unit: string): string {
	if (count !== 1) return unit;
	if (unit.endsWith("ies")) return `${unit.slice(0, -3)}y`;
	if (/(?:ch|sh|x|ss)es$/u.test(unit)) return unit.slice(0, -2);
	return unit.endsWith("s") ? unit.slice(0, -1) : unit;
}

function countSummary(observation: Record<string, unknown>): string | null {
	const unit = stringField(observation, "unit") ?? "results";
	const shown = numberField(observation, "shownCount");
	if (shown === null) return null;
	const total = numberField(observation, "totalCount");
	if (total === null) return `${shown}+ ${unit}`;
	if (total === shown) return `${shown} ${unitFor(shown, unit)}`;
	return `${shown}/${total} ${unitFor(total, unit)}`;
}

/**
 * Outcome facts for the collapsed ledger line, derived from the observation
 * envelope (OBSERVE plane), the exec record (git/verify), or the dispatch
 * receipt counts. Returns null when the result carries no recognizable facts.
 */
/**
 * A settled skill load, read from the details `context(scope=skills)` returns.
 * Null for every other context call and for a load that failed.
 */
interface SkillLoadFacts {
	name: string;
	description: string | null;
	activation: string | null;
	/** The tool surface the skill declares: an allow-list, or the tools it removes. */
	allowedTools: string[];
	disallowedTools: string[];
	allowListAdvisory: boolean;
	drifted: boolean;
}

function skillLoadFacts(finished: ToolExecutionFinished): SkillLoadFacts | null {
	if (finished.toolName !== "context" || finished.isError || finished.outcome !== undefined) return null;
	if (!isPlainObject(finished.args) || finished.args.scope !== "skills") return null;
	const details = detailsOf(finished.result);
	const name = stringField(details, "name");
	if (name === null) return null;
	const declared = (key: string): string[] =>
		Array.isArray(details?.[key])
			? (details[key] as unknown[]).filter((tool): tool is string => typeof tool === "string")
			: [];
	return {
		name,
		description: stringField(details, "description"),
		activation: stringField(details, "activation"),
		allowedTools: declared("allowedTools"),
		disallowedTools: declared("disallowedTools"),
		allowListAdvisory: details?.allowListAdvisory === true,
		drifted: details?.drift === "mismatch",
	};
}

/** A skill the context tool refused to load, from the structured reason in its error details. */
function skillRefusalOf(finished: ToolExecutionFinished | null): SkillLoadRefusal | null {
	if (finished === null || !finished.isError) return null;
	const refusal = detailsOf(finished.result)?.refusal;
	return isSkillLoadRefusal(refusal) ? refusal : null;
}

/**
 * Why a skill did not load, and the one move that changes it, in the words the
 * row states after `skill <name> not loaded`. Commands read in the
 * slash-command accent.
 */
function refusalFact(refusal: SkillLoadRefusal): string {
	const command = (text: string) => cyan(sanitizeCallTargetText(text));
	const skill = `/skill ${refusal.name}`;
	switch (refusal.kind) {
		case "manual-only":
			return `${dim("manual-only: ")}${command(skill)}`;
		case "untrusted":
			return `${dim("untrusted: review it in ")}${command("/library")}`;
		case "not-imported":
			return dim(sanitizeCallTargetText(`not imported: found in ${refusal.source ?? "?"}/${refusal.scope ?? "?"}`));
		case "not-installed":
			return `${dim("not installed: ")}${command(skill)}`;
		case "not-ready":
			return `${dim(`installed but ${sanitizeCallTargetText(refusal.state ?? "not ready")}: `)}${command("/library")}`;
		case "operator-only":
			return `${dim("only you can load it: ")}${command(skill)}`;
		case "recipe-bound":
			return dim("not declared for this run");
		case "not-requested":
			return dim("not requested this turn");
		case "already-loaded":
			return dim("already loaded");
		default:
			return dim("unknown skill");
	}
}

/** The nested row a load states its tool surface on: `narrows tools to read, edit, bash`. */
function skillSurfaceLine(skill: SkillLoadFacts): string | null {
	if (skill.allowListAdvisory && skill.allowedTools.length > 0)
		return `recommends ${skill.allowedTools.join(", ")} in yolo${skill.disallowedTools.length > 0 ? `; blocks ${skill.disallowedTools.join(", ")}` : ""}`;
	if (skill.allowedTools.length > 0) return `narrows tools to ${skill.allowedTools.join(", ")}`;
	if (skill.disallowedTools.length > 0) return `narrows tools to all but ${skill.disallowedTools.join(", ")}`;
	return null;
}

/** Who a skill load answered: the operator's request, a bound recipe, or the model's own choice. */
const SKILL_ACTIVATION_WORDS: Readonly<Record<string, string>> = {
	operator: "by operator",
	recipe: "by recipe",
	model: "by model",
};

/**
 * The facts a settled row states after its object, by class. Every fact comes
 * from the call's structured result or its arguments; none is parsed out of
 * free text except a failed command's exit status, which the main agent's
 * error path delivers as text alone.
 */
function classFacts(finished: ToolExecutionFinished, row: ResolvedToolRow): string[] {
	const skill = skillLoadFacts(finished);
	if (skill !== null) {
		return [
			...(skill.activation !== null && SKILL_ACTIVATION_WORDS[skill.activation] !== undefined
				? [SKILL_ACTIVATION_WORDS[skill.activation] as string]
				: []),
		];
	}
	const details = detailsOf(finished.result);
	const observation = observationOf(finished);
	const parts: string[] = [];
	switch (row.spec.class) {
		case "observe":
		case "search":
		case "knowledge": {
			const range = observation === null ? null : lineRange(finished, observation);
			const count = observation === null ? null : countSummary(observation);
			if (range !== null) parts.push(range);
			else if (count !== null) parts.push(count);
			if (row.spec.class === "observe" && row.spec.statesSize !== false) parts.push(...sizeFacts(finished));
			break;
		}
		case "mutate": {
			const file = details?.file;
			if (isPlainObject(file) && "before" in file && file.before === null) parts.push("new file");
			break;
		}
		case "execute": {
			// Only a structured exit status is stated: a tool with no exit code
			// (panes, an unknown tool classified by admission) never shows one.
			const exitCode = structuredExitCode(finished);
			if (exitCode !== null) parts.push(`exit ${exitCode}`);
			const lines = finished.isError ? 0 : resultLineCount(finished.result);
			if (lines > 1) parts.push(`${lines} lines`);
			else parts.push(...sizeFacts(finished));
			break;
		}
		case "network": {
			const status = numberField(details, "status");
			if (status !== null) parts.push(String(status));
			const format = stringField(details, "format");
			if (format !== null) parts.push(format);
			const bytesRead = numberField(details, "bytesRead");
			if (bytesRead !== null) parts.push(formatSize(bytesRead));
			else parts.push(...sizeFacts(finished));
			if (details?.truncated === true) parts.push("truncated");
			break;
		}
		case "delegate": {
			const receipts = numberField(details, "receiptCount");
			if (receipts !== null) {
				// A card under the call is the run's row: a single dispatch states no
				// tally, a fan-out keeps its execution counts, and quality stays on
				// each card. A dispatch with no card carries both.
				if (finished.cardAttached === true && receipts <= 1) break;
				const failed = numberField(details, "failedCount") ?? 0;
				parts.push(failed > 0 ? `${receipts - failed} ok, ${failed} failed` : `${receipts} ok`);
				const quality = finished.cardAttached === true ? null : receiptQuality(details, receipts);
				if (quality !== null) parts.push(`quality ${quality}`);
				break;
			}
			const counts = isPlainObject(details?.counts) ? details.counts : null;
			const completed = numberField(counts, "completed");
			const total = numberField(counts, "total");
			if (completed !== null && total !== null) {
				const blocked = numberField(counts, "blocked") ?? 0;
				parts.push(`${completed}/${total} done${blocked > 0 ? ` · ${blocked} blocked` : ""}`);
			}
			break;
		}
		case "interaction":
			if (details?.cancelled === true) parts.push("cancelled");
			break;
		case "external": {
			const count = numberField(details, "count");
			const total = numberField(details, "total");
			if (count !== null) parts.push(total !== null && total !== count ? `${count} of ${total} found` : `${count} found`);
			else parts.push(...sizeFacts(finished));
			break;
		}
	}
	return parts;
}

/**
 * Validation quality across a dispatch's receipts, counted by state, with
 * receipts that carry no trust summary counted as unknown. Execution success
 * and quality stay separate facts: a run can execute cleanly and fail
 * validation.
 */
function receiptQuality(details: Record<string, unknown> | null, receipts: number): string | null {
	const runs = Array.isArray(details?.runs) ? details.runs.slice(0, receipts) : [];
	const counts = new Map<string, number>();
	for (const run of runs) {
		const trust = isPlainObject(run) && isPlainObject(run.trust) ? run.trust : null;
		const axes = isPlainObject(trust?.axes) ? trust.axes : null;
		const word = trustStateWord("validationGrounding", stringField(axes, "validationGrounding") ?? "unknown");
		counts.set(word, (counts.get(word) ?? 0) + 1);
	}
	if (runs.length < receipts) {
		const unknown = trustStateWord("validationGrounding", "unknown");
		counts.set(unknown, (counts.get(unknown) ?? 0) + receipts - runs.length);
	}
	return counts.size === 0 ? null : [...counts].map(([word, count]) => `${count} ${word}`).join(", ");
}

/** A read states the range it returned, which is truer than the window it asked for. */
function lineRange(finished: ToolExecutionFinished, observation: Record<string, unknown>): string | null {
	if (stringField(observation, "unit") !== "lines") return null;
	const shown = numberField(observation, "shownCount");
	const total = numberField(observation, "totalCount");
	if (shown === null || total === null) return null;
	const offsetRaw = isPlainObject(finished.args) ? finished.args.offset : undefined;
	const start = typeof offsetRaw === "number" && offsetRaw > 0 ? Math.floor(offsetRaw) : 1;
	return shown > 0 ? `lines ${start}-${start + shown - 1} of ${total}` : `0 of ${total} lines`;
}

/** `1.4KB`, or `1.4KB of 4.3KB` when the result kept only part of what it read. */
function sizeFacts(finished: ToolExecutionFinished): string[] {
	const bytes = shownBytesOf(finished);
	if (bytes === null || bytes <= 0) return [];
	const total = totalBytesOf(finished);
	return [total !== null && total > bytes ? `${formatSize(bytes)} of ${formatSize(total)}` : formatSize(bytes)];
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
	return finished.isError ? (commandStatusLine(finished.result)?.exit ?? null) : null;
}

/**
 * The dim facts after a settled row's object: the class facts, then the
 * flags every class shares, and the offload path for a truncated call. The
 * change stat rides first in its own colors. One line of plain text carries
 * the call and its outcome when copied.
 */
function ledgerTail(finished: ToolExecutionFinished, row: ResolvedToolRow): { facts: string; offload: string } {
	const executed = !isNonExecutedOutcome(finished.outcome);
	const parts = executed ? classFacts(finished, row) : [];
	if (executed) {
		if (isTruncatedResult(finished) && !parts.includes("truncated")) parts.push("truncated");
		const details = detailsOf(finished.result);
		const status = row.spec.class === "execute" && finished.isError ? commandStatusLine(finished.result) : null;
		if (details?.timedOut === true || status?.timedOut === true) {
			// The row does not state a timeout the command stayed under; one it hit is the fact.
			const limit = typeof row.args.timeout_ms === "number" ? optionalCompactMs(row.args.timeout_ms) : null;
			parts.push(limit === null ? "timed out" : `timed out after ${limit}`);
		}
		if (status?.aborted === true) parts.push("aborted");
		if (details?.outputCapped === true) parts.push("output capped");
	}
	if (row.viaGateway) parts.push("via gateway");
	if (finished.excludeFromContext === true) parts.push("not sent to model");
	if (finished.evictedReason !== undefined) parts.push("evicted", finished.evictedReason);
	const stat = executed && !finished.isError ? changeStat(finished.result) : null;
	// Every fact is held together, so a narrow row wraps between facts
	// (`… · exit 0 ·` then `18 lines`), never inside one.
	const statText =
		stat === null ? "" : `${dim(" · ")}${green(`+${stat.added}`)}${holdFact(" ")}${red(`-${stat.removed}`)}`;
	// A skill whose content no longer matches its recorded hash is the one
	// skill fact that is a warning rather than provenance.
	const driftText = skillLoadFacts(finished)?.drifted === true ? `${dim(" · ")}${yellow("drifted")}` : "";
	// An offloaded result says where the rest is, not what its path is: the
	// path is a 64-hex name that wrapped a row across three, and /view and the
	// full body's footer state it.
	const offloadPath = executed ? offloadPathOf(finished) : null;
	return {
		facts: `${statText}${parts.length > 0 ? dim(joinFacts(["", ...parts.map((part) => sanitizeCallTargetText(part))])) : ""}${driftText}`,
		offload:
			offloadPath === null
				? ""
				: offloadFileMissing(finished)
					? dim(" · full output gone after the 14-day retention sweep")
					: dim(" · full output · /view"),
	};
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
	const parts = sublineParts(
		{ toolCallId: call.toolCallId, toolName: call.toolName, args: call.args },
		undefined,
		{},
		width,
	);
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
	outcome?: ToolExecutionFinished["outcome"];
	/** Refusal reason, rendered only alongside a non-executed outcome. */
	blockReason?: string | undefined;
}

function statusGlyph(status: HeaderStatus, meta: StatusMeta = {}): string {
	if (status === undefined) return "";
	if (status === "forming") return ` ${dim(GLYPH.queued)}${dim(" forming call")}`;
	if (status === "ready") return ` ${dim(GLYPH.queued)}${dim(" ready")}`;
	if (status === "running") {
		// The progressive verb already says the call is running; the tail adds
		// only the live mark and the elapsed time.
		const elapsed = optionalCompactMs(meta.elapsedMs);
		return ` ${cyan(GLYPH.running)}${elapsed === null ? "" : dim(` ${elapsed}`)}`;
	}
	const duration = optionalCompactMs(meta.durationMs);
	const durationSuffix = duration ? dim(` · ${duration}`) : "";
	if (status === "ok") return ` ${green(STATUS_OK_GLYPH)}${durationSuffix}`;
	// A blocked row says `blocked` as its verb; an aborted or orphaned one names
	// its outcome here. The exit status is a fact on the row, never a suffix.
	const outcomeSuffix = meta.outcome !== undefined && meta.outcome !== "blocked" ? dim(` ${meta.outcome}`) : "";
	// A refusal that names no rule tells the operator only that something was
	// stopped. The reason rides the same tail as the outcome so the collapsed
	// row and the expanded header state it identically.
	const reason = meta.outcome !== undefined ? meta.blockReason?.trim() : undefined;
	const reasonSuffix = reason ? dim(` · ${truncate(reason, BLOCK_REASON_LIMIT)}`) : "";
	return ` ${red(STATUS_ERROR_GLYPH)}${outcomeSuffix}${reasonSuffix}${durationSuffix}`;
}

const CLASS_MARKS: Readonly<Record<ToolClass, string>> = {
	observe: GLYPH.toolHeader,
	search: GLYPH.toolHeader,
	knowledge: GLYPH.classKnowledge,
	mutate: GLYPH.classMutate,
	execute: GLYPH.classExecute,
	network: GLYPH.classNetwork,
	delegate: GLYPH.workerAgent,
	interaction: GLYPH.classInteraction,
	external: GLYPH.classExternal,
};

/** The class mark in the gutter, dim, with the space that separates it from the verb. */
function classMark(toolClass: ToolClass): string {
	return dim(`${CLASS_MARKS[toolClass]} `);
}

/** The row a call reads as, from its redacted arguments and, once settled, its result. */
function resolveRow(call: ToolExecutionStart | ToolExecutionFinished): ResolvedToolRow {
	const finished = "result" in call ? call : null;
	return resolveToolRow(call.toolName, redactToolArgs(call.args), detailsOf(finished?.result), call.actionClass, {
		cardAttached: call.cardAttached === true,
		cwd: process.cwd(),
	});
}

/**
 * Longest object a row states before it cuts with an ellipsis. A wide row
 * states more of a command, up to 120 characters; a question to the operator
 * is the whole point of its row and runs to 160.
 */
function objectLimit(toolClass: ToolClass, width?: number): number {
	if (toolClass === "interaction") return 160;
	if (width === undefined) return ARG_PREVIEW_LIMIT;
	return Math.max(ARG_PREVIEW_LIMIT, Math.min(120, contentWidth(width) - 24));
}

/**
 * The row's object: a command or a pattern in backticks, a URL as its host
 * and path tail, a path as its tail when it must be cut, anything else plain;
 * an MCP or extension capability as `server › tool`. Always one sanitized line.
 */
function rowObject(row: ResolvedToolRow, finished: ToolExecutionFinished | null, width?: number): string {
	if (row.externalLabel !== null) return sanitizeCallTargetText(row.externalLabel);
	const skill = finished === null ? null : skillLoadFacts(finished);
	if (skill !== null) return `skill ${cyan(truncate(sanitizeCallTargetText(skill.name), ARG_PREVIEW_LIMIT))}`;
	if (row.spec.object === undefined) return sanitizeCallTargetText(row.toolName);
	const display = objectDisplay(row, width);
	if (display === null) return "";
	if (display.style === "url" || display.style === "path") return display.shown;
	const clean = display.shown.length < display.full.length ? `${display.shown}${GLYPH.ellipsis}` : display.shown;
	return display.style === "code" ? `\`${clean}\`` : clean;
}

/**
 * The object as the row shows it: `full` is the sanitized one-line text, and
 * `shown` is what survives the row's length limit (without the ellipsis). A
 * URL shows as its host and path tail, and a cut path as `…` and its tail,
 * ellipsis included.
 */
function objectDisplay(
	row: ResolvedToolRow,
	width?: number,
): { full: string; shown: string; style?: "code" | "url" | "path" } | null {
	const object = row.spec.object?.(row.args, row.context) ?? null;
	if (object === null) return null;
	if (object.style === "url") return { full: object.text, shown: urlLabel(object.text, urlBudget(width)), style: "url" };
	const full = displayText(object.text, object.style);
	const limit = objectLimit(row.spec.class, width);
	if (object.style === "path") {
		// A path that fits beside its verb stays whole, so no `path ›` row repeats
		// it. One that must be cut leaves room for the outcome too, so its tail
		// and the row's status share the first line.
		if (width === undefined) return { full, shown: full.length <= limit ? full : pathTail(full, limit), style: "path" };
		const whole = Math.min(limit, contentWidth(width) - 10);
		const cut = Math.max(16, Math.min(limit, contentWidth(width) - 20));
		return { full, shown: full.length <= whole ? full : pathTail(full, cut), style: "path" };
	}
	const shown = full.length <= limit ? full : full.slice(0, Math.max(0, limit - 1));
	return object.style === undefined ? { full, shown } : { full, shown, style: object.style };
}

/**
 * A path cut to `limit` characters from the left, so the file name survives:
 * `…/src/net/retry.js`. The tail starts at a directory boundary when one falls
 * inside it.
 */
function pathTail(full: string, limit: number): string {
	const chars = Array.from(full);
	const tail = chars.slice(Math.max(0, chars.length - Math.max(1, limit - 1))).join("");
	const slash = tail.indexOf("/");
	return `${GLYPH.ellipsis}${slash > 0 && slash < tail.length - 1 ? tail.slice(slash) : tail}`;
}

function displayText(value: string, style?: "code" | "url" | "path"): string {
	return sanitizeCallTargetText(style === "code" ? stripShellWrapperForDisplay(value) : value);
}

/**
 * Argument fields a settled row's facts already state, beyond the ones its
 * object consumes: the format a fetch returned, the window a read asked for
 * when the row states the range it got.
 */
function factConsumedFields(row: ResolvedToolRow, finished: ToolExecutionFinished | null): readonly string[] {
	if (finished === null || finished.isError || finished.outcome !== undefined) return [];
	if (row.spec.class === "network" && stringField(detailsOf(finished.result), "format") !== null) return ["format"];
	const observation = observationOf(finished);
	if (observation !== null && lineRange(finished, observation) !== null) return ["offset", "limit"];
	return [];
}

/**
 * Mutation payloads. A settled change is described by its diff (Standard and
 * Detailed) or its `+N -M` change facts (Compact); the raw replacement text is
 * inspection material. A failed mutation keeps its payload visible, bounded,
 * because the text that did not match is the diagnosis.
 */
const MUTATION_PAYLOAD_FIELDS = ["edits", "oldText", "newText", "content"] as const;

/** Scalar arguments the row states inline, as `key value`, in argument order. */
function inlineArgs(row: ResolvedToolRow, finished: ToolExecutionFinished | null): string[] {
	// A call whose worker card sits under it leaves the run's facts, its route
	// included, to the card: the row reads `◆ delegated to scout ✓ · 38s`.
	if (row.context.cardAttached === true) return [];
	const skip = new Set<string>([...row.spec.consumes, ...factConsumedFields(row, finished)]);
	if (row.spec.class === "mutate") for (const key of MUTATION_PAYLOAD_FIELDS) skip.add(key);
	const out: string[] = [];
	for (const [key, value] of Object.entries(row.args)) {
		if (skip.has(key) || value === undefined || value === null) continue;
		const shown = inlineArgValue(value);
		// A flag that is on reads as its name (`ignore_case`, `detach`).
		if (shown !== null)
			out.push(value === true ? sanitizeCallTargetText(key) : `${sanitizeCallTargetText(key)} ${shown}`);
	}
	return out;
}

/**
 * The question and answer pairs a settled call resolved, as its registry row
 * reads them from the structured result. A failed or blocked call resolved
 * nothing.
 */
function resolvedPairs(row: ResolvedToolRow, finished: ToolExecutionFinished | null): readonly ToolRowPair[] {
	if (finished === null || finished.isError || finished.outcome !== undefined || row.spec.pairs === undefined) return [];
	return row.spec.pairs(row.args, detailsOf(finished.result));
}

/**
 * A single pair rides the row as `→ answer` when the row's object already
 * states its question; every other set nests, one `question → answer` row each.
 */
function inlinePair(row: ResolvedToolRow, pairs: readonly ToolRowPair[]): ToolRowPair | null {
	const only = pairs.length === 1 ? pairs[0] : undefined;
	if (only === undefined) return null;
	const display = objectDisplay(row);
	return display !== null && display.full === displayText(only.question) ? only : null;
}

function styledVerb(verb: string, toolClass: ToolClass): string {
	return theme.style(toolClass === "delegate" ? "agent" : "tool", verb, { bold: true });
}

function headerLine(
	call: ToolExecutionStart | ToolExecutionFinished,
	status: HeaderStatus,
	meta: StatusMeta,
	width: number,
): string {
	const parts = sublineParts(call, status, meta, width);
	return `${parts.lead}${parts.tail}`;
}

/**
 * A call blocked at admission never executed, so its row must not claim it
 * did: its verb is `blocked`, and the ledger byte count is suppressed because
 * those bytes are the denial text, not output.
 */
function isNonExecutedOutcome(outcome: ToolExecutionFinished["outcome"]): boolean {
	return outcome === "blocked";
}

interface SublineParts {
	/** Mark, verb, object and ledger facts. Breakable across wraps. */
	lead: string;
	/**
	 * Status glyph, duration, and any offload path, composed as one unit. A
	 * wrap may fall before the status glyph but never between the glyph, the
	 * duration, and the offload path. Begins with a joining space so it attaches
	 * to the lead's last line when they share a row. Empty for a call with no
	 * status yet.
	 */
	tail: string;
}

function sublineParts(
	call: ToolExecutionStart | ToolExecutionFinished,
	status: HeaderStatus,
	meta: StatusMeta,
	width?: number,
): SublineParts {
	const finished = "result" in call ? call : null;
	const row = resolveRow(call);
	// A refused skill load reads as plainly as a load: what did not load, why,
	// and the move that changes it.
	const refusal = skillRefusalOf(finished);
	if (refusal !== null) {
		const lead = `${classMark("knowledge")}${dim("skill")} ${cyan(sanitizeCallTargetText(refusal.name))} ${styledVerb("not loaded", "knowledge")}${dim(" · ")}${refusalFact(refusal)}`;
		return { lead, tail: statusGlyph(status, meta) };
	}
	const settled = status === "ok" || status === "error";
	const verb = isNonExecutedOutcome(finished?.outcome) ? "blocked" : settled ? row.spec.verbs[1] : row.spec.verbs[0];
	const object = rowObject(row, finished, width);
	const scopeText = row.spec.scope?.(row.args, row.context) ?? null;
	const scope = scopeText === null ? "" : ` in ${truncate(sanitizeCallTargetText(scopeText), ARG_PREVIEW_LIMIT)}`;
	const inline = inlinePair(row, resolvedPairs(row, finished));
	const answer =
		inline === null
			? ""
			: ` ${dim("→")} ${theme.fg("muted", truncate(sanitizeCallTargetText(inline.answer), ARG_PREVIEW_LIMIT))}`;
	const scalars = inlineArgs(row, finished);
	// A resource read names what it read (`handbook`) unless the path the row
	// shows already says so (`docs/retry.md`, `SKILL.md`).
	const resourceLabel = classifyResourceRead(call.toolName, call.args);
	const resource =
		resourceLabel !== null && !stripTerminalSequences(object).toLowerCase().includes(resourceLabel)
			? dim(` · ${resourceLabel}`)
			: "";
	const inlineText = scalars.length > 0 ? dim(` · ${scalars.join(" · ")}`) : "";
	const head = `${classMark(row.spec.class)}${styledVerb(verb, row.spec.class)}${object.length > 0 ? ` ${object}` : ""}${scope}${answer}${resource}${inlineText}`;
	if (finished !== null) {
		const ledger = ledgerTail(finished, row);
		return { lead: `${head}${ledger.facts}`, tail: `${statusGlyph(status, meta)}${ledger.offload}` };
	}
	const via = row.viaGateway ? dim(" · via gateway") : "";
	const local = call.excludeFromContext === true ? dim(" · not sent to model") : "";
	return { lead: `${head}${via}${local}`, tail: statusGlyph(status, meta) };
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
	if (tail.length === 0) return wrapHanging(lead, width);
	if (visibleWidth(`${lead}${tail}`) <= width) return [releaseSpaces(`${lead}${tail}`)];
	const leadLines = wrapHanging(lead, width);
	const last = leadLines[leadLines.length - 1];
	if (last !== undefined && visibleWidth(`${last}${tail}`) <= width) {
		leadLines[leadLines.length - 1] = releaseSpaces(`${last}${tail}`);
		return leadLines;
	}
	// The tail cannot sit beside the lead: give it its own row in the content
	// column, dropping the joining leading space.
	return [...leadLines, ...indentRows(wrap(tail.replace(/^ +/u, ""), contentWidth(width)))];
}

function wrap(line: string, width: number): string[] {
	return wrapTextWithAnsi(line, width).map(releaseSpaces);
}

function contentWidth(width: number): number {
	return Math.max(1, width - CONTENT_INDENT_WIDTH);
}

function indentRows(rows: string[]): string[] {
	return rows.map((row) => `${CONTENT_INDENT}${row}`);
}

/**
 * Wrap an action row with a hanging indent. The first row keeps the `▸` in the
 * gutter; every continuation starts in the content column, so a long dispatch
 * or command row never wraps back to column 0 where it would read as the next
 * action.
 */
function wrapHanging(line: string, width: number): string[] {
	if (visibleWidth(line) <= width) return [releaseSpaces(line)];
	const rows = wrap(line, contentWidth(width));
	return rows.map((row, index) => (index === 0 ? row : `${CONTENT_INDENT}${row}`));
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

function isScalarList(value: unknown): value is Array<string | number | boolean> {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(item) =>
				(typeof item === "string" && !/[\r\n]/u.test(item)) || typeof item === "number" || typeof item === "boolean",
		)
	);
}

/** Full redacted arguments are retained for inspection; transcript callers budget rows. */
export function renderToolArguments(
	args: unknown,
	width: number,
	isError = false,
	maxRows = Number.POSITIVE_INFINITY,
	joinScalarLists = false,
): string[] {
	if (isEmptyArgs(args)) return [];
	const safeArgs = redactToolArgs(args);
	const out: string[] = [];
	const entries = isPlainObject(safeArgs) ? Object.entries(safeArgs) : [["input", safeArgs] as const];
	for (const [key, value] of entries) {
		// In the transcript a list of short scalars reads as one row (`paths ›
		// a.ts · b.ts`), not as the multi-row JSON array it would pretty-print
		// to. Inspection and approval keep the exact JSON.
		const text =
			typeof value === "string"
				? value
				: joinScalarLists && isScalarList(value)
					? value.map((item) => String(item)).join(" · ")
					: JSON.stringify(value, null, 2);
		const full = String(text ?? value);
		const chars = Number.isFinite(maxRows) ? Math.max(1, maxRows * Math.max(1, width) * 4) : full.length;
		const lines = full.slice(0, chars).split("\n");
		out.push(
			...indentAndWrap(
				`${cyan(sanitizeCallTargetText(key))} ${dim("›")} ${sanitizeMultilineDisplayText(lines[0] ?? "").text}`,
				width,
				isError,
			),
		);
		for (const line of lines.slice(1)) {
			if (out.length > maxRows) break;
			out.push(...indentAndWrap(`  ${sanitizeMultilineDisplayText(line).text}`, width, isError));
		}
		if (out.length > maxRows || full.length > chars) {
			return [
				...out.slice(0, Math.max(0, maxRows - 1)),
				...indentAndWrap(dim("… more arguments · /view"), width, isError),
			];
		}
	}
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

/**
 * Tool output is untrusted terminal input. Cursor movement, backspaces and
 * carriage returns inside a row break the diff renderer's one-row-per-line
 * accounting, so everything but the line structure is neutralized here.
 */
/**
 * Lines middleware attaches to a tool result for the model (`[middleware:info]
 * …`), split from the output they lead or trail. Only whole lines at the start
 * or the end of the text count, so output that merely quotes the tag stays put.
 */
const MODEL_NOTE_LINE = /^\[middleware:[a-z-]+\] (.+)$/u;

function splitModelNotes(text: string): { body: string; notes: string[] } {
	const lines = text.split("\n");
	const leading: string[] = [];
	while (lines.length > 0) {
		const note = MODEL_NOTE_LINE.exec(lines[0] ?? "")?.[1];
		if (note === undefined) break;
		leading.push(note);
		lines.shift();
		while (lines.length > 0 && (lines[0] ?? "").trim().length === 0) lines.shift();
	}
	const trailing: string[] = [];
	while (lines.length > 0) {
		const note = MODEL_NOTE_LINE.exec(lines[lines.length - 1] ?? "")?.[1];
		if (note === undefined) break;
		trailing.unshift(note);
		lines.pop();
	}
	if (trailing.length > 0) while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim().length === 0) lines.pop();
	return { body: lines.join("\n"), notes: [...leading, ...trailing] };
}

function resultText(result: unknown, limit = FULL_RESULT_PREVIEW_LIMIT): string {
	const text = typeof result === "string" ? result : jsonStringifySafe(result);
	return truncate(sanitizeMultilineDisplayText(text).text, limit);
}

function truncateRowsMiddle(rows: ReadonlyArray<string>, rowLimit: number, isError: boolean): string[] {
	if (rows.length <= rowLimit) return [...rows];
	if (rowLimit <= 1)
		return [`${isError ? RAIL_ERROR : RAIL_DIM}${dim(`${GLYPH.ellipsis} ${rows.length} lines hidden`)}`];
	const available = rowLimit - 1;
	const head = Math.floor(available / 2);
	const tail = available - head;
	const hidden = Math.max(0, rows.length - head - tail);
	return [
		...rows.slice(0, head),
		`${isError ? RAIL_ERROR : RAIL_DIM}${dim(`${GLYPH.ellipsis} ${hidden} lines hidden`)}`,
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
	// Every character lands in some token: a lone `&` (`2>&1`, a background
	// job) is an operator, never dropped.
	const tokens = command.match(/'[^']*'|"[^"]*"|\|\||&&|[|;&()<>]|[^\s|;&()<>]+|\s+/gu) ?? [command];
	return tokens
		.map((token) => {
			if (/^\s+$/u.test(token)) return token;
			if (/^'[^']*'$|^"[^"]*"$/u.test(token)) return green(token);
			if (/^(?:\|\||&&|[|;&()<>])$/u.test(token)) return dim(token);
			if (/^-{1,2}[\w-]+/u.test(token)) return yellow(token);
			return token;
		})
		.join("");
}

function resultDiff(result: unknown): string | null {
	const value = detailsOf(result)?.diff;
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Numbered rows from the edit-diff producer: `+12 text`, `- 5 text`. */
const DIFF_ADDED_ROW = /^\+\s*\d+ /u;
const DIFF_REMOVED_ROW = /^-\s*\d+ /u;

/**
 * Added and removed line counts of a mutation, read from the diff the tool
 * returned. These are the change facts a folded row carries in every style,
 * which is what lets Compact describe a change without its payload. A diff the
 * producer capped is partial, so it states nothing rather than a low count.
 */
function changeStat(result: unknown): { added: number; removed: number } | null {
	const diff = resultDiff(result);
	if (diff === null || diff.includes("diff truncated")) return null;
	let added = 0;
	let removed = 0;
	for (const row of diff.split("\n")) {
		if (DIFF_ADDED_ROW.test(row)) added += 1;
		else if (DIFF_REMOVED_ROW.test(row)) removed += 1;
	}
	return added + removed > 0 ? { added, removed } : null;
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

function sublineStatus(call: ToolExecutionStart | ToolExecutionFinished): HeaderStatus {
	// Discriminate on `result` rather than `isError`: only `ToolExecutionFinished`
	// carries a `result` field, so a `ToolExecutionStart` with a stray
	// `isError: false` (e.g. from a future event-shape change) cannot trip the
	// finished path. `result` is the type's load-bearing field.
	if (!("result" in call)) return call.phase ?? "running";
	return call.isError ? "error" : "ok";
}

/** Stable action identity, outcome, and captured-result metadata. */
export function renderToolSubline(call: ToolExecutionStart | ToolExecutionFinished, width: number): string[] {
	const status = sublineStatus(call);
	const meta: StatusMeta =
		"result" in call
			? { durationMs: call.durationMs, outcome: call.outcome, blockReason: call.blockReason }
			: { elapsedMs: call.elapsedMs };
	// A failed call always shows its bounded body, which carries the diagnosis;
	// the row states the outcome once and never excerpts the body onto itself.
	const parts = sublineParts(call, status, meta, width);
	return wrapSublineWithTail(parts.lead, parts.tail, width);
}

/**
 * What a call's row states, as one line of plain text with its class mark and
 * without its outcome tail: `$ ran \`npm test\` · exit 1`. `/view` titles the
 * call with it, so the list reads like the transcript.
 */
export function toolRowTitle(call: ToolExecutionStart | ToolExecutionFinished): string {
	const status = sublineStatus(call);
	const meta: StatusMeta = "result" in call ? { outcome: call.outcome } : {};
	return releaseSpaces(stripTerminalSequences(sublineParts(call, status, meta).lead));
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
		outcome: finished.outcome,
		blockReason: finished.blockReason,
	};
	const row = resolveRow(finished);
	const out: string[] = [];
	out.push(...wrapHanging(headerLine(finished, status, statusMeta, width), width));

	// A mutation produces one bounded numbered diff on result.details. It is the
	// authority because canonical edit args can contain multiple replacements
	// and fuzzy matching can change the actual base text. Live rows receive
	// Pi's word-level styling; replay and export request plain rows.
	if (row.spec.class === "mutate" && finished.isError === false) {
		const diff = resultDiff(finished.result);
		if (diff !== null) {
			out.push(...renderToolArguments(finished.args, width, false));
			out.push(...renderOutputMeta(finished, width, false, "change"));
			out.push(...renderMutationDiffBlock(diff, width, opts.diffStyle !== "plain"));
			out.push(...renderOutputFooter(finished, width, false));
			return out;
		}
	}

	// A command echoes as `$ <cmd>` above its output, so the display command
	// reads whole even where the row had to shorten it.
	if (row.spec.class === "execute") {
		const bashArgs = asBashArgs(redactToolArgs(finished.args));
		if (bashArgs !== null) {
			out.push(...renderToolArguments(finished.args, width, finished.isError));
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

	// The heading is a preview; inspection retains every redacted argument.
	out.push(...renderToolArguments(finished.args, width, finished.isError));
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
	if (!opts.unbounded && opts.detail) return renderToolPreview(finished, width, opts.detail, opts);
	const status: HeaderStatus = finished.isError ? "error" : "ok";
	const statusMeta: StatusMeta = {
		durationMs: finished.durationMs,
		outcome: finished.outcome,
		blockReason: finished.blockReason,
	};
	const out: string[] = [];
	out.push(...wrapHanging(headerLine({ ...finished, args: undefined }, status, statusMeta, width), width));
	out.push(...renderOutputMeta(finished, width, finished.isError));
	out.push(...renderResultBlock(finished.result, finished.isError, width, opts));
	out.push(...renderOutputFooter(finished, width, finished.isError));
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
}

/**
 * Render local bash with the same call, argument, output, and settlement grammar
 * as model-initiated bash. This is a view projection only; callers keep Clio's
 * existing immutable `bashExecution` ledger entry.
 */
export function renderBashTranscriptExecution(
	execution: BashTranscriptExecution,
	width: number,
	_expandKey?: string,
	bodyOptions: ToolBodyRenderOptions = {},
): string[] {
	const shownBytes = Buffer.byteLength(execution.output, "utf8");
	const totalBytes = execution.totalBytes ?? shownBytes;
	const args: Record<string, unknown> = { command: execution.command };
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
	if (execution.running) {
		return renderToolPreview(
			{
				toolCallId: "local-bash",
				toolName: "bash",
				args,
				phase: "running",
				elapsedMs: execution.elapsedMs,
				excludeFromContext: execution.excludeFromContext,
			},
			width,
			bodyOptions.detail ?? transcriptDetail(),
			{ ...bodyOptions, operator: true, partialResult: result },
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
	return bodyOptions.unbounded
		? renderToolExecution(finished, width, bodyOptions)
		: renderToolPreview(finished, width, bodyOptions.detail ?? transcriptDetail(), { ...bodyOptions, operator: true });
}

/**
 * The arguments a row's body lists as `key ›` rows: only what the row could
 * not state. The object and scope fields, the scalars that rode inline and the
 * fields the facts state never repeat here, except an object the row had to
 * shorten, which keeps its whole value (a URL never: the row names its host and
 * path). A gateway call lists its capability's own arguments. A settled
 * mutation's payload is inspection material; a failed one keeps it, bounded,
 * because the text that did not match is the diagnosis.
 */
function previewArguments(call: ToolExecutionStart | ToolExecutionFinished, width: number): Record<string, unknown> {
	const row = resolveRow(call);
	const finished = "result" in call ? call : null;
	const failed = finished !== null && (finished.isError || finished.outcome !== undefined);
	const consumed = new Set<string>([...row.spec.consumes, ...factConsumedFields(row, finished)]);
	const display = objectDisplay(row, width);
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row.args)) {
		if (value === undefined || value === null) continue;
		const payload = (MUTATION_PAYLOAD_FIELDS as readonly string[]).includes(key) && row.spec.class === "mutate";
		if (payload) {
			if (failed) rest[key] = key === "edits" ? flattenSingleEdit(value) : value;
			continue;
		}
		if (consumed.has(key)) {
			if (typeof value === "string" && cutFromRow(value, display)) rest[key] = value;
			continue;
		}
		if (inlineArgValue(value) !== null) continue;
		rest[key] = value;
	}
	return rest;
}

/**
 * Whether the row lost part of a field it states in its object: the length
 * limit cut it, or the one-line row flattened a multiline value. A field the
 * row shows whole, a URL (the row names its host and path by design), and a
 * field that is not part of the object at all never repeat.
 */
function cutFromRow(value: string, display: ReturnType<typeof objectDisplay>): boolean {
	if (display === null || display.style === "url") return false;
	const field = displayText(value, display.style);
	if (field.length === 0 || !display.full.includes(field)) return false;
	return /[\r\n\t]/u.test(value.trim()) || !display.shown.includes(field);
}

/** `text` without its first non-blank line when that line is `line`. */
function withoutLeadingLine(text: string, line: string): string {
	const lines = text.split("\n");
	const first = lines.findIndex((entry) => entry.trim().length > 0);
	return first >= 0 && lines[first]?.trim() === line ? lines.slice(first + 1).join("\n") : text;
}

/** One edit states its two texts as two rows; several stay the list they are. */
function flattenSingleEdit(value: unknown): unknown {
	if (!Array.isArray(value) || value.length !== 1 || !isPlainObject(value[0])) return value;
	return value[0];
}

/** Invocation intent stays visible in every style; /view retains the complete arguments and output. */
export function renderToolPreview(
	call: ToolExecutionStart | ToolExecutionFinished,
	width: number,
	detail: TranscriptDetailPolicy,
	options: ToolBodyRenderOptions & { terminalRows?: number; partialResult?: unknown; operator?: boolean } = {},
): string[] {
	const finished = "result" in call ? call : undefined;
	const failure = finished?.isError === true || finished?.outcome !== undefined;
	const row = resolveRow(call);
	const command = row.spec.class === "execute";
	const limit = previewBudget(
		failure
			? detail.errorRows
			: options.operator
				? detail.operatorBashRows
				: command
					? detail.bashRows
					: detail.resultRows,
		options.terminalRows,
	);
	const rows = renderToolSubline(call, width);
	const args = previewArguments(call, width);
	const expanded = isPlainObject(args.edits) ? { ...args, ...args.edits, edits: undefined } : args;
	rows.push(
		...renderToolArguments(
			Object.fromEntries(Object.entries(expanded).filter(([, value]) => value !== undefined)),
			width,
			failure,
			previewBudget(detail.invocationRows, options.terminalRows),
			true,
		),
	);
	// A refused skill load states its reason on the row; its message is the
	// model's instruction and stays in /view.
	if (finished !== undefined && skillRefusalOf(finished) !== null) return rows;
	const skill = finished ? skillLoadFacts(finished) : null;
	// The tool surface a loaded skill declares and the one line that says what
	// it is for; Compact keeps the row alone.
	if (skill !== null && detail.style !== "compact") {
		const surface = skillSurfaceLine(skill);
		for (const line of [surface, skill.description]) {
			if (line === null || line.length === 0) continue;
			rows.push(
				`${RAIL_DIM}${theme.fg("muted", truncateToWidth(sanitizeCallTargetText(line), Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH), GLYPH.ellipsis))}`,
			);
		}
	}
	// Pairs the row could not carry inline: each question and its answer, or
	// each decision, on its own row.
	const pairs = resolvedPairs(row, finished ?? null);
	if (pairs.length > 0 && inlinePair(row, pairs) === null) {
		const pairRows: string[] = [];
		for (const { question, answer } of pairs) {
			pairRows.push(
				...indentAndWrap(
					`${dim(sanitizeCallTargetText(question))} ${dim("→")} ${theme.fg("muted", sanitizeCallTargetText(answer))}`,
					width,
					false,
				),
			);
		}
		rows.push(
			...previewRows(
				pairRows,
				previewBudget(detail.invocationRows, options.terminalRows),
				width,
				false,
				RAIL_DIM,
				BODY_INDENT_VISIBLE_WIDTH,
			),
		);
	}
	const result = finished?.result ?? options.partialResult;
	const diff = finished && !failure ? resultDiff(result) : null;
	if (diff !== null && detail.diffRows > 0) {
		rows.push(
			...previewRows(
				renderMutationDiffBlock(redactSecretString(diff), width, options.diffStyle !== "plain"),
				previewBudget(detail.diffRows, options.terminalRows),
				width,
				false,
				RAIL_DIM,
				BODY_INDENT_VISIBLE_WIDTH,
			),
		);
	} else if (
		limit > 0 &&
		result !== undefined &&
		!(row.spec.class === "interaction" && !failure) &&
		row.context.cardAttached !== true
	) {
		// A settled question to the operator states what was asked and answered;
		// its output is the model's copy of the same interview. A call whose
		// worker card sits under it leaves the outcome to the card.
		// A failed command's status line is on its row as `exit N`; the body keeps the output.
		const shown = failure && command ? withoutCommandStatus(result) : result;
		const { body: told, notes } = splitModelNotes(resultText(unwrapResultEnvelope(shown), Number.POSITIVE_INFINITY));
		// A refusal's tail names it (`✗ · bash blocked: system_modify`), so its
		// body keeps the rest of what the call was told, not that line again.
		const refusal = finished?.outcome !== undefined ? finished.blockReason?.trim() : undefined;
		let text = refusal ? withoutLeadingLine(told, refusal) : told;
		// The action row already names this run. A short monitor summary can
		// start with the same id; keep the remainder here and the raw result in
		// inspection, where it is useful as an exact model-facing record.
		const runId = row.toolName === "monitor" ? row.args.run_id : undefined;
		if (typeof runId === "string" && text.startsWith(`${runId} · `)) text = text.slice(runId.length + 3);
		if (text.trim().length > 0) {
			const body = indentAndWrap(redactSecretString(text), width, failure);
			rows.push(
				...previewRows(
					body,
					limit,
					width,
					command || !finished,
					failure ? RAIL_ERROR : RAIL_DIM,
					BODY_INDENT_VISIBLE_WIDTH,
				),
			);
		}
		// Guidance middleware attached for the model is not the tool's output: it
		// states as one dim row, and /view keeps the result as the model read it.
		if (notes.length > 0) {
			const more = notes.length > 1 ? ` · +${notes.length - 1} more` : "";
			rows.push(
				`${failure ? RAIL_ERROR : RAIL_DIM}${dim(truncateToWidth(sanitizeCallTargetText(`note to model · ${notes[0]}`), Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH - more.length), GLYPH.ellipsis))}${dim(more)}`,
			);
		}
	}
	return rows;
}

/**
 * Whether rendered action rows include a nested body (arguments, output, a
 * diff, approval facts, or a preview hint) rather than only the action row and
 * its wrapped continuation. The transcript stacks body-less actions and puts a
 * gap around the rest.
 */
export function hasToolBody(lines: readonly string[]): boolean {
	return lines.some((line) => line.startsWith(RAIL_DIM) || line.startsWith(RAIL_ERROR));
}

/** Which Compact fold a settled call can join: explorations, knowledge lookups, or changes. */
export type ToolFoldFamily = "explore" | "knowledge" | "mutate";

/**
 * The fold a settled call joins in Compact, by class. Observations and
 * searches fold together, knowledge lookups fold, changes fold; commands,
 * fetches, delegations and questions never do. A failure, a skill load, and a
 * call whose result was cut, offloaded or evicted keep their own rows: each
 * has a fact the folded row cannot carry.
 */
export function toolFoldFamily(call: ToolExecutionFinished): ToolFoldFamily | null {
	if (call.isError || call.outcome !== undefined || call.evictedReason !== undefined) return null;
	if (isTruncatedResult(call) || offloadPathOf(call) !== null || skillLoadFacts(call) !== null) return null;
	const toolClass = resolveRow(call).spec.class;
	if (toolClass === "observe" || toolClass === "search") return "explore";
	if (toolClass === "knowledge") return "knowledge";
	if (toolClass === "mutate") return "mutate";
	return null;
}

function countNouns(calls: readonly ToolExecutionFinished[]): string {
	const counts = new Map<string, { singular: string; plural: string; count: number }>();
	for (const call of calls) {
		const [singular, plural] = resolveRow(call).spec.nouns ?? CLASS_NOUNS[resolveRow(call).spec.class];
		const entry = counts.get(singular) ?? { singular, plural, count: 0 };
		entry.count += 1;
		counts.set(singular, entry);
	}
	return [...counts.values()]
		.map((entry) => `${entry.count} ${entry.count === 1 ? entry.singular : entry.plural}`)
		.join(", ");
}

/**
 * A run of settled calls of one fold family, in Compact: one row that counts
 * them, and their targets nested beneath it. Changes keep each file's change
 * facts, since those are what a change is. Durations and byte counts stay in
 * `/view`.
 */
export function renderFoldedGroup(
	family: ToolFoldFamily,
	calls: readonly ToolExecutionFinished[],
	width: number,
	maxRows: number,
): string[] {
	const targets: string[] = [];
	let added = 0;
	let removed = 0;
	let complete = true;
	for (const call of calls) {
		const row = resolveRow(call);
		const scope = row.spec.scope?.(row.args, row.context) ?? null;
		const target = `${rowObject(row, call, width)}${scope === null ? "" : ` in ${truncate(sanitizeCallTargetText(scope), ARG_PREVIEW_LIMIT)}`}`;
		if (family !== "mutate") {
			targets.push(target);
			continue;
		}
		const stat = changeStat(call.result);
		if (stat === null) complete = false;
		else {
			added += stat.added;
			removed += stat.removed;
		}
		const file = detailsOf(call.result)?.file;
		const created = isPlainObject(file) && "before" in file && file.before === null;
		targets.push(
			`${target}${stat === null ? "" : ` ${green(`+${stat.added}`)} ${red(`-${stat.removed}`)}`}${created ? dim(" new") : ""}`,
		);
	}
	const toolClass: ToolClass = family === "explore" ? "observe" : family;
	const verb = family === "explore" ? "explored" : family === "knowledge" ? "consulted" : "edited";
	const totals = family === "mutate" && complete ? `${dim(" · ")}${green(`+${added}`)} ${red(`-${removed}`)}` : "";
	const head = `${classMark(toolClass)}${styledVerb(verb, toolClass)} ${countNouns(calls)}${totals} ${green(STATUS_OK_GLYPH)}`;
	const body = indentAndWrap(joinFacts(targets, dim), width, false);
	return [...wrapHanging(head, width), ...previewRows(body, maxRows, width, false, RAIL_DIM, BODY_INDENT_VISIBLE_WIDTH)];
}
