import { redactSecretString } from "../../domains/safety/redaction.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import { transcriptDetail } from "../transcript-detail.js";
import { previewBudget, previewRows } from "./preview.js";
/** Bounded worker summaries share the main transcript's output style. */

import { parseJsonObjectPayload } from "../../core/json-payload.js";
import { trustStateWord } from "../../domains/evidence/trust-projection.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { formatFooterTokens } from "../footer-panel.js";
import { type ClioToken, clioTheme, fitUnits, formatCompactMs, GLYPH } from "../theme/index.js";
import {
	type WorkerEntryState,
	type WorkerPresentedResultContract,
	type WorkerReceiptSummary,
	workerAskedByModel,
} from "../worker-stream.js";

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
	detail?: TranscriptDetailPolicy;
	terminalRows?: number;
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
 * Execution outcome, explicitly named on successful folded and expanded rows
 * so the separate quality line cannot be mistaken for process status.
 * Abandoned names itself rather than falling through to its `stalled`
 * outcome code, so it reads as a ledger-side finding instead of the ordinary
 * heartbeat-timeout `stalled` a sealed receipt reports.
 */
function outcomeUnit(receipt: WorkerReceiptSummary, word: boolean): string {
	if (receipt.outcome === "succeeded") return theme.fg("success", `${GLYPH.ok} execution ok`);
	if (receipt.outcome === "canceled") return theme.fg("dim", `${GLYPH.cancelled} canceled`);
	if (receipt.abandonedDetail !== undefined) return theme.fg("error", word ? `${GLYPH.error} abandoned` : GLYPH.error);
	return theme.fg("error", `${GLYPH.error} ${receipt.outcomeCode ?? receipt.outcome}`);
}

/**
 * A settled worker whose answer is a question for the operator.
 *
 * Materio and WTF-P workers return `needs_input: checkpoint:decision` (or
 * `task_blocked`, or a `## CHECKPOINT REACHED` heading) followed by the
 * questions the orchestrator has to relay. That is a prose convention, not a
 * receipt field, so the transcript reads the first line of the answer.
 */
const CHECKPOINT_PREFIX = /^\s*(?:needs_input\b|task_blocked\b|##\s*CHECKPOINT REACHED\b|##\s*BLOCKED\b)/iu;
/** Rows a checkpoint's body keeps on the folded row: the questions are the point of the entry. */
const CHECKPOINT_PREVIEW_ROWS = 16;

export function workerNeedsInput(entry: Pick<WorkerEntryState, "text" | "receipt">): boolean {
	return entry.receipt !== undefined && entry.receipt.stillRunning !== true && CHECKPOINT_PREFIX.test(entry.text);
}

function needsInputUnit(): string {
	return theme.fg("warning", `${GLYPH.phaseBlocked} needs input`);
}

/** A block with no settled receipt yet: a spinner-free, honest "running". */
function pendingUnit(entry: WorkerEntryState): string {
	return theme.fg(
		"action",
		entry.attempts.length > 1 ? `${GLYPH.running} attempt ${entry.attempts.length}` : `${GLYPH.running} running`,
	);
}

/**
 * Whether a block should render as still going rather than settled: live,
 * never yet received a receipt (`entry.receipt === undefined`), or replayed
 * from a `runs.json` row with no `endedAt` (`stillRunning`) because its
 * process is still executing in another instance of Clio.
 */
function isPending(entry: WorkerEntryState): boolean {
	return entry.receipt === undefined || entry.receipt.stillRunning === true;
}

/**
 * Receipt facts as footer units. A unit is dropped when unknown rather than
 * rendered as zero: an ACP peer reports no tokens at all, so its footer names
 * the tool calls it mediated instead of claiming it spent nothing.
 */
function footerUnits(entry: WorkerEntryState, receipt: WorkerReceiptSummary): string[] {
	const units = [outcomeUnit(receipt, true)];
	if (workerNeedsInput(entry)) units.push(needsInputUnit());
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
	const presentation = presentedContractAnswer(entry);
	if (presentation?.footer !== undefined) units.push(dim(presentation.footer));
	if (receipt.abandonedDetail !== undefined) units.push(theme.fg("warning", receipt.abandonedDetail));
	else if (receipt.receiptUnavailable === true) units.push(theme.fg("warning", "receipt unavailable"));
	return units;
}

/** Wrap one annotation onto the rail, prefixed on its first row and hanging under it after. */
function railLines(text: string, token: ClioToken, width: number): string[] {
	const contentWidth = Math.max(1, width - RAIL_WIDTH);
	return wrapTextWithAnsi(text, contentWidth).map((row) => `${dim(RAIL)}${theme.fg(token, row)}`);
}

/** A worker's terminal JSON payload, using the same tolerant reader as its result contract. */
function structuredAnswer(text: string): Record<string, unknown> | null {
	const parsed = parseJsonObjectPayload(text);
	return parsed.ok ? parsed.value : null;
}

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

function reportString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

interface PresentedContractAnswer {
	lines: string[];
	footer?: string;
}

function debuggerReport(value: Record<string, unknown>): PresentedContractAnswer | null {
	const diagnosis = reportString(value.diagnosis);
	const reproduction = value.reproduction;
	if (
		diagnosis === null ||
		(reproduction !== "reproduced" && reproduction !== "not-reproduced" && reproduction !== "unknown") ||
		!isStringArray(value.evidence)
	) {
		return null;
	}
	return {
		lines: [
			diagnosis,
			...(value.evidence.length === 0 ? ["Evidence: none"] : ["Evidence:", ...value.evidence.map((item) => `- ${item}`)]),
		],
		footer: `reproduction ${reproduction}`,
	};
}

function verifierReport(value: Record<string, unknown>): PresentedContractAnswer | null {
	if ((value.verdict !== "pass" && value.verdict !== "fail") || !Array.isArray(value.checks)) return null;
	const lines: string[] = [];
	for (const raw of value.checks) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
		const check = raw as Record<string, unknown>;
		const name = reportString(check.name);
		const evidence = reportString(check.evidence);
		if (name === null || evidence === null || typeof check.passed !== "boolean") return null;
		lines.push(`${check.passed ? GLYPH.ok : GLYPH.error} ${name}: ${evidence}`);
	}
	return { lines: lines.length === 0 ? ["No checks reported."] : lines, footer: `verdict ${value.verdict}` };
}

function researchReport(value: Record<string, unknown>): PresentedContractAnswer | null {
	if ((value.source !== "local" && value.source !== "external") || !Array.isArray(value.findings)) return null;
	const lines: string[] = [];
	for (const raw of value.findings) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
		const finding = raw as Record<string, unknown>;
		const claim = reportString(finding.claim);
		const evidence = reportString(finding.evidence);
		if (claim === null || evidence === null) return null;
		lines.push(`- ${claim}`, `  citation: ${evidence}`);
	}
	return { lines: lines.length === 0 ? ["No findings reported."] : lines, footer: `source ${value.source}` };
}

function worldKnowledgeReport(value: Record<string, unknown>): PresentedContractAnswer | null {
	if (
		(value.discovery !== "performed" &&
			value.discovery !== "caller-supplied-only" &&
			value.discovery !== "unavailable") ||
		!Array.isArray(value.facts) ||
		!isStringArray(value.synthesis) ||
		!isStringArray(value.uncertainties) ||
		!isStringArray(value.followUpVerification)
	) {
		return null;
	}
	const lines: string[] = [];
	for (const raw of value.facts) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
		const fact = raw as Record<string, unknown>;
		const claim = reportString(fact.claim);
		const evidence = reportString(fact.evidence);
		if (claim === null || evidence === null || !isStringArray(fact.sources)) return null;
		lines.push(`- ${claim}`, `  support: ${evidence}`);
		if (fact.sources.length > 0) lines.push(`  sources: ${fact.sources.join(", ")}`);
	}
	if (value.synthesis.length > 0) lines.push("Synthesis:", ...value.synthesis.map((item) => `- ${item}`));
	if (value.uncertainties.length > 0) lines.push("Uncertainties:", ...value.uncertainties.map((item) => `- ${item}`));
	if (value.followUpVerification.length > 0) {
		lines.push("Verify next:", ...value.followUpVerification.map((item) => `- ${item}`));
	}
	return { lines: lines.length === 0 ? ["No findings reported."] : lines, footer: `discovery ${value.discovery}` };
}

function scoutReport(value: Record<string, unknown>): PresentedContractAnswer | null {
	if (!Array.isArray(value.findings) || typeof value.needsSplit !== "boolean") return null;
	const lines: string[] = [];
	for (const raw of value.findings) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
		const finding = raw as Record<string, unknown>;
		const claim = reportString(finding.claim);
		if (claim === null) return null;
		const path = reportString(finding.path);
		const line = typeof finding.line === "number" && Number.isSafeInteger(finding.line) ? finding.line : null;
		lines.push(path !== null && line !== null ? `- ${claim} — ${path}:${line}` : `- ${claim} (ungrounded lead)`);
	}
	if (value.needsSplit) {
		if (!Array.isArray(value.proposedSubtasks)) return null;
		lines.push("Split recommended:");
		for (const raw of value.proposedSubtasks) {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
			const subtask = raw as Record<string, unknown>;
			const task = reportString(subtask.task);
			const id = reportString(subtask.id);
			if (task === null || id === null) return null;
			lines.push(`- ${id}: ${task}`);
		}
	}
	return {
		lines: lines.length === 0 ? ["No findings reported."] : lines,
		footer: value.needsSplit ? "split needed" : "no split needed",
	};
}

function presentedContractAnswer(entry: WorkerEntryState): PresentedContractAnswer | null {
	if (entry.receipt?.contract !== "pass" || entry.receipt.contractKind === undefined || entry.droppedLines !== 0) {
		return null;
	}
	const value = structuredAnswer(entry.text);
	if (value === null) return null;
	const kind: WorkerPresentedResultContract = entry.receipt.contractKind;
	switch (kind) {
		case "debugger-report":
			return debuggerReport(value);
		case "verifier-report":
			return verifierReport(value);
		case "research-report":
			return researchReport(value);
		case "world-knowledge-report":
			return worldKnowledgeReport(value);
		case "scout-report":
			return scoutReport(value);
	}
}

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
	const presented = presentedContractAnswer(entry);
	if (presented !== null) return presented.lines;
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
	const units =
		isPending(entry) || entry.receipt === undefined ? [pendingUnit(entry)] : footerUnits(entry, entry.receipt);
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
function actionLine(entry: WorkerEntryState, width: number): string {
	const identity = `${originGlyph(entry)} ${identityUnits(entry).join(dim(SEPARATOR))}`;
	const status =
		isPending(entry) || entry.receipt === undefined
			? pendingUnit(entry)
			: workerNeedsInput(entry)
				? needsInputUnit()
				: outcomeUnit(entry.receipt, false);
	const elapsed =
		entry.receipt?.durationMs === undefined ? "" : dim(`${SEPARATOR}${formatCompactMs(entry.receipt.durationMs)}`);
	const full = ` ${status}${elapsed}`;
	let tail = visibleWidth(identity) + visibleWidth(full) <= width ? full : ` ${status}`;
	// Reserve one identity cell. The optional hint yields before execution
	// status when the suffix alone would exhaust the header's width.
	if (visibleWidth(tail) >= width) tail = ` ${status}`;
	const header = `${truncateToWidth(identity, Math.max(1, width - visibleWidth(tail)), GLYPH.ellipsis, false)}${tail}`;
	return truncateToWidth(header, width, GLYPH.ellipsis, false);
}

export function renderWorkerEntryLines(
	entry: WorkerEntryState,
	width: number,
	options: WorkerEntryRenderOptions,
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const quality = isPending(entry)
		? []
		: railLines(
				`quality: ${trustStateWord("validationGrounding", entry.receipt?.trust?.validationGrounding.state ?? "unknown")}`,
				"muted",
				safeWidth,
			);
	const detail = options.detail ?? transcriptDetail();
	if (options.unbounded) {
		const tools = toolLine(entry, safeWidth);
		return [
			headerLine(entry, safeWidth),
			...bodyLines(entry, safeWidth, true),
			...attemptLines(entry, safeWidth),
			...(tools ? [tools] : []),
			...failureLines(entry, safeWidth),
			footerLine(entry, safeWidth),
			...quality,
		].map(redactSecretString);
	}
	const budget = (limit: number) => previewBudget(limit, options.terminalRows);
	// A checkpoint's body is the question the operator answers next, so it keeps
	// its rows whatever the transcript preset hides of an ordinary answer, and
	// it renders in the warning token rather than as folded prose.
	const needsInput = workerNeedsInput(entry);
	const summaryRows = needsInput ? CHECKPOINT_PREVIEW_ROWS : budget(detail.workerRows);
	const summary = bodySourceLines(entry).flatMap((line) =>
		railLines(redactSecretString(line), needsInput ? "warning" : "muted", safeWidth),
	);
	const actions = entry.progress
		? [...entry.progress.recentActions]
				.reverse()
				.concat(entry.progress.currentAction ? [entry.progress.currentAction] : [])
		: [];
	const trail = actions.flatMap((action) =>
		railLines(
			`${GLYPH.phaseTool} ${action.descriptor ? `${action.descriptor.verb} ${action.descriptor.object}` : action.tool}`,
			"muted",
			safeWidth,
		),
	);
	const tools = detail.workerActivity && trail.length === 0 ? toolLine(entry, safeWidth) : null;
	const failure = previewRows(failureLines(entry, safeWidth), budget(detail.errorRows), safeWidth);
	const presented = presentedContractAnswer(entry)?.footer;
	return [
		actionLine(entry, safeWidth),
		...(detail.workerRows > 0 || needsInput ? previewRows(summary, summaryRows, safeWidth, entry.pending) : []),
		...previewRows(attemptLines(entry, safeWidth), budget(detail.errorRows), safeWidth, true),
		...(tools ? [tools] : []),
		...(detail.workerActivity ? previewRows(trail, budget(4), safeWidth, true) : []),
		...failure,
		...(presented ? railLines(presented, "muted", safeWidth) : []),
		...(entry.receipt?.abandonedDetail ? railLines(entry.receipt.abandonedDetail, "warning", safeWidth) : []),
		...(entry.receipt?.receiptUnavailable ? railLines("receipt unavailable", "warning", safeWidth) : []),
		...(entry.droppedLines
			? railLines(
					`… ${entry.droppedLines} earlier lines unavailable here · /view dispatch:${entry.runId}`,
					"muted",
					safeWidth,
				)
			: []),
		...quality,
	].map(redactSecretString);
}
