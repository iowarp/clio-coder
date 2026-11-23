import type { OutputStyle } from "../core/defaults.js";
import { type BoardColumn, type BoardFact, tierPolicy, tierRevision } from "../core/presentation-tier.js";
import type { FactMetric, Quantity, RunTelemetryV1 } from "../core/telemetry/dto.js";
import { factRef } from "../core/telemetry/dto.js";
import { parseCouncilReport } from "../domains/agents/index.js";
import type { AgentAudience } from "../domains/agents/spec.js";
import type { RecordedRunToolBudgetEnvelope } from "../domains/dispatch/budget-envelope.js";
import { budgetLimitWords } from "../domains/dispatch/budget-envelope.js";
import type { CompletedRunCaveat } from "../domains/dispatch/failure-headline.js";
import {
	completedRunCaveat,
	NEVER_STARTED_WORDS,
	workerFailureHeadline,
} from "../domains/dispatch/failure-headline.js";
import { fleetNodeTaskBrief } from "../domains/dispatch/fleet-node-prompt.js";
import type { DispatchRequestOrigin, RunKind } from "../domains/dispatch/types.js";
import { runKindSupportsLiveSteering } from "../domains/dispatch/types.js";
import { describeWriteBoundaryAttributionDowngrade } from "../domains/dispatch/write-boundary.js";
import type { TrustSummaryProjection, TrustVerdict } from "../domains/evidence/trust-projection.js";
import { plainTrustVerdict } from "../domains/evidence/trust-projection.js";
import { foregroundStreamUsage } from "../domains/providers/index.js";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../domains/safety/call-target.js";
import { redactStreamingSecretString } from "../domains/safety/redaction.js";
import type { TelemetryContract, TelemetryRunSummary, TelemetryView } from "../domains/telemetry/contract.js";
import type { TelemetrySnapshot } from "../domains/telemetry/index.js";
import {
	isStructuredAnswerText,
	type WorkerAction,
	type WorkerProgressSnapshot,
} from "../domains/telemetry/worker-progress.js";
import type { Component } from "../engine/tui.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { COUNCIL_SYNTHESIS_LABEL } from "../session-control/council.js";
import { isHelperRun } from "../session-control/worker-stream.js";
import { cardRail, cardRows } from "./card.js";
import type { CouncilGroupView, CouncilMemberView } from "./council-grid.js";
import { councilGroupBody } from "./council-grid.js";
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
import { confirmOnceRail } from "./overlays/confirm-once.js";
import type { QuotaProviders } from "./quota-view.js";
import { routeWeeklyQuota } from "./quota-view.js";
import {
	type CommitPlacement,
	councilAnswerGist,
	councilCollectedWords,
	councilSynthesisLines,
	exactWorkerAnswerObject,
	liveWorkerAnswerText,
	presentSettledWorkerAnswer,
	presentWorkerContractAnswer,
} from "./renderers/worker-answer.js";
import type { ClioTheme, ClioToken } from "./theme/index.js";
import {
	animationStep,
	clioTheme,
	dotSep,
	emptyState,
	fitUnits,
	formatCount,
	formatElapsed,
	formatTargetLabel,
	functionText,
	GLYPH,
	padAnsi,
	positionRow,
	sectionRule,
	spinnerFrame,
	type TableCell,
	type TableColumn,
	tableRows,
	toneRole,
	toolFunction,
	widthClass,
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
	finishedActionFault,
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
	budget?: RecordedRunToolBudgetEnvelope;
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
	/** Another Clio process owns the run: it takes no steering from here, and a cancel goes to its owner as a request. */
	foreign?: true;
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
	completion?: { toolCalls?: number; refusedCalls?: number; guardedCalls?: number; contract?: string };
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
	/** Where a settled run's proposed commit lands; absent when the board has not read the run's result. */
	commitPlacement?: CommitPlacement;
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
/** The fact separator, from the glyph table so ASCII mode replaces it. */
const SEP = ` ${GLYPH.sep} `;
const PENDING_USAGE: DispatchUsageText = {
	prompt: GLYPH.none,
	output: GLYPH.none,
	total: GLYPH.none,
	cost: GLYPH.none,
	measuredOutput: null,
};

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

/** Live HTTP/SDK rows are the only rows whose runtime can consume operator guidance. */
export function isDispatchBoardRowSteerable(row: DispatchBoardRow): boolean {
	return (
		row.plan === undefined &&
		// Steering reaches only a worker this process holds the input channel of.
		row.foreign !== true &&
		runKindSupportsLiveSteering(row.runtimeKind) &&
		// A queued run has no worker yet, and a stale one has stopped answering, so a message would reach no one. A
		// stale worker that speaks again is running again, and takes messages again.
		row.status === "running"
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
			// The card and the strip say stopping while the process exits, so the board's status cell does too.
			return { glyph: GLYPH.cancelled, label: "stopping", token: "warning" };
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
// separator join, the one `fitUnits` draws; an overflowing one is refit unit-by-unit so it closes on a
// whole unit or a dim ellipsis instead of a mid-token clip that reads as a
// complete fact ("total 5" for 5.2k) or a dangling ` · `.
function cardUnitsLine(theme: ClioTheme, key: string, units: ReadonlyArray<string>, contentWidth: number): string {
	const prefix = cardKvKey(theme, key);
	const full = `${prefix}${units.join(theme.fg("divider", SEP))}`;
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
	return remainingMs === 0 ? "now" : `in ${formatElapsed(remainingMs)}`;
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
	const fault = finishedActionFault(action);
	const failure = fault === null ? "" : theme.fg(fault.tone, ` ${GLYPH.error} ${fault.words}`);
	return `${verb}${object}${tool}${failure}`;
}

/** The phase word an expanded card names, or null for a phase that says nothing new. */
function progressPhaseUnit(theme: ClioTheme, progress: WorkerProgressSnapshot): string | null {
	// The phase only, in the words the dock and the inline card use. Reasoning content never reaches an operator surface.
	if (progress.verification === undefined && (progress.phase === "settled" || progress.phase === "starting"))
		return null;
	const [glyph, words] = workerPhaseActivity(progress);
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
	run: Pick<DispatchBoardRow, "resultContract" | "trust" | "commitPlacement">,
	maxRows = WORKER_PROGRESS_CARD_ROWS,
): string[] {
	if (progress.tailText.length === 0) return [];
	const gutter = CARD_KV_KEY_WIDTH + 1;
	const railWidth = Math.max(1, contentWidth - gutter - 2);
	const complete = progress.droppedLines === 0 && progress.droppedBytes === 0;
	const presented = progress.settled
		? presentSettledWorkerAnswer(
				progress.tailText,
				run.resultContract,
				run.trust?.axes.artifactIntegrity === "verified",
				complete,
				run.commitPlacement,
			)
		: null;
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
		body.push(`${rail}${theme.fg("annotation", truncateToWidth(facts.join(SEP), railWidth, GLYPH.ellipsis, false))}`);
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
	const host =
		row.hostVerification === undefined ? "" : `${SEP}${theme.fg("body", `host checks ${row.hostVerification}`)}`;
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
					`${theme.fg("body", row.validationFailure)}${theme.fg("annotation", `${SEP}/view dispatch:${row.runId}`)}`,
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

/** Steps whose worker finished with a caveat its own card marks as a warning, such as a refused call. */
export function planWarnedStepCount(plan: FleetPlanRunView): number {
	return plan.steps.filter((step) => step.state === "passed" && (step.worker?.caveat ?? null) !== null).length;
}

function planProgressText(plan: FleetPlanRunView, statusShown = false, withFailure = true): string {
	const done = plan.steps.filter((step) => step.state === "passed" || step.state === "replayed").length;
	const failed = plan.steps.find((step) => step.state === "failed" && !planStepStopped(plan, step.stepId));
	const live = plan.state === "running" || plan.state === "cancelling";
	const loops =
		live || plan.loops === undefined
			? ""
			: `${SEP}${plan.loops.resolved}/${plan.loops.total} ${plan.loops.total === 1 ? "loop" : "loops"} resolved`;
	const count = `${live ? done : plan.succeededStepCount}/${plan.requiredStepCount} steps${loops}`;
	if (plan.state === "cancelling") {
		const stopping = plan.stoppedStepIds ?? [];
		return `${count}${SEP}${stopping.length > 0 ? `stopping ${stopping.join(", ")}` : "stopping before the next step"}`;
	}
	// Where a status cell already reads cancelled, repeating it on the count only doubles the word.
	if (plan.state === "cancelled") return statusShown ? count : `${count}${SEP}cancelled`;
	if (plan.failure !== undefined) return withFailure ? `${count}${SEP}${planFailureWords(plan)}` : count;
	if (failed !== undefined) return `${count}${SEP}${failed.stepId} failed`;
	const warned = planWarnedStepCount(plan);
	return warned === 0 ? count : `${count}${SEP}${warned} with warnings`;
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
		// The worker's own caveat rides the step, so a step that passed reads the refused call its run's row shows.
		const caveat = stopped ? null : (step.worker?.caveat ?? null);
		// A command step passed its exit check. A worker step only finished: nothing checked its work, and a caveat
		// on it is a warning, as its own card marks it.
		const mark = stopped
			? plan.state === "cancelling" && step.state === "running"
				? { glyph: GLYPH.cancelled, token: "warning" as const, word: "stopping" }
				: { glyph: GLYPH.cancelled, token: "annotation" as const, word: "stopped" }
			: step.state === "passed" && step.worker !== undefined
				? caveat !== null
					? { glyph: GLYPH.warn, token: "warning" as const, word: "finished" }
					: { ...PLAN_STEP_MARKS.passed, word: "done" }
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
		const facts = [
			finishing ? "finishing" : word,
			...(caveat !== null ? [caveat] : []),
			...(detail !== undefined && detail !== caveat ? [detail] : []),
			step.label,
		];
		const lead = `${theme.fg(mark.token, mark.glyph)} ${theme.fg("body", step.stepId.padEnd(nameWidth))}  `;
		return truncateToWidth(
			`${lead}${theme.fg(mark.token, facts[0] ?? "")}${theme.fg("annotation", facts.length > 1 ? `${SEP}${facts.slice(1).join(SEP)}` : "")}`,
			width,
			GLYPH.ellipsis,
			false,
		);
	});
}

function planCardBody(theme: ClioTheme, row: DispatchBoardRow, plan: FleetPlanRunView, contentWidth: number): string[] {
	// Warned worker steps make the plan's status a warning here too, as on its row and its card.
	const presentation =
		plan.state === "passed" && planWarnedStepCount(plan) > 0
			? { glyph: GLYPH.warn, label: "done", token: "warning" as const, glyphToken: undefined }
			: dispatchStatusPresentation(row.status);
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
		// The plan's step-by-step record lives in its event log, which a shell command prints; the row says so, so the
		// id reads as that command's argument rather than as a name.
		...cardWrappedValueLines(
			theme,
			"log",
			theme.fg("annotation", `clio-coder fleet events ${plan.rootId} prints its event log`),
			contentWidth,
		),
	];
}

/** The transcript's settled record of a plan, in the worker card's gutter grammar. */
export function renderFleetPlanCard(plan: FleetPlanRunView, width: number, style: OutputStyle = "standard"): string[] {
	const theme = clioTheme();
	const passed = plan.state === "passed";
	const cancelled = plan.state === "cancelled";
	const rail = cardRail();
	// A plan whose steps all ran but one carries a warning reads as its warned steps do, never as a clean pass.
	const warned = passed && planWarnedStepCount(plan) > 0;
	const tone = warned ? "warning" : passed ? "success" : cancelled ? "toolMetadata" : "error";
	const glyph = warned ? GLYPH.warn : passed ? GLYPH.ok : cancelled ? GLYPH.cancelled : GLYPH.error;
	const head = `${functionText(theme, "dispatch", GLYPH.workerHuman)} ${theme.fg("workerIdentity", `plan ${plan.name}`)}${dotSep(theme)}${theme.fg(tone, `${glyph} ${planProgressText(plan, false, false)}`)}`;
	const room = Math.max(1, width - 4);
	const why = planFailureWords(plan);
	const steps = planStepLines(theme, plan, room);
	const policy = tierPolicy(style);
	const limit = !policy.evidence ? 0 : policy.provenance ? 12 : 4;
	const focus = Math.max(
		0,
		plan.steps.findIndex((step) => step.state === "failed" || step.worker?.caveat != null),
	);
	const start = Math.max(0, Math.min(focus, steps.length - limit));
	const shown = steps.slice(start, start + limit);
	const hidden = steps.length - shown.length;
	return [
		truncateToWidth(head, width, GLYPH.ellipsis, false),
		...(why === null ? [] : cardRows(`${GLYPH.error} ${why}`, width, true, "error")),
		...shown.map((line) => `${rail}${line}`),
		`${rail}${theme.fg("annotation", truncateToWidth(`${hidden > 0 ? `${hidden} more steps${SEP}` : ""}/fleet for detail${!policy.evidence ? "" : `${SEP}${plan.costText === null ? "no model calls" : `cost ${plan.costText}`}`}`, room, GLYPH.ellipsis, false))}`,
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
		style?: OutputStyle;
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
			? theme.fg(failureMark.token, `${failureMark.glyph} ${presentation.label}${SEP}${failure.words}`)
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
		boundMark(row.usage.kind === "ready" ? usageLineFigure(row.usage[key]) : figure(display));
	const tokenDisplays = [usage.prompt, usage.output, usage.total];
	const nothingMeasured = tokenDisplays.every((display) => compactQuantity(display) === null);
	const coverage =
		row.usage.kind === "unavailable" || row.usage.kind === "pending"
			? null
			: usageLineCoverage([
					{ label: "prompt", quantity: row.usage.prompt },
					{ label: "out", quantity: row.usage.output },
				]);
	const tokenUnits = nothingMeasured
		? [theme.fg("body", row.status === "running" || row.status === "enqueued" ? "not measured yet" : USAGE_NOT_MEASURED)]
		: [
				// Label-first words, as the turn receipt says them: `prompt 321 · out 12 · total 333`. The whole prompt,
				// cached reads included, is `prompt`; `in` is the uncached input on every surface (bt-11).
				theme.fg("body", `prompt ${lineFigure("prompt", usage.prompt)}`),
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
		...(cost === GLYPH.none
			? []
			: [theme.fg("body", cost === USAGE_NOT_MEASURED ? "cost not measured" : `cost ${cost}`)]),
	];
	// Context occupancy is a figure like the others: a lower bound keeps its mark, and one nothing measured is left out,
	// since the line's own coverage unit already says calls went unreported.
	const contextFigure = usageFigure(row.telemetry?.activity.contextTokens);
	const contextUnit = usageSaysNothing(contextFigure) ? null : theme.fg("body", `context ${boundMark(contextFigure)}`);
	// The phase column: a fleet step says which wave it belongs to and which
	// step it is; every other run leaves the cell empty rather than inventing a
	// position, so the column reads as "not a fleet step" and not as wave zero.
	const phaseCell =
		row.phase === undefined
			? null
			: truncateToWidth(
					`${row.phase.stepId}${SEP}wave ${row.phase.wave + 1} of its plan`,
					Math.max(1, contentWidth),
					GLYPH.ellipsis,
					false,
				);
	const fullTask = row.taskSummary
		? cardWrappedValueLines(theme, "task", theme.fg("body", row.taskSummary), contentWidth)
		: [];
	const minimal = options.style !== undefined && !tierPolicy(options.style).evidence && options.expanded !== true;
	const taskLines = minimal
		? fullTask.slice(0, 1).map((line) => (fullTask.length > 1 ? cutRowWithEllipsis(line, contentWidth) : line))
		: options.expanded === true || fullTask.length <= 3
			? fullTask
			: [
					...fullTask.slice(0, 2),
					theme.fg("annotation", `${GLYPH.ellipsis} ${options.detailKey ?? "Enter"} detail for full task`),
				];
	const started = runOriginWords(row);
	const bodyLines = [
		cardUnitsLine(theme, "status", statusUnits, contentWidth),
		...(minimal || (started === null && row.earlier !== true)
			? []
			: [
					cardUnitsLine(
						theme,
						"started",
						[
							...(started === null ? [] : [theme.fg("body", started)]),
							...(row.earlier === true ? [theme.fg("annotation", "recorded before this CLIO Coder started")] : []),
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
			bodyLines.push(...progressAnswerLines(theme, row.progress, row.runId, contentWidth, row));
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
		...(!minimal
			? [
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
				]
			: []),
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
		// The provider's call id (`toolu_…`) matches nothing the TUI lists, so the card names the call by its tool and run.
		const warning = describeWriteBoundaryAttributionDowngrade({
			...row.writeRecordDowngrade,
			toolCallId: null,
			runId: row.runId,
			stepId: row.phase?.stepId ?? null,
		});
		// The rule is for the expanded card; the fold says only that the changed-files list may be short.
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
	// A settled member whose typed answer the full presenter could not take still reads as words, never as raw JSON.
	if (progress.settled === true && exactWorkerAnswerObject(progress.tailText) !== null)
		return councilAnswerGist(progress.tailText);
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
	const progress = councilMemberProgress(row);
	return {
		runId: row.runId,
		label: council.label,
		...(council.color !== undefined ? { color: council.color } : {}),
		round: council.round,
		route: formatRowRoute(row),
		status: { ...presentation, ...(progress !== null ? { label: `${presentation.label}${SEP}${progress}` } : {}) },
		// Each line of the answer stays its own line: one flattened paragraph ran a claim into its citation.
		tailText: sanitizeMultilineDisplayText(councilMemberTail(row)).text,
		droppedLines: row.progress?.droppedLines ?? 0,
		...(isTerminalStatus(row.status) ? { settled: true } : {}),
		...memberWhy(row),
	};
}

/**
 * How long a member has run and how much it has produced, so a slow member reads as working rather than stuck. A
 * running member shows the output it has streamed (an estimate, marked `~`) because its calls report usage only
 * once they finish; a settled member shows the measured output when the read model has it.
 */
function councilMemberProgress(row: DispatchBoardRow): string | null {
	if (row.status === "enqueued") return null;
	const facts: string[] = [formatElapsed(row.elapsedMs)];
	const measured = dispatchUsageText(row.usage).measuredOutput;
	if (isTerminalStatus(row.status)) {
		if (measured !== null && measured > 0) facts.push(`${dispatchUsageText(row.usage).output} out`);
	} else {
		const streamed = row.progress?.streamedOutputTokens;
		if (streamed !== undefined && streamed > 0) facts.push(`~${streamed} tok out`);
	}
	return facts.join(SEP);
}

function memberWhy(row: DispatchBoardRow): { why?: string } {
	if (!isTerminalStatus(row.status) || row.status === "completed") return {};
	const why = workerFailureHeadline(terminalDetail(row));
	if (why === null) return {};
	// Inside a council the work that stopped is the council, whose own notice names the cause.
	return {
		why:
			why === NEVER_STARTED_WORDS ? "it never started, because its council stopped first" : sanitizeCallTargetText(why),
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
		elapsed: formatElapsed(elapsedMs),
		...(selectedInGroup !== undefined ? { selectedRunId: selectedInGroup } : {}),
		...(rows.length > 0 && rows.every((row) => row.earlier === true) ? { earlier: true as const } : {}),
	};
}

/**
 * Live rows plus the settled members of any council still running. A council is one card, so the member that already
 * answered stays in it: without it a council of two with one member left read `council of 1 · running`.
 */
function withCouncilSiblings(
	active: ReadonlyArray<DispatchBoardRow>,
	all: ReadonlyArray<DispatchBoardRow>,
): DispatchBoardRow[] {
	const groups = new Set(active.flatMap((row) => (row.council === undefined ? [] : [row.council.group])));
	if (groups.size === 0) return [...active];
	const shown = new Set(active.map((row) => row.runId));
	return [
		...active,
		...all.filter((row) => row.council !== undefined && groups.has(row.council.group) && !shown.has(row.runId)),
	];
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
		`${rule}${rule} earlier sessions${SEP}${count} run${count === 1 ? "" : "s"} `,
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

/** A table cell with no value yet, or one nothing measured (2.9); the selected run's facts say which, once. */
const NO_VALUE = GLYPH.none;

/**
 * A token figure for a right-aligned column in the count form (`39.4k`), its lower-bound or estimate mark kept. The
 * read model's coverage clause is longer than the column; the run's facts and record carry it.
 */
function tableFigure(display: string): string {
	const figure = compactQuantity(display);
	if (figure === null) return NO_VALUE;
	const match = /^(≥|≈|~|>=)?([\d,]+)$/u.exec(figure);
	if (match?.[2] === undefined) return boundMark(figure);
	return boundMark(`${match[1] ?? ""}${formatCount(Number(match[2].replaceAll(",", "")))}`);
}

/**
 * The read model's lower-bound and estimate marks in the glyph vocabulary, so ASCII mode draws `>=` and `~`. The read
 * model keeps `≥` and `≈` in its strings, which other surfaces parse, so the board swaps them only where it draws.
 */
function boundMark(figure: string): string {
	return figure.replace(/^≥/u, GLYPH.atLeast).replace(/^≈/u, GLYPH.estimate);
}

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
	// A council or poll answers in prose by design, members and synthesis alike, so no-tools says nothing there.
	const synthesizes = row.council !== undefined || row.agentId === COUNCIL_SYNTHESIS_AGENT;
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
			return "by CLIO Coder on your behalf";
		case "internal":
			return "by CLIO Coder";
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

/** A live run parked on an ask that this session's operator answers: its state is the wait (2.7), not `running`. */
function waitsOnOperator(row: Pick<DispatchBoardRow, "status" | "progress">): boolean {
	if (row.status !== "running" || row.progress?.awaitingApproval !== true) return false;
	const window = row.progress.approvalWindow;
	return window === undefined || (window.decider === "operator" && window.owner === undefined);
}

/**
 * The status cell: the outcome glyph in its tone, then the word, the same pair every surface uses. `glyphOnly` is the
 * one-column form under 44 cells, where running, queued and a clean done keep only their glyph; a failure, a warning
 * and a wait on the operator keep their word at every width (2.7).
 */
function runStatusCell(
	theme: ClioTheme,
	row: DispatchBoardRow,
	tick: number | undefined,
	width: number,
	glyphOnly = false,
): string {
	// A plan whose worker steps finished with warnings reads as its card does, never as a clean done.
	if (row.plan !== undefined && row.plan.state === "passed" && planWarnedStepCount(row.plan) > 0) {
		return theme.fg("warning", `${GLYPH.warn} ${width >= NARROW_STATUS_WIDTH ? "done with warnings" : "warnings"}`);
	}
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
					? `${row.completion?.refusedCalls ?? 1} ${row.completion?.guardedCalls === row.completion?.refusedCalls ? "guarded" : "refused"}`
					: COMPACT_CAVEAT_WORD[failure.kind];
		return theme.fg(mark.token, `${mark.glyph} ${words}`);
	}
	if (waitsOnOperator(row)) return theme.fg("attention", `${GLYPH.phaseBlocked} needs approval`);
	const full = dispatchStatusPresentation(row.status, {
		...(row.status === "running" && tick !== undefined ? { tick } : {}),
	});
	// A table has room for the whole word; only `completed` shortens, to the word the island uses.
	const presentation = row.status === "completed" ? { ...full, label: "done" } : full;
	const token =
		row.status === "running" && (row.agentAudience === "shadow" || row.agentAudience === "internal")
			? "shadowDispatchAction"
			: presentation.token;
	const glyph = theme.fg(presentation.glyphToken ?? presentation.token, presentation.glyph);
	if (glyphOnly && (row.status === "running" || row.status === "enqueued" || row.status === "completed")) return glyph;
	return `${glyph} ${theme.fg(token, presentation.label)}`;
}

/** Share of the worker's window its last reply occupied; warning tone from this share up (CLI-H3). */
const CONTEXT_FILL_WARNING = 0.8;

/** A live worker's context fill ahead of its activity, so a parent sees a run filling up before it hits the wall. */
function withContextFill(theme: ClioTheme, row: DispatchBoardRow, cell: TableCell): TableCell {
	const window = row.contextWindow ?? 0;
	if (row.lastContextTokens === null || !(window > 0)) return cell;
	const fill = row.lastContextTokens / window;
	const label = theme.fg(
		fill >= CONTEXT_FILL_WARNING ? "warning" : "muted",
		`ctx ${Math.min(100, Math.round(fill * 100))}%`,
	);
	return { ...cell, text: cell.text.length > 0 ? `${label}${SEP}${cell.text}` : label };
}

function liveActivityCell(
	theme: ClioTheme,
	row: DispatchBoardRow,
	room: number | undefined,
	task: string | null,
): TableCell {
	const progress = row.progress;
	if (progress) {
		if (progress.awaitingApproval === true) {
			return { text: approvalWaitWords(progress, room === undefined ? {} : { room }), tone: "warning" };
		}
		if (progress.currentAction) return { text: theme.base("body", actionPhrase(progress.currentAction, "running")) };
		const words = sanitizeCallTargetText(workerActivityWords(progress, { history: row.routeFirstOutput ?? null }));
		const line =
			progress.phase === "writing"
				? firstLine(redactStreamingSecretString(progress.tailText, progress.completed === true))
				: "";
		// A worker writing its JSON report says it is writing; the report's first line is not prose.
		const tail = isStructuredAnswerText(line) ? "" : line;
		return { text: `${theme.fg("dispatchAction", words)}${tail ? ` ${theme.fg("assistantProse", tail)}` : ""}` };
	}
	if (row.currentTool) return { text: `${sanitizeCallTargetText(row.currentTool)} running` };
	return { text: task ?? "" };
}

/** What a run is doing, or how it ended, in one clause the row may clip. `room` picks an approval wait's form. */
function runActivityCell(theme: ClioTheme, row: DispatchBoardRow, now: number, room?: number): TableCell {
	if (row.plan !== undefined) {
		return { text: planProgressText(row.plan, true), ...(row.plan.state === "failed" ? { tone: "error" as const } : {}) };
	}
	const task = row.taskSummary ? sanitizeCallTargetText(row.taskSummary) : null;
	switch (row.status) {
		case "running":
		case "stale":
			return withContextFill(theme, row, liveActivityCell(theme, row, room, task));
		case "cancelling":
			// The worker is being stopped; its last phase would read as work finishing normally.
			return { text: "waiting for it to exit", tone: "warning" };
		case "retrying":
			return row.retry
				? {
						text: `attempt ${row.retry.attempt}${SEP}${retryCountdown(row.retry, now)}${row.retry.reason ? `${SEP}${sanitizeCallTargetText(row.retry.reason)}` : ""}`,
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

/** Board columns in the order they print. */
const BOARD_COLUMN_ORDER: readonly BoardColumn[] = [
	"state",
	"agent",
	"time",
	"in",
	"out",
	"cost",
	"node",
	"account",
	"text",
];

const BOARD_HEADER: Readonly<Record<BoardColumn, string>> = {
	state: "state",
	agent: "agent",
	time: "time",
	in: "in",
	out: "out",
	cost: "cost",
	node: "node",
	account: "account",
	text: `now ${GLYPH.sep} task`,
};

/** The order columns leave when the width cannot hold them, first to go first (6.5); a column absent never drops. */
const BOARD_DROP_RANK: Readonly<Partial<Record<BoardColumn, number>>> = {
	account: 1,
	node: 2,
	cost: 3,
	in: 4,
	out: 5,
	time: 6,
};

/** What a column dropped for width holds, in the words the selected run's facts use. */
const BOARD_COLUMN_FACT: Readonly<Partial<Record<BoardColumn, string>>> = {
	time: "time",
	in: "tokens",
	out: "tokens",
	cost: "cost",
	node: "node",
	account: "account",
};

const RIGHT_ALIGNED: ReadonlySet<BoardColumn> = new Set(["time", "in", "out", "cost"]);

/**
 * The text column keeps twelve cells in a W2 table and three tenths of the row from W3, so a quieter column drops
 * before the text is cut to a stub: at 76 cells a node or an account leaves before the task does.
 */
function boardTextMin(width: number): number {
	return widthClass(width) === "W2" ? 12 : Math.max(12, Math.ceil(width * 0.3));
}
const BOARD_GAP = 2;
/** Under sixty cells one long state (`✗ stopped responding`) would set the column for every row. */
const NARROW_STATE_MAX = 14;

/**
 * The columns the tier offers at the measured width's class (6.5, 2.3): time from W2, the telemetry columns from W3,
 * node and account only when some run has them. W1 is one column and has no header.
 */
function boardColumns(width: number, anyNode: boolean, anyAccount: boolean): BoardColumn[] {
	const offered = new Set(tierPolicy().boardColumns);
	const measured = widthClass(width);
	return BOARD_COLUMN_ORDER.filter((column) => {
		if (!offered.has(column)) return false;
		if (column === "state" || column === "agent" || column === "text") return true;
		if (column === "time") return measured !== "W1";
		if (column === "node" && !anyNode) return false;
		if (column === "account" && !anyAccount) return false;
		return measured !== "W1" && measured !== "W2";
	});
}

function listWords(words: readonly string[]): string {
	return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** The one supporting row that names the columns this width dropped and where their facts are read. */
function droppedColumnsNote(theme: ClioTheme, dropped: readonly BoardColumn[], width: number): string | null {
	if (dropped.length === 0) return null;
	const columns = BOARD_COLUMN_ORDER.filter((column) => dropped.includes(column));
	const names = `${listWords(columns.map((column) => BOARD_HEADER[column]))} column${columns.length === 1 ? "" : "s"} hidden`;
	const facts = listWords([...new Set(columns.map((column) => BOARD_COLUMN_FACT[column] ?? column))]);
	const sep = ` ${GLYPH.sep} `;
	const forms = [`${names}${sep}widen the window, or [Enter] for the run's ${facts}`, `${names}${sep}widen the window`];
	const fitted =
		forms.find((form) => visibleWidth(form) <= width) ?? truncateToWidth(names, width, GLYPH.ellipsis, false);
	return theme.fg("annotation", fitted);
}

type BoardCells = Partial<Record<BoardColumn, string | TableCell>>;

interface BoardCellContext {
	cursor: boolean;
	selectedRunId: string | null | undefined;
	width: number;
	now: number;
	tick: number | undefined;
	quota: QuotaProviders;
	anyAccount: boolean;
	inspectFinished: boolean;
	glyphOnly: boolean;
}

function cursorLead(theme: ClioTheme, context: BoardCellContext, selected: boolean): string {
	if (!context.cursor) return "";
	return `${selected ? theme.fg("selectedOption", GLYPH.cursor) : " "} `;
}

/** A run's text: live rows say what they are doing, then the task (6.1); every other state reads as its cell says. */
function runTextCell(theme: ClioTheme, row: DispatchBoardRow, context: BoardCellContext): TableCell {
	if (context.inspectFinished && isTerminalStatus(row.status) && row.plan === undefined)
		return { text: `/view dispatch:${row.runId}`, tone: "muted" };
	const cell = runActivityCell(theme, row, context.now);
	const live = row.status === "running" || row.status === "stale";
	const task = row.taskSummary ? sanitizeCallTargetText(row.taskSummary) : null;
	if (!live || row.plan !== undefined || task === null || row.progress?.awaitingApproval === true) return cell;
	// The phase words, then the task; a run with no phase yet reads as its task alone.
	const words = liveActivityCell(theme, row, undefined, null).text;
	const text = words.length === 0 ? task : `${words}${theme.fg("separator", ` ${GLYPH.sep} `)}${theme.fg("body", task)}`;
	return withContextFill(theme, row, { text });
}

function itemCells(theme: ClioTheme, item: DispatchBoardItem, context: BoardCellContext): BoardCells {
	if (item.kind === "council") {
		const group = item.group;
		const selected = group.selectedRunId !== undefined;
		// The group id is the record's; a person knows the council by its size and its question.
		const name = councilName(group);
		return {
			state: `${cursorLead(theme, context, selected)}${theme.fg(group.status.glyphToken ?? group.status.token, group.status.glyph)} ${theme.fg(group.status.token, group.status.label)}`,
			agent: selected ? theme.style("selectedOption", name, { bold: true }) : theme.fg("dispatchAction", name),
			time: group.elapsed,
			text: {
				// A one-round council has no round worth naming; a synthesis is the council's own answer, so it says so.
				text: [
					...(group.task === undefined ? [] : [group.task]),
					...(group.round > 1 ? [`round ${group.round}`] : []),
					...(group.synthesis === null ? [] : ["with a synthesis"]),
				].join(` ${GLYPH.sep} `),
				tone: "muted",
			},
		};
	}
	const row = item.row;
	const selected = context.cursor && row.runId === context.selectedRunId;
	const prefix = dispatchRowPrefix(theme, row);
	const label = agentDisplayLabel(row);
	// A plan step's worker carries its step on its name, `coder · map-stats`, so two workers of one plan never read
	// the same when the table is narrow.
	const step =
		row.phase === undefined || row.plan !== undefined
			? ""
			: theme.fg("info", ` ${GLYPH.sep} ${sanitizeCallTargetText(row.phase.stepId)}`);
	const cells: BoardCells = {
		state: `${cursorLead(theme, context, selected)}${runStatusCell(theme, row, context.tick, context.width, context.glyphOnly)}`,
		agent: `${prefix.text}${selected ? theme.style("selectedOption", label, { bold: true }) : theme.fg("workerIdentity", label)}${step}`,
		time: row.telemetry?.activity.elapsed.display ?? (row.status === "enqueued" ? "" : formatElapsed(row.elapsedMs)),
		node: row.node ?? "local",
		text: runTextCell(theme, row, context),
	};
	if (row.plan !== undefined) {
		// A plan's workers have their own rows, so its row sums nothing a reader could mistake for measured.
		cells.cost = { text: row.plan.costText ?? NO_VALUE, tone: "muted" };
		cells.node = "";
		return cells;
	}
	const usage = dispatchUsageText(row.usage);
	const figure = (display: string): TableCell =>
		row.usage.kind === "ready" ? { text: tableFigure(display) } : { text: NO_VALUE, tone: "muted" };
	cells.in = figure(usage.prompt);
	cells.out = figure(usage.output);
	// A cost nothing measured is the dash; the selected run's facts say why, once.
	const cost = row.usage.kind === "ready" ? compactQuantity(usage.cost) : null;
	cells.cost = cost === null || cost === USAGE_NOT_MEASURED ? { text: NO_VALUE, tone: "muted" } : { text: cost };
	const weekly = context.anyAccount ? routeWeeklyQuota(row, context.quota) : null;
	if (weekly !== null)
		cells.account = {
			text: weekly.label,
			tone: weekly.severity === "critical" ? "error" : weekly.severity === "normal" ? "muted" : "warning",
		};
	return cells;
}

function paintedCell(theme: ClioTheme, cell: string | TableCell | undefined): string {
	if (cell === undefined) return "";
	if (typeof cell === "string") return cell;
	return cell.text.includes("\u001b") ? cell.text : theme.fg(toneRole(cell.tone ?? "neutral"), cell.text);
}

interface RunTable {
	/** The column labels, absent under 44 cells where the table is one column. */
	header: string | null;
	/** One row per item, in item order. */
	rows: string[];
	/** The supporting row naming columns dropped for width. */
	note: string | null;
}

/**
 * The run table (6.5): columns from the tier's `boardColumns` and the measured width's class, a header at every tier,
 * the text column taking the rest and clipping, and quieter columns dropping in their fixed order before the text
 * would fall under its floor, named once by a supporting row. Under 44 cells it is one column.
 */
function runTable(items: ReadonlyArray<DispatchBoardItem>, width: number, options: RunTableOptions): RunTable {
	const theme = clioTheme();
	const safe = Math.max(1, Math.floor(width));
	const runs = items.flatMap((item) => (item.kind === "run" ? [item.row] : []));
	const quota = options.quota ?? [];
	const anyNode = options.compact !== true && runs.some((row) => row.node !== undefined && row.node !== "local");
	const anyAccount = runs.some((row) => routeWeeklyQuota(row, quota) !== null);
	const oneColumn = widthClass(safe) === "W1";
	const context: BoardCellContext = {
		cursor: options.selectedRunId !== undefined,
		selectedRunId: options.selectedRunId,
		width: safe,
		now: options.now ?? Date.now(),
		tick: options.tick,
		quota,
		anyAccount,
		inspectFinished: options.inspectFinished === true,
		glyphOnly: oneColumn,
	};
	const cells = items.map((item) => itemCells(theme, item, context));
	if (oneColumn) {
		// State, identity and text flow in one column; identities pad to one width so the text starts together.
		const identities = cells.map((cell) => paintedCell(theme, cell.agent));
		const identityWidth = Math.max(0, ...identities.map((identity) => visibleWidth(identity)));
		const rows = cells.map((cell, index) => {
			const line = `${paintedCell(theme, cell.state)} ${padAnsi(identities[index] ?? "", identityWidth)}  ${paintedCell(theme, cell.text)}`;
			return visibleWidth(line) <= safe ? line : truncateToWidth(line, safe, GLYPH.ellipsis, false);
		});
		return { header: null, rows, note: null };
	}
	const label = (column: BoardColumn): string =>
		column === "state" && context.cursor ? `  ${BOARD_HEADER.state}` : BOARD_HEADER[column];
	const cap = (column: BoardColumn): number =>
		column === "state" && safe < 60
			? NARROW_STATE_MAX + (context.cursor ? 2 : 0)
			: column === "agent"
				? 30
				: column === "node"
					? 12
					: Number.POSITIVE_INFINITY;
	const natural = (column: BoardColumn): number =>
		Math.min(
			cap(column),
			Math.max(visibleWidth(label(column)), ...cells.map((cell) => visibleWidth(paintedCell(theme, cell[column])))),
		);
	let kept = boardColumns(safe, anyNode, anyAccount).filter((column) => column !== "text");
	const dropped: BoardColumn[] = [];
	const used = (): number => kept.reduce((sum, column) => sum + natural(column) + BOARD_GAP, 0);
	while (used() + boardTextMin(safe) > safe) {
		const next = kept
			.filter((column) => BOARD_DROP_RANK[column] !== undefined)
			.sort((a, b) => (BOARD_DROP_RANK[a] ?? 0) - (BOARD_DROP_RANK[b] ?? 0))[0];
		if (next === undefined) break;
		kept = kept.filter((column) => column !== next);
		dropped.push(next);
	}
	const textRoom = Math.max(1, safe - used());
	// An approval wait is what its run is blocked on, so it is worded for the room the text column has.
	items.forEach((item, index) => {
		const cell = cells[index];
		if (item.kind !== "run" || item.row.plan !== undefined || cell === undefined) return;
		if (item.row.progress?.awaitingApproval !== true || isTerminalStatus(item.row.status)) return;
		cell.text = runActivityCell(theme, item.row, context.now, textRoom);
	});
	const order: BoardColumn[] = [...kept, "text"];
	const columns: TableColumn[] = order.map((column) => ({
		label: label(column),
		min: 1,
		max: column === "text" ? textRoom : natural(column),
		priority: 10,
		...(RIGHT_ALIGNED.has(column) ? { align: "right" as const } : {}),
		...(column === "time" ? { tone: "muted" as const } : {}),
	}));
	const lines = tableRows(
		theme,
		{ columns, rows: cells.map((cell) => order.map((column) => cell[column] ?? "")), header: true },
		safe,
	);
	// The header row stands alone over the runs; the table primitive's underline is not part of the board (6.5).
	return {
		header: lines[0] ?? null,
		rows: lines.slice(2, 2 + items.length),
		note: droppedColumnsNote(theme, dropped, safe),
	};
}

/**
 * One row per run (a council is one row), the shape every list of runs shares (6.5): a header naming the columns,
 * the rows, then one supporting row when the width dropped a column the tier offers. The tier comes from
 * `tierPolicy()`.
 */
export function runTableRows(
	items: ReadonlyArray<DispatchBoardItem>,
	width: number,
	options: RunTableOptions = {},
): string[] {
	const table = runTable(items, width, options);
	const rows = [...table.rows];
	// What an earlier Clio recorded sits under the board's own rule here too, so a list of runs reads as the board does.
	const firstEarlier = items.findIndex(itemFromEarlierSession);
	if (firstEarlier >= 0) {
		const safe = Math.max(1, Math.floor(width));
		rows.splice(firstEarlier, 0, earlierSessionsRule(clioTheme(), items.length - firstEarlier, safe));
	}
	return [...(table.header === null ? [] : [table.header]), ...rows, ...(table.note === null ? [] : [table.note])];
}

/** The run identity the board's detail rule names: the agent and its run id. */
function runRuleTitle(row: DispatchBoardRow): string {
	// A plan is known by its name; its root id is for the shell command its detail gives.
	if (row.plan !== undefined) return agentDisplayLabel(row);
	return `${agentDisplayLabel(row)}${SEP}${row.runId}`;
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

/** A painted row's text, for reading its shape. */
function stripPaint(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: only the row's escape sequences are removed.
	return text.replace(/\u001b\[[0-9;]*m/gu, "");
}

/** A route's slots in use and waiting, counted across the board. */
interface EndpointLoad {
	active: number;
	queued: number;
}

/** What the selected run is doing now, or how it ended: its `doing` fact, which no tier leaves out. */
function doingLines(theme: ClioTheme, row: DispatchBoardRow, width: number, now: number): string[] {
	const live = row.status === "running" || row.status === "stale";
	if (row.progress !== undefined && !isTerminalStatus(row.status)) {
		const line = progressActionLine(theme, row.progress, width, row.routeFirstOutput ?? null);
		if (line !== null) return [line];
	}
	if (row.status === "completed" && row.plan === undefined) {
		const failure = completedRunFailure(row);
		const words =
			failure === null ? theme.fg("body", "finished") : theme.fg(completedRunMark(failure).token, failure.words);
		return [cardUnitsLine(theme, "doing", [words], width)];
	}
	const cell = live ? liveActivityCell(theme, row, undefined, null) : runActivityCell(theme, row, now);
	const text = cell.text.length > 0 ? cell.text : "starting";
	return [cardUnitsLine(theme, "doing", [paintedCell(theme, { ...cell, text })], width)];
}

/** The selected run's facts at the tier's `boardFacts`, and how many facts that set left for Enter. */
function boardFactLines(
	theme: ClioTheme,
	row: DispatchBoardRow,
	width: number,
	facts: readonly BoardFact[] | "all",
	load: EndpointLoad | null,
	evidence: RunEvidencePresentation | undefined,
	now: number,
): { lines: string[]; hidden: number } {
	const usage = dispatchUsageText(row.usage);
	const firstOutput =
		row.ttft !== undefined && row.ttft !== null
			? `first output after ${row.ttft}`
			: row.status === "running"
				? "no output yet"
				: null;
	const task = row.taskSummary
		? cardWrappedValueLines(theme, "task", theme.fg("body", sanitizeCallTargetText(row.taskSummary)), width)
		: [];
	const firstTask = task[0];
	const slots = [
		...(row.endpoint !== undefined && load !== null
			? [
					theme.fg(
						"info",
						`${load.active}/${row.endpoint.limit} ${sanitizeCallTargetText(row.endpoint.label)}${load.queued > 0 ? ` +${load.queued} queued` : ""}`,
					),
				]
			: []),
		...(firstOutput === null ? [] : [theme.fg("body", firstOutput)]),
	];
	const started = runOriginWords(row);
	const measured = row.usage.kind === "ready" && compactQuantity(usage.prompt) !== null;
	const cost = row.usage.kind === "ready" ? compactQuantity(usage.cost) : null;
	const tokenUnits = [
		...(measured && row.usage.kind === "ready"
			? [
					theme.fg("body", `prompt ${boundMark(usageLineFigure(row.usage.prompt))}`),
					theme.fg("body", `out ${boundMark(usageLineFigure(row.usage.output))}`),
				]
			: [theme.fg("body", isTerminalStatus(row.status) ? USAGE_NOT_MEASURED : "none reported yet")]),
		theme.fg("body", cost === null || cost === USAGE_NOT_MEASURED ? "cost not measured on this route" : `cost ${cost}`),
	];
	const proof = evidence === undefined ? null : evidenceCardLine(theme, evidence, width);
	const all: ReadonlyArray<readonly [string, string[]]> = [
		["doing", doingLines(theme, row, width, now)],
		["task", firstTask === undefined ? [] : [task.length > 1 ? cutRowWithEllipsis(firstTask, width) : firstTask]],
		["slots", slots.length === 0 ? [] : [cardUnitsLine(theme, "slots", slots, width)]],
		[
			"started",
			started === null && row.earlier !== true
				? []
				: [
						cardUnitsLine(
							theme,
							"started",
							[
								...(started === null ? [] : [theme.fg("body", started)]),
								...(row.earlier === true ? [theme.fg("annotation", "recorded before this CLIO Coder started")] : []),
							],
							width,
						),
					],
		],
		[
			"target",
			[
				cardUnitsLine(
					theme,
					"target",
					[
						theme.fg("footerIdentity", formatRowRoute(row)),
						...(row.node === undefined || row.node === "local" ? [] : [theme.fg("body", `on node ${row.node}`)]),
					],
					width,
				),
			],
		],
		["tokens", [cardUnitsLine(theme, "tokens", tokenUnits, width)]],
		["trust", trustCardLines(theme, row, width, false)],
		["evidence", proof === null ? [] : [proof]],
	];
	const present = all.filter(([, lines]) => lines.length > 0);
	// A settled run's trust verdict is part of its state, which no tier hides (3, invariant 2).
	const settledTrust = isTerminalStatus(row.status);
	const shown =
		facts === "all"
			? present
			: present.filter(([name]) => (facts as readonly string[]).includes(name) || (name === "trust" && settledTrust));
	return { lines: shown.flatMap(([, lines]) => lines), hidden: present.length - shown.length };
}

interface BoardDetail {
	title: string;
	meta: string;
	runId: string;
	body: string[];
	/** Facts the tier left for Enter, named by the fold marker. */
	hidden: number;
	plan: boolean;
}

/**
 * The selected run's titled rule and its body in `room` rows. An open detail pages through the whole record; a folded
 * one shows the tier's facts, then, when `marker`, the row that says how many more Enter opens. A body cut at the
 * budget closes on the row that says where the rest is read.
 */
function detailSection(
	theme: ClioTheme,
	detail: BoardDetail,
	width: number,
	room: number,
	expanded: boolean,
	budgetKnown: boolean,
	detailWindow: { offset: number },
	marker: boolean,
): string[] {
	const lines = [sectionRule(theme, width, detail.title, { meta: detail.meta })];
	const rest = room - 1;
	const sep = ` ${GLYPH.sep} `;
	const fold =
		marker && !expanded && detail.hidden > 0
			? theme.fg(
					"annotation",
					truncateToWidth(`${GLYPH.ellipsis} ${detail.hidden} more rows${sep}[Enter] detail`, width, GLYPH.ellipsis, false),
				)
			: null;
	if ((expanded && !budgetKnown) || detail.body.length + (fold === null ? 0 : 1) <= rest) {
		lines.push(...detail.body, ...(fold === null ? [] : [fold]));
		return lines;
	}
	if (rest <= 0) return lines;
	if (expanded) {
		const page = Math.max(1, rest - 1);
		const start = Math.min(detailWindow.offset, Math.max(0, detail.body.length - page));
		detailWindow.offset = start;
		lines.push(...detail.body.slice(start, start + page));
		if (rest > 1)
			lines.push(
				positionRow(theme, { start: start + 1, end: start + page, total: detail.body.length, unit: "detail rows" }, width),
			);
		return lines;
	}
	const kept = detail.body.slice(0, Math.max(0, rest - 1));
	const hidden = detail.body.length - kept.length + (marker ? detail.hidden : 0);
	// A fact the cut lands inside of wraps onto the next row, which starts blank under its key; the last row kept
	// then closes with the ellipsis, so `its answer was not in the` never reads as the whole of it.
	const nextRow = detail.body[kept.length];
	const lastKept = kept.at(-1);
	if (lastKept !== undefined && nextRow !== undefined && /^\s/u.test(stripPaint(nextRow)) && nextRow.trim().length > 0) {
		kept[kept.length - 1] = cutRowWithEllipsis(lastKept, width);
	}
	// Pointers drop whole from the end rather than cut, so a `/view` never shows a run id it cannot be typed from.
	// A plan is not a dispatch record; Enter opens its steps, not /view dispatch:<id>.
	const where = [`${hidden} more rows`, "[Enter] detail", ...(detail.plan ? [] : [`/view dispatch:${detail.runId}`])];
	const fits = (): boolean => visibleWidth(`${GLYPH.ellipsis} ${where.join(sep)}`) <= width;
	// The /view handle is the only way to the rows a narrow board cut, so the count shortens and Enter goes first.
	if (!fits() && where.length > 2) where.splice(1, 1);
	if (!fits()) where[0] = `${hidden} more`;
	if (!fits() && where.length > 1) where.shift();
	while (where.length > 1 && !fits()) where.pop();
	lines.push(
		...kept,
		theme.fg("annotation", truncateToWidth(`${GLYPH.ellipsis} ${where.join(sep)}`, width, GLYPH.ellipsis, false)),
	);
	return lines;
}

/** The header, the rows in `tableBudget` around the cursor, the earlier-sessions rule and the position row. */
function tableWindowLines(
	theme: ClioTheme,
	table: RunTable,
	items: ReadonlyArray<DispatchBoardItem>,
	selectedIndex: number,
	tableBudget: number,
	width: number,
	detailExpanded: boolean,
): string[] {
	const [start] = centeredWindow(table.rows.length, selectedIndex, tableBudget);
	const { window, position } = windowRows(table.rows, start, tableBudget);
	const lines = [...window];
	// What an earlier Clio recorded sits under its own rule, so a row from before this process never passes for one
	// of its own at a glance, at any width or without colour. The rule sits above the first earlier row in view, or
	// tops the window when every row in view is earlier.
	const firstEarlier = items.findIndex(itemFromEarlierSession);
	if (firstEarlier >= 0 && firstEarlier < start + window.length) {
		lines.splice(Math.max(0, firstEarlier - start), 0, earlierSessionsRule(theme, items.length - firstEarlier, width));
	}
	if (table.header !== null) lines.unshift(table.header);
	if (position) {
		// An open detail adds only how many runs it is hiding.
		const hidden = position.total - (position.end - position.start + 1);
		const keys = detailExpanded ? [`${hidden} hidden while the detail is open`] : [];
		lines.push(positionRow(theme, { ...position, unit: "runs", keys }, width));
	}
	return lines;
}

/**
 * The board body for `budget` rows (6.5): the run table with its header, windowed around the cursor, then the
 * selected run's facts under a rule that names it and its state. The facts are the tier's `boardFacts`; Enter opens
 * the whole record, paged. From W5 the list and the facts sit side by side, 60 and 40 percent. `budgetKnown` is false
 * before the frame has granted rows; an open detail then renders whole and the frame's cut marks what is missing.
 */
function formatDispatchBoardBody(
	rows: ReadonlyArray<DispatchBoardRow>,
	width: number,
	budget: number,
	telemetry: TelemetrySnapshot | undefined,
	selectedRunId: string | null,
	detailExpanded: boolean,
	budgetKnown: boolean,
	detailWindow = { offset: 0 },
): string[] {
	const theme = clioTheme();
	if (rows.length === 0) {
		return emptyState(theme, "No runs in this session.", width, {
			remedy: `/run <agent> <task> starts one ${GLYPH.sep} CLIO Coder lists the workers it starts here.`,
		});
	}
	const now = Date.now();
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
	const split = widthClass(width) === "W5";
	const listWidth = split ? Math.floor((width - BOARD_GAP) * 0.6) : width;
	const factsWidth = split ? width - listWidth - BOARD_GAP : width;
	const table = runTable(items, listWidth, { selectedRunId });
	const head = table.header === null ? 0 : 1;
	// On a short stacked board the note would cost the selected run's status row, which says more than which columns left.
	const notes = table.note === null || (!split && budget < 10) ? [] : [table.note];
	const dividerRows = items.some(itemFromEarlierSession) ? 1 : 0;
	const item = items[selectedIndex];
	const detail = ((): BoardDetail | null => {
		if (item === undefined) return null;
		if (item.kind === "council") {
			return {
				title: `${councilName(item.group)}${item.group.task === undefined ? "" : ` ${GLYPH.sep} ${item.group.task}`}`,
				meta: item.group.round > 1 ? `round ${item.group.round} ${GLYPH.sep} ${item.group.elapsed}` : item.group.elapsed,
				runId: item.group.selectedRunId ?? item.group.members[0]?.runId ?? "",
				// The table keeps its selected row and position row, and the detail its rule, whatever the council's size.
				body: councilGroupBody(theme, item.group, factsWidth, Math.max(3, budget - notes.length - dividerRows - head - 3)),
				hidden: 0,
				plan: false,
			};
		}
		const row = item.row;
		const evidence = deriveRunEvidenceState(telemetry, row.runId);
		const load =
			row.endpoint === undefined
				? null
				: { active: endpointActive[row.endpoint.key] ?? 0, queued: endpointQueued[row.endpoint.key] ?? 0 };
		const folded =
			detailExpanded || row.plan !== undefined
				? {
						lines: dispatchCardBody(row, factsWidth, evidence, {
							expanded: detailExpanded,
							detailKey: "Enter",
							...(load !== null ? { endpointActive: load.active, endpointQueued: load.queued } : {}),
						}),
						hidden: 0,
					}
				: boardFactLines(theme, row, factsWidth, tierPolicy().boardFacts, load, evidence, now);
		return {
			title: runRuleTitle(row),
			meta: `${stripPaint(runStatusCell(theme, row, undefined, factsWidth))} ${GLYPH.sep} ${row.telemetry?.activity.elapsed.display ?? formatElapsed(row.elapsedMs)}`,
			runId: row.runId,
			body: folded.lines,
			hidden: folded.hidden,
			plan: row.plan !== undefined,
		};
	})();
	if (split) {
		// Side by side, the list keeps every row the budget holds and the facts need no fold marker.
		const listRows = Math.max(1, budget - head - notes.length - dividerRows);
		const tableBudget = table.rows.length <= listRows ? table.rows.length : Math.max(1, listRows - 1);
		const list = [
			...tableWindowLines(theme, table, items, selectedIndex, tableBudget, listWidth, detailExpanded),
			...notes,
		];
		const facts =
			detail === null
				? []
				: detailSection(theme, detail, factsWidth, budget, detailExpanded, budgetKnown, detailWindow, false);
		const height = Math.max(list.length, facts.length);
		return Array.from(
			{ length: height },
			(_, index) => `${padAnsi(list[index] ?? "", listWidth)}${" ".repeat(BOARD_GAP)}${facts[index] ?? ""}`,
		);
	}
	// An open detail leaves the table what its body and rule do not need, and never less than the selected row. A
	// table that cannot show every run spends one more row on the position row that counts the rest.
	const detailRows =
		(detail === null ? 0 : detail.body.length + 1 + (detail.hidden > 0 ? 1 : 0)) + notes.length + dividerRows + head;
	const tableBudget = detailExpanded
		? table.rows.length + detailRows <= budget
			? table.rows.length
			: Math.max(1, Math.min(table.rows.length - 1, budget - detailRows - 1))
		: Math.min(
				table.rows.length,
				Math.max(
					1,
					Math.min(
						Math.max(3, Math.floor(budget / 2) - dividerRows - head),
						// The selected run keeps its rule, its first rows and the pointer to the rest, however short the board.
						budget - head - dividerRows - notes.length - 1 - (detail === null ? 0 : Math.min(2, detail.body.length) + 2),
					),
				),
			);
	const lines = [...tableWindowLines(theme, table, items, selectedIndex, tableBudget, width, detailExpanded), ...notes];
	if (detail === null) return lines;
	lines.push(
		...detailSection(theme, detail, width, budget - lines.length, detailExpanded, budgetKnown, detailWindow, true),
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
	scrollDetail(direction: -1 | 1): void;
	detailExpanded(): boolean;
	/** Whether a first `x` asked about the selected run; a second `x` on it cancels. */
	cancelArmed(): boolean;
	/** Arm the selected run for cancel, or disarm. */
	armCancel(on: boolean): void;
	/** Whether `w` can open the watch pane on the selected run. */
	canWatch(): boolean;
	/** Say which rows `w` takes to the watch pane; only a session with a pane host has any. */
	setWatchable(predicate: (row: DispatchBoardRow) => boolean): void;
}

/**
 * The keys Fleet Runs offers for the selected row, without the way out the frame adds. The rail and the board's own
 * key row read this one list, so a key the rail has no room for is named in the body rather than lost (cards r1).
 */
export function dispatchBoardHintEntries(
	board: Pick<DispatchBoardView, "selectedRow" | "detailExpanded" | "canWatch"> &
		Partial<Pick<DispatchBoardView, "cancelArmed">>,
): HintEntry[] {
	const row = board.selectedRow();
	if (row === null) return [];
	if (board.cancelArmed?.() === true && isDispatchBoardRowCancellable(row))
		return confirmOnceRail("x", "cancel", row.agentId);
	const entries: HintEntry[] = [{ key: "↑↓", verb: "select" }];
	const steerable = isDispatchBoardRowSteerable(row);
	if (board.detailExpanded()) entries.push({ key: "PgUp/PgDn", verb: "detail", critical: true });
	if (row.plan === undefined) {
		// A run that can take a message leads with steer and cancel; otherwise detail is what is left to read. A
		// council's detail is its members' answers, which want the rows the table holds.
		// The watch pane splits the terminal, so it says so before the key is pressed. It is listed ahead of Enter
		// because a narrow rail keeps its later keys first, and the run's detail matters more than a split pane.
		if (row.council === undefined && board.canWatch())
			entries.push({ key: "w", verb: "watch in a pane", short: "watch" });
		entries.push({ key: "Enter", verb: board.detailExpanded() ? "hide detail" : "detail", critical: !steerable });
	} else entries.push({ key: "Enter", verb: board.detailExpanded() ? "hide detail" : "detail", critical: true });
	if (steerable) entries.push({ key: "m", verb: "steer", critical: true });
	if (isDispatchBoardRowCancellable(row)) entries.push({ key: "x", verb: "cancel", critical: true });
	return entries;
}

/**
 * Esc by the shared rule: an open run detail is a layer, so Esc folds it and
 * the board stays; from the table Esc closes the board.
 */
export function dispatchBoardEscapeEntry(board: { detailExpanded(): boolean }): HintEntry {
	// Enter already says `hide detail`; Esc names where it lands, so the two keys never read as one verb.
	return board.detailExpanded() ? { key: "Esc", verb: "back to runs", short: "back" } : { key: "Esc", verb: "close" };
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
		const joined = current.length === 0 ? unit : `${current}${SEP}${unit}`;
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
	let armedCancelRunId: string | null = null;
	let selectedRunId: string | null = null;
	// Until the operator moves the cursor, the pick is the board's own, so a live run that registers after the board
	// opened takes it over from a finished one.
	let chosen = false;
	// Detail is a property of the operator's attention, not of a run, so it follows the cursor rather than pinning to
	// the row it was opened on. The board opens folded at every tier, so Esc from the list closes it in one press.
	let expanded = false;
	const detailWindow = { offset: 0 };
	const detailExpanded = (): boolean => expanded && rows().length > 0;
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
		const held = visibleRows.find((row) => row.runId === selectedRunId);
		const live =
			chosen || (held !== undefined && isDispatchBoardRowCancellable(held))
				? undefined
				: visibleRows.find(isDispatchBoardRowCancellable);
		const selected =
			live ??
			held ??
			visibleRows.find(
				(row) =>
					previous?.council !== undefined &&
					row.council?.group === previous.council.group &&
					row.council.label === previous.council.label,
			) ??
			visibleRows[0] ??
			null;
		if (selectedRunId !== selected?.runId) detailWindow.offset = 0;
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
		chosen = true;
		detailWindow.offset = 0;
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
			const key = `${safeWidth}|${budget}|${selectedRunId}|${detailExpanded()}|${detailWindow.offset}|${tierRevision()}|${skinEpoch()}|${clock}|${evidence}|${keyRows.join("/")}|${currentRows.map(rowSignature).join(";")}`;
			if (memo?.key === key) return memo.lines;
			const body = formatDispatchBoardBody(
				currentRows,
				safeWidth,
				Math.max(1, budget - keyRows.length),
				snapshot,
				selectedRunId,
				detailExpanded(),
				bodyRows > 0,
				detailWindow,
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
			chosen = false;
			expanded = false;
			detailWindow.offset = 0;
			normalizeSelection(rows());
		},
		toggleDetail(): void {
			const row = normalizeSelection(rows());
			if (row === null) return;
			expanded = !detailExpanded();
			detailWindow.offset = 0;
		},
		scrollDetail(direction): void {
			if (detailExpanded())
				detailWindow.offset = Math.max(
					0,
					detailWindow.offset + direction * Math.max(1, (bodyRows || DOCK_BODY_ROWS_MAX) - 6),
				);
		},
		detailExpanded,
		cancelArmed(): boolean {
			const row = normalizeSelection(rows());
			return row !== null && armedCancelRunId === row.runId;
		},
		armCancel(on: boolean): void {
			const next = on ? (normalizeSelection(rows())?.runId ?? null) : null;
			if (next === armedCancelRunId) return;
			armedCancelRunId = next;
			memo = null;
		},
		wantsGrowth(): boolean {
			return detailExpanded();
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
	const summary = planLive
		? operator.filter(
				(row) => row.plan !== undefined || row.phase === undefined || row.progress?.awaitingApproval === true,
			)
		: operator;
	return summary.sort(
		(a, b) => Number(b.progress?.awaitingApproval === true) - Number(a.progress?.awaitingApproval === true),
	);
}

/**
 * The runs a turn's dispatch wait stands behind: the summary's runs and the helper-audience runs the turn dispatched
 * itself. A shadow recipe such as scout is the model's own worker, so leaving it out read `waiting for a worker` over
 * two running scouts while the footer counted 2 (FX-7b).
 */
export function dispatchWaitRuns(rows: ReadonlyArray<DispatchBoardRow>): DispatchBoardRow[] {
	const summary = summaryFleetRuns(rows);
	const counted = new Set(summary.map((row) => row.runId));
	const dispatched = rows.filter(
		(row) =>
			!counted.has(row.runId) && isHelperRun(row) && row.requestOrigin === "agent" && !isTerminalStatus(row.status),
	);
	return [...summary, ...dispatched];
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
		...(entry.commitPlacement !== undefined ? { commitPlacement: { ...entry.commitPlacement } } : {}),
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
		...(entry.foreign === true ? { foreign: true as const } : {}),
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
	/** The earlier runs loaded so far; read on every call until `complete`, then held. */
	readDurableRuns?: () => { rows: ReadonlyArray<DispatchBoardRow>; complete: boolean },
	/** A settled run's usage from its own record, for a run this session's journal never referenced, such as a plan step. */
	readRecordedUsage?: (runId: string) => DispatchRunUsage,
): {
	rows(): ReadonlyArray<DispatchBoardRow>;
	activeRows(): ReadonlyArray<DispatchBoardRow>;
	/** What the fleet card shows: plans running now, then the active workers. */
	liveRows(): ReadonlyArray<DispatchBoardRow>;
	/**
	 * Every worker run the board shows, without the plan rows, in the board's order: this process's, then the ones an
	 * earlier Clio recorded. What a count or usage of workers reads.
	 */
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
	// Settled workers from before this process, held once complete like the durable plans; until then a paint shows
	// what has loaded. A run this process folds outranks its earlier row.
	let earlierRuns: ReadonlyArray<DispatchBoardRow> | null = null;
	const historyRows = (): ReadonlyArray<DispatchBoardRow> => {
		let loaded = earlierRuns;
		if (loaded === null) {
			try {
				const read = readDurableRuns?.() ?? { rows: [], complete: true };
				loaded = read.rows;
				if (read.complete) earlierRuns = loaded;
			} catch {
				// An unreadable ledger costs the history, never the board.
				earlierRuns = loaded = [];
			}
		}
		const live = new Set(current.runs.map((run) => run.runId));
		const view = projection.read?.live() ?? null;
		return loaded
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
			// One projection per frame: the active rows and their settled council siblings are both read from it.
			const all = projectRows(false);
			const workers = withCouncilSiblings(
				all.filter((row) => !isTerminalStatus(row.status)),
				all,
			);
			const live = plans.live();
			if (live.length === 0) return workers;
			const byRun = new Map(all.map((row) => [row.runId, row]));
			return [...live.map((plan) => fleetPlanRow(planWithWorkers(plan, byRun), Date.now())), ...workers];
		},
		workerRows: () => [...boardOrder(projectRows(false)), ...boardOrder(historyRows())],
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
