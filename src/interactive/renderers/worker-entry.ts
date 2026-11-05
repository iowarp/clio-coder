import type { RunTelemetryV1 } from "../../core/telemetry/dto.js";
import { renderCalls } from "../../core/telemetry/render.js";
import { parseCouncilReport } from "../../domains/agents/index.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import { COUNCIL_SYNTHESIS_LABEL } from "../../session-control/council.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import { transcriptDetail } from "../transcript-detail.js";
import { previewBudget, previewRows } from "./preview.js";
import {
	exactWorkerAnswerObject,
	type PresentedContractAnswer,
	presentCouncilReport,
	presentWorkerContractAnswer,
	safeWorkerAnswerText,
	WorkerAnswerProjection,
} from "./worker-answer.js";

/** Bounded worker summaries share the main transcript's output style. */

import type { CompletedRunCaveat } from "../../domains/dispatch/failure-headline.js";
import {
	completedRunCaveat,
	plainOutcomeLabel,
	refusedCallsWords,
	STALLED_RUN_HEADLINE,
	workerFailureHeadline,
} from "../../domains/dispatch/failure-headline.js";
import type { TrustSummaryProjection } from "../../domains/evidence/trust-projection.js";
import { trustStateWord, trustVerdict, validationClause } from "../../domains/evidence/trust-projection.js";
import type { CanonicalTrustStatus } from "../../domains/evidence/trust-status.js";
import { TRUST_STATUS_AXES } from "../../domains/evidence/trust-status.js";
import { WORKER_ACTION_TRAIL_LIMIT, type WorkerAction } from "../../domains/telemetry/worker-progress.js";
import { stripDeadToolCallMarkup } from "../../engine/loop-guard.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import {
	type WorkerEntryState as StreamWorkerEntryState,
	type WorkerRunResultSummary,
	workerAskedByModel,
} from "../../session-control/worker-stream.js";
import { councilLabelText } from "../council-grid.js";
import type { RouteFirstOutput } from "../footer/silence-note.js";
import {
	clioTheme,
	fitUnits,
	functionText,
	GLYPH,
	joinFacts,
	releaseSpaces,
	type SemanticRole,
	toolFunction,
} from "../theme/index.js";
import {
	approvalWaitWords,
	compactQuantity,
	completedRunMark,
	workerActionParts,
	workerPhaseActivity,
	workerQuietWords,
	workerSilenceWords,
} from "../worker-activity.js";

const theme = clioTheme();
const meta = (text: string): string => theme.fg("toolMetadata", text);

/**
 * A render reads the worker through a per-call copy carrying its telemetry. `cacheOwner` names the reducer's own
 * state object, the one identity that outlives a frame, so the caches below survive from delta to delta (#428).
 */
type WorkerEntryState = StreamWorkerEntryState & {
	telemetry?: RunTelemetryV1 | null;
	/** This session's worker calls on the run's route, for saying whether a silent wait is unusual. */
	routeFirstOutput?: RouteFirstOutput | null;
	cacheOwner?: StreamWorkerEntryState;
};

const workerTextCache = new WeakMap<StreamWorkerEntryState, Map<string, { source: string; text: string }>>();
const workerAnswers = new WeakMap<StreamWorkerEntryState, WorkerAnswerProjection>();

/** A clipped row's redaction marker can outgrow what it replaced, and the TUI throws on a row past the terminal's width. */
function redactedRow(row: string, width: number): string {
	const redacted = redactSecretString(row);
	return redacted === row ? row : truncateToWidth(redacted, width, GLYPH.ellipsis, false);
}

function displayText(entry: WorkerEntryState, key: string, source: string): string {
	const owner = entry.cacheOwner ?? entry;
	const fields = workerTextCache.get(owner) ?? new Map();
	const cached = fields.get(key);
	if (cached?.source === source) return cached.text;
	const text = sanitizeCallTargetText(redactSecretString(source));
	fields.set(key, { source, text });
	workerTextCache.set(owner, fields);
	return text;
}

function answerText(entry: WorkerEntryState, source: string): string {
	const owner = entry.cacheOwner ?? entry;
	let projection = workerAnswers.get(owner);
	if (projection === undefined) {
		projection = new WorkerAnswerProjection();
		workerAnswers.set(owner, projection);
	}
	// Only a run that succeeded ended its text on purpose; a failed, stalled or cancelled one can stop inside a URL (#446).
	return projection.project(source, !entry.pending && !isPending(entry) && entry.result?.outcome === "succeeded");
}

/**
 * Every telemetry value a card can print. Two views with the same string render the same card, so a batch that moved
 * nothing this card shows keeps its cached rows and the frozen transcript prefix holding them.
 */
export function workerTelemetryDisplay(telemetry: RunTelemetryV1 | null): string {
	if (telemetry === null) return "";
	const { activity, row } = telemetry;
	return [
		activity.elapsed.display,
		row.tokens.display,
		activity.toolCalls.display,
		activity.contextTokens?.display,
	].join("\0");
}

/** A plain display string needs only enough complete words to fill the row (#428). */
function fitDisplayText(text: string, width: number): string {
	const head = text.slice(0, Math.max(0, width) + 32);
	const boundary = head.lastIndexOf(" ");
	const prefix = head.slice(0, boundary);
	return truncateToWidth(boundary > 0 && visibleWidth(prefix) > width ? prefix : text, width, GLYPH.ellipsis, false);
}

// The worker card follows the transcript's gutter grammar: the origin glyph
// sits in the gutter and the card's body nests under it in the content column.
const RAIL = "  │ ";
const RAIL_WIDTH = 4;
const ATTEMPT = "↻ ";
const SEPARATOR = " · ";

export interface WorkerEntryRenderOptions {
	telemetry?: RunTelemetryV1 | null;
	routeFirstOutput?: RouteFirstOutput | null;
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
function identityUnits(entry: WorkerEntryState, withRunId = true): string[] {
	const { kind, targetId, wireModelId } = entry.runtime;
	// A model id that already starts with its target's name (`mock` serving `mock/judge-model`) is not repeated.
	const route =
		targetId !== undefined && wireModelId !== undefined
			? wireModelId.startsWith(`${targetId}/`)
				? wireModelId
				: `${targetId}/${wireModelId}`
			: (targetId ?? wireModelId);
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
		...(withRunId ? [meta(`run ${entry.runId}`)] : []),
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

/** The verdict and axis states the shared caveat reads; an axis a partial record leaves out reads as unknown. */
function trustVerdictOf(trust: CanonicalTrustStatus): Pick<TrustSummaryProjection, "verdict" | "axes"> {
	const partial = trust as Partial<CanonicalTrustStatus>;
	const filled = Object.fromEntries(
		TRUST_STATUS_AXES.map((axis) => [axis, partial[axis] ?? { state: "unknown" }]),
	) as unknown as CanonicalTrustStatus;
	return {
		verdict: trustVerdict(filled),
		axes: Object.fromEntries(TRUST_STATUS_AXES.map((axis) => [axis, filled[axis].state])) as Record<
			(typeof TRUST_STATUS_AXES)[number],
			string
		>,
	};
}

/** The shared caveat on a clean exit, so this card and the Fleet Runs row never disagree about how a run ended. */
function settledCaveat(result: WorkerRunResultSummary, synthesizes = false): CompletedRunCaveat | null {
	if (result.outcome !== "succeeded") return null;
	return completedRunCaveat({
		...(result.trust !== undefined ? { trust: trustVerdictOf(result.trust) } : {}),
		...(result.contract !== undefined ? { contract: result.contract } : {}),
		// A council synthesis composes its members' answers without tools by design, so no-tools says nothing there.
		...(result.toolCalls !== undefined && !synthesizes ? { toolCalls: result.toolCalls } : {}),
		...(result.refusedCalls !== undefined ? { refusedCalls: result.refusedCalls } : {}),
	});
}

function isSynthesis(entry: WorkerEntryState): boolean {
	return entry.council?.label === COUNCIL_SYNTHESIS_LABEL;
}

function settledMark(result: WorkerRunResultSummary, synthesizes: boolean): string {
	const mark = completedRunMark(settledCaveat(result, synthesizes));
	return theme.fg(mark.token, mark.glyph);
}

/** Why a run that executed cleanly still cannot be leaned on, or null when nothing marks it against. */
function settledAgainst(result: WorkerRunResultSummary): string | null {
	const caveat = settledCaveat(result);
	return caveat?.kind === "against" ? caveat.words : null;
}

/**
 * The run's overall outcome, leading with the mark that decides it. A clean
 * exit under a failed validation leads with the failure and keeps the
 * execution fact in words, because a check mark beside a failed check reads
 * as a pass. Abandoned names itself rather than falling through to its `stalled`
 * outcome code, so it reads as a ledger-side finding instead of the ordinary
 * heartbeat-timeout `stalled` a sealed result reports.
 */
function outcomeUnit(result: WorkerRunResultSummary, synthesizes: boolean): string {
	// A worker that exited cleanly without executing one tool did none of an
	// assignment that needed tools, so "execution ok" would read as a done task.
	// The result stays succeeded when the worker answered in prose by design
	// (a judge or scout can); the row states the fact in a neutral tone.
	const caveat = settledCaveat(result, synthesizes);
	if (caveat?.kind === "against") {
		return `${theme.fg("error", `${GLYPH.error} ${caveat.words}`)}${meta(`${SEPARATOR}execution ok`)}`;
	}
	if (caveat?.kind === "no-tools") return theme.fg("toolMetadata", `${GLYPH.queued} ${caveat.words}`);
	// A clean exit is not an all-clear when a call was refused on the way. The row says which is true.
	if (caveat?.kind === "refused") return theme.fg("warning", `${GLYPH.warn} finished with ${caveat.words}`);
	if (result.outcome === "succeeded") return theme.fg("success", `${GLYPH.ok} execution ok`);
	if (result.outcome === "canceled") return theme.fg("toolMetadata", `${GLYPH.cancelled} cancelled`);
	if (result.abandonedDetail !== undefined) return theme.fg("error", GLYPH.error);
	return theme.fg("error", `${GLYPH.error} ${plainOutcomeLabel(result.outcomeCode ?? result.outcome)}`);
}

/**
 * A settled worker whose answer is a question for the operator.
 *
 * Materio and WTF-P workers return `needs_input: checkpoint:decision` (or
 * `task_blocked`, or a `## CHECKPOINT REACHED` heading) followed by the
 * questions the orchestrator has to relay. That is a prose convention, not a
 * result field, so the transcript reads the first line of the answer.
 */
const CHECKPOINT_PREFIX = /^\s*(?:needs_input\b|task_blocked\b|##\s*CHECKPOINT REACHED\b|##\s*BLOCKED\b)/iu;
/** Rows a checkpoint's body keeps on the folded row: the questions are the point of the entry. */
const CHECKPOINT_PREVIEW_ROWS = 16;

export function workerNeedsInput(entry: Pick<WorkerEntryState, "text" | "result">): boolean {
	return (
		entry.result !== undefined &&
		entry.result.stillRunning !== true &&
		CHECKPOINT_PREFIX.test(entry.text.trim().replace(/^```[A-Za-z0-9_-]*[^\S\r\n]*\r?\n/u, ""))
	);
}

function needsInputUnit(): string {
	return theme.fg("warning", `${GLYPH.phaseBlocked} needs input`);
}

/**
 * A block with no settled result yet: the live mark, spinner-free. The row's
 * progress line says what the run is doing; `/view` spells the state out.
 */
function pendingUnit(): string {
	return theme.fg("activity", GLYPH.running);
}

/**
 * Whether a block should render as still going rather than settled: live,
 * never yet received a result (`entry.result === undefined`), or replayed
 * from a `runs.json` row with no `endedAt` (`stillRunning`) because its
 * process is still executing in another instance of Clio.
 */
function isPending(entry: WorkerEntryState): boolean {
	return entry.result === undefined || entry.result.stillRunning === true;
}

/** Wrap one annotation onto the rail, prefixed on its first row and hanging under it after. */
function railLines(text: string, token: SemanticRole, width: number): string[] {
	const contentWidth = Math.max(1, width - RAIL_WIDTH);
	return wrapTextWithAnsi(text, contentWidth).map(
		(row) => `${theme.fg("gutter", RAIL)}${theme.base(token, releaseSpaces(row))}`,
	);
}

function presentedContractAnswer(entry: WorkerEntryState): PresentedContractAnswer | null {
	if (entry.result?.trust?.artifactIntegrity.state !== "verified") return null;
	// A council's synthesis seals the whole council as one report; the card reads it as answers, not as JSON.
	if (entry.council?.label === COUNCIL_SYNTHESIS_LABEL && !isPending(entry)) {
		const report = parseCouncilReport(entry.text);
		if (report !== null) return presentCouncilReport(report);
	}
	const kind = entry.result?.contractKind;
	const conformance = entry.result?.contract;
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
	placement: WorkerRunResultSummary["placement"] | undefined,
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
 * uses its result identity for a readable preview. Unknown objects retain
 * their original numeric source tokens instead of being parsed and reserialized.
 * Truncated text is not one object and passes through as the prose it is.
 */
function bodySourceLines(entry: WorkerEntryState): string[] {
	if (
		entry.pending ||
		entry.result?.trust?.artifactIntegrity.state !== "verified" ||
		entry.droppedLines !== 0 ||
		(entry.progress?.droppedBytes ?? 0) !== 0
	)
		return answerText(entry, entry.pending ? stripDeadToolCallMarkup(entry.text) : entry.text).split("\n");
	const structured = entry.droppedLines === 0 ? exactWorkerAnswerObject(entry.text) : null;
	if (structured === null) return answerText(entry, entry.text).split("\n");
	const presented = presentedContractAnswer(entry);
	if (presented !== null) return presented.lines;
	return (
		mutationReportLines(structured, entry.result?.placement)?.map(safeWorkerAnswerText) ??
		answerText(entry, entry.text).split("\n")
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
			: railLines(
					`${ATTEMPT}failed over → attempt ${index + 1} on ${attempt.targetLabel}${attempt.moveReason ? `: ${sanitizeCallTargetText(attempt.moveReason)}` : ""}`,
					"warning",
					width,
				),
	);
}

/**
 * The failure's first line, on the rail above the footer. The footer stays one
 * line of facts; the reason is prose and wraps like prose, so a long message
 * cannot make the result line heavier than the answer above it.
 */
function failureLines(entry: WorkerEntryState, width: number, inspect = false): string[] {
	const message = entry.result?.failureMessage;
	// A cancelled card's header already says so; the SIGTERM the worker logged adds nothing but alarm.
	if (message === undefined || (entry.result?.outcome === "canceled" && !inspect)) return [];
	// Inspection states the receipt's own words; the transcript leads with the reason a person acts on.
	const first = inspect
		? (message.split("\n", 1)[0] ?? "").trim()
		: entry.result?.outcome === "stalled"
			? STALLED_RUN_HEADLINE
			: (workerFailureHeadline(message) ?? "");
	return first.length === 0 ? [] : railLines(`${GLYPH.error} ${first}`, "error", width);
}

/**
 * Where a finished run's changes are when Clio did not merge them: a `changed` row alone reads as the checkout, and
 * the change sits on the worktree's branch until the operator takes it.
 */
function keptWorktreeLines(entry: WorkerEntryState, width: number): string[] {
	const result = entry.result;
	const task = result?.taskWorktree;
	if (result === undefined || result.outcome === "canceled" || result.mergeDetail !== undefined) return [];
	if (task === undefined || !task.kept || task.changedPaths === 0) return [];
	const files = `${task.changedPaths} changed ${task.changedPaths === 1 ? "file" : "files"}`;
	return railLines(
		sanitizeCallTargetText(`${files} on branch ${task.branch} in its worktree, not in your checkout`),
		"toolMetadata",
		width,
	);
}

/**
 * Who stopped a cancelled run, and what became of its worktree, which nothing else on the card says: a cancel
 * removes a worktree with no work in it and keeps one holding changes, on its branch.
 */
function cancelLines(entry: WorkerEntryState, width: number): string[] {
	if (entry.result?.outcome !== "canceled") return [];
	// The process's own signal note says how it was stopped, not who stopped it, so the card says only that it was.
	const headline = workerFailureHeadline(entry.result.failureMessage);
	const why = headline === null || /\bSIG[A-Z]+\b/u.test(headline) ? "cancelled" : headline;
	const task = entry.result.taskWorktree;
	const placement = entry.result.placement;
	const worktree =
		task !== undefined
			? task.kept
				? task.changedPaths > 0
					? `${task.changedPaths} changed ${task.changedPaths === 1 ? "file stays" : "files stay"} in its worktree on branch ${task.branch}`
					: `its worktree stays on branch ${task.branch}`
				: "its worktree held no changes and was removed"
			: placement?.mode === "worktree"
				? `its worktree stays on branch ${placement.branch}`
				: null;
	// The header already says cancelled; the row is only for who stopped it and what became of its worktree.
	if (why === "cancelled" && worktree === null) return [];
	const text = `${GLYPH.cancelled} ${why.startsWith("cancelled") ? why : `cancelled: ${why}`}${worktree === null ? "" : `${SEPARATOR}${worktree}`}`;
	return railLines(sanitizeCallTargetText(text), "toolMetadata", width);
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
function actionLine(entry: WorkerEntryState, width: number, withRunId: boolean): string {
	const identity = `${cardPrefix(entry)}${identityUnits(entry, withRunId).join(meta(SEPARATOR))}`;
	const status =
		isPending(entry) || entry.result === undefined
			? pendingUnit()
			: workerNeedsInput(entry)
				? needsInputUnit()
				: outcomeUnit(entry.result, isSynthesis(entry));
	const elapsed =
		entry.telemetry === undefined || entry.telemetry === null
			? ""
			: meta(`${SEPARATOR}${entry.telemetry.activity.elapsed.display}`);
	// A narrow row keeps the name and what happened, in the wide row's order, and lets the route take the cut.
	if (width < NARROW_CARD_WIDTH) {
		// The outcome never takes the cut: the name gives way first, then the elapsed time.
		const [who, ...rest] = identityUnits(entry, withRunId);
		const prefix = cardPrefix(entry);
		const tail = visibleWidth(`${prefix}  ${status}${elapsed}`) + 4 <= width ? `${status}${elapsed}` : status;
		const nameRoom = Math.max(1, width - visibleWidth(prefix) - visibleWidth(tail) - 1);
		const lead = `${prefix}${truncateToWidth(who ?? "", nameRoom, GLYPH.ellipsis, false)} ${tail}`;
		const route = rest.length > 0 ? `${meta(SEPARATOR)}${rest.join(meta(SEPARATOR))}` : "";
		return truncateToWidth(`${lead}${route}`, width, GLYPH.ellipsis, false);
	}
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
	const exitCode = entry.result?.exitCode;
	// The exit status is how the process ended, not what went wrong; the failure row says that, and /view keeps the code.
	if (inspect && exitCode !== undefined && exitCode !== 0) {
		metrics.push(`exit ${exitCode}`);
	}
	const tokens = entry.telemetry?.row.tokens.display;
	const calls = entry.telemetry?.activity.toolCalls.display;
	const refused = entry.result?.refusedCalls ?? 0;
	if (!inspect) {
		// The card leads with the two facts a reader acts on. The coverage clause, context and contract are one /view away.
		if (calls !== undefined) metrics.push(renderCalls(calls));
		if (refused > 0) metrics.push(refusedCallsWords(refused));
		const figure = tokens === undefined ? null : compactQuantity(tokens);
		if (figure !== null) metrics.push(`${figure} tokens`);
		return metrics;
	}
	if (tokens !== undefined) metrics.push(`${tokens} tokens processed`);
	const context = entry.telemetry?.activity.contextTokens;
	if (context) metrics.push(`context ${context.display}`);
	if (calls !== undefined) metrics.push(renderCalls(calls));
	if (refused > 0) metrics.push(refusedCallsWords(refused));
	if (entry.result?.contract !== undefined) metrics.push(`contract ${entry.result.contract}`);
	return metrics;
}

/** A finished call as `verb object` in the past tense, or its tool name when the runtime sent no descriptor. */
function finishedAction(action: WorkerAction): string {
	const parts = workerActionParts(action, "finished");
	const verb = functionText(theme, toolFunction(action.tool), sanitizeCallTargetText(parts.verb));
	const actionText =
		parts.object.length === 0 ? verb : `${verb}${theme.fg("toolTarget", ` ${sanitizeCallTargetText(parts.object)}`)}`;
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
function describedAction(entry: WorkerEntryState, room?: number): string | null {
	const action = entry.progress?.currentAction;
	if (action === null || action === undefined) return null;
	if (entry.progress?.awaitingApproval === true) {
		return approvalWaitWords(entry.progress, room === undefined ? {} : { room });
	}
	const parts = workerActionParts(action, "running");
	return parts.object.length === 0 ? parts.verb : `${parts.verb} ${parts.object}`;
}

const TIMER_WIDTH = 7;
const NARROW_CARD_WIDTH = 72;

function workerName(entry: WorkerEntryState): string {
	// The synthesis run carries the council's result, judged, voted or only collected, so it goes by the council.
	const label = entry.council?.label === COUNCIL_SYNTHESIS_LABEL ? "council" : entry.council?.label;
	return displayText(entry, "name", label ?? entry.agentId);
}

/** The widest header outcome word, so sibling cards line up. */
const HEADER_WORD_WIDTH = "needs input".length;
const HEADER_WORD_MIN_WIDTH = 60;

/** The aligned header's outcome in one word: the run's state, never the reason, which the rows under it give. */
function headerWord(entry: WorkerEntryState): string {
	if (isPending(entry) || entry.result === undefined) return "";
	if (workerNeedsInput(entry)) return "needs input";
	const outcome = entry.result.outcome;
	if (outcome === "canceled") return "cancelled";
	if (outcome === "stalled") return "stalled";
	if (outcome === "timed_out") return "timed out";
	if (outcome !== "succeeded" || settledAgainst(entry.result) !== null) return "failed";
	return settledCaveat(entry.result, isSynthesis(entry))?.kind === "no-tools" ? "no tools" : "done";
}

/** Dispatch rows reserve the clock before cutting the task or agent name. */
function alignedHeader(
	entry: WorkerEntryState,
	width: number,
	_nowMs: number,
	siblings?: ReadonlyArray<WorkerEntryState>,
): string {
	const elapsed = entry.telemetry?.activity.elapsed.display ?? "—";
	const timer = meta(elapsed.padStart(TIMER_WIDTH));
	const pending = isPending(entry);
	const mark = pending
		? pendingUnit()
		: workerNeedsInput(entry)
			? theme.fg("warning", GLYPH.phaseBlocked)
			: entry.result?.outcome === "canceled"
				? theme.fg("toolMetadata", GLYPH.cancelled)
				: entry.result?.outcome !== "succeeded"
					? theme.fg("error", GLYPH.error)
					: settledMark(entry.result, isSynthesis(entry));
	// A settled mark says its outcome in a word as well, padded so sibling cards keep one column, because a lone
	// glyph is a colour cue NO_COLOR and a quick read both lose. A narrow row keeps the glyph alone.
	// A running card's live line under the header says what it is doing, so only a settled header carries a word.
	const word = width >= HEADER_WORD_MIN_WIDTH && !pending ? headerWord(entry) : null;
	const status = word === null ? mark : `${mark}${meta(` ${word.padEnd(HEADER_WORD_WIDTH)}`)}`;
	const name = workerName(entry);
	const widest = Math.max(visibleWidth(name), ...(siblings ?? []).map((sibling) => visibleWidth(workerName(sibling))));
	const prefix = cardPrefix(entry);
	const nameWidth = Math.max(0, Math.min(widest, width - visibleWidth(prefix) - TIMER_WIDTH - 3));
	const shown = truncateToWidth(name, nameWidth, GLYPH.ellipsis, false);
	const identity =
		entry.council !== undefined ? councilLabelText(theme, shown, entry.council.color) : theme.fg("workerIdentity", shown);
	const header = `${prefix}${identity}${" ".repeat(Math.max(0, nameWidth - visibleWidth(shown)))} ${status} ${timer}`;
	const taskWidth = width - visibleWidth(header) - 2;
	const task = displayText(entry, "task", entry.task ?? "");
	if (taskWidth > 0 && task.length > 0) return `${header}  ${theme.fg("body", fitDisplayText(task, taskWidth))}`;
	if (visibleWidth(header) <= width) return header;
	// Below the header's minimum width, even its identity yields to elapsed.
	return meta(truncateToWidth(elapsed, width, "", false));
}

function dispatchHeader(siblings: ReadonlyArray<WorkerEntryState>, width: number): string {
	const running = siblings.filter(isPending).length;
	const done = siblings.filter(
		(entry) =>
			!isPending(entry) &&
			entry.result !== undefined &&
			entry.result.outcome === "succeeded" &&
			settledAgainst(entry.result) === null,
	).length;
	const failed = siblings.length - running - done;
	const first = siblings[0];
	const name =
		first !== undefined && siblings.every((entry) => workerName(entry) === workerName(first))
			? `${workerName(first)}${siblings.length === 1 ? "" : "s"}`
			: "workers";
	return meta(
		truncateToWidth(
			`${siblings.length} ${name} · ${running} running · ${done} done${failed > 0 ? ` · ${failed} failed/cancelled` : ""}`,
			width,
			GLYPH.ellipsis,
			false,
		),
	);
}

/** Slice T 1b: one detail row keeps known telemetry and the latest action together. */
function liveCardDetail(entry: WorkerEntryState, width: number): string {
	const room = Math.max(0, width - RAIL_WIDTH);
	const clean = (text: string): string => sanitizeCallTargetText(redactSecretString(text));
	const target = entry.runtime.targetId === undefined ? "" : clean(entry.runtime.targetId);
	const model = entry.runtime.wireModelId === undefined ? "" : clean(entry.runtime.wireModelId);
	const calls = entry.telemetry?.activity.toolCalls.display;
	const tools = calls === undefined ? "" : `tools ${calls}`;
	const tokens = entry.telemetry?.row.tokens.display;
	const tokenFigure = tokens === undefined ? null : compactQuantity(tokens);
	const quiet = isPending(entry) ? workerQuietWords(entry.progress) : null;
	const current = isPending(entry) && quiet === null ? describedAction(entry) : null;
	const last = (entry.progress?.recentActions ?? entry.recentActions)?.[0];
	const activity =
		quiet !== null
			? quiet
			: current !== null
				? clean(current)
				: last !== undefined
					? clean(finishedAction(last))
					: isPending(entry)
						? ((entry.progress === undefined
								? null
								: workerSilenceWords(entry.progress, { room: 48, history: entry.routeFirstOutput ?? null })) ??
							workerPhaseActivity(entry.progress?.phase)[1])
						: "";
	const facts = [
		target,
		tools,
		tokenFigure === null ? "" : `${tokenFigure} tokens`,
		activity && `${GLYPH.phaseTool} ${activity}`,
	].filter(Boolean);
	const modelRoom = room - visibleWidth(facts.join(SEPARATOR)) - (facts.length > 0 ? SEPARATOR.length : 0);
	if (model && modelRoom > 0) facts.splice(target ? 1 : 0, 0, truncateToWidth(model, modelRoom, GLYPH.ellipsis, false));
	return truncateToWidth(
		`${theme.fg("gutter", RAIL)}${theme.fg("metadata", truncateToWidth(facts.join(SEPARATOR), room, GLYPH.ellipsis, false))}`,
		width,
		GLYPH.ellipsis,
		false,
	);
}

/** Room the live line keeps for its label and facts when it picks which of the worker's words to show. */
const PROGRESS_FACTS_ROOM = 40;

/** The end of what a worker has written so far, from a word boundary, so the row moves as the stream does. */
function latestWords(text: string, room: number): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	const limit = Math.max(16, room);
	if (flat.length <= limit) return flat;
	const tail = flat.slice(flat.length - limit + 1);
	const space = tail.indexOf(" ");
	return `${GLYPH.ellipsis}${space > 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail}`;
}

/**
 * A running card's one live line, rewritten in place: what it is doing now,
 * how long it has run, and what it has spent. No spinner; the panel's clock
 * moves the elapsed.
 */
function progressLine(entry: WorkerEntryState, width: number, nowMs: number, includeTimer = true): string {
	const elapsed = entry.telemetry?.activity.elapsed.display;
	// The wait's words shorten to leave the clock beside them, because a cut here would lose the time left.
	const waitRoom =
		width - RAIL_WIDTH - 2 - (!includeTimer || elapsed === undefined ? 0 : elapsed.length + SEPARATOR.length);
	// A worker whose heartbeat stopped is doing nothing it can be seen doing, so its last call or phase would read as current.
	const quiet = workerQuietWords(entry.progress, nowMs);
	const action = quiet !== null ? null : describedAction(entry, waitRoom);
	const tokens = entry.telemetry?.row.tokens.display;
	const tokenFigure = tokens === undefined ? null : compactQuantity(tokens);
	const calls = entry.telemetry?.activity.toolCalls.display;
	const facts = [
		...(!includeTimer || elapsed === undefined ? [] : [elapsed]),
		...(tokenFigure === null ? [] : [`${tokenFigure} tokens`]),
		...(calls === undefined ? [] : [renderCalls(calls, "call")]),
	];
	// A model gone quiet past the watchdog tiers says how long and what ends it, the words the dock uses too. The form
	// is picked for the room the facts beside it leave, so the row never cuts a clause mid-word.
	const silenceRoom =
		width - RAIL_WIDTH - 2 - (facts.length === 0 ? 0 : SEPARATOR.length + facts.join(SEPARATOR).length);
	const silence =
		quiet !== null || action !== null || entry.progress === undefined
			? null
			: workerSilenceWords(entry.progress, {
					now: nowMs,
					room: Math.max(16, silenceRoom),
					history: entry.routeFirstOutput ?? null,
				});
	const [glyph, idle] =
		quiet !== null
			? [GLYPH.warnInline, quiet]
			: silence !== null
				? [GLYPH.warnInline, silence]
				: workerPhaseActivity(entry.progress?.phase);
	// Only a worker writing is saying these words now, and its latest ones: the first sentence of a long run is long stale.
	const answer =
		entry.helper ||
		quiet !== null ||
		silence !== null ||
		action !== null ||
		(entry.progress?.phase !== undefined && entry.progress.phase !== "writing")
			? ""
			: latestWords(answerText(entry, stripDeadToolCallMarkup(entry.text)), width - RAIL_WIDTH - PROGRESS_FACTS_ROOM);
	// A wait on the operator is not a tool running, so it carries the mark every other human wait does.
	const actionGlyph = entry.progress?.awaitingApproval === true ? GLYPH.phaseBlocked : GLYPH.phaseTool;
	const doing =
		action === null ? `${glyph} ${idle}${answer.length > 0 ? `: ${answer}` : ""}` : `${actionGlyph} ${action}`;
	// The elapsed time is the line's live signal, so a narrow row cuts the
	// action's text and then drops the spend, never the clock.
	const room = Math.max(0, width - RAIL_WIDTH);
	const activity = displayText(entry, "activity", doing);
	const current = entry.progress?.currentAction;
	const prefix =
		action === null
			? `${glyph} ${idle}`
			: `${actionGlyph} ${entry.progress?.awaitingApproval === true ? action : current ? workerActionParts(current, "running").verb : ""}`;
	const kind = current ? toolFunction(current.tool) : entry.helper ? "shadowDispatch" : "dispatch";
	const styledActivity = (shown: string): string => {
		const lead = shown.slice(0, sanitizeCallTargetText(prefix).length);
		return `${functionText(theme, kind, lead)}${theme.fg("toolTarget", shown.slice(lead.length))}`;
	};
	for (let kept = facts.length; kept >= 0; kept -= 1) {
		const tail = kept === 0 ? "" : `${SEPARATOR}${facts.slice(0, kept).join(SEPARATOR)}`;
		const activityRoom = room - tail.length;
		// A wait's words carry its time left, so they outrank the spend beside them.
		const wanted = entry.progress?.awaitingApproval === true ? activity.length : Math.min(24, activity.length);
		if (activityRoom < 1 || (kept > (entry.progress?.awaitingApproval === true ? 0 : 1) && activityRoom < wanted))
			continue;
		const shown = fitDisplayText(activity, activityRoom);
		return truncateToWidth(
			`${theme.fg("gutter", RAIL)}${styledActivity(shown)}${meta(tail)}`,
			width,
			GLYPH.ellipsis,
			false,
		);
	}
	return truncateToWidth(
		`${theme.fg("gutter", RAIL)}${styledActivity(fitDisplayText(activity, room))}`,
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
		...(entry.result?.mergeDetail ? railLines(entry.result.mergeDetail, "success", width) : []),
		...keptWorktreeLines(entry, width),
		...previewRows(
			[...failureLines(entry, width), ...attemptLines(entry, width)],
			previewBudget(detail.errorRows, terminalRows),
			width,
			false,
			meta(RAIL),
			RAIL_WIDTH,
		),
		...(entry.result?.resultUnavailable ? railLines("result unavailable", "warning", width) : []),
		...(entry.result?.abandonedDetail ? railLines(entry.result.abandonedDetail, "warning", width) : []),
	].map((row) => redactedRow(row, width));
}

/**
 * A failure the run's own record holds reads as a failure on the card; where the verdict came from stays with the
 * detail view. A failed validation also names its validator and evidence, because a headline that says failed above
 * checks that read as passed is otherwise a contradiction the operator cannot resolve without opening the run.
 */
function qualityRow(result: WorkerRunResultSummary | undefined, runId: string, inspect: boolean): string | null {
	// A cancelled run checked nothing by design, so a validation verdict under it says nothing the cancel did not.
	if (!inspect && result?.outcome === "canceled") return null;
	// A run that failed before any check ran has nothing to say about validation that its failure row does not.
	if (!inspect && result?.outcome !== "succeeded" && result?.trust?.validationGrounding.state === "absent") return null;
	// The failure row already says the answer was unusable; naming the report shape it missed is the record's detail.
	if (
		!inspect &&
		result?.outcome !== "succeeded" &&
		/^the answer did not match the /u.test(result?.validationFailure ?? "")
	)
		return `/view dispatch:${runId} shows what it wrote`;
	const trust = result?.trust;
	if (!trust) return "quality validation unknown";
	const entry = trust.validationGrounding;
	const why =
		entry.state === "failed" && result?.validationFailure !== undefined
			? `: ${result.validationFailure} · /view dispatch:${runId}`
			: "";
	if (!inspect && entry.state === "failed" && entry.authority.id === "result-quality")
		return `${trustStateWord("validationGrounding", entry.state)}${why}`;
	// The folded card says whether anything checked the work in plain words; the record's axis wording is for /view.
	if (!inspect && entry.state === "absent") return "no check ran on this work";
	return `quality ${validationClause(trust)}${why}`;
}

export function renderWorkerEntryLines(
	entry: WorkerEntryState,
	width: number,
	options: WorkerEntryRenderOptions,
): string[] {
	entry = {
		...entry,
		telemetry: options.telemetry ?? null,
		routeFirstOutput: options.routeFirstOutput ?? null,
		cacheOwner: entry.cacheOwner ?? entry,
	};
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
	if (
		!inspect &&
		detail.style === "detailed" &&
		(isPending(entry) || entry.helper || options.siblings !== undefined) &&
		!workerNeedsInput(entry)
	) {
		return [
			...council,
			...group,
			alignedHeader(entry, safeWidth, nowMs, options.siblings),
			liveCardDetail(entry, safeWidth),
		].map((row) => redactedRow(row, safeWidth));
	}
	if (!inspect && isPending(entry)) {
		return [
			...council,
			...group,
			alignedHeader(entry, safeWidth, nowMs, options.siblings),
			...(detail.style === "compact" ? [] : [progressLine(entry, safeWidth, nowMs, false)]),
		].map((row) => redactedRow(row, safeWidth));
	}
	const integrity = entry.result?.trust;
	const provenance =
		isPending(entry) || integrity?.artifactIntegrity.state === "verified"
			? []
			: railLines(
					`run: ${integrity ? trustStateWord("artifactIntegrity", integrity.artifactIntegrity.state) : "integrity unavailable"}; raw output, not admitted as evidence`,
					"warning",
					safeWidth,
				);
	const qualityText = isPending(entry) ? null : qualityRow(entry.result, entry.runId, inspect);
	const quality = qualityText === null ? [] : railLines(qualityText, "body", safeWidth);
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
			: (inspect ? answerText(entry, entry.text).split("\n") : bodySourceLines(entry)).flatMap((line) =>
					railLines(redactSecretString(line), needsInput ? "warning" : "assistantProse", safeWidth),
				);
	// A running card says what it is doing on its one live line in every style,
	// and Detailed adds the call it finished last. A settled card in Detailed
	// lists the calls it made, oldest first and in the past tense, because they
	// are finished work, not activity.
	const pending = isPending(entry);
	const recent = entry.progress?.recentActions ?? entry.recentActions ?? [];
	const totalCalls = entry.result?.toolCalls ?? entry.progress?.toolCalls ?? 0;
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
		failureLines(entry, safeWidth, inspect),
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
			? // The run's id is for looking it up, so /view and Detailed state it and the transcript's card does not,
				// even with its bodies expanded: the live transcript always passes its own style, and /view never does.
				[actionLine(entry, safeWidth, options.detail === undefined ? inspect : options.detail.style === "detailed")]
			: [alignedHeader(entry, safeWidth, nowMs, options.siblings)]),
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
		...(inspect ? [] : cancelLines(entry, safeWidth)),
		...(entry.result?.mergeDetail ? railLines(entry.result.mergeDetail, "success", safeWidth) : []),
		...keptWorktreeLines(entry, safeWidth),
		...(presented ? railLines(presented, "body", safeWidth) : []),
		...(entry.result?.abandonedDetail ? railLines(entry.result.abandonedDetail, "warning", safeWidth) : []),
		...(entry.result?.resultUnavailable ? railLines("result unavailable", "warning", safeWidth) : []),
		...(entry.droppedLines
			? railLines(
					`… ${entry.droppedLines} earlier lines unavailable here · /view dispatch:${entry.runId}`,
					"body",
					safeWidth,
				)
			: []),
		...provenance,
		...quality,
	].map((row) => redactedRow(row, safeWidth));
}
