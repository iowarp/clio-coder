import type { FactMetric, Quantity, RunTelemetryV1 } from "../core/telemetry/dto.js";
import { factRef } from "../core/telemetry/dto.js";
import { parseCouncilReport } from "../domains/agents/index.js";
import type { AgentAudience } from "../domains/agents/spec.js";
import type { RunToolBudgetEnvelope } from "../domains/dispatch/budget-envelope.js";
import { budgetLimitWords } from "../domains/dispatch/budget-envelope.js";
import type { CompletedRunCaveat } from "../domains/dispatch/failure-headline.js";
import { completedRunCaveat, workerFailureHeadline } from "../domains/dispatch/failure-headline.js";
import { fleetNodeTaskBrief } from "../domains/dispatch/fleet-node-prompt.js";
import type { DispatchRequestOrigin, RunKind } from "../domains/dispatch/types.js";
import { runKindSupportsLiveSteering } from "../domains/dispatch/types.js";
import { describeWriteBoundaryAttributionDowngrade } from "../domains/dispatch/write-boundary.js";
import type { TrustSummaryProjection, TrustVerdict } from "../domains/evidence/trust-projection.js";
import { plainTrustVerdict, trustStateWord } from "../domains/evidence/trust-projection.js";
import { foregroundStreamUsage } from "../domains/providers/index.js";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../domains/safety/call-target.js";
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
import { type RouteFirstOutput, routeFirstOutput } from "./footer/silence-note.js";
import {
	centeredWindow,
	cutRowWithEllipsis,
	fitHintEntryList,
	type GrowableBody,
	type HintEntry,
	type RowBudgetedBody,
	windowRows,
} from "./overlay-frame.js";
import type { QuotaProviders } from "./quota-view.js";
import { routeWeeklyQuota } from "./quota-view.js";
import {
	councilCollectedWords,
	councilSynthesisLines,
	liveWorkerAnswerText,
	presentWorkerContractAnswer,
} from "./renderers/worker-answer.js";
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
import { fitIdentityLabel, keyName } from "./theme/labels.js";
import { skinEpoch } from "./theme/tokens.js";
import {
	USAGE_NOT_MEASURED,
	usageFigure,
	usageLineCoverage,
	usageLineFigure,
	usageSaysNothing,
} from "./usage-words.js";
import {
	approvalWaitWords,
	compactQuantity,
	completedRunMark,
	workerActionParts,
	workerActivityWords,
	workerPhaseActivity,
	workerSilenceWords,
} from "./worker-activity.js";

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
	/** This session's worker calls on the run's route, for saying whether a silent wait is unusual; running rows only. */
	routeFirstOutput?: RouteFirstOutput | null;
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
	/** Which validator failed and on what evidence, beside a validation-failed verdict. */
	validationFailure?: string;
	/** How the settled run finished beside its outcome, for the caveat the worker card shows too. */
	completion?: { toolCalls?: number; refusedCalls?: number; contract?: string };
	/** Read back from the run ledger because it settled before this Clio process started (J2-F16). */
	earlier?: true;
	/** When the run settled, or started while it has not; what the board orders settled runs by, newest first. */
	settledAtMs?: number;
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
	// The step is what the plan card names; its wave is a scheduling detail the run's own detail row states.
	return truncateToWidth(phase.stepId, Math.max(1, width), "…", false);
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
		// A queued run has no worker yet, so a message would have nowhere to go.
		(row.status === "running" || row.status === "stale")
	);
}

/** Dispatch abort owns active workers and retry timers, but never terminal history. */
export function isDispatchBoardRowCancellable(row: DispatchBoardRow): boolean {
	// A plan stops through the stop its runner holds, which only the process that started it has.
	if (row.plan !== undefined) return row.plan.state === "running" && row.plan.stoppable === true;
	return row.status === "running" || row.status === "stale" || row.status === "enqueued" || row.status === "retrying";
}

/** Rows of worker prose an expanded card shows before it defers to `/view`. */
const WORKER_PROGRESS_CARD_ROWS = 6;

const TASK_ISLAND_WIDTH = 44;

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
			// The watchdog stopped a worker whose heartbeat went silent: the inline card's words, not the ledger's.
			return { glyph: GLYPH.error, label: "stopped responding", token: "error" };
		case "aborted":
			return { glyph: GLYPH.cancelled, label: "cancelled", token: "annotation" };
		case "stale":
			return { glyph: GLYPH.warnInline, label: "not responding", token: "warning" };
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
	const units = [theme.fg(presentation.token, `${presentation.glyph} ${presentation.word} to inspect`)];
	units.push(theme.fg("annotation", `/view ${evidence.viewFilter}`));
	return cardUnitsLine(theme, "evidence", units, contentWidth);
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
	// The phase only, in the words the dock and the inline card use. Reasoning content never reaches an operator surface.
	if (progress.phase === "settled" || progress.phase === "starting") return null;
	const [glyph, words] = workerPhaseActivity(progress.phase);
	return theme.fg("dispatchAction", `${glyph} ${words}`);
}

/**
 * The `doing` row: the phase, then the running call or the most recent one, with its object. A model gone quiet adds
 * how long and whether that is usual for the route, the words the table row and the rail use.
 */
function progressActionLine(
	theme: ClioTheme,
	progress: WorkerProgressSnapshot,
	contentWidth: number,
	history: RouteFirstOutput | null,
): string | null {
	const phase = progressPhaseUnit(theme, progress);
	const current = progress.currentAction;
	const recent = progress.recentActions[0];
	const units: string[] = [];
	const silence = workerSilenceWords(progress, { history, room: contentWidth - 22 });
	// A silence already says what the worker waits on and for how long, so the bare phase would only repeat it.
	if (phase !== null && current === null && silence === null) units.push(phase);
	if (silence !== null) units.push(theme.fg("warning", silence));
	if (progress.awaitingApproval === true && current !== null) {
		const wanted = workerActionParts(current, "running");
		units.push(
			theme.fg("warning", approvalWaitWords(progress, { room: contentWidth - 12 })),
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
	// The inline card's and the dock's words for the same phase, so the three surfaces never disagree.
	// A running call is what the worker is doing now; without one, the phase says it.
	const phase = workerPhaseActivity(progress.phase)[1];
	const words = progress.currentAction
		? actionPhrase(progress.currentAction, "running")
		: `${phase.charAt(0).toUpperCase()}${phase.slice(1)}`;
	lines.push(...wrapTextWithAnsi(`${theme.fg("harnessHeading", "Now")}  ${words}`, width));
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

/** Axis states a reader must see spelled out, because the verdict's words alone do not carry them. */
const EXCEPTIONAL_TRUST_STATES: ReadonlySet<string> = new Set([
	"failed",
	"unknown",
	"ungrounded",
	"invalid",
	"inconclusive",
	"not_independent",
]);

/**
 * The run's verdict in plain words. Under it the axis record shows only when an axis is out of the ordinary (unknown,
 * failed, inferred), folded or open: an ordinary sealed run's axes only restate the verdict in the receipt's
 * vocabulary, so for it they stay in /view.
 */
function trustCardLines(theme: ClioTheme, row: DispatchBoardRow, contentWidth: number, expanded: boolean): string[] {
	const axes = row.trust?.axes;
	const ordinary =
		axes !== undefined &&
		axes.artifactIntegrity === "verified" &&
		Object.values(axes).every((state) => !EXCEPTIONAL_TRUST_STATES.has(String(state)));
	const host = row.hostVerification === undefined ? "" : ` · ${theme.fg("body", `host checks ${row.hostVerification}`)}`;
	if (row.trust === undefined) {
		const unread = theme.fg(
			"annotation",
			!isTerminalStatus(row.status)
				? "not sealed yet"
				: row.status === "aborted" && row.progress === undefined
					? "nothing to judge: it never started"
					: "run record not read back",
		);
		return cardWrappedValueLines(theme, "trust", `${unread}${host}`, contentWidth);
	}
	// A run that failed or was stopped before any check ran has no verdict worth a reader's time beyond that fact;
	// the axes stay one Enter away.
	if (
		!expanded &&
		isTerminalStatus(row.status) &&
		row.status !== "completed" &&
		axes?.validationGrounding === "absent" &&
		row.validationFailure === undefined
	) {
		return cardWrappedValueLines(
			theme,
			"trust",
			`${theme.fg("annotation", "nothing was checked before it ended")}${host}`,
			contentWidth,
		);
	}
	// The verdict leads in plain words; the axes that back it follow as detail.
	const verdict = theme.fg(
		trustVerdictToken(row.trust.verdict),
		`${trustVerdictMark(row.trust.verdict)}${plainTrustVerdict(row.trust)}`,
	);
	// A failed validation names its validator and evidence right under the verdict, so a passing answer above it
	// never reads as a contradiction.
	const why =
		row.validationFailure === undefined
			? []
			: cardWrappedValueLines(
					theme,
					"why",
					`${theme.fg("body", row.validationFailure)}${theme.fg("annotation", ` · /view dispatch:${row.runId}`)}`,
					contentWidth,
				);
	const valueWidth = Math.max(1, contentWidth - CARD_KV_KEY_WIDTH - 1);
	const detail = ordinary
		? []
		: wrapTextWithAnsi(theme.fg("annotation", row.trust.text), valueWidth).map(
				(line) => `${" ".repeat(CARD_KV_KEY_WIDTH + 1)}${line}`,
			);
	return [...cardWrappedValueLines(theme, "trust", `${verdict}${host}`, contentWidth), ...why, ...detail];
}

/** `2/2 steps`, then the first step that failed. Unsettled steps are not counted as anything yet. */
/** Why a plan ended without its steps settling, without the runner's own prefix. */
function planFailureWords(plan: FleetPlanRunView): string | null {
	return plan.failure === undefined ? null : sanitizeCallTargetText(plan.failure.replace(/^dispatch:\s*/u, ""));
}

function planProgressText(plan: FleetPlanRunView, statusShown = false, withFailure = true): string {
	const done = plan.steps.filter((step) => step.state === "passed" || step.state === "replayed").length;
	const failed = plan.steps.find((step) => step.state === "failed" && !planStepStopped(plan, step.stepId));
	const live = plan.state === "running" || plan.state === "cancelling";
	const count = `${live ? done : plan.succeededStepCount}/${plan.requiredStepCount} steps`;
	if (plan.state === "cancelling") {
		const stopping = plan.stoppedStepIds ?? [];
		return `${count} · ${stopping.length > 0 ? `stopping ${stopping.join(", ")}` : "stopping before the next step"}`;
	}
	// Where a status cell already reads cancelled, repeating it on the count only doubles the word.
	if (plan.state === "cancelled") return statusShown ? count : `${count} · cancelled`;
	if (plan.failure !== undefined) return withFailure ? `${count} · ${planFailureWords(plan)}` : count;
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

/** A step the operator's stop cut short: whatever exit it reported, the stop is why it ended. */
function planStepStopped(plan: FleetPlanRunView, stepId: string): boolean {
	return (plan.state === "cancelling" || plan.state === "cancelled") && (plan.stoppedStepIds ?? []).includes(stepId);
}

/** One row per step: state first, because the step's name and command are what a narrow row can lose. */
function planStepLines(theme: ClioTheme, plan: FleetPlanRunView, width: number): string[] {
	const nameWidth = Math.max(...plan.steps.map((step) => visibleWidth(step.stepId)));
	return plan.steps.map((step) => {
		const stopped = planStepStopped(plan, step.stepId) && step.state !== "passed";
		const mark = stopped
			? plan.state === "cancelling" && step.state === "running"
				? { glyph: GLYPH.cancelled, token: "warning" as const, word: "stopping" }
				: { glyph: GLYPH.cancelled, token: "annotation" as const, word: "stopped" }
			: PLAN_STEP_MARKS[step.state];
		// A step still pending at the end was never reached; while the plan runs it is only waiting.
		const word =
			stopped || step.state !== "pending"
				? mark.word
				: plan.state === "running" || plan.state === "cancelling"
					? "waiting"
					: plan.state === "unsettled"
						? "no result"
						: mark.word;
		// A step whose worker has ended is finishing while the plan records it, not still running.
		const finishing = !stopped && step.state === "running" && step.worker?.settled === true;
		// A stopped step's exit code is the signal the stop sent, not a result; its duration still says how far it got.
		const detail = stopped ? step.detail?.replace(/^exit -?\d+ · /u, "") : step.detail;
		// The worker's own caveat rides the step, so a step that passed reads the refused call its run's row shows.
		const caveat = stopped ? null : (step.worker?.caveat ?? null);
		const facts = [
			finishing ? "finishing" : word,
			...(caveat !== null ? [caveat] : []),
			...(detail !== undefined && detail !== caveat ? [detail] : []),
			step.label,
		];
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
		theme.fg("body", planProgressText(plan, true, false)),
		...(plan.finishedAtMs === null
			? []
			: [
					plan.costText === null
						? theme.fg("body", "no model calls")
						: `${theme.fg("annotation", "cost")} ${theme.fg("body", plan.costText)}`,
				]),
	];
	const gutter = " ".repeat(CARD_KV_KEY_WIDTH + 1);
	const steps = planStepLines(theme, plan, Math.max(1, contentWidth - gutter.length));
	// The reason gets its own wrapped row: as one more status unit it was wider than the row and dropped whole.
	const why = planFailureWords(plan);
	return [
		cardUnitsLine(theme, "status", units, contentWidth),
		...(why === null ? [] : cardWrappedValueLines(theme, "why", theme.fg("error", why), contentWidth)),
		...steps.map((line, index) => `${index === 0 ? cardKvKey(theme, "steps") : gutter}${line}`),
		...cardWrappedValueLines(
			theme,
			"inspect",
			theme.fg("annotation", `clio-coder fleet events ${plan.rootId}`),
			contentWidth,
		),
	];
}

/** Step rows the live card keeps, so a long plan cannot push the composer off a short terminal. */
const PLAN_LIVE_STEP_ROWS = 4;

/** A running plan on the fleet card: its progress and clock, then the steps around the one running now. */
function planIslandLines(theme: ClioTheme, row: DispatchBoardRow, plan: FleetPlanRunView, width: number): string[] {
	const lead = plan.state === "cancelling" ? theme.fg("warning", GLYPH.cancelled) : theme.fg("activity", GLYPH.running);
	const head = `${lead} ${functionText(theme, "dispatch", GLYPH.workerHuman)} ${theme.fg("workerIdentity", `plan ${plan.name}`)}${dotSep(theme)}${theme.fg("body", planProgressText(plan))}${dotSep(theme)}${theme.fg("annotation", formatCompactMs(row.elapsedMs))}`;
	const steps = planStepLines(theme, plan, Math.max(1, width - 2));
	const running = plan.steps.findIndex((step) => step.state === "running");
	const start = Math.max(0, Math.min(Math.max(0, running - 1), steps.length - PLAN_LIVE_STEP_ROWS));
	const shown = steps.slice(start, start + PLAN_LIVE_STEP_ROWS);
	const hidden = steps.length - shown.length;
	return [
		truncateToWidth(head, width, GLYPH.ellipsis, false),
		...shown.map((line) => `  ${line}`),
		...(hidden > 0 ? [theme.fg("annotation", `  ${hidden} more steps · /fleet`)] : []),
	];
}

/** The transcript's settled record of a plan, in the worker card's gutter grammar. */
export function renderFleetPlanCard(plan: FleetPlanRunView, width: number): string[] {
	const theme = clioTheme();
	const passed = plan.state === "passed";
	const cancelled = plan.state === "cancelled";
	const rail = theme.fg("gutter", "  │ ");
	const tone = passed ? "success" : cancelled ? "toolMetadata" : "error";
	const glyph = passed ? GLYPH.ok : cancelled ? GLYPH.cancelled : GLYPH.error;
	const head = `${functionText(theme, "dispatch", GLYPH.workerHuman)} ${theme.fg("workerIdentity", `plan ${plan.name}`)}${dotSep(theme)}${theme.fg(tone, `${glyph} ${planProgressText(plan, false, false)}`)}`;
	const room = Math.max(1, width - 4);
	const why = planFailureWords(plan);
	return [
		truncateToWidth(head, width, GLYPH.ellipsis, false),
		...(why === null
			? []
			: wrapTextWithAnsi(theme.fg("error", `${GLYPH.error} ${why}`), room).map((line) => `${rail}${line}`)),
		...planStepLines(theme, plan, room).map((line) => `${rail}${line}`),
		`${rail}${theme.fg("annotation", truncateToWidth(`/fleet for detail · ${plan.costText === null ? "no model calls" : `cost ${plan.costText}`}`, room, GLYPH.ellipsis, false))}`,
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
		/** The key that opens detail on this row, because Enter opens the watch pane under a pane host. */
		detailKey?: string;
		endpointActive?: number;
		endpointQueued?: number;
		theme?: ClioTheme;
	} = {},
): string[] {
	const theme = options.theme ?? clioTheme();
	if (row.plan !== undefined) return planCardBody(theme, row, row.plan, contentWidth);
	const usage = dispatchUsageText(row.usage);
	const cost = usage.cost;
	// The card says what went wrong in plain words, folded or open; the receipt's own words are the record's, in /view.
	const detail = workerFailureHeadline(terminalDetail(row));

	const presentation = dispatchStatusPresentation(row.status, {
		...(row.status === "running" ? { tick: animationStep(Date.now()) } : {}),
	});
	// The function phase is orange, while identity, cost and TTFT keep their own roles.
	const failure = completedRunFailure(row);
	const failureMark = completedRunMark(failure);
	const statusStr =
		failure !== null
			? theme.fg(failureMark.token, `${failureMark.glyph} ${presentation.label} · ${failure.words}`)
			: `${theme.fg(presentation.glyphToken ?? presentation.token, presentation.glyph)} ${theme.fg(presentation.token, presentation.label)}`;

	// How long the model took to its first output, in words: a run that has not answered yet says so, and one that
	// never reached its model says nothing rather than `n/a`.
	const firstOutput =
		row.ttft !== undefined && row.ttft !== null
			? `first output after ${row.ttft}`
			: row.status === "running"
				? "no output yet"
				: null;

	// A queued run has produced nothing yet, so it never carries a throughput.
	const rate = wallTokenRate(row, usage);
	// Figures keep their lower-bound mark and the line states its coverage once, as its last unit, rather than a
	// `(N calls unknown)` after every figure. A figure nothing measured reads `not measured`, never `?`.
	const figure = (display: string): string => compactQuantity(display) ?? USAGE_NOT_MEASURED;
	const lineFigure = (key: "prompt" | "output" | "total", display: string): string =>
		row.usage.kind === "ready" ? usageLineFigure(row.usage[key]) : figure(display);
	const tokenDisplays = [usage.prompt, usage.output, usage.total];
	const nothingMeasured = tokenDisplays.every((display) => compactQuantity(display) === null);
	const coverage =
		row.usage.kind === "unavailable" || row.usage.kind === "pending"
			? null
			: usageLineCoverage([
					{ label: "in", quantity: row.usage.prompt },
					{ label: "out", quantity: row.usage.output },
				]);
	const tokenUnits = nothingMeasured
		? [theme.fg("body", row.status === "running" || row.status === "enqueued" ? "not measured yet" : USAGE_NOT_MEASURED)]
		: [
				// Label-first words, as the turn receipt says them: `in 321 · out 12 · total 333`.
				theme.fg("body", `in ${lineFigure("prompt", usage.prompt)}`),
				theme.fg(
					"body",
					`out ${lineFigure("output", usage.output)}${rate !== null ? (options.expanded === true ? ` (${rate}/s wall avg)` : ` ${rate}/s`) : ""}`,
				),
				theme.fg("body", `total ${lineFigure("total", usage.total)}`),
			];

	// The model id is user data and can outrun the card; mark the cut with `…`
	// rather than hard-clipping it mid-token into a string that reads whole.
	const targetKey = cardKvKey(theme, "target");
	// The route is the target and model. Enter adds how the worker reached it only when that is not the ordinary model
	// call, because `http runtime` is a transport name that tells a person nothing they can act on.
	const routeLabel = formatTargetLabel(row.targetId, row.wireModelId, { abbreviate: false });
	const reach = RUNTIME_REACH_WORDS[row.runtimeKind];
	const route = options.expanded === true && reach !== undefined ? `${routeLabel}${dotSep(theme)}${reach}` : routeLabel;
	const targetLine = `${targetKey}${theme.fg("footerIdentity", fitIdentityLabel(route, Math.max(1, contentWidth - visibleWidth(targetKey))))}`;
	// Fleet facts: node placement (absent means local), gate role badge, and
	// reroute lineage. Whole units so overflow drops a fact, never clips one.
	const statusUnits = [
		statusStr,
		// A run on this machine is the default and says nothing; one placed on another node names it.
		...(row.node === undefined || row.node === "local" ? [] : [theme.fg("body", `on node ${row.node}`)]),
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
		...(firstOutput === null ? [] : [theme.fg("body", firstOutput)]),
		...(cost === "—" ? [] : [theme.fg("body", cost === USAGE_NOT_MEASURED ? "cost not measured" : `cost ${cost}`)]),
	];
	// Context occupancy is a figure like the others: a lower bound keeps its mark, and one nothing measured is left out,
	// since the line's own coverage unit already says calls went unreported.
	const contextFigure = usageFigure(row.telemetry?.activity.contextTokens);
	const contextUnit = usageSaysNothing(contextFigure) ? null : theme.fg("body", `context ${contextFigure}`);
	// The phase column: a fleet step says which wave it belongs to and which
	// step it is; every other run leaves the cell empty rather than inventing a
	// position, so the column reads as "not a fleet step" and not as wave zero.
	const phaseCell =
		row.phase === undefined
			? null
			: truncateToWidth(
					`${row.phase.stepId} · wave ${row.phase.wave + 1} of its plan`,
					Math.max(1, contentWidth),
					"…",
					false,
				);
	const fullTask = row.taskSummary
		? cardWrappedValueLines(theme, "task", theme.fg("body", row.taskSummary), contentWidth)
		: [];
	const taskLines =
		options.expanded === true || fullTask.length <= 3
			? fullTask
			: [...fullTask.slice(0, 2), theme.fg("annotation", `… ${options.detailKey ?? "Enter"} detail for full task`)];
	const started = runOriginWords(row);
	const bodyLines = [
		cardUnitsLine(theme, "status", statusUnits, contentWidth),
		...(started === null && row.earlier !== true
			? []
			: [
					cardUnitsLine(
						theme,
						"started",
						[
							...(started === null ? [] : [theme.fg("body", started)]),
							...(row.earlier === true ? [theme.fg("annotation", "recorded before this Clio started")] : []),
						],
						contentWidth,
					),
				]),
	];
	// One current-operation row is useful at a glance; prose and policy expand on demand.
	if (row.progress) {
		const doing = progressActionLine(theme, row.progress, contentWidth, row.routeFirstOutput ?? null);
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
		const label = sanitizeCallTargetText(row.endpoint.label);
		bodyLines.push(
			...cardWrappedValueLines(
				theme,
				"waiting",
				theme.fg(
					"body",
					// The main turn's stream counts and is not gated, so `in use` can pass the
					// limit, and one settling then does not free a slot. The fold keeps the count and Enter explains it.
					options.expanded === true
						? `for a slot on ${label}: ${active} in use against a limit of ${row.endpoint.limit}, the main turn included. It starts once the count is under the limit.`
						: `for a slot on ${label}: ${active} in use, limit ${row.endpoint.limit}`,
				),
				contentWidth,
			),
		);
	}
	if (row.status === "enqueued" && row.endpoint === undefined) {
		bodyLines.push(
			...cardWrappedValueLines(
				theme,
				"waiting",
				// The fold leaves `[x] cancel` to the rail below it.
				theme.fg(
					"body",
					options.expanded === true
						? "for a worker slot. It starts when a running worker finishes, or [x] cancels it."
						: "until a worker slot frees",
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
		...(phaseCell === null ? [] : [cardUnitsLine(theme, "step", [theme.fg("info", phaseCell)], contentWidth)]),
		...(options.expanded === true
			? cardWrappedValueLines(theme, "target", theme.fg("body", route), contentWidth)
			: [targetLine]),
		cardUnitsLine(
			theme,
			"tokens",
			[
				...tokenUnits,
				...(contextUnit !== null ? [contextUnit] : []),
				...(coverage !== null && !nothingMeasured ? [theme.fg("annotation", coverage)] : []),
			],
			contentWidth,
		),
		...trustCardLines(theme, row, contentWidth, options.expanded === true),
	);
	if (row.steerAcknowledgement) {
		bodyLines.push(
			cardUnitsLine(
				theme,
				"control",
				[
					// The worker took the message; whether its model read it before the run ended is the transcript receipt's.
					// A settled run's row cannot tell whether its model read the message; the transcript receipt says which.
					theme.fg(
						"success",
						isTerminalStatus(row.status)
							? `${GLYPH.ok} the worker took your message before the run ended`
							: `${GLYPH.ok} the worker took your message`,
					),
					theme.fg("body", `${row.steerAcknowledgement.chars} chars`),
				],
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
			...cardWrappedValueLines(theme, "limit", theme.fg("body", budgetLimitWords(row.budget)), contentWidth),
		);
	}
	return bodyLines;
}

/** How a worker reached its model, in words, for the runtimes that are not an ordinary model call. */
const RUNTIME_REACH_WORDS: Partial<Record<RunKind, string>> = {
	sdk: "through an agent SDK",
	subprocess: "as a command-line agent",
	"acp-delegation": "delegated to an ACP agent",
};

/** The route as the run's detail card words it, so the dock and the board never name one route two ways. */
function formatRowRoute(row: Pick<DispatchBoardRow, "targetId" | "wireModelId">): string {
	return sanitizeCallTargetText(formatTargetLabel(row.targetId, row.wireModelId, { abbreviate: false }));
}

/** The most of a worker's name an approval's words give way to on the island, so a long name clips first. */
const TASK_ISLAND_APPROVAL_LABEL_ROOM = 14;

/**
 * A status phrase cut to what a narrow row still reads whole: its first clause, then without its trailing clock.
 * `not responding for 9s · Clio stops it in 5s` keeps `not responding`; cutting at the first word left `not`, and
 * `no output for 31s` left `no`, words that say the opposite of what is happening.
 */
function compactStatusWords(words: string, room: number): string {
	const clause = words.split(" · ")[0] ?? words;
	const unclocked = clause.replace(/ for \d[\dhms:.]*$/u, "") || clause;
	if (unclocked.length <= room) return unclocked;
	// Down to the phrase's head word, `waiting` for `waiting on the model`, but never a bare negation.
	const head = unclocked.split(" ");
	return head.slice(0, /^(?:no|not)$/u.test(head[0] ?? "") ? 2 : 1).join(" ");
}

function renderTaskIslandRow(row: DispatchBoardRow, width: number, quota: QuotaProviders): string[] {
	const theme = clioTheme();
	if (row.plan !== undefined) return planIslandLines(theme, row, row.plan, width);
	const weekly = routeWeeklyQuota(row, quota);
	const agentLabel = agentDisplayLabel(row);
	// A queued run has not started, so it has no clock; a run whose telemetry has not arrived yet still has its own.
	const elapsed =
		row.telemetry?.activity.elapsed.display ?? (row.status === "enqueued" ? "" : formatCompactMs(row.elapsedMs));
	const usage = dispatchUsageText(row.usage);
	const cost = usage.cost;

	const dot = dotSep(theme);
	const presentation = dispatchStatusPresentation(row.status, {
		compact: true,
		...(row.status === "running" ? { tick: animationStep(Date.now()) } : {}),
	});
	const failure = completedRunFailure(row);
	const failureMark = completedRunMark(failure);
	const glyph =
		failure !== null
			? theme.fg(failureMark.token, failureMark.glyph)
			: theme.fg(presentation.glyphToken ?? presentation.token, presentation.glyph);
	// A running row says what the run is doing in the inline card's words: the
	// island said `running` beside a card that said `starting` (BT-007).
	// An approval's time left must survive a narrow island, so its words shorten before the row cuts them.
	let statusLabel =
		row.status === "running" && row.progress !== undefined
			? sanitizeCallTargetText(
					workerActivityWords(row.progress, {
						history: row.routeFirstOutput ?? null,
						// Beside the glyph, the name and the clock, each with its separator.
						room:
							width -
							2 -
							dispatchRowPrefix(theme, row).width -
							Math.min(visibleWidth(agentLabel), TASK_ISLAND_APPROVAL_LABEL_ROOM) -
							3 -
							(elapsed.length > 0 ? visibleWidth(elapsed) + 3 : 0),
					}),
				)
			: row.status === "enqueued" && row.endpoint !== undefined
				? `waiting for a slot on ${sanitizeCallTargetText(row.endpoint.label)}`
				: failure !== null
					? `done · ${failure.words}`
					: presentation.label;
	// A narrow row keeps the worker's name over the rest of the phase's words, which the card below still states.
	const nameRoom =
		width -
		2 -
		dispatchRowPrefix(theme, row).width -
		3 -
		visibleWidth(statusLabel) -
		(elapsed.length > 0 ? visibleWidth(elapsed) + 3 : 0);
	if (row.progress?.awaitingApproval !== true && nameRoom < Math.min(visibleWidth(agentLabel), 8)) {
		statusLabel = compactStatusWords(
			statusLabel,
			width -
				2 -
				dispatchRowPrefix(theme, row).width -
				Math.min(visibleWidth(agentLabel), 8) -
				3 -
				(elapsed.length > 0 ? visibleWidth(elapsed) + 3 : 0),
		);
	}
	const statusStr = theme.fg(
		failure !== null
			? failureMark.token
			: row.status === "running" && (row.agentAudience === "shadow" || row.agentAudience === "internal")
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
	const line1 = `${glyph} ${rowPrefix.text}${theme.fg("workerIdentity", clampedLabel)}${dot}${statusStr}${elapsed.length > 0 ? `${dot}${theme.fg("toolMetadata", elapsed)}` : ""}${showPhase ? phaseColumn : ""}`;

	// A queued run has produced nothing yet, so it never carries a throughput.
	const rate = wallTokenRate(row, usage);
	const upFigure = row.usage.kind === "ready" ? usageLineFigure(row.usage.prompt) : compactQuantity(usage.prompt);
	const downFigure = row.usage.kind === "ready" ? usageLineFigure(row.usage.output) : compactQuantity(usage.output);
	// Nothing counted yet reads as that, once, rather than as two question marks.
	const tokens =
		upFigure === null && downFigure === null
			? theme.fg("body", isTerminalStatus(row.status) ? "tokens not measured" : "tokens not measured yet")
			: `${theme.fg("body", `in ${upFigure ?? USAGE_NOT_MEASURED}`)}${dot}${theme.fg(
					"body",
					`out ${downFigure ?? USAGE_NOT_MEASURED}${rate !== null ? ` (${rate}/s)` : ""}`,
				)}`;
	const costUnit =
		cost === "—" ? "" : `${dot}${theme.fg("body", cost === USAGE_NOT_MEASURED ? "cost not measured" : `cost ${cost}`)}`;
	// A narrow dock drops the cost whole before it cuts the token figures, so no unit ends mid-word.
	const telemetryLine = row.retry
		? `  ${theme.fg("warning", `attempt ${row.retry.attempt}`)}${dot}${theme.fg("body", retryCountdown(row.retry))}`
		: visibleWidth(`  ${tokens}${costUnit}`) <= width
			? `  ${tokens}${costUnit}`
			: `  ${tokens}`;
	const telemetry = truncateToWidth(telemetryLine, width, GLYPH.ellipsis, false);
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
		// A live run's next step is a control, which /fleet holds; a settled one's is its record.
		...wrapTextWithAnsi(
			theme.fg(
				"annotation",
				isTerminalStatus(row.status)
					? `  /view dispatch:${row.runId}`
					: isDispatchBoardRowSteerable(row)
						? "  /fleet to steer or stop it"
						: "  /fleet to stop it",
			),
			width,
		),
	];
}

/** A settled member's typed answer in the words its own card shows; a live one streams its raw tail. */
function councilMemberTail(row: DispatchBoardRow): string {
	const progress = row.progress;
	if (progress === undefined) return "";
	// A synthesis tail the report reader could not take whole is a cut piece of JSON; the record holds it readably.
	if (row.council?.label === COUNCIL_SYNTHESIS_LABEL && /^\s*[{[]/u.test(progress.tailText)) return "";
	const presented = presentWorkerContractAnswer(
		progress.tailText,
		row.resultContract,
		progress.droppedLines === 0 && progress.droppedBytes === 0,
		progress.settled,
	);
	if (presented !== null) return presented.lines.join("\n");
	return redactStreamingSecretString(progress.tailText, progress.completed === true);
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
	const full = dispatchStatusPresentation(row.status, {
		...(row.status === "running" ? { tick: animationStep(Date.now()) } : {}),
	});
	// A member column words its outcome the way its own run row does, caveat included.
	const caveat = completedRunFailure(row);
	const mark = completedRunMark(caveat);
	const presentation =
		caveat !== null
			? { glyph: mark.glyph, label: caveat.words, token: mark.token }
			: row.status === "completed"
				? { ...full, label: "done" }
				: full;
	return {
		runId: row.runId,
		label: council.label,
		...(council.color !== undefined ? { color: council.color } : {}),
		round: council.round,
		route: formatRowRoute(row),
		status: { ...presentation },
		// Each line of the answer stays its own line: one flattened paragraph ran a claim into its citation.
		tailText: sanitizeMultilineDisplayText(councilMemberTail(row)).text,
		droppedLines: row.progress?.droppedLines ?? 0,
		...(isTerminalStatus(row.status) ? { settled: true } : {}),
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
	const aggregateStatus = aggregate?.[0] ?? "running";
	const aggregatePresentation = dispatchStatusPresentation(aggregateStatus, {
		...(aggregateStatus === "running" ? { tick: animationStep(Date.now()) } : {}),
	});
	const presentation =
		aggregateStatus === "completed" ? { ...aggregatePresentation, label: "done" } : aggregatePresentation;
	const task = rows.find(
		(row) => row.taskSummary !== undefined && row.council?.label !== COUNCIL_SYNTHESIS_LABEL,
	)?.taskSummary;
	const members = [...newest.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		// biome-ignore lint/style/noNonNullAssertion: every entry was inserted with its own council badge.
		.map(([, row]) => councilMemberView(row, row.council!));
	// The synthesis run seals the whole council as one report. Its members' answers are already the columns above it,
	// so the board reads only the council's own answer out of it, and a council that only collected has none to show.
	const report =
		synthesisRow !== null && isTerminalStatus(synthesisRow.status)
			? parseCouncilReport(synthesisRow.progress?.tailText ?? null)
			: null;
	const collected = report?.synthesis.kind === "none";
	const synthesis =
		synthesisRow === null || collected
			? null
			: {
					// biome-ignore lint/style/noNonNullAssertion: the synthesis row was matched on its own council badge.
					...councilMemberView(synthesisRow, synthesisRow.council!),
					...(report !== null
						? { tailText: sanitizeMultilineDisplayText(councilSynthesisLines(report).join("\n")).text, droppedLines: 0 }
						: {}),
				};
	const selectedInGroup =
		selectedRunId != null && rows.some((row) => row.runId === selectedRunId) ? selectedRunId : undefined;
	return {
		group,
		members,
		synthesis,
		...(collected && report !== null ? { collectedNote: councilCollectedWords(report) } : {}),
		status: { ...presentation },
		...(task !== undefined ? { task: sanitizeCallTargetText(task) } : {}),
		round,
		elapsed: formatCompactMs(elapsedMs),
		...(selectedInGroup !== undefined ? { selectedRunId: selectedInGroup } : {}),
		...(rows.length > 0 && rows.every((row) => row.earlier === true) ? { earlier: true as const } : {}),
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

function itemFromEarlierSession(item: DispatchBoardItem): boolean {
	return item.kind === "run" ? item.row.earlier === true : item.group.earlier === true;
}

/** The rule over the runs an earlier Clio recorded: dim, named and counted, so it reads without colour too. */
function earlierSessionsRule(theme: ClioTheme, count: number, width: number): string {
	const rule = GLYPH.innerDivider;
	const text = truncateToWidth(
		`${rule}${rule} earlier sessions · ${count} run${count === 1 ? "" : "s"} `,
		width,
		GLYPH.ellipsis,
		false,
	);
	return theme.fg("annotation", `${text}${rule.repeat(Math.max(0, width - visibleWidth(text)))}`);
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
	return figure === "unknown" ? "—" : figure;
}

const USAGE_SHORT: Readonly<Record<string, string>> = { "not available": "n/a" };

export { USAGE_NOT_MEASURED } from "./usage-words.js";
export const USAGE_NO_CALLS = "no calls yet";

function firstLine(text: string): string {
	const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
	return sanitizeCallTargetText(line.trim());
}

/** What marks a run that finished as not to be leaned on, so its row cannot read as a plain success. */
const COUNCIL_SYNTHESIS_AGENT = "council-synthesis";

/** A council by its size; one whose members are past the board's history reads as a council alone. */
function councilName(group: Pick<CouncilGroupView, "members">): string {
	return group.members.length === 0 ? "council" : `council of ${group.members.length}`;
}

function completedRunFailure(
	row: Pick<DispatchBoardRow, "status" | "trust" | "completion" | "council" | "agentId">,
): CompletedRunCaveat | null {
	if (row.status !== "completed") return null;
	// A council synthesis composes its members' answers without tools by design, so no-tools says nothing there.
	const synthesizes = row.council?.label === COUNCIL_SYNTHESIS_LABEL || row.agentId === COUNCIL_SYNTHESIS_AGENT;
	const { toolCalls, ...completion } = row.completion ?? {};
	return completedRunCaveat({
		...(row.trust !== undefined ? { trust: row.trust } : {}),
		...completion,
		...(toolCalls !== undefined && !synthesizes ? { toolCalls } : {}),
	});
}

/** Who started a run, in words, because the row's glyph only implies it. */
function runOriginWords(row: Pick<DispatchBoardRow, "requestOrigin">): string | null {
	switch (row.requestOrigin) {
		case "user":
			return "by you";
		case "agent":
			return "by the main agent";
		case "harness":
			return "by Clio on your behalf";
		case "internal":
			return "by Clio";
		default:
			return null;
	}
}

const NARROW_STATUS_WIDTH = 100;
const COMPACT_CAVEAT_WORD: Readonly<Record<CompletedRunCaveat["kind"], string>> = {
	against: "failed",
	refused: "done",
	"no-tools": "no tools",
};

/** The status cell: the outcome glyph in its tone, then the word, the same pair every surface uses. */
function runStatusCell(theme: ClioTheme, row: DispatchBoardRow, tick: number | undefined, width: number): string {
	const failure = completedRunFailure(row);
	// The caveat replaces `done` rather than trailing it: the mark already says the run finished, and the status
	// column stays narrow enough that the task beside it still reads.
	if (failure !== null) {
		const mark = completedRunMark(failure);
		// Below a hundred columns the cell keeps the worker card header's one word, so the agent column survives; the
		// detail under the table states the caveat whole.
		const words =
			width >= NARROW_STATUS_WIDTH
				? failure.words
				: failure.kind === "refused"
					? `${row.completion?.refusedCalls ?? 1} refused`
					: COMPACT_CAVEAT_WORD[failure.kind];
		return theme.fg(mark.token, `${mark.glyph} ${words}`);
	}
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
		return { text: planProgressText(row.plan, true), ...(row.plan.state === "failed" ? { tone: "error" as const } : {}) };
	}
	const task = row.taskSummary ? sanitizeCallTargetText(row.taskSummary) : null;
	switch (row.status) {
		case "running":
		case "stale":
		case "cancelling": {
			// The worker is being stopped; its last phase would read as work finishing normally.
			if (row.status === "cancelling") return { text: "stopping", tone: "warning" };
			const progress = row.progress;
			if (progress) {
				if (progress.awaitingApproval === true) return { text: approvalWaitWords(progress), tone: "warning" };
				if (progress.currentAction) return { text: theme.base("body", actionPhrase(progress.currentAction, "running")) };
				const words = sanitizeCallTargetText(workerActivityWords(progress, { history: row.routeFirstOutput ?? null }));
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
					: "waiting for a worker slot",
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
	const anyNode = options.compact !== true && runs.some((row) => row.node !== undefined && row.node !== "local");
	const anyAccount = runs.some((row) => routeWeeklyQuota(row, quota) !== null);
	const fixed: TableColumn[] = [
		...(cursor ? [{ label: "", min: 1, max: 1, priority: 10 }] : []),
		// Under sixty columns one long state (`✗ stopped responding`) would set the column for every row and leave the
		// names a stub, so the column keeps the common words whole and cuts a long one on the ellipsis; the selected
		// run's detail under the table states it in full.
		{ label: "status", priority: 10, ...(width < 60 ? { max: 11 } : {}) },
		{ label: "agent", priority: 9, max: 30 },
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
			// The group id is the record's; a person knows the council by its size and its question.
			const name = councilName(group);
			const cells: Array<string | TableCell> = [];
			if (cursor) cells.push(selected ? theme.fg("selectedOption", GLYPH.cursor) : " ");
			cells.push(
				`${theme.fg(group.status.glyphToken ?? group.status.token, group.status.glyph)} ${theme.fg(group.status.token, group.status.label)}`,
				selected ? theme.style("selectedOption", name, { bold: true }) : theme.fg("dispatchAction", name),
			);
			if (anyNode) cells.push("");
			cells.push(group.elapsed, "", "", "");
			if (anyAccount) cells.push("");
			cells.push({
				// A one-round council has no round worth naming; a synthesis is the council's own answer, so it says so.
				text: [
					...(group.task === undefined ? [] : [group.task]),
					...(group.round > 1 ? [`round ${group.round}`] : []),
					...(group.synthesis === null ? [] : ["with a synthesis"]),
				].join(" · "),
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
				runStatusCell(theme, row, options.tick, width),
				`${prefix.text}${selected ? theme.style("selectedOption", label, { bold: true }) : theme.fg("workerIdentity", label)}`,
			);
			if (anyNode) cells.push("");
			// A plan's workers have their own rows, so its row sums nothing a reader could mistake for measured.
			cells.push(elapsed, "", "", { text: row.plan.costText ?? "no model calls", tone: "muted" });
			if (anyAccount) cells.push("");
			cells.push(runActivityCell(theme, row, now));
			return cells;
		}
		const figure = (label: string, text: string): TableCell =>
			pending
				? { text: USAGE_SHORT[text] ?? text, tone: "muted" }
				: { text: label ? `${label} ${tableFigure(text)}` : text };
		const cells: Array<string | TableCell> = [];
		if (cursor) cells.push(selected ? theme.fg("selectedOption", GLYPH.cursor) : " ");
		// A plan step's worker carries its step on its name, `coder · map-stats`: as a column of its own the step was
		// the first thing a row under 130 columns dropped, which left two workers of one plan reading the same.
		const step = row.phase === undefined ? "" : theme.fg("info", ` · ${sanitizeCallTargetText(row.phase.stepId)}`);
		cells.push(
			runStatusCell(theme, row, options.tick, width),
			`${prefix.text}${selected ? theme.style("selectedOption", label, { bold: true }) : theme.fg("workerIdentity", label)}${step}`,
		);
		if (anyNode) cells.push(row.node ?? "local");
		// Unmeasured and not started are different facts, and the cost cell is wide enough to say which.
		const costCell: TableCell = pending
			? {
					// A finished run's calls are in the session that ran it, so `no calls yet` would be false here.
					text:
						row.usage.kind === "unavailable"
							? USAGE_NOT_MEASURED
							: isTerminalStatus(row.status)
								? row.earlier === true && row.status === "completed"
									? "earlier session"
									: row.status === "completed"
										? USAGE_NOT_MEASURED
										: "no calls here"
								: USAGE_NO_CALLS,
					tone: "muted",
				}
			: figure("", usage.cost);
		cells.push(elapsed, figure("in", usage.prompt), figure("out", usage.output), costCell);
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
	// The run's name is what a narrow row is read by, so it shrinks into the room the status leaves before it would
	// be dropped: a board of bare `● running` rows says nothing about which run is which.
	const agentIndex = fixed.findIndex((column) => column.label === "agent");
	const lead = fixed
		.slice(0, agentIndex)
		.reduce(
			(sum, column, index) =>
				sum +
				Math.min(
					column.max ?? Number.POSITIVE_INFINITY,
					Math.max(0, ...rows.map((cells) => visibleWidth(cellText(cells[index])))),
				) +
				gap,
			0,
		);
	const agentColumn = fixed[agentIndex];
	if (agentColumn !== undefined) agentColumn.max = Math.max(6, Math.min(agentColumn.max ?? 24, width - lead));
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
	// A plan is known by its name; its root id is for the shell command its detail gives.
	if (row.plan !== undefined) return agentDisplayLabel(row);
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
 * that names where the rest is read.
 *
 * Enter asks for the selected run's whole story, so an open detail takes the
 * rows it needs before the table does. The table shrinks to the selected row
 * and the rows around it that still fit, and its position row says how many
 * runs the detail is hiding. `budgetKnown` is false before the frame has
 * granted rows; an open detail then renders whole and the frame's cut marks
 * what is missing.
 */
/** A painted row's text, for reading its shape. */
function stripPaint(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: only the row's escape sequences are removed.
	return text.replace(/\u001b\[[0-9;]*m/gu, "");
}

/** What a column the width dropped holds, in the words the run's detail uses for it. */
const DROPPED_COLUMN_WORDS: Readonly<Record<string, string>> = {
	in: "tokens",
	out: "tokens",
	cost: "cost",
	phase: "plan step",
	node: "node",
	elapsed: "time",
	account: "account",
	activity: "activity",
};

/**
 * The table's dropped-column note, said as where the facts are rather than as column labels: `in, out not shown`
 * named two columns a person never saw, while the selected run's detail under the table states every one of them.
 */
function boardColumnNote(note: string): string {
	const plain = stripPaint(note).replace(/\s+/gu, " ").trim();
	const match = /^\S+\s+(.+?) not shown at this width$/u.exec(plain);
	if (match?.[1] === undefined) return plain;
	const words = [...new Set(match[1].split(", ").map((label) => DROPPED_COLUMN_WORDS[label.trim()] ?? label.trim()))];
	const list = words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
	return `${GLYPH.ellipsis} detail below has ${list}`;
}

function formatDispatchBoardBody(
	rows: ReadonlyArray<DispatchBoardRow>,
	width: number,
	budget: number,
	telemetry: TelemetrySnapshot | undefined,
	selectedRunId: string | null,
	detailExpanded: boolean,
	budgetKnown: boolean,
	detailKey = "Enter",
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
	// One line per run, then any note on the columns this width dropped. The position row counts runs, so the note
	// rides under the window instead of being counted as one, which made the total change with the width.
	const tableLines = runTableRows(items, width, { selectedRunId });
	const table = tableLines.slice(0, items.length);
	const columnNote = boardColumnNote(
		tableLines
			.slice(items.length)
			.map((line) => line.trim())
			.join(" "),
	);
	// On a short board the note would cost the selected run's status row, which says more than which columns left.
	const notes =
		columnNote.length === 0 || budget < 10
			? []
			: [theme.fg("annotation", truncateToWidth(columnNote, width, GLYPH.ellipsis, false))];
	// What an earlier Clio recorded sits under its own rule, so a row from before this process never passes for one
	// of its own at a glance, at any width or without colour.
	const firstEarlier = items.findIndex(itemFromEarlierSession);
	const earlierCount = firstEarlier < 0 ? 0 : items.length - firstEarlier;
	const dividerRows = firstEarlier < 0 ? 0 : 1;
	const item = items[selectedIndex];
	const detail =
		item === undefined
			? null
			: item.kind === "council"
				? {
						title: `${councilName(item.group)}${item.group.task === undefined ? "" : ` · ${item.group.task}`}`,
						meta: item.group.round > 1 ? `round ${item.group.round} · ${item.group.elapsed}` : item.group.elapsed,
						runId: item.group.selectedRunId ?? item.group.members[0]?.runId ?? "",
						body: councilGroupBody(theme, item.group, width),
					}
				: {
						title: runRuleTitle(item.row),
						meta: item.row.telemetry?.activity.elapsed.display ?? formatCompactMs(item.row.elapsedMs),
						runId: item.row.runId,
						body: dispatchCardBody(item.row, width, deriveRunEvidenceState(telemetry, item.row.runId), {
							expanded: detailExpanded,
							detailKey,
							...(item.row.endpoint !== undefined
								? {
										endpointActive: endpointActive[item.row.endpoint.key] ?? 0,
										endpointQueued: endpointQueued[item.row.endpoint.key] ?? 0,
									}
								: {}),
						}),
					};
	// An open detail leaves the table what its body and rule do not need, and
	// never less than the selected row. A table that cannot show every run
	// spends one more row on the position row that counts the rest.
	const detailRows = (detail === null ? 0 : detail.body.length + 1) + notes.length + dividerRows;
	const tableBudget = detailExpanded
		? table.length + detailRows <= budget
			? table.length
			: Math.max(1, Math.min(table.length - 1, budget - detailRows - 1))
		: Math.min(
				table.length,
				Math.max(
					1,
					Math.min(
						Math.max(3, Math.floor(budget / 2) - dividerRows),
						// The selected run keeps its rule, its first rows and the pointer to the rest, however short the board.
						budget - dividerRows - notes.length - 1 - (detail === null ? 0 : Math.min(2, detail.body.length) + 2),
					),
				),
			);
	const [start] = centeredWindow(table.length, selectedIndex, tableBudget);
	const { window, position } = windowRows(table, start, tableBudget);
	const lines = [...window];
	// The rule sits above the first earlier row in view, or tops the window when every row in view is earlier.
	if (firstEarlier >= 0 && firstEarlier < start + window.length) {
		lines.splice(Math.max(0, firstEarlier - start), 0, earlierSessionsRule(theme, earlierCount, width));
	}
	if (position) {
		// One wording at every width and in both views; an open detail adds only how many runs it is hiding.
		const hidden = position.total - (position.end - position.start + 1);
		const keys = [...(detailExpanded ? [`${hidden} hidden while the detail is open`] : []), "↑↓ select"];
		lines.push(positionRow(theme, { ...position, unit: "runs", keys }, width));
	}
	lines.push(...notes);
	if (detail === null) return lines;
	lines.push(sectionRule(theme, width, detail.title, { meta: detail.meta }));
	const room = budget - lines.length;
	if ((detailExpanded && !budgetKnown) || detail.body.length <= room) {
		lines.push(...detail.body);
		return lines;
	}
	if (room <= 0) return lines;
	const kept = detail.body.slice(0, Math.max(0, room - 1));
	const hidden = detail.body.length - kept.length;
	// A fact the cut lands inside of wraps onto the next row, which starts blank under its key; the last row kept
	// then closes with the ellipsis, so `its answer was not in the` never reads as the whole of it.
	const nextRow = detail.body[kept.length];
	const lastKept = kept.at(-1);
	if (lastKept !== undefined && nextRow !== undefined && /^\s/u.test(stripPaint(nextRow)) && nextRow.trim().length > 0) {
		kept[kept.length - 1] = cutRowWithEllipsis(lastKept, width);
	}
	// Pointers drop whole from the end rather than cut, so a `/view` never shows a run id it cannot be typed from.
	const where = [
		`${hidden} more rows`,
		...(detailExpanded ? [] : [`${detailKey} for detail`]),
		`/view dispatch:${detail.runId}`,
	];
	while (where.length > 1 && visibleWidth(`${GLYPH.ellipsis} ${where.join(" · ")}`) > width) where.pop();
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
export interface DispatchBoardView extends Component, RowBudgetedBody, GrowableBody {
	selectedRow(): DispatchBoardRow | null;
	selectPrevious(): void;
	selectNext(): void;
	resetSelection(): void;
	/** Open or close the selected row's worker-progress detail. */
	toggleDetail(): void;
	detailExpanded(): boolean;
	/** Whether Enter on the selected row opens the watch pane instead of its detail. */
	/** Whether `w` can open the watch pane on the selected run. */
	canWatch(): boolean;
	/** Say which rows Enter takes to the watch pane; only a session with a pane host has any. */
	setWatchable(predicate: (row: DispatchBoardRow) => boolean): void;
}

/**
 * The keys Fleet Runs offers for the selected row, without the way out the frame adds. The rail and the board's own
 * key row read this one list, so a key the rail has no room for is named in the body rather than lost (cards r1).
 */
export function dispatchBoardHintEntries(
	board: Pick<DispatchBoardView, "selectedRow" | "detailExpanded" | "canWatch">,
): HintEntry[] {
	const row = board.selectedRow();
	if (row === null) return [];
	const entries: HintEntry[] = [{ key: "↑↓", verb: "select" }];
	const steerable = isDispatchBoardRowSteerable(row);
	// A plan's card already shows every step, so its row has no detail to open or pane to watch.
	if (row.plan === undefined) {
		// A run that can take a message leads with steer and cancel; otherwise detail is what is left to read. A
		// council's detail is its members' answers, which want the rows the table holds.
		entries.push({ key: "Enter", verb: board.detailExpanded() ? "hide detail" : "detail", critical: !steerable });
		// The watch pane splits the terminal, so it says so before the key is pressed.
		if (row.council === undefined && board.canWatch())
			entries.push({ key: "w", verb: "watch in a pane", short: "watch" });
	}
	if (steerable) entries.push({ key: "s", verb: "steer", critical: true });
	if (isDispatchBoardRowCancellable(row)) entries.push({ key: "x", verb: "cancel", critical: true });
	return entries;
}

/**
 * Esc by the shared rule: an open run detail is a layer, so Esc folds it and
 * the board stays; from the table Esc closes the board.
 */
export function dispatchBoardEscapeEntry(board: { detailExpanded(): boolean }): HintEntry {
	return board.detailExpanded() ? { key: "Esc", verb: "hide detail", short: "hide" } : { key: "Esc", verb: "close" };
}

/** The keys the frame's rail drops at this width, as rows under the table; the arrows are on the position row. */
function droppedKeyRows(entries: ReadonlyArray<HintEntry>, width: number, esc: HintEntry): string[] {
	const all: HintEntry[] = [...entries, esc];
	// The frame fits its rail into the body's width less one cell.
	const { kept } = fitHintEntryList(all, width - 1);
	// Splitting off a watch pane from a terminal this narrow leaves two unreadable halves, so the key goes unadvertised
	// there and the keys that act on the run fit one row.
	const dropped = all.filter(
		(entry) => !kept.includes(entry) && entry.key !== "↑↓" && !(entry.key === "w" && width < 50),
	);
	if (dropped.length === 0) return [];
	const theme = clioTheme();
	// Keys wrap between entries, never inside one, so a narrow board names every key it takes. Each row sits flush
	// right, over the rail's own keys, so the two read as one key rail in two rows rather than as loose body text.
	const room = Math.max(1, width - 1);
	const rows: string[] = [];
	let current = "";
	for (const entry of dropped) {
		const unit = `[${keyName(entry.key)}] ${entry.short ?? entry.verb}`;
		const joined = current.length === 0 ? unit : `${current} · ${unit}`;
		if (current.length > 0 && visibleWidth(joined) > room) {
			rows.push(current);
			current = unit;
		} else current = joined;
	}
	if (current.length > 0) rows.push(current);
	return rows.map((row) => {
		const shown = truncateToWidth(row, room, GLYPH.ellipsis, false);
		return `${" ".repeat(Math.max(0, room - visibleWidth(shown)))}${theme.fg("keyboardHint", shown)}`;
	});
}

export function createDispatchBoardView(
	rows: () => ReadonlyArray<DispatchBoardRow>,
	telemetry: () => TelemetrySnapshot | undefined,
): DispatchBoardView {
	let selectedRunId: string | null = null;
	// Detail is a property of the operator's attention, not of a run, so it
	// follows the cursor rather than pinning to the row it was opened on.
	let expanded = false;
	let watchable: (row: DispatchBoardRow) => boolean = () => false;
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

	const view: DispatchBoardView = {
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
			const keyRows = droppedKeyRows(dispatchBoardHintEntries(view), safeWidth, dispatchBoardEscapeEntry(view));
			const key = `${safeWidth}|${budget}|${selectedRunId}|${expanded}|${skinEpoch()}|${clock}|${evidence}|${keyRows.join("/")}|${currentRows.map(rowSignature).join(";")}`;
			if (memo?.key === key) return memo.lines;
			const body = formatDispatchBoardBody(
				currentRows,
				safeWidth,
				Math.max(1, budget - keyRows.length),
				snapshot,
				selectedRunId,
				expanded,
				bodyRows > 0,
			);
			const lines = currentRows.length === 0 ? body : [...body, ...keyRows];
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
			// A plan's card already shows every step and its hint offers no Enter; a silent toggle there opened the next
			// run's detail the moment the cursor moved onto it.
			const row = normalizeSelection(rows());
			if (row === null || row.plan !== undefined) return;
			expanded = !expanded;
		},
		detailExpanded(): boolean {
			return expanded;
		},
		wantsGrowth(): boolean {
			return expanded;
		},
		canWatch(): boolean {
			const row = normalizeSelection(rows());
			return row !== null && watchable(row);
		},
		setWatchable(predicate: (row: DispatchBoardRow) => boolean): void {
			watchable = predicate;
			memo = null;
		},
		invalidate(): void {
			memo = null;
		},
	};
	return view;
}

const HIDDEN_RUNS_NAMED = 3;

/** What the runs off the card are doing, so a queued or failed one is not hidden behind a count. */
function hiddenRunsSummary(hidden: ReadonlyArray<DispatchBoardItem>): string {
	const counts = new Map<string, number>();
	for (const item of hidden) {
		const label =
			item.kind === "council"
				? item.group.status.label
				: item.row.progress?.awaitingApproval === true
					? "asking"
					: dispatchStatusPresentation(item.row.status).label;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	const states = [...counts].map(([label, count]) => `${count} ${label}`).join(" · ");
	// One state alone is the whole count: `+ 1 more · 1 queued` reads as two runs.
	if (counts.size > 1) return `+ ${hidden.length} more · ${states} · /fleet`;
	// A few runs off the card are named, because a count sends the reader to /fleet just to learn which.
	const named = hidden.flatMap((item) => (item.kind === "run" ? [sanitizeCallTargetText(item.row.agentId)] : []));
	return named.length === hidden.length && named.length <= HIDDEN_RUNS_NAMED
		? `+ ${states} · ${[...new Set(named)].join(", ")} · /fleet`
		: `+ ${states} · /fleet`;
}

/**
 * A run the operator's fleet surfaces show. Helper runs are Clio's own and stay off them, but a council member runs in
 * the helper audience while answering the operator's own /council question, so it counts: without it a running
 * council left the dock and the rail empty.
 */
function isOperatorFleetRun(row: Pick<DispatchBoardRow, "agentAudience" | "council">): boolean {
	return row.council !== undefined || !isHelperRun(row);
}

/**
 * The live runs a summary surface counts: a running plan already names the steps it is running, so the workers those
 * steps started are its own and not more work beside it. Counted apart they read `+ 2 running` under the plan that
 * listed them.
 */
export function summaryFleetRuns(rows: ReadonlyArray<DispatchBoardRow>): DispatchBoardRow[] {
	const operator = rows.filter(isOperatorFleetRun);
	const planLive = operator.some((row) => row.plan !== undefined && !isTerminalStatus(row.status));
	// A step's worker waiting on the operator stays: that wait is the part that blocks the plan.
	return planLive
		? operator.filter(
				(row) => row.plan !== undefined || row.phase === undefined || row.progress?.awaitingApproval === true,
			)
		: operator;
}

export function formatTaskIslandLines(
	rows: ReadonlyArray<DispatchBoardRow>,
	maxRows = 4,
	quota: QuotaProviders = [],
	contentWidth = TASK_ISLAND_WIDTH,
): string[] {
	// Councils are folded before the row cap, so a five-member council costs the
	// island one card and never crowds out the runs beside it.
	const items = dispatchBoardItems(summaryFleetRuns(rows));
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
	return frame(clioTheme(), "Fleet Runs", body, contentWidth + 4);
}

/**
 * The fleet dock on a short terminal: one row per run, at most two, then what the rest are doing, then where the
 * controls are. The full card there repeated the inline worker card sitting just above it and pushed the transcript
 * off a 24-row screen; this keeps what the dock alone gives, a run that stays in view after its card scrolls away.
 */
export function formatFleetDockRows(
	rows: ReadonlyArray<DispatchBoardRow>,
	width: number,
	quota: QuotaProviders = [],
	maxRuns = 2,
): string[] {
	const theme = clioTheme();
	const items = dispatchBoardItems(summaryFleetRuns(rows));
	if (items.length === 0) return [];
	const room = Math.max(1, width - 2);
	const shown = items.slice(0, Math.max(1, maxRuns));
	const lines = shown.map((item) => {
		const head =
			item.kind === "council"
				? councilIslandLines(theme, item.group, room)[0]
				: renderTaskIslandRow(item.row, room, quota)[0];
		return `  ${truncateToWidth((head ?? "").trimEnd(), room, GLYPH.ellipsis, false)}`;
	});
	const hidden = items.slice(shown.length);
	const steerable = items.some((item) => item.kind === "run" && isDispatchBoardRowSteerable(item.row));
	const pointer = steerable ? "/fleet to steer or stop" : "/fleet to stop or inspect";
	const tail = hidden.length > 0 ? `${hiddenRunsSummary(hidden).replace(/ · \/fleet$/u, "")} · ${pointer}` : pointer;
	const last = lines.length - 1;
	const joined = `${lines[last]}${dotSep(theme)}${theme.fg("annotation", tail)}`;
	if (hidden.length === 0 && visibleWidth(joined) <= width) lines[last] = joined;
	else lines.push(`  ${theme.fg("annotation", truncateToWidth(tail, room, GLYPH.ellipsis, false))}`);
	return lines;
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
	return parseOptionalDetail(row.outcomeDetail)?.replace(/^dispatch:\s*/u, "") ?? null;
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
		...(entry.taskSummary !== undefined ? { taskSummary: fleetNodeTaskBrief(entry.taskSummary) } : {}),
		...(entry.budget !== undefined ? { budget: entry.budget } : {}),
		status: entry.status,
		elapsedMs: entry.durationMs ?? Math.max(0, (entry.finishedAtMs ?? now) - entry.startedAtMs),
		settledAtMs: entry.finishedAtMs ?? entry.startedAtMs,
		usage,
		ttft,
		...(entry.outcomeDetail !== undefined ? { outcomeDetail: entry.outcomeDetail } : {}),
		...(entry.node !== undefined ? { node: entry.node } : {}),
		...(entry.gate !== undefined ? { gate: { ...entry.gate } } : {}),
		...(entry.council !== undefined ? { council: { ...entry.council } } : {}),
		...(entry.hostVerification !== undefined ? { hostVerification: entry.hostVerification } : {}),
		...(entry.trust !== undefined ? { trust: entry.trust } : {}),
		...(entry.validationFailure !== undefined ? { validationFailure: entry.validationFailure } : {}),
		...(entry.completion !== undefined ? { completion: { ...entry.completion } } : {}),
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
	cancelling: "cancelling",
	cancelled: "aborted",
	passed: "completed",
	failed: "failed",
	unsettled: "stale",
};

/** The plan with each agent step's worker run read in, so a step never says less than that run's own row. */
function planWithWorkers(plan: FleetPlanRunView, workers: ReadonlyMap<string, DispatchBoardRow>): FleetPlanRunView {
	if (!plan.steps.some((step) => step.runId !== undefined && workers.has(step.runId))) return plan;
	return {
		...plan,
		steps: plan.steps.map((step) => {
			const row = step.runId === undefined ? undefined : workers.get(step.runId);
			if (row === undefined) return step;
			const caveat = completedRunFailure(row);
			return { ...step, worker: { settled: isTerminalStatus(row.status), caveat: caveat?.words ?? null } };
		}),
	};
}

/** The plan as its settled card reads it, with each step's worker run from these rows. */
export function planWithWorkerRows(plan: FleetPlanRunView, rows: ReadonlyArray<DispatchBoardRow>): FleetPlanRunView {
	return planWithWorkers(plan, new Map(rows.map((row) => [row.runId, row])));
}

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
		settledAtMs: plan.finishedAtMs ?? plan.startedAtMs,
		...(plan.earlier === true ? { earlier: true as const } : {}),
		usage: UNAVAILABLE,
		ttft: null,
		lastContextTokens: null,
		plan,
	};
}

/**
 * The board's one order: runs still going first, in the order a person acts on them, then settled runs newest first
 * whatever their outcome. Opening the board puts the cursor on the first row, so that row is the run the operator
 * most likely came for; ordering settled runs by outcome put an old failure above the run that just finished.
 */
function boardOrder(rows: ReadonlyArray<DispatchBoardRow>): DispatchBoardRow[] {
	const live = (row: DispatchBoardRow): boolean => !isTerminalStatus(row.status);
	return [...rows].sort((a, b) => {
		if (live(a) !== live(b)) return live(a) ? -1 : 1;
		// A running plan leads the workers its steps started, so the board reads plan, then its steps' runs.
		if (live(a))
			return (
				STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
				Number(b.plan !== undefined) - Number(a.plan !== undefined) ||
				(b.settledAtMs ?? 0) - (a.settledAtMs ?? 0)
			);
		return (b.settledAtMs ?? 0) - (a.settledAtMs ?? 0);
	});
}

/** The board keeps display order and reads every run fact from telemetry; tokens and cost from its read model. */
export function createDispatchBoardStore(
	projection: Pick<TelemetryContract, "snapshot" | "subscribe" | "reconcileRuns" | "setFleetPhase" | "read">,
	readDurablePlans?: () => ReadonlyArray<FleetPlanRunView>,
	readDurableRuns?: () => ReadonlyArray<DispatchBoardRow>,
	/** A settled run's usage from its own record, for a run this session's journal never referenced, such as a plan step. */
	readRecordedUsage?: (runId: string) => DispatchRunUsage,
): {
	rows(): ReadonlyArray<DispatchBoardRow>;
	activeRows(): ReadonlyArray<DispatchBoardRow>;
	/** What the fleet card shows: plans running now, then the active workers. */
	liveRows(): ReadonlyArray<DispatchBoardRow>;
	/** Every worker run, without the plan rows: what a count or usage of workers reads. */
	workerRows(): ReadonlyArray<DispatchBoardRow>;
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
	// Settled workers from before this process, read once like the durable plans; a run this process folds outranks it.
	let earlierRuns: ReadonlyArray<DispatchBoardRow> | null = null;
	const historyRows = (): ReadonlyArray<DispatchBoardRow> => {
		if (earlierRuns === null) {
			try {
				earlierRuns = readDurableRuns?.() ?? [];
			} catch {
				// An unreadable ledger costs the history, never the board.
				earlierRuns = [];
			}
		}
		const live = new Set(current.runs.map((run) => run.runId));
		const view = projection.read?.live() ?? null;
		return earlierRuns
			.filter((row) => !live.has(row.runId))
			.map((row) => {
				const telemetry = view?.run(row.runId) ?? null;
				return telemetry === null
					? row
					: { ...row, usage: dispatchRunUsage(view, row.runId), ttft: dispatchRunTtft(view, row.runId), telemetry };
			});
	};
	// Read once per settled run: its record no longer changes, and a repaint must not read the disk.
	const recorded = new Map<string, DispatchRunUsage>();
	const settledUsage = (runId: string, usage: DispatchRunUsage): DispatchRunUsage => {
		if (usage.kind !== "pending" || readRecordedUsage === undefined) return usage;
		let found = recorded.get(runId);
		if (found === undefined) {
			try {
				found = readRecordedUsage(runId);
			} catch {
				// An unreadable record leaves the usage pending, which the row already words.
				found = usage;
			}
			recorded.set(runId, found);
		}
		return found.kind === "ready" ? found : usage;
	};
	const projectRows = (activeOnly: boolean): ReadonlyArray<DispatchBoardRow> => {
		const view = projection.read?.live() ?? null;
		return [...current.runs]
			.reverse()
			.sort(
				(a, b) =>
					STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
					(b.finishedAtMs ?? b.startedAtMs) - (a.finishedAtMs ?? a.startedAtMs),
			)
			.map((run) => {
				const live = dispatchRunUsage(view, run.runId);
				const usage = isTerminalStatus(run.status) ? settledUsage(run.runId, live) : live;
				const row = toRow(run, current.generatedAt, usage, dispatchRunTtft(view, run.runId));
				return {
					...row,
					telemetry: view?.run(run.runId) ?? null,
					...(row.status === "running"
						? { routeFirstOutput: routeFirstOutput(view, row.targetId, row.wireModelId, "worker") }
						: {}),
				};
			})
			.filter((row) => !activeOnly || !isTerminalStatus(row.status));
	};
	return {
		plans,
		rows() {
			const workers = projectRows(false);
			const byRun = new Map(workers.map((row) => [row.runId, row]));
			const planRows = plans.runs().map((plan) => fleetPlanRow(planWithWorkers(plan, byRun), Date.now()));
			const earlier = historyRows();
			if (planRows.length === 0 && earlier.length === 0) return boardOrder(workers);
			// This process's runs lead; what an earlier Clio recorded follows as its own section, newest first.
			return [
				...boardOrder([...workers, ...planRows.filter((row) => row.earlier !== true)]),
				...boardOrder([...planRows.filter((row) => row.earlier === true), ...earlier]),
			];
		},
		activeRows: () => projectRows(true),
		liveRows: () => {
			const live = plans.live();
			if (live.length === 0) return projectRows(true);
			const byRun = new Map(projectRows(false).map((row) => [row.runId, row]));
			return [...live.map((plan) => fleetPlanRow(planWithWorkers(plan, byRun), Date.now())), ...projectRows(true)];
		},
		workerRows: () => projectRows(false),
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
