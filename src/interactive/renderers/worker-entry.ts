/**
 * Renderer for a worker's transcript block: the attributed stream a `/run`,
 * `/delegate`, or model-driven dispatch produces.
 *
 * One shape serves every runtime. A local Clio worker, a Claude subprocess, and
 * a delegated ACP peer differ only in what the header can name about their
 * route, so the body, the tool line, and the receipt footer are identical and
 * an operator learns one grammar.
 *
 *   ◇ you → coder · mini/Nemo-3.5-Lightning · run 2mkas6s
 *   │ Hello! I'm the coder worker.
 *   │ ⚙ read · artifact
 *   └ ok · 4.8k tok · 9.6s · contract pass
 *
 * Folded (the default for agent origin) collapses all of that to the header
 * line plus its outcome, so a fan-out of five scouts costs five rows until the
 * operator asks for one of them.
 *
 * Pure: no I/O, no module-level mutable state beyond the shared theme handle.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { formatFooterTokens } from "../footer-panel.js";
import { type ClioToken, clioTheme, formatCompactMs, GLYPH } from "../theme/index.js";
import type { WorkerEntryState, WorkerReceiptSummary } from "../worker-stream.js";

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
	/** Collapsed to the header line plus outcome. Default for agent origin. */
	folded: boolean;
	/** Key hint appended to a folded header, e.g. "Ctrl+O". Omitted when unknown. */
	expandKey?: string | undefined;
	/** Render the full body without the line cap; `/export` sets this. */
	unbounded?: boolean;
}

function originGlyph(entry: WorkerEntryState): { glyph: string; token: ClioToken; actor: string } {
	return entry.origin === "user"
		? { glyph: GLYPH.workerHuman, token: "accent", actor: "you" }
		: { glyph: GLYPH.workerAgent, token: "action", actor: "agent" };
}

/**
 * What the header can honestly say about where the run executed. A Clio or
 * Claude worker names its target and model; an ACP peer runs behind someone
 * else's process and can only name the protocol it was reached through.
 */
function routeLabel(entry: WorkerEntryState): string | null {
	if (entry.runtime.kind === "acp") return "(acp)";
	const target = entry.runtime.targetId;
	const model = entry.runtime.wireModelId;
	if (target !== undefined && model !== undefined) return `${target}/${model}`;
	return target ?? model ?? null;
}

/** Outcome word plus glyph, shared by the folded row and the expanded footer. */
function outcomeUnit(receipt: WorkerReceiptSummary): string {
	if (receipt.outcome === "succeeded") return theme.fg("success", `${GLYPH.ok} ok`);
	if (receipt.outcome === "canceled") return theme.fg("dim", `${GLYPH.cancelled} canceled`);
	const label = receipt.outcomeCode ?? receipt.outcome;
	return theme.fg("error", `${GLYPH.error} ${label}`);
}

function firstLine(text: string): string {
	const index = text.indexOf("\n");
	return index < 0 ? text : text.slice(0, index);
}

/**
 * Receipt facts in one line. Units are dropped when unknown rather than
 * rendered as zero: an ACP peer reports no tokens at all, so its footer names
 * the tool calls it mediated instead of claiming it spent nothing.
 */
function footerUnits(receipt: WorkerReceiptSummary): string[] {
	const units = [outcomeUnit(receipt)];
	if (receipt.exitCode !== undefined && receipt.exitCode !== 0) {
		units.push(theme.fg("error", `exit=${receipt.exitCode}`));
	}
	if (receipt.tokens > 0) units.push(dim(`${formatFooterTokens(receipt.tokens)} tok`));
	else if (receipt.toolCalls !== undefined && receipt.toolCalls > 0) {
		units.push(dim(`${receipt.toolCalls} tool call${receipt.toolCalls === 1 ? "" : "s"}`));
	}
	units.push(dim(formatCompactMs(receipt.elapsedMs)));
	if (receipt.contract !== undefined) units.push(dim(`contract ${receipt.contract}`));
	if (receipt.receiptUnavailable === true) units.push(theme.fg("warning", "receipt unavailable"));
	const failure = receipt.failureMessage === undefined ? "" : firstLine(receipt.failureMessage).trim();
	if (failure.length > 0) units.push(theme.fg("error", failure));
	return units;
}

/** Live status for a block that has not settled: a spinner-free, honest "running". */
function pendingUnit(entry: WorkerEntryState): string {
	return theme.fg(
		"action",
		entry.attempts.length > 1 ? `${GLYPH.running} attempt ${entry.attempts.length}` : `${GLYPH.running} running`,
	);
}

function headerLine(entry: WorkerEntryState, width: number): string {
	const origin = originGlyph(entry);
	const route = routeLabel(entry);
	const units = [
		theme.fg("muted", `${origin.actor} → ${entry.agentId}`),
		...(route === null ? [] : [dim(route)]),
		dim(`run ${entry.runId}`),
	];
	const line = `${theme.fg(origin.token, origin.glyph)} ${units.join(dim(SEPARATOR))}`;
	return truncateToWidth(line, Math.max(1, width), GLYPH.ellipsis, false);
}

function bodyLines(entry: WorkerEntryState, width: number, unbounded: boolean): string[] {
	// A worker that produced no prose (a pure tool run, a run that failed before
	// its first token) gets no rail at all rather than one blank rail row.
	if (entry.text.length === 0) return [];
	const contentWidth = Math.max(1, width - RAIL_WIDTH);
	const source = entry.text.split("\n");
	const capped = unbounded || source.length <= BODY_LINE_LIMIT ? source : source.slice(0, BODY_LINE_LIMIT);
	const hiddenLines = entry.droppedLines + (source.length - capped.length);
	const out: string[] = [];
	for (const line of capped) {
		for (const wrapped of wrapTextWithAnsi(line, contentWidth)) out.push(`${dim(RAIL)}${wrapped}`);
	}
	if (hiddenLines > 0) {
		const tail = `${GLYPH.ellipsis} ${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}, /view dispatch:${entry.runId}`;
		out.push(`${dim(RAIL)}${dim(truncateToWidth(tail, contentWidth, GLYPH.ellipsis, false))}`);
	}
	return out;
}

/** Tool names only, coalesced onto one line. Arguments never cross into the transcript. */
function toolLine(entry: WorkerEntryState, width: number): string | null {
	if (entry.tools.length === 0) return null;
	const contentWidth = Math.max(1, width - RAIL_WIDTH);
	const text = `${GLYPH.phaseTool} ${entry.tools.join(" · ")}`;
	return `${dim(RAIL)}${theme.fg("muted", truncateToWidth(text, contentWidth, GLYPH.ellipsis, false))}`;
}

/** One rail line per failover, naming the attempt and the route it moved to. */
function attemptLines(entry: WorkerEntryState, width: number): string[] {
	const contentWidth = Math.max(1, width - RAIL_WIDTH);
	const out: string[] = [];
	for (let index = 1; index < entry.attempts.length; index += 1) {
		const attempt = entry.attempts[index];
		if (attempt === undefined) continue;
		const text = `${ATTEMPT}failed over → attempt ${index + 1} on ${attempt.targetLabel}`;
		out.push(`${dim(RAIL)}${theme.fg("warning", truncateToWidth(text, contentWidth, GLYPH.ellipsis, false))}`);
	}
	return out;
}

/**
 * The receipt line. It wraps instead of truncating: the last unit is the
 * failure message, and a footer that cut it would report that something went
 * wrong while hiding what. Continuations hang under the `└ ` marker.
 */
function footerLines(entry: WorkerEntryState, width: number): string[] {
	const body = entry.receipt === undefined ? pendingUnit(entry) : footerUnits(entry.receipt).join(dim(SEPARATOR));
	const wrapped = wrapTextWithAnsi(`${dim(FOOTER)}${body}`, Math.max(1, width));
	return wrapped.map((line, index) => (index === 0 ? line : `  ${line}`));
}

/**
 * Folded row: everything the operator needs to decide whether to open it, on
 * one line. The expand hint is only rendered when the caller resolved a key
 * binding for it, so a rebound or unbound key never advertises a wrong chord.
 */
function foldedLines(entry: WorkerEntryState, width: number, expandKey: string | undefined): string[] {
	const header = headerLine(entry, width);
	const status = entry.receipt === undefined ? pendingUnit(entry) : outcomeUnit(entry.receipt);
	const elapsed = entry.receipt === undefined ? "" : dim(` ${formatCompactMs(entry.receipt.elapsedMs)}`);
	const hint = expandKey === undefined || expandKey.length === 0 ? "" : dim(`  [${expandKey} expand]`);
	const tail = `  ${status}${elapsed}${hint}`;
	const room = Math.max(1, width - visibleWidth(tail));
	return [`${truncateToWidth(header, room, GLYPH.ellipsis, false)}${tail}`];
}

export function renderWorkerEntryLines(
	entry: WorkerEntryState,
	width: number,
	options: WorkerEntryRenderOptions,
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (options.folded) return foldedLines(entry, safeWidth, options.expandKey);
	const tools = toolLine(entry, safeWidth);
	return [
		headerLine(entry, safeWidth),
		...bodyLines(entry, safeWidth, options.unbounded === true),
		...attemptLines(entry, safeWidth),
		...(tools === null ? [] : [tools]),
		...footerLines(entry, safeWidth),
	];
}
