import type { FactMetric, Quantity, RunTelemetryV1 } from "../core/telemetry/dto.js";
import { factRef } from "../core/telemetry/dto.js";
import type { AgentAudience } from "../domains/agents/spec.js";
import type { RunToolBudgetEnvelope } from "../domains/dispatch/budget-envelope.js";
import {
	formatBudgetPolicy,
	formatBudgetReasons,
	formatBudgetRequest,
	formatEffectiveBudget,
} from "../domains/dispatch/budget-envelope.js";
import { workerFailureHeadline } from "../domains/dispatch/failure-headline.js";
import type { DispatchRequestOrigin, RunKind } from "../domains/dispatch/types.js";
import { runKindSupportsLiveSteering } from "../domains/dispatch/types.js";
import { describeWriteBoundaryAttributionDowngrade } from "../domains/dispatch/write-boundary.js";
import type { TrustSummaryProjection, TrustVerdict } from "../domains/evidence/trust-projection.js";
import { plainTrustVerdict, trustStateWord } from "../domains/evidence/trust-projection.js";
import { foregroundStreamUsage } from "../domains/providers/index.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { redactStreamingSecretString } from "../domains/safety/redaction.js";
import type { TelemetryContract, TelemetryRunSummary, TelemetryView } from "../domains/telemetry/contract.js";
import type { TelemetrySnapshot } from "../domains/telemetry/index.js";
import type { WorkerAction, WorkerProgressSnapshot } from "../domains/telemetry/worker-progress.js";
import type { Component } from "../engine/tui.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { COUNCIL_SYNTHESIS_LABEL } from "../session-control/council.js";
import { isHelperRun } from "../session-control/worker-stream.js";
import type { CouncilGroupView, CouncilMemberView } from "./council-grid.js";
import { councilGroupBody, councilIslandLines } from "./council-grid.js";
import { DOCK_BODY_ROWS_MAX } from "./dock.js";
import { createFleetPlanRuns, type FleetPlanRuns, type FleetPlanRunView } from "./fleet-plan-runs.js";
import { centeredWindow, type RowBudgetedBody, windowRows } from "./overlay-frame.js";
import type { QuotaProviders } from "./quota-view.js";
import { routeWeeklyQuota } from "./quota-view.js";
import { liveWorkerAnswerText, presentWorkerContractAnswer } from "./renderers/worker-answer.js";
import type { ClioTheme, ClioToken } from "./theme/index.js";
import {
	animationStep,
	clioTheme,
	dotSep,
	emptyState,
	fitUnits,
	formatCompactMs,
	formatTargetLabel,
	frame,
	functionText,
	GLYPH,
	innerDivider,
	padAnsi,
	positionRow,
	sectionRule,
	spinnerFrame,
	type TableCell,
	type TableColumn,
	tableRows,
	toolFunction,
} from "./theme/index.js";
import { fitIdentityLabel } from "./theme/labels.js";
import { skinEpoch } from "./theme/tokens.js";
import { compactQuantity, WAITING_FOR_APPROVAL, workerActionParts, workerActivityWords } from "./worker-activity.js";

export type DispatchBoardStatus = TelemetryRunSummary["status"];

export interface DispatchRetryPresentation {
	attempt: number;
	dueAtMs: number;
	reason: string;
}

export interface DispatchSteerAcknowledgement {
	receivedAtMs: number;
	chars: number;
}

export interface DispatchWriteRecordDowngrade {
	reason: "opaque_tool_succeeded";
	tool: string;
	toolCallId: string;
}

export interface DispatchBoardRow {
	runId: string;
	agentId: string;
	agentAudience?: AgentAudience;
	requestOrigin?: DispatchRequestOrigin;
	runtimeKind: RunKind;
	runtimeId: string;
	targetId: string;
	wireModelId: string;
	/** Canonical inference scheduler and its independent request-slot bound. */
	endpoint?: { key: string; label: string; limit: number };
	/** Sanitized, one-line summary of the task assigned to this run. */
	taskSummary?: string;
	/** Immutable budget admission provenance for this run. */
	budget?: RunToolBudgetEnvelope;
	status: DispatchBoardStatus;
	elapsedMs: number;
	telemetry?: RunTelemetryV1 | null;
	/** Tokens and cost from the telemetry read model; never the projection's own tally (#434 §11.3). */
	usage: DispatchRunUsage;
	/** The run's first call's TTFT as the read model displays it; null before that call settles (#434). */
	ttft: string | null;
	outcomeDetail?: string | null;
	/** Fleet node id; absent renders as the local node. */
	node?: string;
	/** Review/compete gate badge (role + cycle). */
	gate?: { role: string; cycle: number };
	council?: { group: string; label: string; color?: string; round: number };
	/** Orchestrator-executed declared verification status. */
	hostVerification?: "verified" | "rejected" | "skipped" | "not_implicated";
	/**
	 * The canonical trust projection of the sealed receipt, read back from
	 * disk and authenticated against the ledger row. Absent while the run is
	 * live or when the receipt could not be read back, so the card never
	 * implies a verdict the terminal bus event cannot carry.
	 */
	trust?: TrustSummaryProjection;
	/** Dead-node failover hops recorded on this run's chain. */
	rerouteCount?: number;
	/** Assignment retry attempts observed on the assignment event stream. */
	failoverHops?: number;
	/** Model context window for the per-worker context meter. */
	contextWindow?: number;
	/** Last assistant message's input+cacheRead+cacheWrite+output: current context occupancy; null until reported. */
	lastContextTokens: number | null;
	/** Tool currently executing in the worker; null between calls. Projected from `progress`. */
	currentTool?: string | null;
	/** Recently finished tools, newest first, bounded. Projected from `progress`. */
	recentTools?: ReadonlyArray<string>;
	/**
	 * The canonical worker-progress projection for this run: the bounded answer
	 * tail, the phase, and the redacted action descriptors. The same projection
	 * the transcript's worker block reads, so opening a run here shows what the
	 * worker is doing rather than a richer spinner.
	 */
	progress?: WorkerProgressSnapshot;
	resultContract?: TelemetryRunSummary["resultContract"];
	/**
	 * Id of the run record sealed for this run (the id `clio-coder fleet view`
	 * takes). Set only once a terminal dispatch event has
	 * been published, which the dispatch domain does after recordReceipt, so a
	 * running row carries no receipt id and never implies evidence that does
	 * not exist yet.
	 */
	runRecordId?: string;
	/** Waiting retry projected from the live dispatch snapshot. */
	retry?: DispatchRetryPresentation;
	/** Most recent worker delivery acknowledgement for an operator steer. */
	steerAcknowledgement?: DispatchSteerAcknowledgement;
	/** First successful opaque call that opened this run's write record. */
	writeRecordDowngrade?: DispatchWriteRecordDowngrade;
	/**
	 * Where this run sits in a fleet plan: the wave the step was scheduled in
	 * and the step id it executes. Present only for runs a fleet plan
	 * dispatched, so a `/run`, a delegation, or a dispatch-tool run leaves the
	 * board's phase column empty rather than claiming a position it has none of.
	 */
	phase?: DispatchBoardPhase;
	/** Set on the row standing for a whole fleet plan rather than one worker. */
	plan?: FleetPlanRunView;
}

/**
 * A run's tokens and cost as the bound session's telemetry view reads them (#434 §11.3): `unavailable` without a
 * read model, `pending` until the session's journal references the run.
 */
export type DispatchRunUsage =
	| { kind: "unavailable" }
	| { kind: "pending" }
	| { kind: "ready"; prompt: Quantity; output: Quantity; total: Quantity; usd: Quantity };

/** What every run surface says of a run's usage, so the board, the footer and /usage word it identically. */
export interface DispatchUsageText {
	prompt: string;
	output: string;
	total: string;
	cost: string;
	/** Output tokens when every call reported them; a rate over a partial or estimated count would mislead. */
	measuredOutput: number | null;
}

const UNAVAILABLE_USAGE: DispatchUsageText = {
	prompt: "n/a",
	output: "n/a",
	total: "n/a",
	cost: "not available",
	measuredOutput: null,
};
const PENDING_USAGE: DispatchUsageText = { prompt: "—", output: "—", total: "—", cost: "—", measuredOutput: null };

function measuredCount(fact: Quantity["fact"]): number | null {
	if ("kind" in fact) return fact.kind === "measured" ? fact.value : null;
	return fact.unknownCount === 0 && fact.coverage.estimated === 0 && fact.coverage.measured > 0 ? fact.measured : null;
}

export function dispatchUsageText(usage: DispatchRunUsage): DispatchUsageText {
	if (usage.kind === "unavailable") return UNAVAILABLE_USAGE;
	if (usage.kind === "pending") return PENDING_USAGE;
	return {
		prompt: usage.prompt.display,
		output: usage.output.display,
		total: usage.total.display,
		cost: usage.usd.display,
		measuredOutput: measuredCount(usage.output.fact),
	};
}

/** Output tokens per wall second, or null when the output is not wholly measured or nothing ran yet. */
function wallTokenRate(row: DispatchBoardRow, _usage: DispatchUsageText): string | null {
	const rate = row.telemetry?.activity.outputPerSecond;
	return row.status !== "enqueued" && rate?.fact.kind === "measured" ? rate.display : null;
}

/** One fleet plan position: the wave index and the step the run executes. */
export interface DispatchBoardPhase {
	wave: number;
	stepId: string;
}

/**
 * The phase cell, or null for a run that is not a fleet step. Fixed width so
 * the column lines up across rows; a long step id is clipped with a marker
 * rather than pushing the row's other facts out of position.
 */
function formatDispatchPhaseCell(phase: DispatchBoardPhase | undefined, width = PHASE_COLUMN_WIDTH): string | null {
	if (phase === undefined) return null;
	return truncateToWidth(`w${phase.wave} ${phase.stepId}`, Math.max(1, width), "…", false);
}

/** Columns the compact island reserves for the phase cell when it can afford them. */
const PHASE_COLUMN_WIDTH = 12;
/** Below this much room for the agent label, the compact row drops the column entirely. */
const PHASE_COLUMN_MIN_LABEL_WIDTH = 8;

/** Live HTTP/SDK rows are the only rows whose runtime can consume operator guidance. */
export function isDispatchBoardRowSteerable(row: DispatchBoardRow): boolean {
	return (
		row.plan === undefined &&
		runKindSupportsLiveSteering(row.runtimeKind) &&
		(row.status === "running" || row.status === "stale" || row.status === "enqueued")
	);
}

/** Dispatch abort owns active workers and retry timers, but never terminal history. */
export function isDispatchBoardRowCancellable(row: DispatchBoardRow): boolean {
	if (row.plan !== undefined) return false;
	return row.status === "running" || row.status === "stale" || row.status === "enqueued" || row.status === "retrying";
}

/** Rows of worker prose an expanded card shows before it defers to `/view`. */
const WORKER_PROGRESS_CARD_ROWS = 6;

export const TASK_ISLAND_WIDTH = 44;

const STATUS_ORDER: Record<DispatchBoardStatus, number> = {
	running: 0,
	cancelling: 1,
	stale: 2,
	retrying: 3,
	enqueued: 4,
	dead: 5,
	failed: 6,
	aborted: 7,
	completed: 8,
};

/**
 * The agent's own name, unadorned. Audience is carried by
 * {@link agentAudiencePresentation}, never by a name prefix: `sh:scout` reads
 * as an agent literally called "sh:scout", and an operator cannot tell a
 * prefix apart from user data at a glance.
 */
function agentDisplayLabel(row: Pick<DispatchBoardRow, "agentId" | "agentAudience">): string {
	return row.agentId;
}

export interface AgentAudiencePresentation {
	glyph: string;
	token: ClioToken;
}

/**
 * Visual treatment for a run Clio started for itself: the sub-process glyph in
 * the subordinate orange tone for shadow and internal harness
 * machinery. Returns null for base/custom agents, which the operator asked for
 * directly and which therefore render like any other row.
 */
function agentAudiencePresentation(row: Pick<DispatchBoardRow, "agentAudience">): AgentAudiencePresentation | null {
	if (row.agentAudience === "shadow") return { glyph: GLYPH.subProcess, token: "shadowDispatchAction" };
	if (row.agentAudience === "internal") return { glyph: GLYPH.subProcess, token: "shadowDispatchAction" };
	return null;
}

export interface DispatchOriginPresentation {
	glyph: string;
	token: ClioToken;
}

/**
 * Who asked for this run, as the transcript spells it: hollow for the
 * operator's own `/run` or `/delegate`, filled for one the model started by
 * calling a dispatch tool, a quiet dot for the runs Clio starts for itself and
 * never puts on the transcript. A running `◇` on the board is therefore the
 * operator's own work, on the board and in the footer both.
 *
 * This is a different axis from {@link agentAudiencePresentation}, which says
 * who picked the agent. An operator who approves a plan gets user-origin runs
 * on shadow agents, so a row can carry both marks and mean two true things.
 *
 * Returns null for a row whose origin never reached the projection, so an
 * unknown origin renders as nothing rather than claiming to be internal.
 * Harness runs use the quiet internal dot in the operator's color because Clio acts on their behalf.
 *
 * Operator and harness runs take the guidance color. The transcript block paints an
 * agent-origin run in action orange because it is the one signal on that
 * surface; a board row sits under the fleet summary, which already owns the
 * quadrant's single orange, so here the filled glyph carries origin by shape.
 */
function dispatchOriginPresentation(row: Pick<DispatchBoardRow, "requestOrigin">): DispatchOriginPresentation | null {
	if (row.requestOrigin === "user") return { glyph: GLYPH.workerHuman, token: "guidance" };
	if (row.requestOrigin === "agent") return { glyph: GLYPH.workerAgent, token: "body" };
	if (row.requestOrigin === "internal") return { glyph: GLYPH.workerInternal, token: "annotation" };
	if (row.requestOrigin === "harness") return { glyph: GLYPH.workerInternal, token: "guidance" };
	return null;
}

/**
 * The full glyph lead for a row: origin first, then audience. Reported with its
 * own display width so each caller can reserve columns for it without
 * measuring ANSI.
 */
function dispatchRowPrefix(
	theme: ClioTheme,
	row: Pick<DispatchBoardRow, "agentAudience" | "requestOrigin">,
): { text: string; width: number } {
	const origin = dispatchOriginPresentation(row);
	const audience = agentAudiencePresentation(row);
	const text = `${origin === null ? "" : `${theme.fg(origin.token, origin.glyph)} `}${audience === null ? "" : `${theme.fg(audience.token, audience.glyph)} `}`;
	const width =
		(origin === null ? 0 : visibleWidth(origin.glyph) + 1) + (audience === null ? 0 : visibleWidth(audience.glyph) + 1);
	return { text, width };
}

export interface DispatchStatusPresentation {
	glyph: string;
	label: string;
	/** A live glyph uses the activity accent; its phase word uses the dispatch role. */
	glyphToken?: ClioToken;
	token: ClioToken;
}

/**
 * One presentation per run status, shared by the dispatch cards, the task
 * island, and the footer worker lines so a status never changes glyph or color
 * between surfaces. `compact` shortens labels for narrow rows; a `tick`
 * animates the running glyph.
 */
export function dispatchStatusPresentation(
	status: DispatchBoardStatus,
	options: { compact?: boolean; tick?: number } = {},
): DispatchStatusPresentation {
	const compact = options.compact === true;
	switch (status) {
		case "running":
			// Glyph and phase have distinct roles; identities and telemetry stay separate.
			return {
				glyph: options.tick !== undefined ? spinnerFrame(options.tick) : GLYPH.running,
				label: "running",
				glyphToken: "activity",
				token: "dispatchAction",
			};
		case "cancelling":
			return { glyph: GLYPH.cancelled, label: "cancelling", token: "warning" };
		case "retrying":
			return { glyph: GLYPH.phaseRetry, label: "retrying", token: "warning" };
		case "completed":
			return { glyph: GLYPH.ok, label: compact ? "done" : "completed", token: "success" };
		case "failed":
			return { glyph: GLYPH.error, label: compact ? "fail" : "failed", token: "error" };
		case "dead":
			return { glyph: GLYPH.error, label: "dead", token: "error" };
		case "aborted":
			return { glyph: GLYPH.cancelled, label: "cancelled", token: "annotation" };
		case "stale":
			return { glyph: GLYPH.warnInline, label: "stale", token: "warning" };
		case "enqueued":
			return { glyph: GLYPH.queued, label: "queued", token: "body" };
	}
}

/** Evidence-readiness state for a dispatch run, derived from the telemetry projection. */
export type EvidenceState = "ready" | "none";

/**
 * Compact, presentation-ready evidence readiness for one run. Derived purely
 * from a TelemetrySnapshot: no run scope is read and no /view artifact bodies
 * are inspected. `viewFilter` is the `/view` deep-link an operator would type
 * to inspect the run or its assessment.
 */
export interface RunEvidencePresentation {
	state: EvidenceState;
	/** The `/view` filter text: evidence:<runId> once assessed, dispatch:<runId> before. */
	viewFilter: string;
}

/**
 * Fold a TelemetrySnapshot into the evidence readiness for one run: a run whose assessment the projection saw is
 * ready (#434). Cheap and pure; it reads no run scope.
 */
function deriveRunEvidenceState(snapshot: TelemetrySnapshot | undefined, runId: string): RunEvidencePresentation {
	if (!snapshot || runId.length === 0) return { state: "none", viewFilter: `dispatch:${runId}` };
	if (snapshot.runs.find((run) => run.runId === runId)?.evidence)
		return { state: "ready", viewFilter: `evidence:${runId}` };
	return { state: "none", viewFilter: `dispatch:${runId}` };
}

interface EvidenceGlyphPresentation {
	glyph: string;
	word: string;
	token: ClioToken;
}

// Proof state shares the section 5 glyph language with run status: the ok check for an assessed run. `none` renders
// no marker.
function evidenceStatePresentation(state: EvidenceState): EvidenceGlyphPresentation | null {
	return state === "ready" ? { glyph: GLYPH.ok, word: "ready", token: "success" } : null;
}

// Dispatch card rows follow the footer dashboard key-value grammar: a dim key
// padded to a shared column, then one trailing space before the value. The
// widest key ("telemetry") sets the column so every value starts aligned.
const CARD_KV_KEY_WIDTH = "telemetry".length;

function cardKvKey(theme: ClioTheme, key: string): string {
	return theme.fg("fieldName", `${key.padEnd(CARD_KV_KEY_WIDTH)} `);
}

// A card key-value row built from whole units. A row that fits keeps its dim
// middot join; an overflowing one is refit unit-by-unit so it closes on a
// whole unit or a dim ellipsis instead of a mid-token clip that reads as a
// complete fact ("total 5" for 5.2k) or a dangling ` · `.
function cardUnitsLine(theme: ClioTheme, key: string, units: ReadonlyArray<string>, contentWidth: number): string {
	const prefix = cardKvKey(theme, key);
	const full = `${prefix}${units.join(dotSep(theme))}`;
	return visibleWidth(full) <= contentWidth ? full : fitUnits(theme, prefix, units, contentWidth);
}

/** A prose card value, wrapped inside the columns left by its one-time key. */
function cardWrappedValueLines(theme: ClioTheme, key: string, value: string, contentWidth: number): string[] {
	const prefix = cardKvKey(theme, key);
	const prefixWidth = visibleWidth(prefix);
	const valueWidth = Math.max(1, contentWidth - prefixWidth);
	return wrapTextWithAnsi(value, valueWidth).map(
		(line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`,
	);
}

// The `proof` row: the colored state marker, then the dim `/view` filter an operator would type.
function evidenceCardLine(theme: ClioTheme, evidence: RunEvidencePresentation, contentWidth: number): string | null {
	const presentation = evidenceStatePresentation(evidence.state);
	if (!presentation) return null;
	const units = [theme.fg(presentation.token, `${presentation.glyph} ${presentation.word}`)];
	units.push(theme.fg("annotation", evidence.viewFilter));
	return cardUnitsLine(theme, "proof", units, contentWidth);
}

function retryCountdown(retry: DispatchRetryPresentation, now = Date.now()): string {
	const remainingMs = Math.max(0, retry.dueAtMs - now);
	return remainingMs === 0 ? "now" : `in ${formatCompactMs(remainingMs)}`;
}

/**
 * One action in plain words: the verb and object of its redacted descriptor,
 * then the tool when the verb has not named it, as in `ran npm run lint (bash)`.
 * The descriptor was bounded and scrubbed at the worker seam, so this composes
 * text and never inspects an argument.
 */
function actionPhrase(action: WorkerAction, tense: "running" | "finished"): string {
	const theme = clioTheme();
	const parts = workerActionParts(action, tense);
	const verb = functionText(theme, toolFunction(action.tool), sanitizeCallTargetText(parts.verb));
	const object = parts.object.length === 0 ? "" : theme.fg("toolTarget", ` ${sanitizeCallTargetText(parts.object)}`);
	const tool = parts.tool === null ? "" : theme.fg("toolCapability", ` (${sanitizeCallTargetText(parts.tool)})`);
	const failure =
		action.outcome === "error"
			? theme.fg("error", ` ${GLYPH.error} failed`)
			: action.outcome === "blocked"
				? theme.fg("warning", ` ${GLYPH.error} blocked`)
				: "";
	return `${verb}${object}${tool}${failure}`;
}

/** The phase word an expanded card names, or null for a phase that says nothing new. */
function progressPhaseUnit(theme: ClioTheme, progress: WorkerProgressSnapshot): string | null {
	switch (progress.phase) {
		case "thinking":
			// The phase only. Reasoning content never reaches an operator surface.
			return theme.fg("dispatchAction", `${GLYPH.phaseThinking} thinking`);
		case "writing":
			return theme.fg("dispatchAction", `${GLYPH.phaseWriting} writing`);
		case "tool":
			return theme.fg("dispatchAction", `${GLYPH.phaseTool} tool`);
		case "waiting":
			return theme.fg("dispatchAction", `${GLYPH.phaseWaiting} waiting`);
		case "settled":
		case "starting":
			return null;
	}
}

/** The `doing` row: the phase, then the running call or the most recent one, with its object. */
function progressActionLine(theme: ClioTheme, progress: WorkerProgressSnapshot, contentWidth: number): string | null {
	const phase = progressPhaseUnit(theme, progress);
	const current = progress.currentAction;
	const recent = progress.recentActions[0];
	const units: string[] = [];
	if (phase !== null && current === null) units.push(phase);
	if (progress.awaitingApproval === true && current !== null) {
		const wanted = workerActionParts(current, "running");
		units.push(
			theme.fg("warning", WAITING_FOR_APPROVAL),
			theme.fg("toolTarget", `${wanted.verb} ${wanted.object}`.trim()),
		);
	} else if (current !== null)
		units.push(theme.base("body", `${theme.fg("toolMetadata", "now:")} ${actionPhrase(current, "running")}`));
	else if (recent !== undefined)
		units.push(theme.base("body", `${theme.fg("toolMetadata", "last:")} ${actionPhrase(recent, "finished")}`));
	if (units.length === 0) return null;
	return cardUnitsLine(theme, "doing", units, contentWidth);
}

/** Live dashboard detail shares the board's redacted actions and contract-aware answer rendering. */
export function renderDispatchActivity(row: DispatchBoardRow, width: number): string[] {
	const theme = clioTheme();
	const progress = row.progress;
	if (!progress) return [];
	const lines: string[] = [];
	const phase = {
		starting: "Starting worker",
		thinking: "Thinking",
		writing: "Streaming response",
		tool: "Executing tool",
		waiting: "Between tool calls · awaiting next worker event",
		settled: "Worker output finished",
	}[progress.phase];
	lines.push(...wrapTextWithAnsi(`${theme.fg("harnessHeading", "Now")}  ${phase}`, width));
	if (progress.currentAction)
		lines.push(...wrapTextWithAnsi(`  → ${actionPhrase(progress.currentAction, "running")}`, width));
	for (const action of progress.recentActions.slice(0, 3))
		lines.push(...wrapTextWithAnsi(`${theme.fg("annotation", "Recent")}  ${actionPhrase(action, "finished")}`, width));
	if (progress.tailText.trim()) {
		lines.push(theme.fg("annotation", progress.settled ? "Worker output" : "Live response · provisional"));
		lines.push(...progressAnswerLines(theme, progress, row.runId, width, row.resultContract, 3));
	}
	return lines;
}

/**
 * The `answer` block: the newest rows of the worker's bounded prose on a rail,
 * then what is not shown and where to read it. Wrapping happens before the row
 * cap, so the block is at most {@link WORKER_PROGRESS_CARD_ROWS} rows tall
 * whatever the terminal width, and a streaming answer cannot make the card grow
 * under the operator.
 */
function progressAnswerLines(
	theme: ClioTheme,
	progress: WorkerProgressSnapshot,
	runId: string,
	contentWidth: number,
	contract: TelemetryRunSummary["resultContract"],
	maxRows = WORKER_PROGRESS_CARD_ROWS,
): string[] {
	if (progress.tailText.length === 0) return [];
	const gutter = CARD_KV_KEY_WIDTH + 1;
	const railWidth = Math.max(1, contentWidth - gutter - 2);
	const presented = presentWorkerContractAnswer(
		progress.tailText,
		contract,
		progress.droppedLines === 0 && progress.droppedBytes === 0,
		progress.settled,
	);
	const source = presented
		? [...(presented.footer ? [presented.footer] : []), ...presented.lines]
		: liveWorkerAnswerText(progress.tailText, progress.completed === true).split("\n");
	const wrapped: string[] = [];
	for (const line of source) {
		for (const row of wrapTextWithAnsi(sanitizeCallTargetText(line), railWidth)) wrapped.push(row);
	}
	const shown = progress.settled ? wrapped.slice(0, maxRows) : wrapped.slice(Math.max(0, wrapped.length - maxRows));
	const hiddenRows = wrapped.length - shown.length;
	const rail = theme.fg("gutter", `${GLYPH.rail} `);
	const body = shown.map((row) => `${rail}${theme.fg("assistantProse", row)}`);
	const hiddenLines = progress.droppedLines + hiddenRows;
	if (hiddenLines > 0 || progress.droppedBytes > 0) {
		const facts = [
			`/view dispatch:${runId}`,
			...(hiddenLines > 0 ? [`${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}`] : []),
			...(progress.droppedBytes > 0 ? [`${progress.droppedBytes} bytes outran the view`] : []),
		];
		body.push(`${rail}${theme.fg("annotation", truncateToWidth(facts.join(" · "), railWidth, "…", false))}`);
	}
	// The key labels the block once and the rest hangs under it, which is the
	// card's key-value grammar applied to a body rather than to one value.
	return body.map((row, index) => `${index === 0 ? cardKvKey(theme, "answer") : " ".repeat(gutter)}${row}`);
}

/** Compact ordinary unvalidated completions; preserve all exceptional facts and expanded provenance. */
function trustCardLines(theme: ClioTheme, row: DispatchBoardRow, contentWidth: number, expanded: boolean): string[] {
	const gutter = CARD_KV_KEY_WIDTH + 1;
	const valueWidth = Math.max(1, contentWidth - gutter);
	const axes = row.trust?.axes;
	// Only the ordinary sealed, mediated completion without validation/review
	// folds. Unknown, failed, inferred or exceptional provenance stays explicit.
	const compact =
		!expanded &&
		isTerminalStatus(row.status) &&
		row.trust?.verdict === "unverified" &&
		axes?.artifactIntegrity === "verified" &&
		axes.validationGrounding === "absent" &&
		axes.independentReview === "absent" &&
		axes.contextProvenance === "recorded" &&
		axes.completionEvidence === "absent";
	const host = row.hostVerification === undefined ? "" : ` · ${theme.fg("body", `host checks ${row.hostVerification}`)}`;
	if (row.trust === undefined) {
		const unread = theme.fg("annotation", isTerminalStatus(row.status) ? "run record not read back" : "not sealed yet");
		return cardWrappedValueLines(theme, "trust", `${unread}${host}`, contentWidth);
	}
	// The verdict leads in plain words; the axes that back it follow as detail.
	const verdict = theme.fg(
		trustVerdictToken(row.trust.verdict),
		`${trustVerdictMark(row.trust.verdict)}${plainTrustVerdict(row.trust)}`,
	);
	const detail = compact
		? []
		: wrapTextWithAnsi(theme.fg("annotation", row.trust.text), valueWidth).map((line) => `${" ".repeat(gutter)}${line}`);
	return [...cardWrappedValueLines(theme, "trust", `${verdict}${host}`, contentWidth), ...detail];
}

/** `2/2 steps`, then the first step that failed. Unsettled steps are not counted as anything yet. */
export function planProgressText(plan: FleetPlanRunView): string {
	const done = plan.steps.filter((step) => step.state === "passed" || step.state === "replayed").length;
	const failed = plan.steps.find((step) => step.state === "failed");
	const count = `${plan.state === "running" ? done : plan.succeededStepCount}/${plan.requiredStepCount} steps`;
	if (plan.failure !== undefined) return `${count} · ${plan.failure}`;
	return failed === undefined ? count : `${count} · ${failed.stepId} failed`;
}

const PLAN_STEP_MARKS: Record<
	FleetPlanRunView["steps"][number]["state"],
	{ glyph: string; token: ClioToken; word: string }
> = {
	pending: { glyph: GLYPH.queued, token: "annotation", word: "not run" },
	running: { glyph: GLYPH.running, token: "activity", word: "running" },
	passed: { glyph: GLYPH.ok, token: "success", word: "passed" },
	failed: { glyph: GLYPH.error, token: "error", word: "failed" },
	replayed: { glyph: GLYPH.ok, token: "annotation", word: "kept from the earlier run" },
};

/** One row per step: state first, because the step's name and command are what a narrow row can lose. */
export function planStepLines(theme: ClioTheme, plan: FleetPlanRunView, width: number): string[] {
	const nameWidth = Math.max(...plan.steps.map((step) => visibleWidth(step.stepId)));
	return plan.steps.map((step) => {
		const mark = PLAN_STEP_MARKS[step.state];
		// A step still pending at the end was never reached; while the plan runs it is only waiting.
		const word = step.state === "pending" && plan.state === "running" ? "waiting" : mark.word;
		const facts = [word, ...(step.detail !== undefined ? [step.detail] : []), step.label];
		const lead = `${theme.fg(mark.token, mark.glyph)} ${theme.fg("body", step.stepId.padEnd(nameWidth))}  `;
		return truncateToWidth(
			`${lead}${theme.fg(mark.token, facts[0] ?? "")}${theme.fg("annotation", facts.length > 1 ? ` · ${facts.slice(1).join(" · ")}` : "")}`,
			width,
			GLYPH.ellipsis,
			false,
		);
	});
}

function planCardBody(theme: ClioTheme, row: DispatchBoardRow, plan: FleetPlanRunView, contentWidth: number): string[] {
	const presentation = dispatchStatusPresentation(row.status);
	const units = [
		`${theme.fg(presentation.glyphToken ?? presentation.token, presentation.glyph)} ${theme.fg(presentation.token, presentation.label)}`,
		theme.fg("body", planProgressText(plan)),
		...(plan.finishedAtMs === null
			? []
			: [`${theme.fg("annotation", "cost")} ${theme.fg("body", plan.costText ?? "no model calls")}`]),
	];
	const gutter = " ".repeat(CARD_KV_KEY_WIDTH + 1);
	const steps = planStepLines(theme, plan, Math.max(1, contentWidth - gutter.length));
	return [
		cardUnitsLine(theme, "status", units, contentWidth),
		...steps.map((line, index) => `${index === 0 ? cardKvKey(theme, "steps") : gutter}${line}`),
		...cardWrappedValueLines(
			theme,
			"inspect",
			theme.fg("annotation", `clio-coder fleet events ${plan.rootId}`),
			contentWidth,
		),
	];
}

/** The transcript's settled record of a plan, in the worker card's gutter grammar. */
export function renderFleetPlanCard(plan: FleetPlanRunView, width: number): string[] {
	const theme = clioTheme();
	const passed = plan.state === "passed";
	const rail = theme.fg("gutter", "  │ ");
	const head = `${functionText(theme, "dispatch", GLYPH.workerHuman)} ${theme.fg("workerIdentity", `plan ${plan.name}`)}${dotSep(theme)}${theme.fg(passed ? "success" : "error", `${passed ? GLYPH.ok : GLYPH.error} ${planProgressText(plan)}`)}`;
	const room = Math.max(1, width - 4);
	return [
		truncateToWidth(head, width, GLYPH.ellipsis, false),
		...planStepLines(theme, plan, room).map((line) => `${rail}${line}`),
		`${rail}${theme.fg("annotation", truncateToWidth(`/fleet for detail · cost ${plan.costText ?? "none, no model calls"}`, room, GLYPH.ellipsis, false))}`,
	];
}

/**
 * The selected run's facts under the board's table, most useful first: what it
 * is doing, then the task, the route, its telemetry and its provenance. The
 * board cuts this at its row budget, so the order is the priority. The run id
 * and elapsed time sit in the rule above, not in the body.
 */
function dispatchCardBody(
	row: DispatchBoardRow,
	contentWidth: number,
	evidence?: RunEvidencePresentation,
	options: {
		expanded?: boolean;
		endpointActive?: number;
		endpointQueued?: number;
		theme?: ClioTheme;
	} = {},
): string[] {
	const theme = options.theme ?? clioTheme();
	if (row.plan !== undefined) return planCardBody(theme, row, row.plan, contentWidth);
	const usage = dispatchUsageText(row.usage);
	const cost = usage.cost;
	const rawDetail = terminalDetail(row);
	// Enter opens the receipt's own words; the folded card leads with the reason.
	const detail = options.expanded === true ? rawDetail : workerFailureHeadline(rawDetail);

	const presentation = dispatchStatusPresentation(row.status, {
		...(row.status === "running" ? { tick: animationStep(Date.now()) } : {}),
	});
	// The function phase is orange, while identity, cost and TTFT keep their own roles.
	const statusStr = `${theme.fg(presentation.glyphToken ?? presentation.token, presentation.glyph)} ${theme.fg(presentation.token, presentation.label)}`;

	const ttft = row.ttft ?? (row.status === "running" ? `waiting${GLYPH.ellipsis}` : "n/a");

	// A queued run has produced nothing yet, so it never carries a throughput.
	const rate = wallTokenRate(row, usage);
	// The fold leads with the figures; Enter adds the coverage clause each one was hedged with.
	const figure = (display: string): string => (options.expanded === true ? display : (compactQuantity(display) ?? "?"));
	const up = theme.fg("body", `${GLYPH.up} ${figure(usage.prompt)}`);
	const down = theme.fg(
		"body",
		`${GLYPH.down} ${figure(usage.output)}${rate !== null ? (options.expanded === true ? ` (${rate}/s wall avg)` : ` ${rate}/s`) : ""}`,
	);
	const total = theme.fg("body", `total ${figure(usage.total)}`);

	// The model id is user data and can outrun the card; mark the cut with `…`
	// rather than hard-clipping it mid-token into a string that reads whole.
	const targetKey = cardKvKey(theme, "target");
	const route = `${sanitizeCallTargetText(String(row.runtimeKind))}${dotSep(theme)}${formatTargetLabel(row.targetId, row.wireModelId, { abbreviate: false })}`;
	const targetLine = `${targetKey}${theme.fg("footerIdentity", fitIdentityLabel(route, Math.max(1, contentWidth - visibleWidth(targetKey))))}`;
	// Fleet facts: node placement (absent means local), gate role badge, and
	// reroute lineage. Whole units so overflow drops a fact, never clips one.
	const statusUnits = [
		statusStr,
		theme.fg("body", `node ${row.node ?? "local"}`),
		...(row.endpoint !== undefined
			? [
					theme.fg(
						"info",
						`slots ${options.endpointActive ?? 0}/${row.endpoint.limit}${(options.endpointQueued ?? 0) > 0 ? ` +${options.endpointQueued} queued` : ""} ${row.endpoint.label}`,
					),
				]
			: []),
		...(row.gate !== undefined ? [theme.fg("info", `gate ${row.gate.role} c${row.gate.cycle}`)] : []),
		...(row.rerouteCount !== undefined && row.rerouteCount > 0
			? [theme.fg("warning", `rerouted x${row.rerouteCount}`)]
			: []),
		...(row.failoverHops !== undefined && row.failoverHops > 0
			? [theme.fg("warning", `failed over x${row.failoverHops}`)]
			: []),
		`${theme.fg("annotation", "ttft")} ${theme.fg("body", ttft)}`,
		`${theme.fg("annotation", "cost")} ${theme.fg("body", cost)}`,
	];
	const context = row.telemetry?.activity.contextTokens;
	const contextFigure = context
		? options.expanded === true
			? context.display
			: compactQuantity(context.display)
		: null;
	const contextUnit = contextFigure ? theme.fg("body", `ctx ${contextFigure}`) : null;
	// The phase column: a fleet step says which wave it belongs to and which
	// step it is; every other run leaves the cell empty rather than inventing a
	// position, so the column reads as "not a fleet step" and not as wave zero.
	const phaseCell = formatDispatchPhaseCell(row.phase, contentWidth);
	const fullTask = row.taskSummary
		? cardWrappedValueLines(theme, "task", theme.fg("body", row.taskSummary), contentWidth)
		: [];
	const taskLines =
		options.expanded === true || fullTask.length <= 3
			? fullTask
			: [...fullTask.slice(0, 2), theme.fg("annotation", "… Enter detail for full task")];
	const bodyLines = [cardUnitsLine(theme, "status", statusUnits, contentWidth)];
	// One current-operation row is useful at a glance; prose and policy expand on demand.
	if (row.progress) {
		const doing = progressActionLine(theme, row.progress, contentWidth);
		if (doing !== null) bodyLines.push(doing);
		if (options.expanded === true)
			bodyLines.push(...progressAnswerLines(theme, row.progress, row.runId, contentWidth, row.resultContract));
	}
	// Live tool activity: the executing tool (worker telemetry carries names,
	// never arguments, across the stdout seam) and the recent-tool trail.
	const currentTool = row.currentTool ?? null;
	const recentTools = row.recentTools ?? [];
	if (!row.progress && (currentTool !== null || recentTools.length > 0)) {
		const toolUnits = [
			currentTool !== null ? theme.fg("body", `${currentTool} running`) : theme.fg("annotation", "idle"),
			...(recentTools.length > 0 ? [theme.fg("body", `recent ${recentTools.join(" ")}`)] : []),
		];
		bodyLines.push(cardUnitsLine(theme, "tools", toolUnits, contentWidth));
	}
	if (row.status === "enqueued" && row.endpoint !== undefined) {
		const active = options.endpointActive ?? 0;
		bodyLines.push(
			...cardWrappedValueLines(
				theme,
				"waiting",
				theme.fg(
					"body",
					`for a slot on ${sanitizeCallTargetText(row.endpoint.label)}: ${active} of ${row.endpoint.limit} in use, starts when one settles`,
				),
				contentWidth,
			),
		);
	}
	if (row.retry) {
		bodyLines.push(
			cardUnitsLine(
				theme,
				"retry",
				[
					theme.fg("warning", `attempt ${row.retry.attempt}`),
					theme.fg("body", retryCountdown(row.retry)),
					...(row.retry.reason.length > 0 ? [theme.fg("body", row.retry.reason)] : []),
				],
				contentWidth,
			),
		);
	}
	if (detail !== null)
		bodyLines.push(...cardWrappedValueLines(theme, "detail", theme.fg("annotation", detail), contentWidth));
	bodyLines.push(
		...taskLines,
		...(phaseCell === null ? [] : [cardUnitsLine(theme, "phase", [theme.fg("info", phaseCell)], contentWidth)]),
		...(options.expanded === true
			? cardWrappedValueLines(theme, "target", theme.fg("body", route), contentWidth)
			: [targetLine]),
		cardUnitsLine(theme, "telemetry", [up, down, total, ...(contextUnit !== null ? [contextUnit] : [])], contentWidth),
		...trustCardLines(theme, row, contentWidth, options.expanded === true),
	);
	if (row.steerAcknowledgement) {
		bodyLines.push(
			cardUnitsLine(
				theme,
				"control",
				[theme.fg("success", `${GLYPH.ok} steer received`), theme.fg("body", `${row.steerAcknowledgement.chars} chars`)],
				contentWidth,
			),
		);
	}
	if (row.writeRecordDowngrade) {
		const warning = describeWriteBoundaryAttributionDowngrade({
			...row.writeRecordDowngrade,
			runId: row.runId,
			stepId: row.phase?.stepId ?? null,
		});
		// The call id and rule are for the inspector; the fold says only that the changed-files list may be short.
		const brief = `changed-files list may be incomplete: ${sanitizeCallTargetText(row.writeRecordDowngrade.tool)} can write paths it does not name`;
		bodyLines.push(
			...cardWrappedValueLines(
				theme,
				"record",
				theme.fg("warning", options.expanded === true ? `open: ${warning}` : brief),
				contentWidth,
			),
		);
	}
	// The proof row is present only when the telemetry projection knows an
	// evidence state for this run; an unknown/none state adds no line.
	if (evidence) {
		const proofLine = evidenceCardLine(theme, evidence, contentWidth);
		if (proofLine !== null) bodyLines.push(proofLine);
	}
	if (options.expanded === true && row.budget !== undefined) {
		bodyLines.push(
			...cardWrappedValueLines(
				theme,
				"policy",
				theme.fg("body", `${formatBudgetPolicy(row.budget)}; requested ${formatBudgetRequest(row.budget)}`),
				contentWidth,
			),
			...cardWrappedValueLines(
				theme,
				"budget",
				theme.fg("body", `${formatEffectiveBudget(row.budget)}; reason ${formatBudgetReasons(row.budget)}`),
				contentWidth,
			),
		);
	}
	return bodyLines;
}

/** The route as `target/model`, the shape the inline card's header already uses. */
function formatRowRoute(row: Pick<DispatchBoardRow, "targetId" | "wireModelId">): string {
	return sanitizeCallTargetText(`${row.targetId}/${row.wireModelId}`);
}

function renderTaskIslandRow(row: DispatchBoardRow, width: number, quota: QuotaProviders): string[] {
	const theme = clioTheme();
	const weekly = routeWeeklyQuota(row, quota);
	const agentLabel = agentDisplayLabel(row);
	const elapsed = row.telemetry?.activity.elapsed.display ?? "not available";
	const usage = dispatchUsageText(row.usage);
	const cost = usage.cost;

	const dot = dotSep(theme);
	const presentation = dispatchStatusPresentation(row.status, {
		compact: true,
		...(row.status === "running" ? { tick: animationStep(Date.now()) } : {}),
	});
	const glyph = theme.fg(presentation.glyphToken ?? presentation.token, presentation.glyph);
	// A running row says what the run is doing in the inline card's words: the
	// island said `running` beside a card that said `starting` (BT-007).
	const statusLabel =
		row.status === "running" && row.progress !== undefined
			? sanitizeCallTargetText(workerActivityWords(row.progress))
			: presentation.label;
	const statusStr = theme.fg(
		row.status === "running" && (row.agentAudience === "shadow" || row.agentAudience === "internal")
			? "shadowDispatchAction"
			: presentation.token,
		statusLabel,
	);

	// Reserve the glyph, separators, status word, and elapsed so a long agent
	// label is clipped with a `…` marker rather than shoved off the row unmarked.
	const rowPrefix = dispatchRowPrefix(theme, row);
	const labelChrome =
		visibleWidth(presentation.glyph) + 1 + rowPrefix.width + 3 + visibleWidth(statusLabel) + 3 + visibleWidth(elapsed);
	// The phase column rides the compact row only when the row can still show a
	// readable agent label beside it. TASK_ISLAND_WIDTH is fixed, so a row that
	// cannot afford the cell drops the column here and shows the phase in the
	// expanded card instead of clipping the label to make room.
	const phaseCell = formatDispatchPhaseCell(row.phase);
	const phaseColumn = phaseCell === null ? "" : `${dot}${theme.fg("info", padAnsi(phaseCell, PHASE_COLUMN_WIDTH))}`;
	const phaseChrome = phaseCell === null ? 0 : PHASE_COLUMN_WIDTH + 3;
	const labelWidth = width - labelChrome - phaseChrome;
	const showPhase = phaseCell !== null && labelWidth >= PHASE_COLUMN_MIN_LABEL_WIDTH;
	const clampedLabel = truncateToWidth(
		agentLabel,
		Math.max(1, showPhase ? labelWidth : width - labelChrome),
		"…",
		false,
	);

	// Worker identity, function phase, outcome and telemetry each keep their role.
	const line1 = `${glyph} ${rowPrefix.text}${theme.fg("workerIdentity", clampedLabel)}${dot}${statusStr}${dot}${theme.fg("toolMetadata", elapsed)}${showPhase ? phaseColumn : ""}`;

	// A queued run has produced nothing yet, so it never carries a throughput.
	const rate = wallTokenRate(row, usage);
	const up = theme.fg("body", `${GLYPH.up} ${compactQuantity(usage.prompt) ?? "?"}`);
	const down = theme.fg(
		"body",
		`${GLYPH.down} ${compactQuantity(usage.output) ?? "?"}${rate !== null ? ` (${rate}/s)` : ""}`,
	);
	const telemetry = row.retry
		? `  ${theme.fg("warning", `attempt ${row.retry.attempt}`)}${dot}${theme.fg("body", retryCountdown(row.retry))}`
		: `  ${up}${dot}${down}${dot}${theme.fg("body", `cost ${cost}`)}`;
	const task = row.taskSummary
		? wrapTextWithAnsi(row.taskSummary, Math.max(1, width - 2))
				.slice(0, 3)
				.map((line) => `  ${theme.fg("body", line)}`)
		: [];

	const quality = isTerminalStatus(row.status)
		? wrapTextWithAnsi(
				`  quality ${trustStateWord("validationGrounding", row.trust?.axes.validationGrounding ?? "unknown")}`,
				width,
			)
		: [];
	return [
		padAnsi(line1, width),
		padAnsi(theme.fg("annotation", truncateToWidth(`  ${formatRowRoute(row)}`, width, GLYPH.ellipsis, false)), width),
		...quality.map((line) => padAnsi(theme.fg("body", line), width)),
		...task.map((line) => padAnsi(line, width)),
		padAnsi(telemetry, width),
		...(weekly
			? [
					padAnsi(
						theme.fg(
							weekly.severity === "critical" ? "error" : weekly.severity === "normal" ? "annotation" : "warning",
							`  Shared account · ${weekly.label}`,
						),
						width,
					),
				]
			: []),
		...wrapTextWithAnsi(theme.fg("annotation", `  /view dispatch:${row.runId}`), width),
	];
}

/**
 * One member column's facts, drawn from the row the board already keeps. The
 * route, status, and answer tail are the same values the run's own card shows,
 * so a council column and a council card can never disagree.
 */
function councilMemberView(
	row: DispatchBoardRow,
	council: NonNullable<DispatchBoardRow["council"]>,
): CouncilMemberView {
	const presentation = dispatchStatusPresentation(row.status, {
		compact: true,
		...(row.status === "running" ? { tick: animationStep(Date.now()) } : {}),
	});
	return {
		runId: row.runId,
		label: council.label,
		...(council.color !== undefined ? { color: council.color } : {}),
		round: council.round,
		route: `${row.targetId}/${row.wireModelId}`,
		status: { ...presentation },
		tailText: sanitizeCallTargetText(
			redactStreamingSecretString(row.progress?.tailText ?? "", row.progress?.completed === true),
		),
		droppedLines: row.progress?.droppedLines ?? 0,
	};
}

/**
 * Fold one council group's rows into the view the grid renders.
 *
 * A council of N members over R rounds seals N x R member runs, and the
 * operator is looking at a council, not at its history: each label keeps its
 * newest round, so the group shows one column per member however many rounds
 * it ran. Columns are ordered by label so a repaint cannot reshuffle them under
 * the cursor while runs settle in whatever order they finish.
 */
function foldCouncilGroup(
	group: string,
	rows: ReadonlyArray<DispatchBoardRow>,
	selectedRunId?: string | null,
): CouncilGroupView {
	const newest = new Map<string, DispatchBoardRow>();
	let synthesisRow: DispatchBoardRow | null = null;
	let rank = Number.POSITIVE_INFINITY;
	let elapsedMs = 0;
	let round = 1;
	for (const row of rows) {
		const council = row.council;
		if (council === undefined) continue;
		rank = Math.min(rank, STATUS_ORDER[row.status]);
		elapsedMs = Math.max(elapsedMs, row.elapsedMs);
		if (council.label === COUNCIL_SYNTHESIS_LABEL) {
			synthesisRow = row;
			continue;
		}
		round = Math.max(round, council.round);
		const previous = newest.get(council.label);
		if (previous === undefined || (previous.council?.round ?? 0) <= council.round) newest.set(council.label, row);
	}
	const aggregate = (Object.entries(STATUS_ORDER) as Array<[DispatchBoardStatus, number]>).find(
		([, value]) => value === rank,
	);
	const presentation = dispatchStatusPresentation(aggregate?.[0] ?? "running", {
		compact: true,
		...(aggregate?.[0] === "running" ? { tick: animationStep(Date.now()) } : {}),
	});
	const members = [...newest.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		// biome-ignore lint/style/noNonNullAssertion: every entry was inserted with its own council badge.
		.map(([, row]) => councilMemberView(row, row.council!));
	const selectedInGroup =
		selectedRunId != null && rows.some((row) => row.runId === selectedRunId) ? selectedRunId : undefined;
	return {
		group,
		members,
		// biome-ignore lint/style/noNonNullAssertion: the synthesis row was matched on its own council badge.
		synthesis: synthesisRow === null ? null : councilMemberView(synthesisRow, synthesisRow.council!),
		status: { ...presentation },
		round,
		elapsed: formatCompactMs(elapsedMs),
		...(selectedInGroup !== undefined ? { selectedRunId: selectedInGroup } : {}),
	};
}

/** A board entry: either one ordinary run, or one whole council in the position of its first row. */
export type DispatchBoardItem = { kind: "run"; row: DispatchBoardRow } | { kind: "council"; group: CouncilGroupView };

/**
 * Board order with councils folded in place. A council occupies the position of
 * its first row and its remaining rows are consumed, so the board never shows a
 * member both inside its group and beside it.
 */
export function dispatchBoardItems(
	rows: ReadonlyArray<DispatchBoardRow>,
	selectedRunId?: string | null,
): DispatchBoardItem[] {
	const byGroup = new Map<string, DispatchBoardRow[]>();
	for (const row of rows) {
		const group = row.council?.group;
		if (group === undefined) continue;
		const bucket = byGroup.get(group);
		if (bucket === undefined) byGroup.set(group, [row]);
		else bucket.push(row);
	}
	const emitted = new Set<string>();
	const items: DispatchBoardItem[] = [];
	for (const row of rows) {
		const group = row.council?.group;
		if (group === undefined) {
			items.push({ kind: "run", row });
			continue;
		}
		if (emitted.has(group)) continue;
		emitted.add(group);
		items.push({ kind: "council", group: foldCouncilGroup(group, byGroup.get(group) ?? [row], selectedRunId) });
	}
	return items;
}

/** Use the same folded, sorted council projection for focus as for visible cards. */
function selectableBoardRows(rows: ReadonlyArray<DispatchBoardRow>): DispatchBoardRow[] {
	const byRunId = new Map(rows.map((row) => [row.runId, row]));
	return dispatchBoardItems(rows).flatMap((item) => {
		if (item.kind === "run") return [item.row];
		const members = item.group.synthesis === null ? item.group.members : [...item.group.members, item.group.synthesis];
		return members.flatMap((member) => {
			const row = byRunId.get(member.runId);
			return row ? [row] : [];
		});
	});
}

export interface RunTableOptions {
	/** The run under the cursor; when given, every row reserves the cursor column. */
	selectedRunId?: string | null;
	/** A dashboard page: the fleet phase and node columns stay on the board. */
	compact?: boolean;
	tick?: number;
	now?: number;
	/** Shared account limits, so a run on a metered account names its weekly figure. */
	quota?: QuotaProviders;
	/** A finished run says where its record is, in place of its task. */
	inspectFinished?: boolean;
}

/**
 * A token figure for a table cell. The read model's coverage clause, `unknown (2 calls unknown)`, is
 * longer than the row can spare, and it cost a 120-column table its cost column; the run's record has it.
 */
function tableFigure(display: string): string {
	const figure = display.replace(/ \(.*\)$/u, "");
	return figure === "unknown" ? "?" : figure;
}

const USAGE_SHORT: Readonly<Record<string, string>> = { "not available": "n/a" };
export const USAGE_NOT_MEASURED = "not measured";
export const USAGE_NO_CALLS = "no calls yet";

function firstLine(text: string): string {
	const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
	return sanitizeCallTargetText(line.trim());
}

/** The status cell: the outcome glyph in its tone, then the word, the same pair every surface uses. */
function runStatusCell(theme: ClioTheme, row: DispatchBoardRow, tick: number | undefined): string {
	const full = dispatchStatusPresentation(row.status, {
		...(row.status === "running" && tick !== undefined ? { tick } : {}),
	});
	// A table has room for the whole word; only `completed` shortens, to the word the island uses.
	const presentation = row.status === "completed" ? { ...full, label: "done" } : full;
	const token =
		row.status === "running" && (row.agentAudience === "shadow" || row.agentAudience === "internal")
			? "shadowDispatchAction"
			: presentation.token;
	return `${theme.fg(presentation.glyphToken ?? presentation.token, presentation.glyph)} ${theme.fg(token, presentation.label)}`;
}

/** What a run is doing, or how it ended, in one clause the row may clip. */
function runActivityCell(theme: ClioTheme, row: DispatchBoardRow, now: number): TableCell {
	if (row.plan !== undefined) {
		return { text: planProgressText(row.plan), ...(row.plan.state === "failed" ? { tone: "error" as const } : {}) };
	}
	const task = row.taskSummary ? sanitizeCallTargetText(row.taskSummary) : null;
	switch (row.status) {
		case "running":
		case "stale":
		case "cancelling": {
			const progress = row.progress;
			if (progress) {
				if (progress.awaitingApproval === true) return { text: WAITING_FOR_APPROVAL, tone: "warning" };
				if (progress.currentAction) return { text: theme.base("body", actionPhrase(progress.currentAction, "running")) };
				const words = sanitizeCallTargetText(workerActivityWords(progress));
				const tail =
					progress.phase === "writing"
						? firstLine(redactStreamingSecretString(progress.tailText, progress.completed === true))
						: "";
				return { text: `${theme.fg("dispatchAction", words)}${tail ? ` ${theme.fg("assistantProse", tail)}` : ""}` };
			}
			if (row.currentTool) return { text: `${sanitizeCallTargetText(row.currentTool)} running` };
			return { text: task ?? "" };
		}
		case "retrying":
			return row.retry
				? {
						text: `attempt ${row.retry.attempt} · ${retryCountdown(row.retry, now)}${row.retry.reason ? ` · ${sanitizeCallTargetText(row.retry.reason)}` : ""}`,
						tone: "warning",
					}
				: { text: task ?? "retrying", tone: "warning" };
		case "enqueued":
			// The wait's cause outranks the task, which the card under the table still states.
			return {
				text: row.endpoint
					? `waiting for a slot on ${sanitizeCallTargetText(row.endpoint.label)}`
					: (task ?? "waiting for a slot"),
				tone: "muted",
			};
		case "failed":
		case "dead":
			return { text: workerFailureHeadline(terminalDetail(row)) ?? task ?? "", tone: "error" };
		case "aborted":
			return { text: workerFailureHeadline(terminalDetail(row)) ?? task ?? "", tone: "muted" };
		case "completed":
			return { text: task ?? "", tone: "muted" };
	}
}

/**
 * One row per run (a council is one row), the shape every list of runs
 * shares: status, who, how long, what it has consumed and cost, and what it is
 * doing, with the numbers right-aligned. The activity column clips first and
 * the cost, token and phase columns drop before the status and the name do,
 * so a narrow row still says which run is in which state.
 */
export function runTableRows(
	items: ReadonlyArray<DispatchBoardItem>,
	width: number,
	options: RunTableOptions = {},
): string[] {
	const theme = clioTheme();
	const now = options.now ?? Date.now();
	const quota = options.quota ?? [];
	const cursor = options.selectedRunId !== undefined;
	const runs = items.flatMap((item) => (item.kind === "run" ? [item.row] : []));
	const anyPhase = options.compact !== true && runs.some((row) => row.phase !== undefined);
	const anyNode = options.compact !== true && runs.some((row) => row.node !== undefined && row.node !== "local");
	const anyAccount = runs.some((row) => routeWeeklyQuota(row, quota) !== null);
	const fixed: TableColumn[] = [
		...(cursor ? [{ label: "", min: 1, max: 1, priority: 10 }] : []),
		{ label: "status", priority: 10 },
		{ label: "agent", priority: 9, max: 24 },
		...(anyPhase ? [{ label: "phase", priority: 2, max: 14, tone: "info" as const }] : []),
		...(anyNode ? [{ label: "node", priority: 2, max: 12 }] : []),
		{ label: "elapsed", align: "right" as const, priority: 6, tone: "muted" as const },
		{ label: "in", align: "right" as const, priority: 4 },
		{ label: "out", align: "right" as const, priority: 5 },
		{ label: "cost", align: "right" as const, priority: 3 },
		...(anyAccount ? [{ label: "account", priority: 1 }] : []),
	];
	const rows = items.map((item): Array<string | TableCell> => {
		if (item.kind === "council") {
			const group = item.group;
			const selected = group.selectedRunId !== undefined;
			const name = `council ${group.group}`;
			const cells: Array<string | TableCell> = [];
			if (cursor) cells.push(selected ? theme.fg("selectedOption", GLYPH.cursor) : " ");
			cells.push(
				`${theme.fg(group.status.glyphToken ?? group.status.token, group.status.glyph)} ${theme.fg(group.status.token, group.status.label)}`,
				selected ? theme.style("selectedOption", name, { bold: true }) : theme.fg("dispatchAction", name),
			);
			if (anyPhase) cells.push("");
			if (anyNode) cells.push("");
			cells.push(group.elapsed, "", "", "");
			if (anyAccount) cells.push("");
			cells.push({
				text: `${group.members.length} member${group.members.length === 1 ? "" : "s"} · r${group.round}${group.synthesis === null ? "" : ` · ${COUNCIL_SYNTHESIS_LABEL}`}`,
				tone: "muted",
			});
			return cells;
		}
		const row = item.row;
		const selected = cursor && row.runId === options.selectedRunId;
		const prefix = dispatchRowPrefix(theme, row);
		const label = agentDisplayLabel(row);
		const usage = dispatchUsageText(row.usage);
		const weekly = anyAccount ? routeWeeklyQuota(row, quota) : null;
		const elapsed =
			row.telemetry?.activity.elapsed.display ?? (row.status === "enqueued" ? "" : formatCompactMs(row.elapsedMs));
		const pending = row.usage.kind !== "ready";
		if (row.plan !== undefined) {
			const cells: Array<string | TableCell> = [];
			if (cursor) cells.push(selected ? theme.fg("selectedOption", GLYPH.cursor) : " ");
			cells.push(
				runStatusCell(theme, row, options.tick),
				`${prefix.text}${selected ? theme.style("selectedOption", label, { bold: true }) : theme.fg("workerIdentity", label)}`,
			);
			if (anyPhase) cells.push("");
			if (anyNode) cells.push("");
			// A plan's workers have their own rows, so its row sums nothing a reader could mistake for measured.
			cells.push(elapsed, "", "", { text: row.plan.costText ?? "no model calls", tone: "muted" });
			if (anyAccount) cells.push("");
			cells.push(runActivityCell(theme, row, now));
			return cells;
		}
		const figure = (glyph: string, text: string): TableCell =>
			pending
				? { text: USAGE_SHORT[text] ?? text, tone: "muted" }
				: { text: glyph ? `${glyph} ${tableFigure(text)}` : text };
		const cells: Array<string | TableCell> = [];
		if (cursor) cells.push(selected ? theme.fg("selectedOption", GLYPH.cursor) : " ");
		cells.push(
			runStatusCell(theme, row, options.tick),
			`${prefix.text}${selected ? theme.style("selectedOption", label, { bold: true }) : theme.fg("workerIdentity", label)}`,
		);
		if (anyPhase) cells.push(formatDispatchPhaseCell(row.phase, 14) ?? "");
		if (anyNode) cells.push(row.node ?? "local");
		// Unmeasured and not started are different facts, and the cost cell is wide enough to say which.
		const costCell: TableCell = pending
			? { text: row.usage.kind === "unavailable" ? USAGE_NOT_MEASURED : USAGE_NO_CALLS, tone: "muted" }
			: figure("", usage.cost);
		cells.push(elapsed, figure(GLYPH.up, usage.prompt), figure(GLYPH.down, usage.output), costCell);
		if (anyAccount)
			cells.push(
				weekly === null
					? ""
					: {
							text: weekly.label,
							tone: weekly.severity === "critical" ? "error" : weekly.severity === "normal" ? "muted" : "warning",
						},
			);
		cells.push(
			options.inspectFinished && isTerminalStatus(row.status)
				? { text: `/view dispatch:${row.runId}`, tone: "muted" }
				: runActivityCell(theme, row, now),
		);
		return cells;
	});
	// The activity column takes whatever the fixed columns leave, so a long
	// clause clips before it costs the row its cost or phase; below sixteen
	// cells the table drops its quietest columns instead.
	const gap = 2;
	const used = fixed.reduce((sum, column, index) => {
		const natural = Math.max(0, ...rows.map((cells) => visibleWidth(cellText(cells[index]))));
		return sum + Math.min(natural, column.max ?? Number.POSITIVE_INFINITY);
	}, 0);
	const activityRoom = width - used - gap * fixed.length;
	const columns: TableColumn[] = [
		...fixed,
		{ label: "activity", priority: 8, min: 12, max: Math.max(16, activityRoom) },
	];
	return tableRows(theme, { columns, rows }, width);
}

function cellText(cell: string | TableCell | undefined): string {
	return cell === undefined ? "" : typeof cell === "string" ? cell : cell.text;
}

/** The run identity the board's detail rule names: the agent and its run id. */
function runRuleTitle(row: DispatchBoardRow): string {
	return `${agentDisplayLabel(row)} · ${row.runId}`;
}

function rowSignature(row: DispatchBoardRow): string {
	return [
		row.runId,
		row.status,
		row.telemetry?.activity.elapsed.display ?? row.elapsedMs,
		row.usage.kind === "ready" ? `${row.usage.total.display}/${row.usage.usd.display}` : row.usage.kind,
		row.ttft,
		row.progress ? `${row.progress.phase}:${row.progress.tailText.length}:${row.progress.recentActions.length}` : "",
		row.currentTool ?? "",
		row.recentTools?.length ?? 0,
		row.retry ? `${row.retry.attempt}@${row.retry.dueAtMs}` : "",
		row.steerAcknowledgement?.receivedAtMs ?? "",
		row.trust?.verdict ?? "",
		row.hostVerification ?? "",
		row.outcomeDetail ?? "",
		row.phase ? `${row.phase.wave}/${row.phase.stepId}` : "",
		row.node ?? "",
		row.taskSummary?.length ?? 0,
		row.plan ? row.plan.steps.map((step) => step.state).join(",") : "",
	].join("|");
}

/**
 * The board body for `budget` rows: the run table windowed around the cursor,
 * then the selected run's facts under a rule that names it. The key router
 * gives the board only ↑↓, Enter, s and x, so nothing here scrolls by key: the
 * table follows the cursor and the detail is cut at the budget with a marker
 * that names where the rest is read. Enter trades table rows for detail rows
 * and adds the worker's answer and budget.
 */
function formatDispatchBoardBody(
	rows: ReadonlyArray<DispatchBoardRow>,
	width: number,
	budget: number,
	telemetry: TelemetrySnapshot | undefined,
	selectedRunId: string | null,
	detailExpanded: boolean,
): string[] {
	const theme = clioTheme();
	if (rows.length === 0) {
		return emptyState(theme, "No fleet runs yet", width, { remedy: "Use /run or /delegate to start a run." });
	}
	const endpointActive: Record<string, number> = { ...foregroundStreamUsage() };
	const endpointQueued: Record<string, number> = {};
	for (const row of rows) {
		if (row.endpoint === undefined) continue;
		if (row.status === "enqueued") endpointQueued[row.endpoint.key] = (endpointQueued[row.endpoint.key] ?? 0) + 1;
		else if (row.status === "running" || row.status === "stale" || row.status === "cancelling")
			endpointActive[row.endpoint.key] = (endpointActive[row.endpoint.key] ?? 0) + 1;
	}
	// A council is one question asked of several members, so its rows fold into
	// one table row and one detail block rather than unrelated neighbours.
	const items = dispatchBoardItems(rows, selectedRunId);
	const selectedIndex = Math.max(
		0,
		items.findIndex((item) =>
			item.kind === "run" ? item.row.runId === selectedRunId : item.group.selectedRunId !== undefined,
		),
	);
	const table = runTableRows(items, width, { selectedRunId });
	const tableBudget = Math.min(
		table.length,
		Math.max(detailExpanded ? 2 : 3, Math.floor(budget / (detailExpanded ? 4 : 2))),
	);
	const [start] = centeredWindow(table.length, selectedIndex, tableBudget);
	const { window, position } = windowRows(table, start, tableBudget);
	const lines = [...window];
	if (position) lines.push(positionRow(theme, { ...position, unit: "runs", keys: ["↑↓ select"] }, width));
	const item = items[selectedIndex];
	if (item === undefined) return lines;
	const detail =
		item.kind === "council"
			? {
					title: `council ${item.group.group}`,
					meta: `r${item.group.round} · ${item.group.elapsed}`,
					runId: item.group.selectedRunId ?? item.group.members[0]?.runId ?? "",
					body: councilGroupBody(theme, item.group, width),
				}
			: {
					title: runRuleTitle(item.row),
					meta: item.row.telemetry?.activity.elapsed.display ?? formatCompactMs(item.row.elapsedMs),
					runId: item.row.runId,
					body: dispatchCardBody(item.row, width, deriveRunEvidenceState(telemetry, item.row.runId), {
						expanded: detailExpanded,
						...(item.row.endpoint !== undefined
							? {
									endpointActive: endpointActive[item.row.endpoint.key] ?? 0,
									endpointQueued: endpointQueued[item.row.endpoint.key] ?? 0,
								}
							: {}),
					}),
				};
	lines.push(sectionRule(theme, width, detail.title, { meta: detail.meta }));
	const room = budget - lines.length;
	// Enter asked for everything the run has to say; the frame cuts what the
	// dock cannot hold. The folded view keeps its budget and names the key.
	if (detailExpanded || detail.body.length <= room) {
		lines.push(...detail.body);
		return lines;
	}
	if (room <= 0) return lines;
	const kept = detail.body.slice(0, Math.max(0, room - 1));
	const hidden = detail.body.length - kept.length;
	const where = [`${hidden} more rows`, "Enter for detail", `/view dispatch:${detail.runId}`];
	lines.push(
		...kept,
		theme.fg("annotation", truncateToWidth(`${GLYPH.ellipsis} ${where.join(" · ")}`, width, GLYPH.ellipsis, false)),
	);
	return lines;
}

/**
 * Live dispatch-board component. The table renders at the width the TUI
 * grants and the body at the rows the dock grants, so a narrow terminal drops
 * columns rather than clipping telemetry mid-token and a short one windows the
 * table around the cursor rather than cutting the board at the second card.
 * Rows and the telemetry snapshot are read per render and the body is
 * memoized on what they show, so a ticker repaint that changed nothing costs
 * the frame its identity check and no more. The only local state is the
 * selected run id, kept stable across lifecycle-driven reorders, and whether
 * its detail is expanded.
 */
export interface DispatchBoardView extends Component, RowBudgetedBody {
	selectedRow(): DispatchBoardRow | null;
	selectPrevious(): void;
	selectNext(): void;
	resetSelection(): void;
	/** Open or close the selected row's worker-progress detail. */
	toggleDetail(): void;
	detailExpanded(): boolean;
}

export function createDispatchBoardView(
	rows: () => ReadonlyArray<DispatchBoardRow>,
	telemetry: () => TelemetrySnapshot | undefined,
): DispatchBoardView {
	let selectedRunId: string | null = null;
	// Detail is a property of the operator's attention, not of a run, so it
	// follows the cursor rather than pinning to the row it was opened on.
	let expanded = false;
	let bodyRows = 0;
	let memo: { key: string; lines: string[] } | null = null;

	const normalizeSelection = (
		currentRows: ReadonlyArray<DispatchBoardRow>,
		visibleRows = selectableBoardRows(currentRows),
	): DispatchBoardRow | null => {
		if (visibleRows.length === 0) {
			selectedRunId = null;
			return null;
		}
		const previous = currentRows.find((row) => row.runId === selectedRunId);
		const selected =
			visibleRows.find((row) => row.runId === selectedRunId) ??
			visibleRows.find(
				(row) =>
					previous?.council !== undefined &&
					row.council?.group === previous.council.group &&
					row.council.label === previous.council.label,
			) ??
			visibleRows[0] ??
			null;
		selectedRunId = selected?.runId ?? null;
		return selected;
	};

	const moveSelection = (delta: -1 | 1): void => {
		const currentRows = rows();
		const visibleRows = selectableBoardRows(currentRows);
		const selected = normalizeSelection(currentRows, visibleRows);
		if (!selected || visibleRows.length < 2) return;
		const index = visibleRows.findIndex((row) => row.runId === selected.runId);
		const nextIndex = (index + delta + visibleRows.length) % visibleRows.length;
		selectedRunId = visibleRows[nextIndex]?.runId ?? selected.runId;
	};

	return {
		render(width: number): string[] {
			const currentRows = rows();
			normalizeSelection(currentRows);
			const snapshot = telemetry();
			const safeWidth = Math.max(1, width);
			const budget = bodyRows > 0 ? bodyRows : DOCK_BODY_ROWS_MAX;
			// A waiting retry counts down by the second, so its row is keyed on the second.
			const clock = currentRows.some((row) => row.retry !== undefined) ? Math.floor(Date.now() / 1000) : 0;
			const evidence =
				snapshot?.runs
					.filter((run) => run.evidence)
					.map((run) => run.runId)
					.join(",") ?? "";
			const key = `${safeWidth}|${budget}|${selectedRunId}|${expanded}|${skinEpoch()}|${clock}|${evidence}|${currentRows.map(rowSignature).join(";")}`;
			if (memo?.key === key) return memo.lines;
			const lines = formatDispatchBoardBody(currentRows, safeWidth, budget, snapshot, selectedRunId, expanded);
			memo = { key, lines };
			return lines;
		},
		setBodyRows(next: number): void {
			bodyRows = Math.max(0, Math.floor(next));
		},
		selectedRow(): DispatchBoardRow | null {
			return normalizeSelection(rows());
		},
		selectPrevious(): void {
			moveSelection(-1);
		},
		selectNext(): void {
			moveSelection(1);
		},
		resetSelection(): void {
			selectedRunId = null;
			expanded = false;
			normalizeSelection(rows());
		},
		toggleDetail(): void {
			expanded = !expanded;
		},
		detailExpanded(): boolean {
			return expanded;
		},
		invalidate(): void {
			memo = null;
		},
	};
}

/** What the runs off the card are doing, so a queued or failed one is not hidden behind a count. */
function hiddenRunsSummary(hidden: ReadonlyArray<DispatchBoardItem>): string {
	const counts = new Map<string, number>();
	for (const item of hidden) {
		const label = item.kind === "council" ? item.group.status.label : dispatchStatusPresentation(item.row.status).label;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	const states = [...counts].map(([label, count]) => `${count} ${label}`).join(" · ");
	return `+ ${hidden.length} more · ${states} · /fleet`;
}

export function formatTaskIslandLines(
	rows: ReadonlyArray<DispatchBoardRow>,
	maxRows = 4,
	quota: QuotaProviders = [],
	contentWidth = TASK_ISLAND_WIDTH,
): string[] {
	// Councils are folded before the row cap, so a five-member council costs the
	// island one card and never crowds out the runs beside it.
	const items = dispatchBoardItems(rows.filter((row) => !isHelperRun(row)));
	const visibleItems = items.slice(0, Math.max(1, maxRows));
	const body: string[] = [];

	if (visibleItems.length === 0) {
		const theme = clioTheme();
		body.push(theme.fg("annotation", "No active fleet runs."));
		body.push(theme.fg("annotation", "Use /run or /delegate to spawn agents."));
	} else {
		for (let i = 0; i < visibleItems.length; i++) {
			const item = visibleItems[i];
			if (!item) continue;
			if (i > 0) {
				body.push(innerDivider(clioTheme(), contentWidth));
			}
			body.push(
				...(item.kind === "council"
					? councilIslandLines(clioTheme(), item.group, contentWidth)
					: renderTaskIslandRow(item.row, contentWidth, quota)),
			);
		}
		const hidden = items.length - visibleItems.length;
		if (hidden > 0) {
			body.push(innerDivider(clioTheme(), contentWidth));
			body.push(clioTheme().fg("annotation", hiddenRunsSummary(items.slice(visibleItems.length))));
		}
	}

	// Body rows are already ANSI-padded to TASK_ISLAND_WIDTH by the row renderer
	// (or are fixed-width dividers/empty-state lines). The canonical frame re-pads
	// each row ANSI-aware, so passing the styled lines through is safe.
	return frame(clioTheme(), "Fleet runs", body, contentWidth + 4);
}

function parseOptionalDetail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const detail = value.replace(/\s+/g, " ").trim();
	return detail.length > 0 ? detail : null;
}

/** Only an authenticated independent pass earns the success token; sealed alone is never green. */
function trustVerdictToken(verdict: TrustVerdict): ClioToken {
	switch (verdict) {
		case "reviewed":
			return "success";
		case "grounded":
			return "info";
		case "unverified":
			return "body";
		case "compromised":
			return "error";
		default:
			return "annotation";
	}
}

/**
 * Only the two settled verdicts carry a glyph. `◇` and `◆` already mark who
 * started a run on this board, so a hollow diamond here read as an origin.
 */
function trustVerdictMark(verdict: TrustVerdict): string {
	if (verdict === "reviewed") return `${GLYPH.ok} `;
	if (verdict === "compromised") return `${GLYPH.error} `;
	return "";
}

function terminalDetail(row: DispatchBoardRow): string | null {
	if (row.status !== "failed" && row.status !== "dead" && row.status !== "aborted") return null;
	return parseOptionalDetail(row.outcomeDetail);
}

function isTerminalStatus(status: DispatchBoardStatus): boolean {
	return status === "completed" || status === "failed" || status === "aborted" || status === "dead";
}

function toRow(
	entry: TelemetryRunSummary,
	now: number,
	usage: DispatchRunUsage,
	ttft: string | null,
): DispatchBoardRow {
	const retry = entry.retry;
	const progress = entry.progress;
	return {
		...(progress !== undefined ? { progress } : {}),
		...(entry.resultContract !== undefined ? { resultContract: entry.resultContract } : {}),
		runId: entry.runId,
		agentId: entry.agentId,
		...(entry.agentAudience !== undefined ? { agentAudience: entry.agentAudience } : {}),
		...(entry.requestOrigin !== undefined ? { requestOrigin: entry.rootRequestOrigin ?? entry.requestOrigin } : {}),
		runtimeKind: entry.runtimeKind ?? "http",
		runtimeId: entry.runtimeId ?? "-",
		targetId: entry.targetId ?? "-",
		wireModelId: entry.modelId ?? "-",
		...(entry.endpoint !== undefined ? { endpoint: { ...entry.endpoint } } : {}),
		...(entry.taskSummary !== undefined ? { taskSummary: entry.taskSummary } : {}),
		...(entry.budget !== undefined ? { budget: entry.budget } : {}),
		status: entry.status,
		elapsedMs: entry.durationMs ?? Math.max(0, (entry.finishedAtMs ?? now) - entry.startedAtMs),
		usage,
		ttft,
		...(entry.outcomeDetail !== undefined ? { outcomeDetail: entry.outcomeDetail } : {}),
		...(entry.node !== undefined ? { node: entry.node } : {}),
		...(entry.gate !== undefined ? { gate: { ...entry.gate } } : {}),
		...(entry.council !== undefined ? { council: { ...entry.council } } : {}),
		...(entry.hostVerification !== undefined ? { hostVerification: entry.hostVerification } : {}),
		...(entry.trust !== undefined ? { trust: entry.trust } : {}),
		...(entry.rerouteCount !== undefined ? { rerouteCount: entry.rerouteCount } : {}),
		...(entry.failoverHops !== undefined ? { failoverHops: entry.failoverHops } : {}),
		...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
		lastContextTokens: entry.lastContextTokens ?? null,
		...(entry.runRecordId !== undefined ? { runRecordId: entry.runRecordId } : {}),
		...(entry.phase !== undefined ? { phase: { ...entry.phase } } : {}),
		// Both tool fields are views of the one projection, so the compact card and
		// the expanded detail can never disagree about what is running.
		currentTool: retry ? null : (progress?.currentAction?.tool ?? null),
		recentTools: progress?.recentActions.map((action) => action.tool) ?? [],
		...(retry ? { retry: { ...retry } } : {}),
		...(entry.steerAcknowledgement ? { steerAcknowledgement: { ...entry.steerAcknowledgement } } : {}),
		...(entry.writeRecordDowngrade ? { writeRecordDowngrade: { ...entry.writeRecordDowngrade } } : {}),
	};
}

const UNAVAILABLE: DispatchRunUsage = { kind: "unavailable" };
const PENDING: DispatchRunUsage = { kind: "pending" };
const runUsages = new WeakMap<TelemetryView, Map<string, DispatchRunUsage>>();

/** Each run the bound session references, read once per view: the read model folds, the board only looks up. */
function runUsagesOf(view: TelemetryView): Map<string, DispatchRunUsage> {
	let usages = runUsages.get(view);
	if (usages) return usages;
	usages = new Map();
	for (const run of view.runs()) {
		const quantity = (metric: FactMetric) => view.quantity(factRef({ scope: "run", owner: run.runId, metric }));
		const prompt = quantity("prompt");
		const output = quantity("output");
		usages.set(
			run.runId,
			prompt && output ? { kind: "ready", prompt, output, total: run.tokens, usd: run.usd } : PENDING,
		);
	}
	runUsages.set(view, usages);
	return usages;
}

const runTtfts = new WeakMap<TelemetryView, Map<string, string | null>>();

/**
 * The run's first generated token, send to first token of its earliest attempt that produced one, as the read model
 * folds the run's journal: never an orchestrator clock that also counts the worker's startup, and never hidden by a
 * failed attempt before it (#434). Null until such an attempt settles.
 */
function dispatchRunTtft(view: TelemetryView | null | undefined, runId: string): string | null {
	if (!view) return null;
	let ttfts = runTtfts.get(view);
	if (!ttfts) {
		ttfts = new Map();
		runTtfts.set(view, ttfts);
	}
	if (ttfts.has(runId)) return ttfts.get(runId) ?? null;
	const first = view.quantity(factRef({ scope: "run", owner: runId, metric: "firstToken" }));
	const kind = first && "kind" in first.fact ? first.fact.kind : null;
	const ttft = first && (kind === "measured" || kind === "estimated") ? first.display : null;
	ttfts.set(runId, ttft);
	return ttft;
}

/** A run's usage in one telemetry view: unavailable without a view, pending until the view's session references it. */
export function dispatchRunUsage(view: TelemetryView | null | undefined, runId: string): DispatchRunUsage {
	return view ? (runUsagesOf(view).get(runId) ?? PENDING) : UNAVAILABLE;
}

const FLEET_PLAN_ROW_STATUS: Record<FleetPlanRunView["state"], DispatchBoardStatus> = {
	running: "running",
	passed: "completed",
	failed: "failed",
	unsettled: "stale",
};

function fleetPlanRow(plan: FleetPlanRunView, now: number): DispatchBoardRow {
	return {
		runId: plan.rootId,
		agentId: `plan ${plan.name}`,
		requestOrigin: "user",
		runtimeKind: "http",
		runtimeId: "fleet",
		targetId: "",
		wireModelId: "",
		taskSummary: planProgressText(plan),
		status: FLEET_PLAN_ROW_STATUS[plan.state],
		elapsedMs: (plan.finishedAtMs ?? now) - plan.startedAtMs,
		usage: UNAVAILABLE,
		ttft: null,
		lastContextTokens: null,
		plan,
	};
}

/** The board keeps display order and reads every run fact from telemetry; tokens and cost from its read model. */
export function createDispatchBoardStore(
	projection: Pick<TelemetryContract, "snapshot" | "subscribe" | "reconcileRuns" | "setFleetPhase" | "read">,
	readDurablePlans?: () => ReadonlyArray<FleetPlanRunView>,
): {
	rows(): ReadonlyArray<DispatchBoardRow>;
	activeRows(): ReadonlyArray<DispatchBoardRow>;
	reconcile(): void;
	setFleetPhase(runId: string, phase: DispatchBoardPhase): void;
	/** Plans this session started and the durable ones before it; their rows join `rows()` but never `activeRows()`. */
	plans: FleetPlanRuns;
	unsubscribe(): void;
} {
	let current = projection.snapshot();
	const plans = createFleetPlanRuns(Date.now, readDurablePlans);
	const unsubscribe = projection.subscribe((snapshot) => {
		current = snapshot;
	});
	const projectRows = (activeOnly: boolean): ReadonlyArray<DispatchBoardRow> => {
		const view = projection.read?.live() ?? null;
		return [...current.runs]
			.reverse()
			.sort(
				(a, b) =>
					STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
					(b.finishedAtMs ?? b.startedAtMs) - (a.finishedAtMs ?? a.startedAtMs),
			)
			.map((run) => ({
				...toRow(run, current.generatedAt, dispatchRunUsage(view, run.runId), dispatchRunTtft(view, run.runId)),
				telemetry: view?.run(run.runId) ?? null,
			}))
			.filter((row) => !activeOnly || !isTerminalStatus(row.status));
	};
	return {
		plans,
		rows() {
			const planRows = plans.runs().map((plan) => fleetPlanRow(plan, Date.now()));
			if (planRows.length === 0) return projectRows(false);
			const finishedAt = (row: DispatchBoardRow): number =>
				row.plan !== undefined ? (row.plan.finishedAtMs ?? Date.now()) : Date.now() - row.elapsedMs;
			return [...projectRows(false), ...planRows].sort(
				(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || finishedAt(b) - finishedAt(a),
			);
		},
		activeRows: () => projectRows(true),
		reconcile() {
			projection.reconcileRuns();
			current = projection.snapshot();
		},
		setFleetPhase(runId, phase) {
			projection.setFleetPhase(runId, phase);
			current = projection.snapshot();
		},
		unsubscribe,
	};
}
