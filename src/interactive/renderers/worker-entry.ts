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

import { trustStateWord, validationClause } from "../../domains/evidence/trust-projection.js";
import { retiredIntegrityVersionOf } from "../../domains/evidence/trust-status.js";
import { WORKER_ACTION_TRAIL_LIMIT, type WorkerAction } from "../../domains/observability/worker-progress.js";
import { stripDeadToolCallMarkup } from "../../engine/loop-guard.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { councilLabelText } from "../council-grid.js";
import { formatFooterTokens } from "../footer-panel.js";
import {
	clioTheme,
	fitUnits,
	formatCompactMs,
	functionText,
	GLYPH,
	joinFacts,
	releaseSpaces,
	type SemanticRole,
	toolFunction,
} from "../theme/index.js";
import { workerPhaseActivity } from "../worker-activity.js";
import { type WorkerEntryState, type WorkerReceiptSummary, workerAskedByModel } from "../worker-stream.js";

const theme = clioTheme();
const meta = (text: string): string => theme.fg("toolMetadata", text);

// The worker card follows the transcript's gutter grammar: the origin glyph
// sits in the gutter and the card's body nests under it in the content column.
const RAIL = "  │ ";
const RAIL_WIDTH = 4;
const ATTEMPT = "↻ ";
const SEPARATOR = " · ";

export interface WorkerEntryRenderOptions {
	nowMs?: number;
	detail?: TranscriptDetailPolicy;
	terminalRows?: number;
	/**
	 * Inspect the card whole, as `/view` and `/export` do: the Detailed card with
	 * every budget lifted and the answer exactly as the run returned it.
	 */
	unbounded?: boolean;
	/**
	 * `continues` when this card follows a card of the same council round, so
	 * the round's header row is not repeated above it.
	 */
	group?: "leads" | "continues";
	/** Workers admitted by the same dispatch call, including settled siblings. */
	siblings?: ReadonlyArray<WorkerEntryState>;
	showGroupHeader?: boolean;
}

/**
 * Who started the run, in the gutter: `◆` the model, `◇` the operator, `↳`
 * Clio's own helper work. Settled or running, the mark keeps its token; the
 * function family uses orange; the separate `●` on the row conveys live state.
 */
function originGlyph(entry: WorkerEntryState): string {
	if (entry.helper) return functionText(theme, "shadowDispatch", GLYPH.subProcess);
	return functionText(theme, "dispatch", workerAskedByModel(entry) ? GLYPH.workerAgent : GLYPH.workerHuman);
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
			: theme.fg("workerIdentity", kind === "acp" ? `${entry.agentId} (acp)` : entry.agentId);
	return [
		who,
		...(entry.helper ? [meta("internal")] : []),
		...(kind !== "acp" && route !== undefined ? [meta(route)] : []),
		meta(`run ${entry.runId}`),
		// A failover keeps the card; the header says which attempt it shows.
		...(entry.attempts.length > 1 ? [meta(`attempt ${entry.attempts.length}`)] : []),
	];
}

/**
 * The gutter mark and the row a council round opens with. Its members follow
 * in the content column, each under its roster label, so the round reads as
 * one question put to several voices rather than as unrelated cards.
 */
function councilHeader(entry: WorkerEntryState, width: number): string {
	const round = entry.council?.round ?? 1;
	return fitUnits(
		theme,
		`${originGlyph(entry)} `,
		[functionText(theme, "dispatch", "council"), meta(`round ${round}`)],
		width,
	);
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
function outcomeUnit(receipt: WorkerReceiptSummary): string {
	// A worker that exited cleanly without executing one tool did none of an
	// assignment that needed tools, so "execution ok" would read as a done task.
	// The receipt stays succeeded when the worker answered in prose by design
	// (a judge or scout can); the row states the fact in a neutral tone.
	if (receipt.outcome === "succeeded" && receipt.toolCalls === 0) {
		return theme.fg("toolMetadata", `${GLYPH.queued} ran no tools`);
	}
	if (receipt.outcome === "succeeded") return theme.fg("success", `${GLYPH.ok} execution ok`);
	if (receipt.outcome === "canceled") return theme.fg("toolMetadata", `${GLYPH.cancelled} canceled`);
	if (receipt.abandonedDetail !== undefined) return theme.fg("error", GLYPH.error);
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
function pendingUnit(): string {
	return theme.fg("activity", GLYPH.running);
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

/** Wrap one annotation onto the rail, prefixed on its first row and hanging under it after. */
function railLines(text: string, token: SemanticRole, width: number): string[] {
	const contentWidth = Math.max(1, width - RAIL_WIDTH);
	return wrapTextWithAnsi(text, contentWidth).map(
		(row) => `${theme.fg("gutter", RAIL)}${theme.base(token, releaseSpaces(row))}`,
	);
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
function mutationReportLines(
	value: Record<string, unknown>,
	placement: WorkerReceiptSummary["placement"] | undefined,
): string[] | null {
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
		// The message is the worker's proposal. A worktree run commits it on the
		// task branch; a run in the current tree commits nothing (race-Q4-t2-b).
		lines.push(
			placement?.mode === "worktree"
				? `commit on ${placement.branch}: ${value.commitMessage.trim()}`
				: `proposed commit message, not committed: ${value.commitMessage.trim()}`,
		);
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
		return safeWorkerAnswerText(entry.pending ? stripDeadToolCallMarkup(entry.text) : entry.text).split("\n");
	const structured = entry.droppedLines === 0 ? exactWorkerAnswerObject(entry.text) : null;
	if (structured === null) return safeWorkerAnswerText(entry.text).split("\n");
	const presented = presentedContractAnswer(entry);
	if (presented !== null) return presented.lines;
	return (
		mutationReportLines(structured, entry.receipt?.placement)?.map(safeWorkerAnswerText) ??
		safeWorkerAnswerText(entry.text).split("\n")
	);
}

/** Tool names only, coalesced onto one line. Arguments never cross into the transcript. */
function toolLine(entry: WorkerEntryState, width: number): string | null {
	if (entry.tools.length === 0) return null;
	const contentWidth = Math.max(1, width - RAIL_WIDTH);
	return `${theme.fg("gutter", RAIL)}${theme.fg(
		"body",
		fitUnits(
			theme,
			`${theme.fg("toolGlyph", GLYPH.phaseTool)} `,
			entry.tools.map((tool) => functionText(theme, toolFunction(tool), tool)),
			contentWidth,
		),
	)}`;
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
	const identity = `${cardPrefix(entry)}${identityUnits(entry).join(meta(SEPARATOR))}`;
	const status =
		isPending(entry) || entry.receipt === undefined
			? pendingUnit()
			: workerNeedsInput(entry)
				? needsInputUnit()
				: outcomeUnit(entry.receipt);
	const elapsed =
		entry.receipt?.durationMs === undefined ? "" : meta(`${SEPARATOR}${formatCompactMs(entry.receipt.durationMs)}`);
	const full = ` ${status}${elapsed}`;
	let tail = visibleWidth(identity) + visibleWidth(full) <= width ? full : ` ${status}`;
	// Reserve one identity cell. The optional hint yields before execution
	// status when the suffix alone would exhaust the header's width.
	if (visibleWidth(tail) >= width) tail = ` ${status}`;
	const header = `${truncateToWidth(identity, Math.max(1, width - visibleWidth(tail)), GLYPH.ellipsis, false)}${tail}`;
	return truncateToWidth(header, width, GLYPH.ellipsis, false);
}

/**
 * What a settled run spent, and a failed process's exit status. A fact the
 * run did not report is left out rather than stated as zero. Inspection adds
 * the answer's result-contract conformance, which the transcript states by
 * presenting a conforming answer readably and `/view` and `/export` cannot,
 * since they show the answer as the run returned it.
 */
function workerMetrics(entry: WorkerEntryState, inspect: boolean): string[] {
	const metrics: string[] = [];
	const exitCode = entry.receipt?.exitCode;
	if (exitCode !== undefined && exitCode !== 0) metrics.push(`exit ${exitCode}`);
	const tokens = entry.receipt?.tokenCount ?? entry.progress?.processedTokens;
	const calls = entry.receipt?.toolCalls ?? entry.progress?.toolCalls;
	if (tokens !== undefined) metrics.push(`${formatFooterTokens(tokens)} tokens processed`);
	const context = entry.progress?.contextTokens ?? entry.contextTokens;
	if (context !== undefined) metrics.push(`context ${formatFooterTokens(context)}`);
	if (calls !== undefined) metrics.push(`${calls} tool call${calls === 1 ? "" : "s"}`);
	if (inspect && entry.receipt?.contract !== undefined) metrics.push(`contract ${entry.receipt.contract}`);
	return metrics;
}

/**
 * The descriptor vocabulary's progressive verbs in the past tense. A verb that
 * names a tool rather than an act (`git`, `context`, `gateway`, `tasks`) reads
 * the same either way.
 */
const FINISHED_VERBS: Readonly<Record<string, string>> = {
	reading: "read",
	editing: "edited",
	writing: "wrote",
	listing: "listed",
	running: "ran",
	searching: "searched",
	finding: "found",
	fetching: "fetched",
	verifying: "verified",
	navigating: "navigated",
	inspecting: "inspected",
	monitoring: "monitored",
	steering: "steered",
	dispatching: "dispatched",
	deleting: "deleted",
	moving: "moved",
	thinking: "thought",
	calling: "called",
};

/** A call's object, marked when the safety layer cut it to its length cap. */
function descriptorObject(descriptor: NonNullable<WorkerAction["descriptor"]>): string {
	if (descriptor.object === undefined) return "";
	return ` ${descriptor.object}${descriptor.truncated === true ? GLYPH.ellipsis : ""}`;
}

/** A finished call as `verb object` in the past tense, or its tool name when the runtime sent no descriptor. */
function finishedAction(action: WorkerAction): string {
	const descriptor = action.descriptor;
	const actionText =
		descriptor === undefined
			? functionText(theme, toolFunction(action.tool), sanitizeCallTargetText(action.tool))
			: `${functionText(theme, toolFunction(action.tool), sanitizeCallTargetText(FINISHED_VERBS[descriptor.verb] ?? descriptor.verb))}${theme.fg("toolTarget", descriptor.object === undefined ? "" : ` ${sanitizeCallTargetText(descriptorObject(descriptor))}`)}`;
	const failure = action.outcome === "blocked" ? "blocked" : action.outcome === "error" ? "failed" : null;
	return failure === null
		? actionText
		: `${actionText} ${theme.fg(action.outcome === "blocked" ? "warning" : "error", `${GLYPH.error} ${failure}`)}`;
}

/**
 * A settled card's calls, oldest first, with a run of one repeated call stated
 * once and counted (`read docs/retry.md ×3`): a worker going round in a loop is
 * a fact worth one row, not four identical ones.
 */
function trailCalls(recent: ReadonlyArray<WorkerAction>): string[] {
	const calls: Array<{ text: string; count: number }> = [];
	for (const action of [...recent].reverse()) {
		const text = finishedAction(action);
		const last = calls[calls.length - 1];
		if (last?.text === text) last.count += 1;
		else calls.push({ text, count: 1 });
	}
	return calls.map(({ text, count }) => (count > 1 ? `${text} ${GLYPH.times}${count}` : text));
}

/** The running call as `verb object`, or its tool name when the runtime sent no descriptor. */
function describedAction(entry: WorkerEntryState): string | null {
	const action = entry.progress?.currentAction;
	if (action === null || action === undefined) return null;
	return action.descriptor ? `${action.descriptor.verb}${descriptorObject(action.descriptor)}` : action.tool;
}

function elapsedMsOf(entry: WorkerEntryState, nowMs: number): number | undefined {
	if (isPending(entry)) return entry.startedAtMs === undefined ? undefined : Math.max(0, nowMs - entry.startedAtMs);
	return entry.receipt?.durationMs;
}

const TIMER_WIDTH = 7;

function workerName(entry: WorkerEntryState): string {
	return sanitizeCallTargetText(redactSecretString(entry.council?.label ?? entry.agentId));
}

/** Dispatch rows reserve the clock before cutting the task or agent name. */
function alignedHeader(
	entry: WorkerEntryState,
	width: number,
	nowMs: number,
	siblings?: ReadonlyArray<WorkerEntryState>,
): string {
	const elapsedMs = elapsedMsOf(entry, nowMs);
	const elapsed =
		elapsedMs === undefined
			? "—"
			: elapsedMs >= 3_600_000
				? `${Math.min(999_999, Math.floor(elapsedMs / 3_600_000))}h`
				: formatCompactMs(elapsedMs);
	const timer = meta(elapsed.padStart(TIMER_WIDTH));
	const pending = isPending(entry);
	const status = pending
		? pendingUnit()
		: workerNeedsInput(entry)
			? theme.fg("warning", GLYPH.phaseBlocked)
			: entry.receipt?.outcome === "canceled"
				? theme.fg("toolMetadata", GLYPH.cancelled)
				: entry.receipt?.outcome !== "succeeded" || entry.receipt?.contract === "fail"
					? theme.fg("error", GLYPH.error)
					: theme.fg(
							entry.receipt.toolCalls === 0 ? "toolMetadata" : "success",
							entry.receipt.toolCalls === 0 ? GLYPH.queued : GLYPH.ok,
						);
	const name = workerName(entry);
	const widest = Math.max(visibleWidth(name), ...(siblings ?? []).map((sibling) => visibleWidth(workerName(sibling))));
	const prefix = cardPrefix(entry);
	const nameWidth = Math.max(0, Math.min(widest, width - visibleWidth(prefix) - TIMER_WIDTH - 3));
	const shown = truncateToWidth(name, nameWidth, GLYPH.ellipsis, false);
	const identity =
		entry.council !== undefined ? councilLabelText(theme, shown, entry.council.color) : theme.fg("workerIdentity", shown);
	const header = `${prefix}${identity}${" ".repeat(Math.max(0, nameWidth - visibleWidth(shown)))} ${status} ${timer}`;
	const taskWidth = width - visibleWidth(header) - 2;
	const task = sanitizeCallTargetText(redactSecretString(entry.task ?? ""));
	if (taskWidth > 0 && task.length > 0)
		return `${header}  ${theme.fg("body", truncateToWidth(task, taskWidth, GLYPH.ellipsis, false))}`;
	if (visibleWidth(header) <= width) return header;
	// Below the header's minimum width, even its identity yields to elapsed.
	return meta(truncateToWidth(elapsed, width, "", false));
}

function dispatchHeader(siblings: ReadonlyArray<WorkerEntryState>, width: number): string {
	const running = siblings.filter(isPending).length;
	const done = siblings.filter((entry) => !isPending(entry) && entry.receipt?.outcome === "succeeded").length;
	const failed = siblings.length - running - done;
	const first = siblings[0];
	const name =
		first !== undefined && siblings.every((entry) => workerName(entry) === workerName(first))
			? `${workerName(first)}${siblings.length === 1 ? "" : "s"}`
			: "workers";
	return meta(
		truncateToWidth(
			`${siblings.length} ${name} · ${running} running · ${done} done${failed > 0 ? ` · ${failed} failed/canceled` : ""}`,
			width,
			GLYPH.ellipsis,
			false,
		),
	);
}

/** Live cards keep one row per fact, even before telemetry arrives. */
function liveCardFacts(entry: WorkerEntryState, width: number): string[] {
	const room = Math.max(0, width - RAIL_WIDTH);
	const row = (text: string): string =>
		truncateToWidth(
			`${theme.fg("gutter", RAIL)}${meta(truncateToWidth(text, room, GLYPH.ellipsis, false))}`,
			width,
			GLYPH.ellipsis,
			false,
		);
	const target = sanitizeCallTargetText(redactSecretString(entry.runtime.targetId ?? entry.runtime.kind));
	const model = sanitizeCallTargetText(redactSecretString(entry.runtime.wireModelId ?? "unknown"));
	const targetUnit = `target ${target}`;
	const modelWidth = room - visibleWidth(targetUnit) - SEPARATOR.length - 6;
	const route =
		modelWidth > 0
			? `${targetUnit}${SEPARATOR}model ${truncateToWidth(model, modelWidth, GLYPH.ellipsis, false)}`
			: targetUnit;
	const calls = entry.receipt?.toolCalls ?? entry.progress?.toolCalls;
	const limit = entry.toolCallLimit;
	const filled =
		calls === undefined || limit === undefined || limit <= 0 ? 0 : Math.min(5, Math.ceil((calls / limit) * 5));
	const meter = `${GLYPH.contextFull.repeat(filled)}${GLYPH.contextFree.repeat(5 - filled)} ${calls ?? "?"}/${limit ?? "?"}`;
	const tokens = entry.receipt?.tokenCount ?? entry.progress?.processedTokens;
	const state = isPending(entry) ? (entry.progress?.phase ?? "starting") : (entry.receipt?.outcome ?? "unknown");
	return [
		row(route),
		row(
			`state ${state}${SEPARATOR}tools ${meter}${SEPARATOR}${tokens === undefined ? "?" : formatFooterTokens(tokens)} tokens`,
		),
	];
}

/**
 * A running card's one live line, rewritten in place: what it is doing now,
 * how long it has run, and what it has spent. No spinner; the panel's clock
 * moves the elapsed.
 */
function progressLine(
	entry: WorkerEntryState,
	width: number,
	nowMs: number,
	includeTimer = true,
	showToolName = false,
): string {
	const action = describedAction(entry);
	const [glyph, idle] = workerPhaseActivity(entry.progress?.phase);
	const answer = entry.helper
		? ""
		: safeWorkerAnswerText(stripDeadToolCallMarkup(entry.text)).replace(/\s+/gu, " ").trim();
	const toolName =
		showToolName && entry.progress?.currentAction ? `${entry.progress.currentAction.tool}${SEPARATOR}` : "";
	const doing =
		action === null
			? `${glyph} ${idle}${answer.length > 0 ? `: ${answer}` : ""}`
			: `${GLYPH.phaseTool} ${toolName}${action}`;
	const elapsedMs = elapsedMsOf(entry, nowMs);
	const tokens = entry.progress?.processedTokens;
	const calls = entry.progress?.toolCalls;
	const facts = [
		...(!includeTimer || elapsedMs === undefined ? [] : [formatCompactMs(elapsedMs)]),
		...(showToolName || tokens === undefined ? [] : [`${formatFooterTokens(tokens)} tokens`]),
		...(showToolName || calls === undefined ? [] : [`${calls} call${calls === 1 ? "" : "s"}`]),
	];
	// The elapsed time is the line's live signal, so a narrow row cuts the
	// action's text and then drops the spend, never the clock.
	const room = Math.max(0, width - RAIL_WIDTH);
	const activity = sanitizeCallTargetText(redactSecretString(doing));
	const current = entry.progress?.currentAction;
	const prefix =
		action === null ? `${glyph} ${idle}` : `${GLYPH.phaseTool} ${current?.descriptor?.verb ?? current?.tool ?? ""}`;
	const kind = current ? toolFunction(current.tool) : entry.helper ? "shadowDispatch" : "dispatch";
	const styledActivity = (shown: string): string => {
		const lead = shown.slice(0, sanitizeCallTargetText(prefix).length);
		return `${functionText(theme, kind, lead)}${theme.fg("toolTarget", shown.slice(lead.length))}`;
	};
	for (let kept = facts.length; kept >= 0; kept -= 1) {
		const tail = kept === 0 ? "" : `${SEPARATOR}${facts.slice(0, kept).join(SEPARATOR)}`;
		const activityRoom = room - tail.length;
		if (activityRoom < 1 || (kept > 1 && activityRoom < Math.min(24, activity.length))) continue;
		const shown = truncateToWidth(activity, activityRoom, GLYPH.ellipsis, false);
		return truncateToWidth(
			`${theme.fg("gutter", RAIL)}${styledActivity(shown)}${meta(tail)}`,
			width,
			GLYPH.ellipsis,
			false,
		);
	}
	return truncateToWidth(
		`${theme.fg("gutter", RAIL)}${styledActivity(truncateToWidth(activity, room, GLYPH.ellipsis, false))}`,
		width,
		GLYPH.ellipsis,
		false,
	);
}

/**
 * Helper and shadow work keeps its task on the aligned header. Standard adds
 * the current action while running; a failure keeps its explanation below.
 */
function helperRow(
	entry: WorkerEntryState,
	width: number,
	detail: TranscriptDetailPolicy,
	terminalRows?: number,
	nowMs = Date.now(),
	siblings?: ReadonlyArray<WorkerEntryState>,
): string[] {
	const pending = isPending(entry);
	return [
		alignedHeader(entry, width, nowMs, siblings),
		...(pending && detail.style === "standard" ? [progressLine(entry, width, nowMs, false)] : []),
		...(entry.receipt?.mergeDetail ? railLines(entry.receipt.mergeDetail, "success", width) : []),
		...previewRows(
			[...failureLines(entry, width), ...attemptLines(entry, width)],
			previewBudget(detail.errorRows, terminalRows),
			width,
			false,
			meta(RAIL),
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
	const inspect = options.unbounded === true;
	const detail = inspect ? transcriptDetail("detailed") : (options.detail ?? transcriptDetail());
	if (entry.helper && detail.style !== "detailed" && !workerNeedsInput(entry))
		return helperRow(entry, safeWidth, detail, options.terminalRows, options.nowMs, options.siblings);
	// The first card of a council round carries the round's header row.
	const council = entry.council !== undefined && options.group !== "continues" ? [councilHeader(entry, safeWidth)] : [];
	const group =
		!inspect && detail.style === "detailed" && options.showGroupHeader && (options.siblings?.length ?? 0) > 1
			? [dispatchHeader(options.siblings ?? [], safeWidth)]
			: [];
	const nowMs = options.nowMs ?? Date.now();
	if (!inspect && isPending(entry)) {
		const last = entry.progress?.recentActions[0];
		const lastLine =
			last === undefined
				? meta(`${RAIL}${GLYPH.phaseTool} last: —`)
				: `${theme.fg("gutter", RAIL)}${GLYPH.phaseTool} last: ${finishedAction(last)}`;
		return [
			...council,
			...group,
			alignedHeader(entry, safeWidth, nowMs, options.siblings),
			...(detail.style === "detailed" ? liveCardFacts(entry, safeWidth) : []),
			...(detail.style === "compact" ? [] : [progressLine(entry, safeWidth, nowMs, false, detail.style === "detailed")]),
			...(detail.style === "detailed" ? [truncateToWidth(lastLine, safeWidth, GLYPH.ellipsis, false)] : []),
		].map(redactSecretString);
	}
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
				`quality ${entry.receipt?.trust ? validationClause(entry.receipt.trust) : "validation unknown"}`,
				"body",
				safeWidth,
			);
	const budget = (limit: number) => (inspect ? Number.POSITIVE_INFINITY : previewBudget(limit, options.terminalRows));
	// A checkpoint's body is the question the operator answers next, so it keeps
	// its rows whatever the transcript preset hides of an ordinary answer, and
	// it renders in the warning token rather than as folded prose.
	const needsInput = workerNeedsInput(entry);
	const summaryRows = needsInput ? CHECKPOINT_PREVIEW_ROWS : budget(detail.workerRows);
	// A run that produced no prose has no summary rows, rather than one blank rail row.
	const summary =
		entry.text.length === 0
			? []
			: (inspect ? safeWorkerAnswerText(entry.text).split("\n") : bodySourceLines(entry)).flatMap((line) =>
					railLines(redactSecretString(line), needsInput ? "warning" : "assistantProse", safeWidth),
				);
	// A running card says what it is doing on its one live line in every style,
	// and Detailed adds the call it finished last. A settled card in Detailed
	// lists the calls it made, oldest first and in the past tense, because they
	// are finished work, not activity.
	const pending = isPending(entry);
	const recent = entry.progress?.recentActions ?? entry.recentActions ?? [];
	const totalCalls = entry.receipt?.toolCalls ?? entry.progress?.toolCalls ?? 0;
	const earlierCalls = pending ? 0 : Math.max(0, totalCalls - recent.length);
	const trail = pending
		? recent
				.slice(0, 1)
				.flatMap((action) => railLines(`${GLYPH.phaseTool} last: ${finishedAction(action)}`, "body", safeWidth))
		: [
				...(earlierCalls > 0
					? [`… ${earlierCalls} earlier call${earlierCalls === 1 ? "" : "s"} · /view dispatch:${entry.runId}`]
					: []),
				...trailCalls(recent),
			].flatMap((call) => railLines(`${GLYPH.phaseTool} ${call}`, "body", safeWidth));
	const tools = detail.workerActivity && !pending && trail.length === 0 ? toolLine(entry, safeWidth) : null;
	const failure = previewRows(
		failureLines(entry, safeWidth),
		budget(detail.errorRows),
		safeWidth,
		false,
		meta(RAIL),
		RAIL_WIDTH,
	);
	const presented = presentedContractAnswer(entry)?.footer;
	// Compact states identity, execution and quality; the spend is a keystroke away.
	const metrics = pending || detail.style === "compact" ? [] : workerMetrics(entry, inspect);
	return [
		...council,
		...group,
		...(inspect || options.siblings === undefined
			? [actionLine(entry, safeWidth)]
			: [alignedHeader(entry, safeWidth, nowMs, options.siblings)]),
		...(!inspect && options.siblings !== undefined && detail.style === "detailed" ? liveCardFacts(entry, safeWidth) : []),
		...(pending ? [progressLine(entry, safeWidth, options.nowMs ?? Date.now())] : []),
		...(metrics.length ? railLines(joinFacts(metrics), "toolMetadata", safeWidth) : []),
		...(entry.helper && entry.task && (inspect || options.siblings === undefined)
			? previewRows(
					railLines(entry.task, "body", safeWidth),
					budget(detail.invocationRows),
					safeWidth,
					false,
					meta(RAIL),
					RAIL_WIDTH,
				)
			: []),
		...(detail.workerRows > 0 || needsInput
			? previewRows(summary, summaryRows, safeWidth, entry.pending, meta(RAIL), RAIL_WIDTH)
			: []),
		...previewRows(attemptLines(entry, safeWidth), budget(detail.errorRows), safeWidth, true, meta(RAIL), RAIL_WIDTH),
		...(tools ? [tools] : []),
		...(detail.workerActivity
			? previewRows(trail, budget(WORKER_ACTION_TRAIL_LIMIT + 1), safeWidth, true, meta(RAIL), RAIL_WIDTH)
			: []),
		...failure,
		...(entry.receipt?.mergeDetail ? railLines(entry.receipt.mergeDetail, "success", safeWidth) : []),
		...(presented ? railLines(presented, "body", safeWidth) : []),
		...(entry.receipt?.abandonedDetail ? railLines(entry.receipt.abandonedDetail, "warning", safeWidth) : []),
		...(entry.receipt?.receiptUnavailable ? railLines("receipt unavailable", "warning", safeWidth) : []),
		...(entry.droppedLines
			? railLines(
					`… ${entry.droppedLines} earlier lines unavailable here · /view dispatch:${entry.runId}`,
					"body",
					safeWidth,
				)
			: []),
		...provenance,
		...quality,
	].map(redactSecretString);
}
