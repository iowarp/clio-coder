/**
 * Renderer for a worker's transcript block: the attributed stream a `/run`,
 * `/delegate`, or model-driven dispatch produces.
 *
 * One shape serves every runtime. A local Clio worker, a Claude subprocess, and
 * a delegated ACP peer differ only in what the header can name about their
 * route, so the body, the tool line, and the receipt footer are identical and
 * an operator learns one grammar. The origin glyph is the only thing that says
 * who asked, which is the same rule the board and the footer chip follow.
 *
 *   ◇ coder · mini/Nemo-3.5-Lightning · run 2mkas6s
 *   │ Hello! I'm the coder worker.
 *   │ ⚙ read · artifact
 *   └ ✓ ok · 4.8k tok · 9.6s · contract pass
 *
 * Folded (the default for a run the model asked for) is one row shaped like a tool subline,
 * so a fan-out of five scouts costs five rows until the operator opens one:
 *
 *   ◆ scout · zbook/gemma-4-26b · run 3nc18jo ✓ · 41s (Ctrl+O)
 *
 * Pure: no I/O, no module-level mutable state beyond the shared theme handle.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { formatFooterTokens } from "../footer-panel.js";
import { type ClioToken, clioTheme, fitUnits, formatCompactMs, GLYPH } from "../theme/index.js";
import { type WorkerEntryState, type WorkerReceiptSummary, workerAskedByModel } from "../worker-stream.js";

const theme = clioTheme();
const dim = (text: string): string => theme.fg("dim", text);

const RAIL = "│ ";
const RAIL_WIDTH = 2;
const FOOTER = "└ ";
const ATTEMPT = "↻ ";
const SEPARATOR = " · ";

/** Rows of worker prose an expanded block shows before it defers to `/view`. */
const BODY_LINE_LIMIT = 80;

export interface WorkerEntryRenderOptions {
	/** Collapsed to the header line plus outcome. Default for a run the model asked for. */
	folded: boolean;
	/** Key hint appended to a folded header, e.g. "Ctrl+O". Omitted when unknown. */
	expandKey?: string | undefined;
	/** Render the full body without the line cap; `/export` sets this. */
	unbounded?: boolean;
}

function originGlyph(entry: WorkerEntryState): string {
	return workerAskedByModel(entry) ? theme.fg("action", GLYPH.workerAgent) : theme.fg("accent", GLYPH.workerHuman);
}

/**
 * The header's units after the glyph: who ran, where, and which run. A Clio or
 * Claude worker names its target and model; an ACP peer runs behind someone
 * else's process and can only name the protocol it was reached through, so it
 * carries that on the agent instead of a route.
 */
function identityUnits(entry: WorkerEntryState): string[] {
	const { kind, targetId, wireModelId } = entry.runtime;
	const route =
		targetId !== undefined && wireModelId !== undefined ? `${targetId}/${wireModelId}` : (targetId ?? wireModelId);
	return [
		theme.fg("muted", kind === "acp" ? `${entry.agentId} (acp)` : entry.agentId),
		...(kind !== "acp" && route !== undefined ? [dim(route)] : []),
		dim(`run ${entry.runId}`),
	];
}

/** Whole header units, closing on a dim ellipsis rather than cutting a unit mid-word. */
function headerLine(entry: WorkerEntryState, width: number): string {
	return fitUnits(theme, `${originGlyph(entry)} `, identityUnits(entry), width);
}

/**
 * Outcome glyph, with the word on the footer. The folded row uses the glyph
 * alone, as a tool subline does, so a list of cards reads like a list of calls.
 */
function outcomeUnit(receipt: WorkerReceiptSummary, word: boolean): string {
	if (receipt.outcome === "succeeded") return theme.fg("success", word ? `${GLYPH.ok} ok` : GLYPH.ok);
	if (receipt.outcome === "canceled") return theme.fg("dim", `${GLYPH.cancelled} canceled`);
	return theme.fg("error", `${GLYPH.error} ${receipt.outcomeCode ?? receipt.outcome}`);
}

/** Live status for a block that has not settled: a spinner-free, honest "running". */
function pendingUnit(entry: WorkerEntryState): string {
	return theme.fg(
		"action",
		entry.attempts.length > 1 ? `${GLYPH.running} attempt ${entry.attempts.length}` : `${GLYPH.running} running`,
	);
}

/**
 * Receipt facts as footer units. A unit is dropped when unknown rather than
 * rendered as zero: an ACP peer reports no tokens at all, so its footer names
 * the tool calls it mediated instead of claiming it spent nothing.
 */
function footerUnits(receipt: WorkerReceiptSummary): string[] {
	const units = [outcomeUnit(receipt, true)];
	if (receipt.exitCode !== undefined && receipt.exitCode !== 0) {
		units.push(theme.fg("error", `exit=${receipt.exitCode}`));
	}
	if (receipt.tokenCount !== undefined && receipt.tokenCount > 0) {
		units.push(dim(`${formatFooterTokens(receipt.tokenCount)} tok`));
	} else if (receipt.toolCalls !== undefined && receipt.toolCalls > 0) {
		units.push(dim(`${receipt.toolCalls} tool call${receipt.toolCalls === 1 ? "" : "s"}`));
	}
	if (receipt.durationMs !== undefined) units.push(dim(formatCompactMs(receipt.durationMs)));
	if (receipt.contract !== undefined) units.push(dim(`contract ${receipt.contract}`));
	if (receipt.receiptUnavailable === true) units.push(theme.fg("warning", "receipt unavailable"));
	return units;
}

/** Wrap one annotation onto the rail, prefixed on its first row and hanging under it after. */
function railLines(text: string, token: ClioToken, width: number): string[] {
	const contentWidth = Math.max(1, width - RAIL_WIDTH);
	return wrapTextWithAnsi(text, contentWidth).map((row) => `${dim(RAIL)}${theme.fg(token, row)}`);
}

/** A worker's terminal answer when it is one JSON object, as a structured result contract asks for. */
function structuredAnswer(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * A mutation report as prose: the paths it changed, each validation with its
 * verdict and evidence, then the summary and commit line. Null when the object
 * is not that shape.
 */
function mutationReportLines(value: Record<string, unknown>): string[] | null {
	if (!isStringArray(value.mutatedPaths) || !Array.isArray(value.validations)) return null;
	const lines: string[] = [];
	lines.push(value.mutatedPaths.length === 0 ? "changed nothing" : `changed ${value.mutatedPaths.join(", ")}`);
	for (const validation of value.validations) {
		if (typeof validation !== "object" || validation === null) continue;
		const check = validation as Record<string, unknown>;
		const name = typeof check.name === "string" ? check.name : "validation";
		const glyph = check.passed === true ? GLYPH.ok : check.passed === false ? GLYPH.error : GLYPH.queued;
		const evidence =
			typeof check.evidence === "string" && check.evidence.trim().length > 0 ? `: ${check.evidence.trim()}` : "";
		lines.push(`${glyph} ${name}${evidence}`);
	}
	if (typeof value.summary === "string" && value.summary.trim().length > 0) lines.push(value.summary.trim());
	if (typeof value.commitMessage === "string" && value.commitMessage.trim().length > 0) {
		lines.push(`commit: ${value.commitMessage.trim()}`);
	}
	return lines;
}

/**
 * The body's source lines. A structured answer (a result-contract JSON object)
 * never reaches the rail raw: a mutation report reads as prose, and any other
 * object is pretty-printed so its keys line up instead of wrapping mid-string.
 * Truncated text is not one object and passes through as the prose it is.
 */
function bodySourceLines(entry: WorkerEntryState): string[] {
	const structured = entry.droppedLines === 0 ? structuredAnswer(entry.text) : null;
	if (structured === null) return entry.text.split("\n");
	return mutationReportLines(structured) ?? JSON.stringify(structured, null, 2).split("\n");
}

function bodyLines(entry: WorkerEntryState, width: number, unbounded: boolean): string[] {
	// A worker that produced no prose (a pure tool run, a run that failed before
	// its first token) gets no rail at all rather than one blank rail row.
	if (entry.text.length === 0) return [];
	const contentWidth = Math.max(1, width - RAIL_WIDTH);
	const source = bodySourceLines(entry);
	const capped = unbounded || source.length <= BODY_LINE_LIMIT ? source : source.slice(0, BODY_LINE_LIMIT);
	const hiddenLines = entry.droppedLines + (source.length - capped.length);
	const out: string[] = [];
	for (const line of capped) {
		for (const wrapped of wrapTextWithAnsi(line, contentWidth)) out.push(`${dim(RAIL)}${wrapped}`);
	}
	if (hiddenLines > 0) {
		const tail = `${GLYPH.ellipsis} ${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}, /view dispatch:${entry.runId}`;
		out.push(`${dim(RAIL)}${dim(fitUnits(theme, "", [tail], contentWidth))}`);
	}
	return out;
}

/** Tool names only, coalesced onto one line. Arguments never cross into the transcript. */
function toolLine(entry: WorkerEntryState, width: number): string | null {
	if (entry.tools.length === 0) return null;
	const contentWidth = Math.max(1, width - RAIL_WIDTH);
	return `${dim(RAIL)}${theme.fg("muted", fitUnits(theme, `${GLYPH.phaseTool} `, entry.tools, contentWidth))}`;
}

/** One rail line per failover, naming the attempt and the route it moved to. */
function attemptLines(entry: WorkerEntryState, width: number): string[] {
	return entry.attempts.flatMap((attempt, index) =>
		index === 0
			? []
			: railLines(`${ATTEMPT}failed over → attempt ${index + 1} on ${attempt.targetLabel}`, "warning", width),
	);
}

/**
 * The failure's first line, on the rail above the footer. The footer stays one
 * line of facts; the reason is prose and wraps like prose, so a long message
 * cannot make the receipt line heavier than the answer above it.
 */
function failureLines(entry: WorkerEntryState, width: number): string[] {
	const message = entry.receipt?.failureMessage;
	if (message === undefined) return [];
	const first = (message.split("\n", 1)[0] ?? "").trim();
	return first.length === 0 ? [] : railLines(`${GLYPH.error} ${first}`, "error", width);
}

/** The receipt line, whole units only; a unit that would not fit is dropped behind a dim ellipsis. */
function footerLine(entry: WorkerEntryState, width: number): string {
	const units = entry.receipt === undefined ? [pendingUnit(entry)] : footerUnits(entry.receipt);
	return fitUnits(theme, dim(FOOTER), units, width);
}

/**
 * Folded row: everything the operator needs to decide whether to open it, on
 * one line, shaped like a tool subline. Identity outranks elapsed: when the row
 * is too narrow for both, the elapsed unit goes first, and the identity is then
 * cut where the room ends rather than by whole units, because a partial route
 * still tells two scouts apart and a bare agent id may not. The expand hint
 * renders only when the caller resolved a key binding for it, so a rebound or
 * unbound key never advertises a wrong chord.
 */
function foldedLine(entry: WorkerEntryState, width: number, expandKey: string | undefined): string {
	const identity = `${originGlyph(entry)} ${identityUnits(entry).join(dim(SEPARATOR))}`;
	const status = entry.receipt === undefined ? pendingUnit(entry) : outcomeUnit(entry.receipt, false);
	const elapsed =
		entry.receipt?.durationMs === undefined ? "" : dim(`${SEPARATOR}${formatCompactMs(entry.receipt.durationMs)}`);
	const hint = expandKey === undefined || expandKey.length === 0 ? "" : dim(` (${expandKey})`);
	const full = ` ${status}${elapsed}${hint}`;
	const tail = visibleWidth(identity) + visibleWidth(full) <= width ? full : ` ${status}${hint}`;
	return `${truncateToWidth(identity, Math.max(1, width - visibleWidth(tail)), GLYPH.ellipsis, false)}${tail}`;
}

export function renderWorkerEntryLines(
	entry: WorkerEntryState,
	width: number,
	options: WorkerEntryRenderOptions,
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (options.folded) return [foldedLine(entry, safeWidth, options.expandKey)];
	const tools = toolLine(entry, safeWidth);
	return [
		headerLine(entry, safeWidth),
		...bodyLines(entry, safeWidth, options.unbounded === true),
		...attemptLines(entry, safeWidth),
		...(tools === null ? [] : [tools]),
		...failureLines(entry, safeWidth),
		footerLine(entry, safeWidth),
	];
}
