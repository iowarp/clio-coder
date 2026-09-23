import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import { transcriptDetail } from "../transcript-detail.js";
import { previewBudget, previewRows } from "./preview.js";
import {
	exactWorkerAnswerObject,
	type PresentedContractAnswer,
	presentWorkerContractAnswer,
	safeWorkerAnswerText,
} from "./worker-answer.js";

/** Bounded worker summaries share the main transcript's output style. */

import { trustStateWord } from "../../domains/evidence/trust-projection.js";
import { retiredIntegrityVersionOf } from "../../domains/evidence/trust-status.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { councilLabelText } from "../council-grid.js";
import { formatFooterTokens } from "../footer-panel.js";
import { type ClioToken, clioTheme, fitUnits, formatCompactMs, GLYPH } from "../theme/index.js";
import { type WorkerEntryState, type WorkerReceiptSummary, workerAskedByModel } from "../worker-stream.js";

const theme = clioTheme();
const dim = (text: string): string => theme.fg("dim", text);

// The worker card follows the transcript's gutter grammar: the origin glyph
// sits in the gutter and the card's body nests under it in the content column.
const RAIL = "  │ ";
const RAIL_WIDTH = 4;
const FOOTER = "  └ ";
const ATTEMPT = "↻ ";
const SEPARATOR = " · ";

/** Rows of worker prose an expanded block shows before it defers to `/view`. */
const BODY_LINE_LIMIT = 80;

export interface WorkerEntryRenderOptions {
	nowMs?: number;
	detail?: TranscriptDetailPolicy;
	terminalRows?: number;
	/** Render the full body without the line cap; `/export` sets this. */
	unbounded?: boolean;
	/**
	 * `continues` when this card follows a card of the same council round, so
	 * the round's header row is not repeated above it.
	 */
	group?: "leads" | "continues";
}

/**
 * Who started the run, in the gutter: `◆` the model, `◇` the operator, `↳`
 * Clio's own helper work. Settled or running, the mark keeps its token; the
 * live state is the `●` on the row, never an orange mark.
 */
function originGlyph(entry: WorkerEntryState): string {
	if (entry.helper) return dim(GLYPH.subProcess);
	return workerAskedByModel(entry) ? theme.fg("agent", GLYPH.workerAgent) : theme.fg("accent", GLYPH.workerHuman);
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
	// A council member reads by its roster label in its roster color, the name
	// the operator configured, rather than by its agent id.
	const who =
		entry.council !== undefined
			? councilLabelText(theme, entry.council.label, entry.council.color)
			: theme.fg("muted", kind === "acp" ? `${entry.agentId} (acp)` : entry.agentId);
	return [
		who,
		...(entry.helper ? [dim("internal")] : []),
		...(kind !== "acp" && route !== undefined ? [dim(route)] : []),
		dim(`run ${entry.runId}`),
		// A failover keeps the card; the header says which attempt it shows.
		...(entry.attempts.length > 1 ? [dim(`attempt ${entry.attempts.length}`)] : []),
	];
}

/** Whole header units, closing on a dim ellipsis rather than cutting a unit mid-word. */
function headerLine(entry: WorkerEntryState, width: number): string {
	return fitUnits(theme, `${originGlyph(entry)} `, identityUnits(entry), width);
}

/**
 * The gutter mark and the row a council round opens with. Its members follow
 * in the content column, each under its roster label, so the round reads as
 * one question put to several voices rather than as unrelated cards.
 */
function councilHeader(entry: WorkerEntryState, width: number): string {
	const round = entry.council?.round ?? 1;
	return fitUnits(theme, `${originGlyph(entry)} `, [theme.fg("muted", "council"), dim(`round ${round}`)], width);
}

/** A card's own row starts in the gutter, or, for a council member, in the content column. */
function cardPrefix(entry: WorkerEntryState): string {
	return entry.council !== undefined ? "  " : `${originGlyph(entry)} `;
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
	return (
		entry.receipt !== undefined &&
		entry.receipt.stillRunning !== true &&
		CHECKPOINT_PREFIX.test(entry.text.trim().replace(/^```[A-Za-z0-9_-]*[^\S\r\n]*\r?\n/u, ""))
	);
}

function needsInputUnit(): string {
	return theme.fg("warning", `${GLYPH.phaseBlocked} needs input`);
}

/**
 * A block with no settled receipt yet: the live mark, spinner-free. The row's
 * progress line says what the run is doing; `/view` spells the state out.
 */
function pendingUnit(word = false): string {
	return theme.fg("accent", word ? `${GLYPH.running} running` : GLYPH.running);
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
	}
	if (receipt.toolCalls !== undefined && receipt.toolCalls > 0) {
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

function presentedContractAnswer(entry: WorkerEntryState): PresentedContractAnswer | null {
	if (entry.receipt?.trust?.artifactIntegrity.state !== "verified") return null;
	const kind = entry.receipt?.contractKind;
	const conformance = entry.receipt?.contract;
	return presentWorkerContractAnswer(
		entry.text,
		kind && conformance ? { kind, conformance } : undefined,
		entry.droppedLines === 0 && (entry.progress?.droppedBytes ?? 0) === 0,
		!entry.pending && !isPending(entry),
	);
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
 * uses its receipt identity for a readable preview. Unknown objects retain
 * their original numeric source tokens instead of being parsed and reserialized.
 * Truncated text is not one object and passes through as the prose it is.
 */
function bodySourceLines(entry: WorkerEntryState): string[] {
	if (
		entry.pending ||
		entry.receipt?.trust?.artifactIntegrity.state !== "verified" ||
		entry.droppedLines !== 0 ||
		(entry.progress?.droppedBytes ?? 0) !== 0
	)
		return safeWorkerAnswerText(entry.text).split("\n");
	const structured = entry.droppedLines === 0 ? exactWorkerAnswerObject(entry.text) : null;
	if (structured === null) return safeWorkerAnswerText(entry.text).split("\n");
	const presented = presentedContractAnswer(entry);
	if (presented !== null) return presented.lines;
	return mutationReportLines(structured)?.map(safeWorkerAnswerText) ?? safeWorkerAnswerText(entry.text).split("\n");
}

function bodyLines(entry: WorkerEntryState, width: number, unbounded: boolean): string[] {
	// A worker that produced no prose (a pure tool run, a run that failed before
	// its first token) gets no rail at all rather than one blank rail row.
	if (entry.text.length === 0) return [];
	const contentWidth = Math.max(1, width - RAIL_WIDTH);
	const source = unbounded ? safeWorkerAnswerText(entry.text).split("\n") : bodySourceLines(entry);
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
		isPending(entry) || entry.receipt === undefined ? [pendingUnit(true)] : footerUnits(entry, entry.receipt);
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
	const identity = `${cardPrefix(entry)}${identityUnits(entry).join(dim(SEPARATOR))}`;
	const status =
		isPending(entry) || entry.receipt === undefined
			? pendingUnit()
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

function workerMetrics(entry: WorkerEntryState): string[] {
	const metrics: string[] = [];
	const tokens = entry.receipt?.tokenCount ?? entry.progress?.processedTokens;
	const calls = entry.receipt?.toolCalls ?? entry.progress?.toolCalls;
	if (tokens !== undefined) metrics.push(`${formatFooterTokens(tokens)} tokens processed`);
	if (entry.progress?.contextTokens !== undefined)
		metrics.push(`context ${formatFooterTokens(entry.progress.contextTokens)}`);
	if (calls !== undefined) metrics.push(`${calls} tool calls`);
	return metrics;
}

/** What a running worker is doing when no call is in flight, by the phase its stream is in. */
const PHASE_ACTIVITY: Readonly<Record<string, readonly [glyph: string, words: string]>> = {
	starting: [GLYPH.phaseWaiting, "starting"],
	waiting: [GLYPH.phaseWaiting, "waiting on the model"],
	thinking: [GLYPH.phaseThinking, "thinking"],
	writing: [GLYPH.phaseWriting, "writing"],
	tool: [GLYPH.phaseTool, "between calls"],
};

/** The running call as `verb object`, or its tool name when the runtime sent no descriptor. */
function describedAction(entry: WorkerEntryState): string | null {
	const action = entry.progress?.currentAction;
	if (action === null || action === undefined) return null;
	return action.descriptor ? `${action.descriptor.verb} ${action.descriptor.object ?? ""}`.trim() : action.tool;
}

function elapsedMsOf(entry: WorkerEntryState, nowMs: number): number | undefined {
	if (isPending(entry)) return entry.startedAtMs === undefined ? undefined : Math.max(0, nowMs - entry.startedAtMs);
	return entry.receipt?.durationMs;
}

/**
 * A running card's one live line, rewritten in place: what it is doing now,
 * how long it has run, and what it has spent. No spinner; the panel's clock
 * moves the elapsed.
 */
function progressLine(entry: WorkerEntryState, width: number, nowMs: number): string {
	const action = describedAction(entry);
	const [glyph, idle] = PHASE_ACTIVITY[entry.progress?.phase ?? "starting"] ?? [GLYPH.phaseWaiting, "starting"];
	const doing = action === null ? `${glyph} ${idle}` : `${GLYPH.phaseTool} ${action}`;
	const elapsedMs = elapsedMsOf(entry, nowMs);
	const tokens = entry.progress?.processedTokens;
	const calls = entry.progress?.toolCalls;
	const facts = [
		...(elapsedMs === undefined ? [] : [formatCompactMs(elapsedMs)]),
		...(tokens === undefined ? [] : [`${formatFooterTokens(tokens)} tokens`]),
		...(calls === undefined ? [] : [`${calls} call${calls === 1 ? "" : "s"}`]),
	];
	// The elapsed time is the line's live signal, so a narrow row cuts the
	// action's text and then drops the spend, never the clock.
	const room = Math.max(1, width - RAIL_WIDTH);
	const activity = sanitizeCallTargetText(redactSecretString(doing));
	for (let kept = facts.length; kept >= 0; kept -= 1) {
		const tail = kept === 0 ? "" : `${SEPARATOR}${facts.slice(0, kept).join(SEPARATOR)}`;
		const activityRoom = room - tail.length;
		if (kept > 1 && activityRoom < Math.min(24, activity.length)) continue;
		const shown = truncateToWidth(activity, Math.max(1, activityRoom), GLYPH.ellipsis, false);
		return `${dim(RAIL)}${theme.fg("muted", shown)}${dim(tail)}`;
	}
	return `${dim(RAIL)}${theme.fg("muted", truncateToWidth(activity, room, GLYPH.ellipsis, false))}`;
}

/**
 * Helper and shadow work, outside Detailed: one subordinate row naming the
 * helper, what it was asked to do (or, while it runs, the call it is making),
 * and how it ended. A failure adds its reason beneath. Detailed shows the full
 * card.
 */
function helperRow(
	entry: WorkerEntryState,
	width: number,
	detail: TranscriptDetailPolicy,
	terminalRows?: number,
	nowMs = Date.now(),
): string[] {
	const pending = isPending(entry);
	const failed = !pending && (entry.receipt?.outcome !== "succeeded" || entry.receipt?.contract === "fail");
	const clean = (text: string) => sanitizeCallTargetText(redactSecretString(text)).replace(/\.$/u, "");
	const what = (pending ? describedAction(entry) : null) ?? entry.task ?? "assisting the main agent";
	const status = pending
		? pendingUnit()
		: entry.receipt?.outcome === "canceled"
			? theme.fg("dim", GLYPH.cancelled)
			: failed
				? theme.fg("error", GLYPH.error)
				: theme.fg("success", GLYPH.ok);
	const elapsedMs = elapsedMsOf(entry, nowMs);
	// A running row's tail is the live mark and its clock (`● 3.1s`), a settled
	// one its outcome and duration (`✓ · 7.3s`), as on an action row.
	const elapsed = elapsedMs === undefined ? "" : formatCompactMs(elapsedMs);
	const tail = ` ${status}${elapsed.length === 0 ? "" : dim(pending ? ` ${elapsed}` : `${SEPARATOR}${elapsed}`)}`;
	const lead = `${originGlyph(entry)} ${theme.fg("muted", clean(entry.agentId))}${dim(SEPARATOR)}${theme.fg("muted", clean(what))}`;
	const row = `${truncateToWidth(lead, Math.max(1, width - visibleWidth(tail)), GLYPH.ellipsis, false)}${tail}`;
	return [
		truncateToWidth(row, width, GLYPH.ellipsis, false),
		...previewRows(
			[...failureLines(entry, width), ...attemptLines(entry, width)],
			previewBudget(detail.errorRows, terminalRows),
			width,
			false,
			dim(RAIL),
			RAIL_WIDTH,
		),
		...(entry.receipt?.receiptUnavailable ? railLines("receipt unavailable", "warning", width) : []),
		...(entry.receipt?.abandonedDetail ? railLines(entry.receipt.abandonedDetail, "warning", width) : []),
	].map(redactSecretString);
}

export function renderWorkerEntryLines(
	entry: WorkerEntryState,
	width: number,
	options: WorkerEntryRenderOptions,
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const detail = options.detail ?? transcriptDetail();
	if (entry.helper && !options.unbounded && detail.style !== "detailed" && !workerNeedsInput(entry))
		return helperRow(entry, safeWidth, detail, options.terminalRows, options.nowMs);
	// The first card of a council round carries the round's header row.
	const council = entry.council !== undefined && options.group !== "continues" ? [councilHeader(entry, safeWidth)] : [];
	const integrity = entry.receipt?.trust;
	const provenance =
		isPending(entry) || integrity?.artifactIntegrity.state === "verified"
			? []
			: railLines(
					`receipt: ${integrity ? (retiredIntegrityVersionOf(integrity.artifactIntegrity) !== null ? "seal retired" : trustStateWord("artifactIntegrity", integrity.artifactIntegrity.state)) : "integrity unavailable"}; raw output, not admitted as evidence`,
					"warning",
					safeWidth,
				);
	const quality = isPending(entry)
		? []
		: railLines(
				`quality: ${trustStateWord("validationGrounding", entry.receipt?.trust?.validationGrounding.state ?? "unknown")}`,
				"muted",
				safeWidth,
			);
	if (options.unbounded) {
		const tools = toolLine(entry, safeWidth);
		return [
			...council,
			entry.council !== undefined ? fitUnits(theme, "  ", identityUnits(entry), safeWidth) : headerLine(entry, safeWidth),
			...(entry.helper && entry.task ? railLines(entry.task, "muted", safeWidth) : []),
			...bodyLines(entry, safeWidth, true),
			...attemptLines(entry, safeWidth),
			...(tools ? [tools] : []),
			...failureLines(entry, safeWidth),
			footerLine(entry, safeWidth),
			...provenance,
			...quality,
		].map(redactSecretString);
	}
	const budget = (limit: number) => previewBudget(limit, options.terminalRows);
	// A checkpoint's body is the question the operator answers next, so it keeps
	// its rows whatever the transcript preset hides of an ordinary answer, and
	// it renders in the warning token rather than as folded prose.
	const needsInput = workerNeedsInput(entry);
	const summaryRows = needsInput ? CHECKPOINT_PREVIEW_ROWS : budget(detail.workerRows);
	// A run that produced no prose has no summary rows, rather than one blank rail row.
	const summary =
		entry.text.length === 0
			? []
			: bodySourceLines(entry).flatMap((line) =>
					railLines(redactSecretString(line), needsInput ? "warning" : "muted", safeWidth),
				);
	// Current work leads the bounded preview; completed calls remain explicitly historical.
	const current = isPending(entry) ? entry.progress?.currentAction : null;
	const actions = [
		...(current ? [{ action: current, label: "now" }] : []),
		...(entry.progress?.recentActions ?? []).map((action) => ({ action, label: "last" })),
	];
	const trail = actions.flatMap(({ action, label }) =>
		railLines(
			`${GLYPH.phaseTool} ${label}: ${action.descriptor ? `${action.descriptor.verb} ${action.descriptor.object}` : action.tool}`,
			"muted",
			safeWidth,
		),
	);
	// A running card says what it is doing on one live line in every style;
	// Detailed adds the calls it already finished beneath it.
	const pending = isPending(entry);
	const history = actions.filter(({ label }) => label === "last");
	const lastTrail = history.flatMap(({ action }) =>
		railLines(
			`${GLYPH.phaseTool} last: ${action.descriptor ? `${action.descriptor.verb} ${action.descriptor.object}` : action.tool}`,
			"muted",
			safeWidth,
		),
	);
	const tools = detail.workerActivity && !pending && trail.length === 0 ? toolLine(entry, safeWidth) : null;
	const failure = previewRows(
		failureLines(entry, safeWidth),
		budget(detail.errorRows),
		safeWidth,
		false,
		dim(RAIL),
		RAIL_WIDTH,
	);
	const presented = presentedContractAnswer(entry)?.footer;
	// Compact states identity, execution and quality; the spend is a keystroke away.
	const metrics = pending || detail.style === "compact" ? [] : workerMetrics(entry);
	return [
		...council,
		actionLine(entry, safeWidth),
		...(pending ? [progressLine(entry, safeWidth, options.nowMs ?? Date.now())] : []),
		...(metrics.length ? railLines(metrics.join(" · "), "dim", safeWidth) : []),
		...(entry.helper && entry.task
			? previewRows(
					railLines(entry.task, "muted", safeWidth),
					budget(detail.invocationRows),
					safeWidth,
					false,
					dim(RAIL),
					RAIL_WIDTH,
				)
			: []),
		...(detail.workerRows > 0 || needsInput
			? previewRows(summary, summaryRows, safeWidth, entry.pending, dim(RAIL), RAIL_WIDTH)
			: []),
		...previewRows(attemptLines(entry, safeWidth), budget(detail.errorRows), safeWidth, true, dim(RAIL), RAIL_WIDTH),
		...(tools ? [tools] : []),
		...(detail.workerActivity
			? previewRows(pending ? lastTrail : trail, budget(4), safeWidth, false, dim(RAIL), RAIL_WIDTH)
			: []),
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
		...provenance,
		...quality,
	].map(redactSecretString);
}
