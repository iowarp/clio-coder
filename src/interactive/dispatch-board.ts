import { performance } from "node:perf_hooks";
import {
	BusChannels,
	type DispatchCompletedPayload,
	type DispatchFailedPayload,
	type DispatchProgressPayload,
	type DispatchRunIdentity,
} from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { rawDurationMs } from "../core/timers.js";
import type { AgentAudience } from "../domains/agents/spec.js";
import {
	cloneRunToolBudgetEnvelope,
	formatBudgetPolicy,
	formatBudgetReasons,
	formatBudgetRequest,
	formatEffectiveBudget,
	type RunToolBudgetEnvelope,
} from "../domains/dispatch/budget-envelope.js";
import type { DispatchSnapshot } from "../domains/dispatch/contract.js";
import {
	type DispatchRequestOrigin,
	type RunKind,
	type RunStatus,
	runKindSupportsLiveSteering,
} from "../domains/dispatch/types.js";
import {
	COST_NOT_MEASURED,
	costAggregateForAmount,
	formatCostAggregate,
	type ObservabilityNotice,
	type ObservabilitySnapshot,
} from "../domains/observability/index.js";
import type { CostProvenance } from "../domains/providers/index.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { formatWorkerContextMeter } from "./context-meter.js";
import { formatFooterTokens } from "./footer-panel.js";
import {
	type ClioTheme,
	type ClioToken,
	clioTheme,
	dotSep,
	fitUnits,
	formatCompactMs,
	frame,
	GLYPH,
	innerDivider,
	padAnsi,
	screenTitle,
	spinnerFrame,
} from "./theme/index.js";
import {
	createWorkerProgressFold,
	type WorkerAction,
	type WorkerProgressFold,
	type WorkerProgressSnapshot,
} from "./worker-progress.js";
import type { WorkerReceiptReader } from "./worker-stream.js";

export type DispatchBoardStatus =
	| Extract<RunStatus, "running" | "completed" | "failed" | "stale" | "dead">
	| "aborted"
	| "cancelling"
	| "enqueued"
	| "retrying";

export interface DispatchRetryPresentation {
	attempt: number;
	dueAtMs: number;
	reason: string;
}

export interface DispatchSteerAcknowledgement {
	receivedAtMs: number;
	chars: number;
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
	/** Sanitized, one-line summary of the task assigned to this run. */
	taskSummary?: string;
	/** Immutable budget admission provenance for this run. */
	budget?: RunToolBudgetEnvelope;
	status: DispatchBoardStatus;
	elapsedMs: number;
	tokenCount: number;
	costUsd: number;
	/** Pricing truth for costUsd; a progress event that omits it reads as unknown. */
	costProvenance?: CostProvenance;
	inputTokens: number;
	outputTokens: number;
	ttftMs: number | null;
	outcomeDetail?: string | null;
	/** Fleet node id; absent renders as the local node. */
	node?: string;
	/** Review/compete gate badge (role + cycle). */
	gate?: { role: string; cycle: number };
	/** Dead-node failover hops recorded on this run's chain. */
	rerouteCount?: number;
	/** Assignment retry attempts observed on the assignment event stream. */
	failoverHops?: number;
	/** Model context window for the per-worker context meter. */
	contextWindow?: number;
	/** Last assistant message's input+cacheRead+output: current context occupancy. */
	lastContextTokens?: number;
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
	/**
	 * Id of the receipt sealed for this run (`receipts/<runId>.json`, the id
	 * `clio-coder trace` takes). Set only once a terminal dispatch event has
	 * been published, which the dispatch domain does after recordReceipt, so a
	 * running row carries no receipt id and never implies evidence that does
	 * not exist yet.
	 */
	receiptId?: string;
	/** Waiting retry projected from the live dispatch snapshot. */
	retry?: DispatchRetryPresentation;
	/** Most recent worker delivery acknowledgement for an operator steer. */
	steerAcknowledgement?: DispatchSteerAcknowledgement;
}

/** Live HTTP/SDK rows are the only rows whose runtime can consume operator guidance. */
export function isDispatchBoardRowSteerable(row: DispatchBoardRow): boolean {
	return (
		runKindSupportsLiveSteering(row.runtimeKind) &&
		(row.status === "running" || row.status === "stale" || row.status === "enqueued")
	);
}

/** Dispatch abort owns active workers and retry timers, but never terminal history. */
export function isDispatchBoardRowCancellable(row: DispatchBoardRow): boolean {
	return row.status === "running" || row.status === "stale" || row.status === "enqueued" || row.status === "retrying";
}

interface DispatchBoardEntry
	extends Omit<
		DispatchBoardRow,
		"elapsedMs" | "recentTools" | "lastContextTokens" | "currentTool" | "retry" | "progress"
	> {
	sequence: number;
	enqueuedAtMs: number;
	startedAtMs: number | null;
	/**
	 * The monotonic twin of `startedAtMs`, set from the same observation. TTFT
	 * is a span, so it is measured against this and never against the wall
	 * stamps, which exist to order and label rows.
	 */
	startedAtClockMs: number | null;
	finishedAtMs: number | null;
	durationMs: number | null;
	lastContextTokens: number;
	/**
	 * The one fold that reads this run's worker events. Tool activity and the
	 * answer tail are its output, so the board no longer interprets the stream
	 * alongside the transcript.
	 */
	progress: WorkerProgressFold;
	retry?: DispatchRetryPresentation;
}

/** Keep raw task text out of long-lived TUI rows and bound hostile/user-sized input. */
const TASK_SUMMARY_MAX_WIDTH = 240;
/** Rows of worker prose an expanded card shows before it defers to `/view`. */
const WORKER_PROGRESS_CARD_ROWS = 6;

interface WorkerEventShape {
	type?: unknown;
	message?: {
		role?: unknown;
		usage?: {
			input?: unknown;
			output?: unknown;
			cacheRead?: unknown;
			cacheWrite?: unknown;
		};
	};
	messages?: unknown;
}

interface AssistantMessageShape {
	role?: unknown;
	stopReason?: unknown;
}

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
const MAX_DISPATCH_BOARD_ROWS = 50;

/**
 * The agent's own name, unadorned. Audience is carried by
 * {@link agentAudiencePresentation}, never by a name prefix: `sh:scout` reads
 * as an agent literally called "sh:scout", and an operator cannot tell a
 * prefix apart from user data at a glance.
 */
export function agentDisplayLabel(row: Pick<DispatchBoardRow, "agentId" | "agentAudience">): string {
	return row.agentId;
}

export interface AgentAudiencePresentation {
	glyph: string;
	token: ClioToken;
}

/**
 * Visual treatment for a run Clio started for itself: the sub-process glyph in
 * a muted tone for a shadow worker, the same glyph dimmed for internal harness
 * machinery. Returns null for base/custom agents, which the operator asked for
 * directly and which therefore render like any other row.
 */
export function agentAudiencePresentation(
	row: Pick<DispatchBoardRow, "agentAudience">,
): AgentAudiencePresentation | null {
	if (row.agentAudience === "shadow") return { glyph: GLYPH.subProcess, token: "muted" };
	if (row.agentAudience === "internal") return { glyph: GLYPH.subProcess, token: "dim" };
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
 *
 * Only the operator's own run takes a color. The transcript block paints an
 * agent-origin run in action orange because it is the one signal on that
 * surface; a board row sits under the fleet summary, which already owns the
 * quadrant's single orange, so here the filled glyph carries origin by shape.
 */
export function dispatchOriginPresentation(
	row: Pick<DispatchBoardRow, "requestOrigin">,
): DispatchOriginPresentation | null {
	if (row.requestOrigin === "user") return { glyph: GLYPH.workerHuman, token: "accent" };
	if (row.requestOrigin === "agent") return { glyph: GLYPH.workerAgent, token: "muted" };
	if (row.requestOrigin === "internal") return { glyph: GLYPH.workerInternal, token: "dim" };
	return null;
}

/**
 * The full glyph lead for a row: origin first, then audience. Reported with its
 * own display width so each caller can reserve columns for it without
 * measuring ANSI.
 */
export function dispatchRowPrefix(
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
			// Running fleet work is Clio acting, so it joins queued work under the
			// action token rather than the old teal-running/orange-queued split.
			return {
				glyph: options.tick !== undefined ? spinnerFrame(options.tick) : GLYPH.running,
				label: "running",
				token: "action",
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
			return { glyph: GLYPH.cancelled, label: compact ? "abort" : "aborted", token: "dim" };
		case "stale":
			return { glyph: GLYPH.warnInline, label: "stale", token: "warning" };
		case "enqueued":
			return { glyph: GLYPH.queued, label: "queued", token: "action" };
	}
}

/** Evidence-readiness state for a dispatch run, derived from the observability projection. */
export type EvidenceState = "pending" | "ready" | "failed" | "none";

/**
 * Compact, presentation-ready evidence readiness for one run. Derived purely
 * from an ObservabilitySnapshot: no evidence files are read and no /view
 * artifact bodies are inspected. `viewFilter` is the `/view` deep-link an
 * operator would type to inspect the run or its bundle.
 */
export interface RunEvidencePresentation {
	state: EvidenceState;
	/** Bundle id, present only when the evidence is ready. */
	evidenceId?: string;
	/** Short failure reason drawn from the latest evidence notice, when failed. */
	reason?: string;
	/** The `/view` filter text: evidence:<id|runId>, or dispatch:<runId> when absent. */
	viewFilter: string;
}

// A run's evidence failure is signalled by its latest evidence notice carrying
// the error level and this run's id; a trailing warning/info notice for the same
// run is not a failure, and a notice without ref.runId is not attributed here.
function latestEvidenceFailureReason(notices: readonly ObservabilityNotice[], runId: string): string | null {
	for (let index = notices.length - 1; index >= 0; index -= 1) {
		const notice = notices[index];
		if (!notice) continue;
		if (notice.kind !== "evidence" || notice.ref?.runId !== runId) continue;
		if (notice.level !== "error") return null;
		const reason = notice.message.replace(/\s+/g, " ").trim();
		return reason.length > 0 ? reason : null;
	}
	return null;
}

/**
 * Fold an ObservabilitySnapshot into the evidence readiness for one run. Cheap
 * and pure: it scans the bounded run and notice rings the projection already
 * maintains and reads no evidence files. Pending outranks a stale ready bundle
 * because an in-flight rebuild is the more current signal; a matching run
 * summary with an evidence bundle is ready; the latest error-level evidence
 * notice for the run marks it failed.
 */
export function deriveRunEvidenceState(
	snapshot: ObservabilitySnapshot | undefined,
	runId: string,
): RunEvidencePresentation {
	if (!snapshot || runId.length === 0) return { state: "none", viewFilter: `dispatch:${runId}` };
	if (snapshot.pendingEvidenceBuildRunIds.includes(runId)) {
		return { state: "pending", viewFilter: `evidence:${runId}` };
	}
	const evidence = snapshot.runs.find((run) => run.runId === runId)?.evidence;
	if (evidence) {
		return { state: "ready", evidenceId: evidence.evidenceId, viewFilter: `evidence:${evidence.evidenceId}` };
	}
	const reason = latestEvidenceFailureReason(snapshot.notices, runId);
	if (reason !== null) return { state: "failed", reason, viewFilter: `evidence:${runId}` };
	return { state: "none", viewFilter: `dispatch:${runId}` };
}

interface EvidenceGlyphPresentation {
	glyph: string;
	word: string;
	token: ClioToken;
}

// Proof state shares the section 5 glyph language with run status: the queued
// glyph for pending build work, the ok check for a ready bundle, and the error
// cross for a failed build. `none` renders no marker.
function evidenceStatePresentation(state: EvidenceState): EvidenceGlyphPresentation | null {
	switch (state) {
		case "pending":
			return { glyph: GLYPH.queued, word: "pending", token: "info" };
		case "ready":
			return { glyph: GLYPH.ok, word: "ready", token: "success" };
		case "failed":
			return { glyph: GLYPH.error, word: "failed", token: "error" };
		case "none":
			return null;
	}
}

// Dispatch card rows follow the footer dashboard key-value grammar: a dim key
// padded to a shared column, then one trailing space before the value. The
// widest key ("telemetry") sets the column so every value starts aligned.
const CARD_KV_KEY_WIDTH = "telemetry".length;

function cardKvKey(theme: ClioTheme, key: string): string {
	return theme.fg("dim", `${key.padEnd(CARD_KV_KEY_WIDTH)} `);
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

// The `proof` row: the colored state marker, an optional failure reason, then
// the dim `/view` filter an operator would type.
function evidenceCardLine(theme: ClioTheme, evidence: RunEvidencePresentation, contentWidth: number): string | null {
	const presentation = evidenceStatePresentation(evidence.state);
	if (!presentation) return null;
	const units = [theme.fg(presentation.token, `${presentation.glyph} ${presentation.word}`)];
	if (evidence.state === "failed" && evidence.reason) units.push(theme.fg("muted", evidence.reason));
	units.push(theme.fg("dim", evidence.viewFilter));
	return cardUnitsLine(theme, "proof", units, contentWidth);
}

/** Sanitize lifecycle task text at the terminal boundary and collapse it to one bounded line. */
export function sanitizeDispatchTaskSummary(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const sanitized = sanitizeCallTargetText(value);
	if (sanitized.length === 0) return undefined;
	// pi-tui's truncator appends reset sequences when it elides. Strip those
	// again so the stored projection remains plain text, not terminal styling.
	return sanitizeCallTargetText(truncateToWidth(sanitized, TASK_SUMMARY_MAX_WIDTH, "…", false));
}

function retryCountdown(retry: DispatchRetryPresentation, now = Date.now()): string {
	const remainingMs = Math.max(0, retry.dueAtMs - now);
	return remainingMs === 0 ? "now" : `in ${formatCompactMs(remainingMs)}`;
}

/**
 * One action as a phrase: the tool name, then the verb and object of its
 * redacted descriptor. The descriptor was bounded and scrubbed at the worker
 * seam, so this composes text and never inspects an argument.
 */
function actionPhrase(action: WorkerAction): string {
	const descriptor = action.descriptor;
	if (descriptor === undefined) return action.tool;
	const object = descriptor.object === undefined ? "" : ` ${descriptor.object}${descriptor.truncated ? "…" : ""}`;
	return `${action.tool} ${descriptor.verb}${object}`;
}

/** The phase word an expanded card names, or null for a phase that says nothing new. */
function progressPhaseUnit(theme: ClioTheme, progress: WorkerProgressSnapshot): string | null {
	switch (progress.phase) {
		case "thinking":
			// The phase only. Reasoning content never reaches an operator surface.
			return theme.fg("reason", `${GLYPH.phaseThinking} thinking`);
		case "writing":
			return theme.fg("accent", `${GLYPH.phaseWriting} writing`);
		case "tool":
			return theme.fg("action", `${GLYPH.phaseTool} tool`);
		case "waiting":
			return theme.fg("info", `${GLYPH.phaseWaiting} waiting`);
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
	if (phase !== null) units.push(phase);
	if (current !== null) units.push(theme.fg("muted", actionPhrase(current)));
	else if (recent !== undefined) units.push(theme.fg("dim", `last ${actionPhrase(recent)}`));
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
): string[] {
	if (progress.tailText.length === 0) return [];
	const gutter = CARD_KV_KEY_WIDTH + 1;
	const railWidth = Math.max(1, contentWidth - gutter - 2);
	const wrapped: string[] = [];
	for (const line of progress.tailText.split("\n")) {
		for (const row of wrapTextWithAnsi(sanitizeCallTargetText(line), railWidth)) wrapped.push(row);
	}
	const shown = wrapped.slice(Math.max(0, wrapped.length - WORKER_PROGRESS_CARD_ROWS));
	const hiddenRows = wrapped.length - shown.length;
	const rail = theme.fg("dim", `${GLYPH.rail} `);
	const body = shown.map((row) => `${rail}${theme.fg("muted", row)}`);
	const hiddenLines = progress.droppedLines + hiddenRows;
	if (hiddenLines > 0 || progress.droppedBytes > 0) {
		const facts = [
			...(hiddenLines > 0 ? [`${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}`] : []),
			...(progress.droppedBytes > 0 ? [`${progress.droppedBytes} bytes outran the view`] : []),
			`/view dispatch:${runId}`,
		];
		body.push(`${rail}${theme.fg("dim", truncateToWidth(facts.join(" · "), railWidth, "…", false))}`);
	}
	// The key labels the block once and the rest hangs under it, which is the
	// card's key-value grammar applied to a body rather than to one value.
	return body.map((row, index) => `${index === 0 ? cardKvKey(theme, "answer") : " ".repeat(gutter)}${row}`);
}

export function renderDispatchCard(
	row: DispatchBoardRow,
	width: number,
	evidence?: RunEvidencePresentation,
	options: { selected?: boolean; expanded?: boolean } = {},
): string[] {
	const theme = clioTheme();
	const contentWidth = Math.max(0, width - 4);
	const agentLabel = agentDisplayLabel(row);
	const elapsed = formatCompactMs(row.elapsedMs);
	const cost = formatCostAggregate(costAggregateForAmount(row.costUsd, row.costProvenance)) ?? COST_NOT_MEASURED;
	const detail = terminalDetail(row);

	const presentation = dispatchStatusPresentation(row.status, {
		...(row.status === "running" ? { tick: Math.floor(Date.now() / 100) } : {}),
	});
	// The status value (glyph plus word) is the single status-colored element on
	// the card. Cost and TTFT are neutral telemetry, so they render muted rather
	// than amber or the accentDeep structure color.
	const statusStr = theme.fg(presentation.token, `${presentation.glyph} ${presentation.label}`);

	const ttft = row.ttftMs !== null ? `${row.ttftMs}ms` : row.status === "running" ? `waiting${GLYPH.ellipsis}` : "n/a";
	const target = `${theme.fg("muted", `${row.runtimeKind}:${row.targetId}`)} ${theme.fg("dim", "▸")} ${theme.fg("muted", row.wireModelId)}`;

	// The agent label is the frame title and can be arbitrarily long (agent ids
	// are user data); clamp it so the title plus the elapsed meta never pushes
	// the right corner past the card width.
	const selectionWidth = options.selected === true ? visibleWidth(GLYPH.cursor) + 1 : 0;
	const rowPrefix = dispatchRowPrefix(theme, row);
	const labelBudget = Math.max(1, width - visibleWidth(elapsed) - 10 - selectionWidth - rowPrefix.width);
	const clampedLabel = truncateToWidth(agentLabel, labelBudget, GLYPH.ellipsis, false);
	const cardTitle =
		options.selected === true
			? `${theme.fg("accent", GLYPH.cursor)} ${rowPrefix.text}${screenTitle(theme, clampedLabel)}`
			: `${rowPrefix.text}${clampedLabel}`;

	const elapsedSec = row.elapsedMs / 1000;
	const tokensPerSec = elapsedSec > 0.1 ? Math.round(row.outputTokens / elapsedSec) : 0;
	// A queued run has produced nothing yet, so it never carries a throughput.
	const showRate = row.status !== "enqueued" && tokensPerSec > 0;
	const up = theme.fg("muted", `${GLYPH.up} ${formatFooterTokens(row.inputTokens)}`);
	const down = theme.fg(
		"muted",
		`${GLYPH.down} ${formatFooterTokens(row.outputTokens)}${showRate ? ` (${tokensPerSec}/s)` : ""}`,
	);
	const total = theme.fg("muted", `total ${formatFooterTokens(row.tokenCount)}`);

	// The model id is user data and can outrun the card; mark the cut with `…`
	// rather than hard-clipping it mid-token into a string that reads whole.
	const targetLine = truncateToWidth(`${cardKvKey(theme, "target")}${target}`, contentWidth, "…", false);
	// Fleet facts: node placement (absent means local), gate role badge, and
	// reroute lineage. Whole units so overflow drops a fact, never clips one.
	const statusUnits = [
		statusStr,
		theme.fg("muted", `node ${row.node ?? "local"}`),
		...(row.gate !== undefined ? [theme.fg("info", `gate ${row.gate.role} c${row.gate.cycle}`)] : []),
		...(row.rerouteCount !== undefined && row.rerouteCount > 0
			? [theme.fg("warning", `rerouted x${row.rerouteCount}`)]
			: []),
		...(row.failoverHops !== undefined && row.failoverHops > 0
			? [theme.fg("warning", `failed over x${row.failoverHops}`)]
			: []),
		`${theme.fg("dim", "ttft")} ${theme.fg("muted", ttft)}`,
		`${theme.fg("dim", "cost")} ${theme.fg("muted", cost)}`,
	];
	const contextUnit = formatWorkerContextMeter(row.lastContextTokens ?? 0, row.contextWindow, theme);
	const bodyLines = [
		cardUnitsLine(theme, "run", [theme.fg("dim", row.runId)], contentWidth),
		targetLine,
		...(row.taskSummary
			? [truncateToWidth(`${cardKvKey(theme, "task")}${theme.fg("muted", row.taskSummary)}`, contentWidth, "…", false)]
			: []),
		cardUnitsLine(theme, "status", statusUnits, contentWidth),
		...(row.budget !== undefined
			? [
					truncateToWidth(
						`${cardKvKey(theme, "policy")}${theme.fg("muted", `${formatBudgetPolicy(row.budget)}; requested ${formatBudgetRequest(row.budget)}`)}`,
						contentWidth,
						"…",
						false,
					),
					truncateToWidth(
						`${cardKvKey(theme, "budget")}${theme.fg("muted", `${formatEffectiveBudget(row.budget)}; reason ${formatBudgetReasons(row.budget)}`)}`,
						contentWidth,
						"…",
						false,
					),
				]
			: []),
		cardUnitsLine(theme, "telemetry", [up, down, total, ...(contextUnit !== null ? [contextUnit] : [])], contentWidth),
	];
	if (row.retry) {
		bodyLines.push(
			cardUnitsLine(
				theme,
				"retry",
				[
					theme.fg("warning", `attempt ${row.retry.attempt}`),
					theme.fg("muted", retryCountdown(row.retry)),
					...(row.retry.reason.length > 0 ? [theme.fg("muted", row.retry.reason)] : []),
				],
				contentWidth,
			),
		);
	}
	// Live tool activity: the executing tool (worker telemetry carries names,
	// never arguments, across the stdout seam) and the recent-tool trail.
	const currentTool = row.currentTool ?? null;
	const recentTools = row.recentTools ?? [];
	if (currentTool !== null || recentTools.length > 0) {
		const toolUnits = [
			currentTool !== null ? theme.fg("action", `${currentTool} running`) : theme.fg("dim", "idle"),
			...(recentTools.length > 0 ? [theme.fg("muted", `recent ${recentTools.join(" ")}`)] : []),
		];
		bodyLines.push(cardUnitsLine(theme, "tools", toolUnits, contentWidth));
	}
	// Live worker progress is expanded detail, never a default row: five running
	// scouts must stay five compact cards until the operator opens one.
	if (options.expanded === true && row.progress) {
		const doing = progressActionLine(theme, row.progress, contentWidth);
		if (doing !== null) bodyLines.push(doing);
		bodyLines.push(...progressAnswerLines(theme, row.progress, row.runId, contentWidth));
	}
	if (row.steerAcknowledgement) {
		bodyLines.push(
			cardUnitsLine(
				theme,
				"control",
				[theme.fg("success", `${GLYPH.ok} steer received`), theme.fg("muted", `${row.steerAcknowledgement.chars} chars`)],
				contentWidth,
			),
		);
	}
	// The proof row is present only when the observability projection knows an
	// evidence state for this run; an unknown/none state adds no line, so cards
	// without evidence keep their existing three-line body.
	if (evidence) {
		const proofLine = evidenceCardLine(theme, evidence, contentWidth);
		if (proofLine !== null) bodyLines.push(proofLine);
	}
	if (detail !== null) bodyLines.push(`${cardKvKey(theme, "detail")}${theme.fg("dim", detail)}`);

	return frame(theme, cardTitle, bodyLines, width, { rightMeta: elapsed });
}

function renderTaskIslandRow(row: DispatchBoardRow, width: number): string[] {
	const theme = clioTheme();
	const agentLabel = agentDisplayLabel(row);
	const elapsed = formatCompactMs(row.elapsedMs);
	const cost = formatCostAggregate(costAggregateForAmount(row.costUsd, row.costProvenance)) ?? COST_NOT_MEASURED;

	const dot = dotSep(theme);
	const presentation = dispatchStatusPresentation(row.status, {
		compact: true,
		...(row.status === "running" ? { tick: Math.floor(Date.now() / 100) } : {}),
	});
	const glyph = theme.fg(presentation.token, presentation.glyph);
	const statusStr = theme.fg(presentation.token, presentation.label);

	// Reserve the glyph, separators, status word, and elapsed so a long agent
	// label is clipped with a `…` marker rather than shoved off the row unmarked.
	const rowPrefix = dispatchRowPrefix(theme, row);
	const labelChrome =
		visibleWidth(presentation.glyph) +
		1 +
		rowPrefix.width +
		3 +
		visibleWidth(presentation.label) +
		3 +
		visibleWidth(elapsed);
	const clampedLabel = truncateToWidth(agentLabel, Math.max(1, width - labelChrome), "…", false);

	// The agent label drops its accent color for plain bold; the status word is
	// the only status-colored element on the row, with dim middot separators.
	const line1 = `${glyph} ${rowPrefix.text}${theme.paint(clampedLabel, { bold: true })}${dot}${statusStr}${dot}${theme.fg("muted", elapsed)}`;

	const elapsedSec = row.elapsedMs / 1000;
	const tokensPerSec = elapsedSec > 0.1 ? Math.round(row.outputTokens / elapsedSec) : 0;
	// A queued run has produced nothing yet, so it never carries a throughput.
	const showRate = row.status !== "enqueued" && tokensPerSec > 0;
	const up = theme.fg("muted", `${GLYPH.up} ${formatFooterTokens(row.inputTokens)}`);
	const down = theme.fg(
		"muted",
		`${GLYPH.down} ${formatFooterTokens(row.outputTokens)}${showRate ? ` (${tokensPerSec}/s)` : ""}`,
	);
	const telemetry = row.retry
		? `  ${theme.fg("warning", `attempt ${row.retry.attempt}`)}${dot}${theme.fg("muted", retryCountdown(row.retry))}`
		: `  ${up}${dot}${down}${dot}${theme.fg("muted", cost)}`;
	const task = row.taskSummary
		? `  ${theme.fg("muted", truncateToWidth(row.taskSummary, Math.max(1, width - 2), "…", false))}`
		: null;

	return [padAnsi(line1, width), ...(task ? [padAnsi(task, width)] : []), padAnsi(telemetry, width)];
}

export function formatDispatchBoardLines(
	rows: ReadonlyArray<DispatchBoardRow>,
	width = 76,
	observability?: ObservabilitySnapshot,
	selectedRunId?: string | null,
	/** Whether the selected row renders its worker-progress detail. Off by default. */
	detailExpanded = false,
): string[] {
	if (rows.length === 0) {
		const theme = clioTheme();
		const lines = ["", "No fleet runs yet", "Delegated runs appear here with task, status, and telemetry.", ""];
		return lines.map((line) => {
			const padding = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
			return theme.fg("dim", " ".repeat(padding) + line);
		});
	}

	const cards = rows.map((row) =>
		renderDispatchCard(row, width, deriveRunEvidenceState(observability, row.runId), {
			selected: row.runId === selectedRunId,
			expanded: detailExpanded && row.runId === selectedRunId,
		}),
	);
	const body: string[] = [];
	for (const card of cards) {
		if (body.length > 0) body.push("");
		body.push(...card);
	}
	return body;
}

/**
 * Live dispatch-board component. Cards render at the width the TUI actually
 * grants instead of a baked-in 76-column layout, so a narrow terminal no
 * longer clips telemetry mid-token and a wide one no longer wastes the frame.
 * Rows and the observability snapshot are read per render. The board is a pure
 * consumer: its owner reconciles the store on the shared UI polling cycle.
 * The only local state is the selected run id, kept stable across
 * lifecycle-driven reorders; ticker plus bus-driven requestRender calls drive
 * repaints.
 */
export interface DispatchBoardView extends Component {
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
	observability: () => ObservabilitySnapshot | undefined,
): DispatchBoardView {
	let selectedRunId: string | null = null;
	// Detail is a property of the operator's attention, not of a run, so it
	// follows the cursor rather than pinning to the row it was opened on.
	let expanded = false;

	const normalizeSelection = (currentRows: ReadonlyArray<DispatchBoardRow>): DispatchBoardRow | null => {
		if (currentRows.length === 0) {
			selectedRunId = null;
			return null;
		}
		const selected = currentRows.find((row) => row.runId === selectedRunId) ?? currentRows[0] ?? null;
		selectedRunId = selected?.runId ?? null;
		return selected;
	};

	const moveSelection = (delta: -1 | 1): void => {
		const currentRows = rows();
		const selected = normalizeSelection(currentRows);
		if (!selected || currentRows.length < 2) return;
		const index = currentRows.findIndex((row) => row.runId === selected.runId);
		const nextIndex = (index + delta + currentRows.length) % currentRows.length;
		selectedRunId = currentRows[nextIndex]?.runId ?? selected.runId;
	};

	return {
		render(width: number): string[] {
			const currentRows = rows();
			normalizeSelection(currentRows);
			return formatDispatchBoardLines(currentRows, Math.max(1, width), observability(), selectedRunId, expanded);
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
		invalidate(): void {},
	};
}

export function formatTaskIslandLines(rows: ReadonlyArray<DispatchBoardRow>, maxRows = 4): string[] {
	const visibleRows = rows.slice(0, Math.max(1, maxRows));
	const body: string[] = [];

	if (visibleRows.length === 0) {
		const theme = clioTheme();
		body.push(theme.fg("dim", "No active fleet runs."));
		body.push(theme.fg("dim", "Use /run or /delegate to spawn agents."));
	} else {
		for (let i = 0; i < visibleRows.length; i++) {
			const row = visibleRows[i];
			if (!row) continue;
			if (i > 0) {
				body.push(innerDivider(clioTheme(), TASK_ISLAND_WIDTH));
			}
			body.push(...renderTaskIslandRow(row, TASK_ISLAND_WIDTH));
		}
		const hidden = rows.length - visibleRows.length;
		if (hidden > 0) {
			body.push(innerDivider(clioTheme(), TASK_ISLAND_WIDTH));
			body.push(clioTheme().fg("dim", `+ ${hidden} more`));
		}
	}

	// Body rows are already ANSI-padded to TASK_ISLAND_WIDTH by the row renderer
	// (or are fixed-width dividers/empty-state lines). The canonical frame re-pads
	// each row ANSI-aware, so passing the styled lines through is safe.
	return frame(clioTheme(), "Fleet runs", body, TASK_ISLAND_WIDTH + 4);
}

function parseRunId(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function parseText(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function parseRuntimeKind(value: unknown): RunKind {
	if (value === "sdk" || value === "subprocess" || value === "acp-delegation") return value;
	return "http";
}

function parseAgentAudience(value: unknown, fallback: AgentAudience | undefined): AgentAudience | undefined {
	if (value === "base" || value === "shadow" || value === "custom" || value === "internal") return value;
	return fallback;
}

function parseRequestOrigin(
	value: unknown,
	fallback: DispatchRequestOrigin | undefined,
): DispatchRequestOrigin | undefined {
	if (value === "user" || value === "agent" || value === "internal") return value;
	return fallback;
}

function parseFiniteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseTaskSummary(
	raw: Partial<DispatchRunIdentity> & { task?: unknown; taskSummary?: unknown },
	fallback: string | undefined,
): string | undefined {
	return sanitizeDispatchTaskSummary(raw.task) ?? sanitizeDispatchTaskSummary(raw.taskSummary) ?? fallback;
}

function parsePositiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function parseGateBadge(value: unknown): { role: string; cycle: number } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as { role?: unknown; cycle?: unknown };
	if (typeof record.role !== "string" || record.role.length === 0) return undefined;
	const cycle = parsePositiveInt(record.cycle) ?? 1;
	return { role: record.role, cycle };
}

function parseFiniteNumberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseOptionalDetail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const detail = value.replace(/\s+/g, " ").trim();
	return detail.length > 0 ? detail : null;
}

function terminalDetail(row: DispatchBoardRow): string | null {
	if (row.status !== "failed" && row.status !== "dead" && row.status !== "aborted") return null;
	return parseOptionalDetail(row.outcomeDetail);
}

function resolveAgentEndStatus(rawMessages: unknown): DispatchBoardStatus | null {
	if (!Array.isArray(rawMessages)) return null;
	for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
		const message = (rawMessages[index] ?? {}) as AssistantMessageShape;
		if (message.role !== "assistant") continue;
		if (message.stopReason === "stop") return "completed";
		if (message.stopReason === "error") return "failed";
		if (message.stopReason === "aborted") return "aborted";
		return null;
	}
	return null;
}

function resolveFailedStatus(reason: unknown): DispatchBoardStatus {
	if (reason === "dead" || reason === "stalled") return "dead";
	if (reason === "interrupted" || reason === "canceled") return "aborted";
	return "failed";
}

function resolveFailureDetail(
	payload: Partial<DispatchFailedPayload>,
	fallback: string | null | undefined,
): string | null {
	const detail = parseOptionalDetail(payload.outcomeDetail);
	if (detail !== null) return detail;
	if (payload.reason === "timed_out") return "turn timeout exceeded";
	return fallback ?? null;
}

function resolveHeartbeatStatus(status: unknown): DispatchBoardStatus | null {
	if (status === "alive") return "running";
	if (status === "stale" || status === "dead") return status;
	return null;
}

function isTerminalStatus(status: DispatchBoardStatus): boolean {
	return status === "completed" || status === "failed" || status === "aborted" || status === "dead";
}

function parseRetrySnapshot(value: DispatchSnapshot["retrying"][number]): DispatchRetryPresentation | null {
	const attempt = parsePositiveInt(value.attempt);
	const dueAtMs = Date.parse(value.dueAt);
	if (attempt === undefined || !Number.isFinite(dueAtMs)) return null;
	return {
		attempt,
		dueAtMs,
		reason: sanitizeCallTargetText(value.reason),
	};
}

function readRetrySnapshot(
	snapshot: DispatchSnapshot,
): Map<string, { agentId: string; taskSummary?: string; retry: DispatchRetryPresentation }> {
	const retrying = new Map<string, { agentId: string; taskSummary?: string; retry: DispatchRetryPresentation }>();
	try {
		for (const value of snapshot.retrying) {
			const runId = parseRunId(value.runId);
			const agentId = parseNonEmptyString(value.agentId);
			const retry = parseRetrySnapshot(value);
			const taskSummary = sanitizeDispatchTaskSummary(value.task);
			if (runId && agentId && retry) {
				retrying.set(runId, {
					agentId,
					...(taskSummary !== undefined ? { taskSummary } : {}),
					retry,
				});
			}
		}
	} catch {
		// The board remains lifecycle-event driven if an optional snapshot fails.
	}
	return retrying;
}

function readRunningSnapshot(snapshot: DispatchSnapshot): Map<
	string,
	{
		inputTokens: number;
		outputTokens: number;
		tokenCount: number;
		costUsd: number;
		costProvenance: CostProvenance;
		outcomePhase: string;
		budget?: RunToolBudgetEnvelope;
	}
> {
	const running = new Map<
		string,
		{
			inputTokens: number;
			outputTokens: number;
			tokenCount: number;
			costUsd: number;
			costProvenance: CostProvenance;
			outcomePhase: string;
			budget?: RunToolBudgetEnvelope;
		}
	>();
	try {
		for (const value of snapshot.running) {
			const runId = parseRunId(value.runId);
			if (!runId) continue;
			const budget = cloneRunToolBudgetEnvelope(value.budget);
			running.set(runId, {
				inputTokens: parseFiniteNumberOrZero(value.tokens.input),
				outputTokens: parseFiniteNumberOrZero(value.tokens.output),
				tokenCount: parseFiniteNumberOrZero(value.tokens.total),
				costUsd: parseFiniteNumberOrZero(value.costUsd),
				costProvenance: value.costProvenance ?? "unknown",
				outcomePhase: value.outcomePhase,
				...(budget !== undefined ? { budget } : {}),
			});
		}
	} catch {
		// Lifecycle/progress events remain authoritative if the optional snapshot fails.
	}
	return running;
}

function resolveElapsedMs(entry: DispatchBoardEntry, now: number): number {
	const startedAtMs = entry.startedAtMs ?? entry.enqueuedAtMs;
	if (entry.durationMs !== null) return entry.durationMs;
	const endMs = entry.finishedAtMs ?? now;
	return Math.max(0, rawDurationMs(startedAtMs, endMs));
}

function toRow(entry: DispatchBoardEntry, now: number): DispatchBoardRow {
	const retry = entry.retry;
	const progress = entry.progress.snapshot();
	return {
		progress,
		runId: entry.runId,
		agentId: entry.agentId,
		...(entry.agentAudience !== undefined ? { agentAudience: entry.agentAudience } : {}),
		...(entry.requestOrigin !== undefined ? { requestOrigin: entry.requestOrigin } : {}),
		runtimeKind: entry.runtimeKind,
		runtimeId: entry.runtimeId,
		targetId: entry.targetId,
		wireModelId: entry.wireModelId,
		...(entry.taskSummary !== undefined ? { taskSummary: entry.taskSummary } : {}),
		...(entry.budget !== undefined ? { budget: entry.budget } : {}),
		status: retry ? "retrying" : entry.status,
		elapsedMs: resolveElapsedMs(entry, now),
		tokenCount: entry.tokenCount,
		costUsd: entry.costUsd,
		...(entry.costProvenance !== undefined ? { costProvenance: entry.costProvenance } : {}),
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		ttftMs: entry.ttftMs,
		...(entry.outcomeDetail !== undefined ? { outcomeDetail: entry.outcomeDetail } : {}),
		...(entry.node !== undefined ? { node: entry.node } : {}),
		...(entry.gate !== undefined ? { gate: { ...entry.gate } } : {}),
		...(entry.rerouteCount !== undefined ? { rerouteCount: entry.rerouteCount } : {}),
		...(entry.failoverHops !== undefined ? { failoverHops: entry.failoverHops } : {}),
		...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
		lastContextTokens: entry.lastContextTokens,
		...(entry.receiptId !== undefined ? { receiptId: entry.receiptId } : {}),
		// Both tool fields are views of the one projection, so the compact card and
		// the expanded detail can never disagree about what is running.
		currentTool: retry ? null : (progress.currentAction?.tool ?? null),
		recentTools: progress.recentActions.map((action) => action.tool),
		...(retry ? { retry: { ...retry } } : {}),
		...(entry.steerAcknowledgement ? { steerAcknowledgement: { ...entry.steerAcknowledgement } } : {}),
	};
}

function sortEntries(a: DispatchBoardEntry, b: DispatchBoardEntry): number {
	const aStatus = a.retry ? "retrying" : a.status;
	const bStatus = b.retry ? "retrying" : b.status;
	const rank = STATUS_ORDER[aStatus] - STATUS_ORDER[bStatus];
	if (rank !== 0) return rank;
	const aTime = a.finishedAtMs ?? a.startedAtMs ?? a.enqueuedAtMs;
	const bTime = b.finishedAtMs ?? b.startedAtMs ?? b.enqueuedAtMs;
	if (aTime !== bTime) return bTime - aTime;
	return a.sequence - b.sequence;
}

function pruneEntries(entries: Map<string, DispatchBoardEntry>): void {
	if (entries.size <= MAX_DISPATCH_BOARD_ROWS) return;
	const terminalEntries = [...entries.values()]
		.filter((entry) => !entry.retry && isTerminalStatus(entry.status))
		.sort((a, b) => a.sequence - b.sequence);
	const evictionQueue =
		terminalEntries.length > 0 ? terminalEntries : [...entries.values()].sort((a, b) => a.sequence - b.sequence);
	for (const entry of evictionQueue) {
		if (entries.size <= MAX_DISPATCH_BOARD_ROWS) break;
		entries.delete(entry.runId);
	}
}

export function createDispatchBoardStore(
	bus: SafeEventBus,
	snapshot?: () => DispatchSnapshot,
	/**
	 * Sealed terminal facts for a finished run. Settlement replaces the
	 * provisional live tail with the receipt's answer where one can be read; the
	 * run's own durable message stands in where it cannot.
	 */
	readReceipt?: WorkerReceiptReader,
): {
	rows(): ReadonlyArray<DispatchBoardRow>;
	activeRows(): ReadonlyArray<DispatchBoardRow>;
	reconcile(): void;
	unsubscribe(): void;
} {
	const entries = new Map<string, DispatchBoardEntry>();
	let nextSequence = 0;
	let reconciledAtMs = Date.now();

	/** Seal a run's projection on the receipt's answer, or on its own last durable message. */
	const settleProgress = (entry: DispatchBoardEntry): void => {
		const text = readReceipt?.(entry.runId)?.text;
		entry.progress.settle(typeof text === "string" && text.trim().length > 0 ? text : undefined);
	};

	// Payloads arrive typed off the bus, but the board keeps its runtime
	// parsing (parse* helpers) because events are not validated at runtime.
	const upsertBase = (
		raw: Partial<DispatchRunIdentity>,
		status: DispatchBoardStatus,
		now: number,
	): DispatchBoardEntry | null => {
		const runId = parseRunId(raw.runId);
		if (!runId) return null;
		const previous = entries.get(runId);
		const agentAudience = parseAgentAudience(raw.agentAudience, previous?.agentAudience);
		const requestOrigin = parseRequestOrigin(raw.requestOrigin, previous?.requestOrigin);
		const node = parseNonEmptyString(raw.node) ?? previous?.node;
		const gate = parseGateBadge(raw.gate) ?? previous?.gate;
		const rerouteCount = parsePositiveInt(raw.rerouteCount) ?? previous?.rerouteCount;
		const contextWindow = parsePositiveInt(raw.contextWindow) ?? previous?.contextWindow;
		const taskSummary = parseTaskSummary(raw, previous?.taskSummary);
		const budget = cloneRunToolBudgetEnvelope(raw.budget) ?? previous?.budget;
		const entry: DispatchBoardEntry = {
			runId,
			agentId: parseText(raw.agentId, previous?.agentId ?? "-"),
			...(agentAudience !== undefined ? { agentAudience } : {}),
			...(requestOrigin !== undefined ? { requestOrigin } : {}),
			runtimeKind: parseRuntimeKind(raw.runtimeKind ?? previous?.runtimeKind),
			runtimeId: parseText(raw.runtimeId, previous?.runtimeId ?? "-"),
			targetId: parseText(raw.targetId, previous?.targetId ?? "-"),
			wireModelId: parseText(raw.wireModelId, previous?.wireModelId ?? "-"),
			...(taskSummary !== undefined ? { taskSummary } : {}),
			...(budget !== undefined ? { budget } : {}),
			status,
			tokenCount: previous?.tokenCount ?? 0,
			costUsd: previous?.costUsd ?? 0,
			costProvenance: previous?.costProvenance ?? "unknown",
			sequence: previous?.sequence ?? nextSequence++,
			enqueuedAtMs: previous?.enqueuedAtMs ?? now,
			startedAtMs: previous?.startedAtMs ?? null,
			startedAtClockMs: previous?.startedAtClockMs ?? null,
			finishedAtMs: previous?.finishedAtMs ?? null,
			durationMs: previous?.durationMs ?? null,
			inputTokens: previous?.inputTokens ?? 0,
			outputTokens: previous?.outputTokens ?? 0,
			ttftMs: previous?.ttftMs ?? null,
			outcomeDetail: previous?.outcomeDetail ?? null,
			...(node !== undefined ? { node } : {}),
			...(gate !== undefined ? { gate } : {}),
			...(rerouteCount !== undefined ? { rerouteCount } : {}),
			...(contextWindow !== undefined ? { contextWindow } : {}),
			lastContextTokens: previous?.lastContextTokens ?? 0,
			...(previous?.receiptId !== undefined ? { receiptId: previous.receiptId } : {}),
			progress: previous?.progress ?? createWorkerProgressFold(),
			...(previous?.retry ? { retry: { ...previous.retry } } : {}),
			...(previous?.steerAcknowledgement ? { steerAcknowledgement: { ...previous.steerAcknowledgement } } : {}),
		};
		entries.set(runId, entry);
		pruneEntries(entries);
		return entry;
	};

	const unsubscribers = [
		bus.on(BusChannels.DispatchEnqueued, (raw) => {
			const entry = upsertBase(raw ?? {}, "enqueued", Date.now());
			if (entry) delete entry.retry;
		}),
		bus.on(BusChannels.DispatchStarted, (raw) => {
			const now = Date.now();
			const entry = upsertBase(raw ?? {}, "running", now);
			if (!entry) return;
			entry.startedAtMs ??= now;
			entry.startedAtClockMs ??= performance.now();
			entry.finishedAtMs = null;
			entry.durationMs = null;
			delete entry.retry;
		}),
		bus.on(BusChannels.DispatchCompleted, (raw) => {
			const now = Date.now();
			const payload: Partial<DispatchCompletedPayload> = raw ?? {};
			const entry = upsertBase(payload, "completed", now);
			if (!entry) return;
			entry.startedAtMs ??= entry.enqueuedAtMs;
			entry.finishedAtMs = now;
			entry.durationMs = parseFiniteNumber(payload.durationMs, Math.max(0, rawDurationMs(entry.startedAtMs, now)));
			entry.tokenCount = parseFiniteNumber(payload.tokenCount, entry.tokenCount);
			entry.costUsd = parseFiniteNumber(payload.costUsd, entry.costUsd);
			entry.costProvenance = payload.costProvenance ?? "unknown";
			entry.outcomeDetail = null;
			settleProgress(entry);
			// A terminal dispatch event is published only after the run's receipt is
			// sealed at receipts/<runId>.json, so the run id is the receipt id here.
			entry.receiptId = entry.runId;
			delete entry.retry;
			if (typeof payload.inputTokenCount === "number") {
				entry.inputTokens = payload.inputTokenCount + parseFiniteNumberOrZero(payload.cacheReadTokenCount);
			}
			if (typeof payload.outputTokenCount === "number") {
				entry.outputTokens = payload.outputTokenCount;
			}
		}),
		bus.on(BusChannels.DispatchFailed, (raw) => {
			const now = Date.now();
			const payload: Partial<DispatchFailedPayload> = raw ?? {};
			const runId = parseRunId(payload.runId);
			const previousStatus = runId !== null ? entries.get(runId)?.status : undefined;
			const resolvedStatus = resolveFailedStatus(payload.reason);
			const status = previousStatus === "dead" && resolvedStatus === "failed" ? "dead" : resolvedStatus;
			const entry = upsertBase(payload, status, now);
			if (!entry) return;
			entry.startedAtMs ??= entry.enqueuedAtMs;
			entry.finishedAtMs = now;
			entry.durationMs = parseFiniteNumber(payload.durationMs, Math.max(0, rawDurationMs(entry.startedAtMs, now)));
			entry.tokenCount = parseFiniteNumber(payload.tokenCount, entry.tokenCount);
			entry.costUsd = parseFiniteNumber(payload.costUsd, entry.costUsd);
			entry.costProvenance = payload.costProvenance ?? "unknown";
			entry.outcomeDetail = resolveFailureDetail(payload, entry.outcomeDetail);
			settleProgress(entry);
			// A denied retry never reached a run, so no receipt was sealed for it;
			// every other failure finalized through recordReceipt like a success.
			if (payload.reason !== "retry_denied") entry.receiptId = entry.runId;
			delete entry.retry;
			if (typeof payload.inputTokenCount === "number") {
				entry.inputTokens = payload.inputTokenCount + parseFiniteNumberOrZero(payload.cacheReadTokenCount);
			}
			if (typeof payload.outputTokenCount === "number") {
				entry.outputTokens = payload.outputTokenCount;
			}
		}),
		bus.on(BusChannels.RunAborted, (raw) => {
			const runId = parseRunId(raw?.runId);
			if (!runId) return;
			const entry = entries.get(runId);
			if (!entry) return;
			const wasRetrying = entry.retry !== undefined;
			delete entry.retry;
			if (wasRetrying && raw?.startedAt === null) {
				// Canceling a retry timer is synchronous: there is no worker left to
				// wind down, so the history row can become terminal immediately.
				entry.status = "aborted";
				entry.finishedAtMs = Date.now();
				settleProgress(entry);
			} else {
				if (isTerminalStatus(entry.status) && !wasRetrying) return;
				entry.status = "cancelling";
			}
			entry.outcomeDetail = parseOptionalDetail(raw?.reason) ?? entry.outcomeDetail ?? null;
		}),
		bus.on(BusChannels.DispatchProgress, (raw) => {
			const payload: Partial<DispatchProgressPayload> = raw ?? {};
			const runId = parseRunId(payload.runId);
			if (!runId) return;
			const entry = entries.get(runId);
			if (!entry) return;
			const workerEvent = (payload.event ?? {}) as WorkerEventShape;
			const type = typeof workerEvent.type === "string" ? workerEvent.type : "";
			if (type === "heartbeat_status") {
				if (isTerminalStatus(entry.status) || entry.status === "cancelling") return;
				const status = resolveHeartbeatStatus((workerEvent as { status?: unknown }).status);
				if (!status) return;
				entry.status = status;
				if (status === "dead") {
					entry.finishedAtMs ??= Date.now();
					settleProgress(entry);
					delete entry.retry;
				}
				return;
			}
			if (type === "attempt_start") {
				// The assignment stream hands the root run a failover hop: a later
				// attempt took over, so the row is live again on the new route.
				entry.failoverHops = (entry.failoverHops ?? 0) + 1;
				entry.status = "running";
				entry.finishedAtMs = null;
				// The projection keeps the tail the operator is reading and drops the
				// finished attempt's live state, exactly as the transcript block does.
				entry.progress.restart();
				delete entry.retry;
				return;
			}
			if (type === "agent_start") {
				entry.startedAtMs = Date.now();
				entry.startedAtClockMs = performance.now();
			}
			if (type === "message_update") {
				const assistantEvent =
					"assistantMessageEvent" in workerEvent &&
					typeof workerEvent.assistantMessageEvent === "object" &&
					workerEvent.assistantMessageEvent !== null
						? (workerEvent.assistantMessageEvent as { type?: unknown })
						: {};
				const hasDelta =
					assistantEvent.type === "text_delta" ||
					assistantEvent.type === "thinking_delta" ||
					assistantEvent.type === "toolcall_start" ||
					assistantEvent.type === "toolcall_delta";
				if (hasDelta && entry.ttftMs === null && entry.startedAtClockMs !== null) {
					entry.ttftMs = Math.round(performance.now() - entry.startedAtClockMs);
				}
			}
			// The one fold that reads worker prose and tool activity. Everything the
			// board says about what a worker is saying or touching comes from here,
			// so the board and the transcript block cannot tell two stories.
			entry.progress.observe(payload.event);
			if (type === "clio_steer_received") {
				const steerPayload = (workerEvent as { payload?: { chars?: unknown } }).payload;
				entry.steerAcknowledgement = {
					receivedAtMs: Date.now(),
					chars: Math.max(0, Math.floor(parseFiniteNumberOrZero(steerPayload?.chars))),
				};
			}
			if (isTerminalStatus(entry.status)) return;
			if (type === "message_end" && workerEvent.message?.role === "assistant") {
				const usage = workerEvent.message.usage;
				const input = parseFiniteNumberOrZero(usage?.input) + parseFiniteNumberOrZero(usage?.cacheRead);
				const output = parseFiniteNumberOrZero(usage?.output);
				entry.inputTokens += input;
				entry.outputTokens += output;
				entry.tokenCount += input + output + parseFiniteNumberOrZero(usage?.cacheWrite);
				// The last assistant message's input+cacheRead+output approximates the
				// worker's current context occupancy for the per-worker meter.
				entry.lastContextTokens = input + output;
			}
			if (type === "agent_end") {
				const status = resolveAgentEndStatus(workerEvent.messages);
				if (!status) return;
				entry.status = status;
				entry.finishedAtMs ??= Date.now();
				settleProgress(entry);
				delete entry.retry;
			}
		}),
	];

	let closed = false;
	const reconcile = (): void => {
		const now = Date.now();
		if (!snapshot) {
			reconciledAtMs = now;
			return;
		}
		let currentSnapshot: DispatchSnapshot;
		try {
			currentSnapshot = snapshot();
		} catch {
			// Lifecycle and progress events remain authoritative if snapshot polling fails.
			return;
		}
		if (!Array.isArray(currentSnapshot?.retrying) || !Array.isArray(currentSnapshot?.running)) return;
		reconciledAtMs = now;
		const retrying = readRetrySnapshot(currentSnapshot);
		const running = readRunningSnapshot(currentSnapshot);
		for (const entry of entries.values()) {
			if (entry.retry && !retrying.has(entry.runId)) {
				// The timer left the queue (launched or was otherwise consumed). The
				// parent attempt's original terminal state becomes visible again; the
				// successor gets its own row.
				delete entry.retry;
			}
		}
		for (const [runId, projection] of retrying) {
			const existing = entries.get(runId);
			if (existing && existing.status !== "failed" && existing.status !== "dead") {
				continue;
			}
			const entry =
				existing ??
				upsertBase(
					{
						runId,
						agentId: projection.agentId,
						...(projection.taskSummary !== undefined ? { task: projection.taskSummary } : {}),
					},
					"failed",
					now,
				);
			if (entry) {
				// A waiting retry has no live worker; the row projection already
				// renders a retrying row with no current tool.
				entry.retry = { ...projection.retry };
				if (entry.taskSummary === undefined && projection.taskSummary !== undefined) {
					entry.taskSummary = projection.taskSummary;
				}
			}
		}
		for (const [runId, live] of running) {
			const entry = entries.get(runId);
			if (!entry) continue;
			if (isTerminalStatus(entry.status) && live.outcomePhase !== "aborting") continue;
			entry.inputTokens = live.inputTokens;
			entry.outputTokens = live.outputTokens;
			entry.tokenCount = live.tokenCount;
			entry.costUsd = live.costUsd;
			entry.costProvenance = live.costProvenance;
			if (live.budget !== undefined) entry.budget = live.budget;
			if (live.outcomePhase === "aborting") {
				if (entry.status !== "completed" && entry.status !== "aborted") {
					entry.status = "cancelling";
					delete entry.retry;
				}
			}
		}
	};

	const projectRows = (activeOnly: boolean): ReadonlyArray<DispatchBoardRow> => {
		return [...entries.values()]
			.sort(sortEntries)
			.map((entry) => toRow(entry, reconciledAtMs))
			.filter((row) => !activeOnly || !isTerminalStatus(row.status));
	};

	return {
		rows() {
			return projectRows(false);
		},
		activeRows() {
			return projectRows(true);
		},
		reconcile,
		unsubscribe() {
			if (closed) return;
			closed = true;
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}
