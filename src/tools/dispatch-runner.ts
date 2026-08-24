import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { clioStateDir } from "../core/xdg.js";
import { closeAgentLedger, openAgentLedger, renderAgentLedgerBoard } from "../domains/dispatch/agent-ledger-store.js";
import type { DetachedBatchRun } from "../domains/dispatch/batch-store.js";
import type { AbortReason, DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import { durableAssistantTextFromEvent } from "../domains/dispatch/event-pump.js";
import { compileExecutionPlan, requireAgentSteps } from "../domains/dispatch/execution-plan.js";
import {
	gateDeciderAgentId,
	gateRouteCorrelation,
	type RouteCorrelationFacts,
} from "../domains/dispatch/execution-role.js";
import {
	decideReviewGate,
	finalizePendingGateDecision,
	type GateDecisionArtifact,
	type GateDecisionCorrelation,
	type GateDecisionDraft,
	materializePendingGateDecision,
	type PendingGateDecisionHandle,
	parseCompeteGateResult,
	preflightPendingGateDecisionMaterialization,
	preparePendingGateDecisionRecovery,
	readGateDecisionArtifacts,
	resolvePendingGateDecision,
	stagePendingGateDecision,
	stagePendingGateOutput,
} from "../domains/dispatch/gate-decisions.js";
import {
	COMPETE_STANCES,
	type CompeteStance,
	JUDGE_GATE_PROMPT,
	REVIEWER_GATE_PROMPT,
} from "../domains/dispatch/gate-role-prompts.js";
import { UNVERIFIABLE_RECEIPT_VERIFICATION } from "../domains/dispatch/receipt-findings.js";
import { type ReceiptIntegrityResult, verifyReceiptIntegrity } from "../domains/dispatch/receipt-integrity.js";
import { explainRouteDecision } from "../domains/dispatch/routing-intent.js";
import type { RunGateProvenance, RunGateSubjectRef, RunPlanProvenance, RunReceipt } from "../domains/dispatch/types.js";
import { extractRunProvenance, provenanceCompactSuffix } from "../domains/evidence/provenance.js";
import { adaptRunReceiptTrustStatus } from "../domains/evidence/trust-status.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import {
	type CandidateWorktree,
	type CompeteGroupOwnership,
	candidateDiffStat,
	claimCompeteGroup,
	cleanupCompeteGroup,
	commitCandidateWork,
	createCandidateWorktree,
	isGitRepository,
	loadCompeteGroup,
	markCompeteGroupCleanupReady,
	markCompeteGroupWinnerPreserved,
	mergeWinnerBranch,
	protectedPathsChangedByCompeteBranch,
	recoverCleanupReadyCompeteGroups,
	registerCompeteGroupRun,
	removeCandidateWorktree,
	settleCompeteGroupRun,
	settleRecoveredCompeteDecision,
} from "./compete-worktrees.js";
import type { DispatchAdmissionState } from "./dispatch-admission.js";
import { describeDispatchPlan, RESOLVED_DISPATCH_PLAN_ARGUMENT, withResolvedPlanTaskPin } from "./dispatch-plan.js";
import {
	createDispatchRunEventRegistry,
	type DispatchEventSummary,
	type DispatchRunEventRegistry,
} from "./dispatch-run-events.js";
import { runScoutContinuationPlan, scoutPlanAuthorityGranted, scoutTransitionDetail } from "./dispatch-scout.js";
import type { DispatchCompeteSettings, DispatchReviewSettings, DispatchToolDeps } from "./dispatch-types.js";
import type { ToolInvokeOptions, ToolResult, ToolResultDetails } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";
import {
	receiptEvidenceLabels,
	SPOT_CHECK_GUIDANCE,
	workerTextLabel,
	workerTextNonEvidenceNotices,
} from "./worker-evidence.js";

export type {
	DispatchBackgroundControl,
	DispatchBackgroundOutcome,
	DispatchBackgroundRegistry,
} from "./dispatch-background.js";

const TRUNCATION_MARKER = "\n[agent output truncated]";

/**
 * One-shot latch an attached executor races against its runs. Firing it never
 * aborts anything: the registry drain that meters the runs was never owned by
 * the awaiting code path, so unwinding the await leaves token metering, run
 * tails, and bus progress flowing.
 */
interface BackgroundSwitch {
	/** Resolves when the operator fires the control; never rejects. */
	readonly requested: Promise<void>;
	fire(): void;
}

function createBackgroundSwitch(): BackgroundSwitch {
	let fired = false;
	let signal = (): void => {};
	const requested = new Promise<void>((resolve) => {
		signal = resolve;
	});
	return {
		requested,
		fire: () => {
			if (fired) return;
			fired = true;
			signal();
		},
	};
}

type EventSummary = DispatchEventSummary;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawAssistantTextFromEvent(event: unknown): string {
	return durableAssistantTextFromEvent(event);
}

function normalizedAssistantText(summary: EventSummary): string {
	return summary.lastAssistantText.trim();
}

type RegisteredDispatchToolDeps = DispatchToolDeps & { runEvents: DispatchRunEventRegistry };

function fallbackProgressBus(deps: DispatchToolDeps): SafeEventBus | undefined {
	return deps.dispatch.ownsProgressBus?.(deps.bus) === true ? undefined : deps.bus;
}

/**
 * Gate-sensitive coordinator drain. Review and compete must finish this drain
 * and stage pending decision output before awaiting the receipt-facing final
 * promise; the ordinary registry's concurrent join cannot provide that edge.
 */
async function consumeGateSensitiveDispatchEvents(
	deps: RegisteredDispatchToolDeps,
	runId: string,
	agentId: string,
	events: AsyncIterableIterator<unknown>,
): Promise<EventSummary> {
	const summary: EventSummary = { count: 0, types: [], lastAssistantText: "", terminalAttemptRunId: runId };
	const bus = fallbackProgressBus(deps);
	for await (const event of events) {
		summary.count += 1;
		const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";
		summary.types.push(type);
		if (type === "attempt_start" && isRecord(event) && typeof event.runId === "string" && event.runId.length > 0) {
			summary.terminalAttemptRunId = event.runId;
		}
		const text = rawAssistantTextFromEvent(event);
		if (text.trim().length > 0) summary.lastAssistantText = text;
		deps.runEvents.recordEvent(runId, agentId, event);
		if (type !== "heartbeat") bus?.emit(BusChannels.DispatchProgress, { runId, agentId, event });
	}
	return summary;
}

/**
 * Fan out without waiting: admit and spawn every task, persist the durable
 * batch record, then hand the merged event stream to a background drain so
 * token metering, run tails (monitor peek), and bus progress keep flowing
 * while the orchestrator's turn continues. The tool result carries only the
 * batch id and run ids; results are gathered later through monitor
 * mode="wait"/"collect", in this session or after a resume.
 */
async function runDetached(
	deps: RegisteredDispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	sessionId: string | null,
): Promise<ToolResult> {
	const detached = deps.dispatch.detached;
	if (!detached) {
		return { kind: "error", message: "dispatch: detach is not supported in this context" };
	}
	// Detached runs are concurrent peers too, so they get a board whenever there
	// is more than one of them. Collection closes it, which can happen in a later
	// process, so the batch record carries the id.
	const ledgerId = requests.length >= 2 ? newGateGroupId("ledger") : null;
	if (ledgerId !== null) await openAgentLedger(ledgerId);
	const ledgered =
		ledgerId === null ? requests : requests.map((request) => ({ ...request, ledger: { id: ledgerId, sequence: 0 } }));
	const handle = await deps.dispatch.dispatchBatch(ledgered);
	const registered = deps.runEvents.registerBatch(
		handle,
		ledgered.map((request) => request.agentId),
		fallbackProgressBus(deps),
	);
	const assignmentIds = handle.assignmentIds;
	const runs = handle.assignmentIds.map((runId, index) => ({
		runId,
		assignmentId: assignmentIds[index] ?? runId,
		agentId: requests[index]?.agentId ?? "unknown",
	}));
	registered.completion.catch(() => {});
	// The runs are live; make their assignment records durable before returning
	// so an immediate collect resolves the logical assignment (and any queued
	// retry) instead of falling back to a bare, possibly-failed first attempt.
	await deps.dispatch.assignments?.flushWrites?.();
	try {
		await detached.register({
			batchId: handle.batchId,
			runs,
			sessionId,
			...(ledgerId !== null ? { ledgerId } : {}),
		});
	} catch (err) {
		// The runs are already live; report the durability gap instead of
		// pretending the batch does not exist.
		const message = err instanceof Error ? err.message : String(err);
		return {
			kind: "error",
			message: `dispatch: detached assignments started (batch=${handle.batchId}, assignments=${handle.assignmentIds.join(", ")}) but the durable batch record failed: ${message}`,
			details: { mode: "detached", batchId: handle.batchId, assignmentIds: [...handle.assignmentIds] },
		};
	}
	const lines = [
		`dispatch (detached) batch=${handle.batchId} started ${runs.length} run(s)`,
		...runs.map((run) => `- ${run.assignmentId} agent=${run.agentId}`),
		"",
		`Runs continue in the background. Collect results with monitor(mode="collect", batch_id="${handle.batchId}"); block on one run with monitor(mode="wait", run_id=<id>).`,
	];
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: {
			mode: "detached",
			batchId: handle.batchId,
			assignmentIds: [...handle.assignmentIds],
			runs: runs.map((run) => ({ runId: run.runId, assignmentId: run.assignmentId, agentId: run.agentId })),
		},
	};
}

/**
 * Publish this call's conversion control for as long as its topology branch
 * runs. A refusing control still registers: the operator who pressed the key
 * needs the topology's reason, and an unregistered call would answer with the
 * "nothing running" no-op instead.
 */
function registerBackgroundControl(
	deps: DispatchToolDeps,
	toolCallId: string | undefined,
	plan: { label: string; refusal: string | null; fire: () => void },
): () => void {
	const registry = deps.background;
	if (registry === undefined || toolCallId === undefined || toolCallId.length === 0) return () => {};
	let release = (): void => {};
	release = registry.register({
		toolCallId,
		label: plan.label,
		convert: () => {
			if (plan.refusal !== null) {
				return { ok: false, message: `${plan.label} cannot be backgrounded: ${plan.refusal}` };
			}
			// Drop the control before firing so a second keypress reaches the next
			// attached dispatch instead of re-firing a converted one.
			release();
			plan.fire();
			return { ok: true, message: `${plan.label} is moving to the background as a detached batch` };
		},
	});
	return () => release();
}

/**
 * Thrown out of an attached executor when the operator converts the call to a
 * detached batch. The runs keep going; only the await unwinds. `settled` names
 * sequential steps that already finished, and `undispatched` names later steps
 * that were never started, because a mid-sequence conversion really does leave
 * them unstarted and reporting a completed sequence would be a lie.
 */
class DispatchBackgroundedError extends Error {
	constructor(
		readonly batchId: string,
		readonly live: ReadonlyArray<DetachedBatchRun>,
		readonly settled: ReadonlyArray<CompletedRun>,
		readonly undispatched: ReadonlyArray<string>,
		/**
		 * The agent ledger the live runs still share. It stays open across the
		 * conversion and rides on the detached record so collect closes it, the
		 * same as a batch that was detached from the start.
		 */
		readonly ledgerId: string | null = null,
	) {
		super("dispatch: backgrounded by operator");
		this.name = "DispatchBackgroundedError";
	}
}

/**
 * Finish an operator-initiated conversion: persist the same durable batch
 * record a `detach: true` call would have written, so monitor collect, the
 * completion nudge, and resume all attach to it exactly as they do for a
 * model-initiated detach, then answer the model in the detached shape.
 */
async function backgroundedDispatchResult(
	deps: RegisteredDispatchToolDeps,
	converted: DispatchBackgroundedError,
	mode: string,
	sessionId: string | null,
): Promise<ToolResult> {
	const liveIds = converted.live.map((run) => run.assignmentId);
	const detached = deps.dispatch.detached;
	if (!detached) {
		return {
			kind: "error",
			message: `dispatch: the operator moved this call to the background, but detached batch records are unavailable in this context; ${liveIds.join(", ")} keep running and can only be reached with monitor(mode="wait", run_id=<id>)`,
			details: { mode: "detached", assignmentIds: liveIds },
		};
	}
	// Same ordering as runDetached: the runs are already live, so their
	// assignment records must land before the batch record an immediate collect
	// would resolve through.
	await deps.dispatch.assignments?.flushWrites?.();
	try {
		await detached.register({
			batchId: converted.batchId,
			runs: converted.live,
			sessionId,
			...(converted.ledgerId !== null ? { ledgerId: converted.ledgerId } : {}),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			kind: "error",
			message: `dispatch: the operator moved this call to the background (batch=${converted.batchId}, assignments=${liveIds.join(", ")}) but the durable batch record failed: ${message}`,
			details: { mode: "detached", batchId: converted.batchId, assignmentIds: liveIds },
		};
	}
	const lines = [
		`dispatch (${mode}) was moved to the background by the operator: batch=${converted.batchId} holds ${converted.live.length} still-running assignment(s)`,
		...converted.live.map((run) => `- ${run.assignmentId} agent=${run.agentId}`),
	];
	if (converted.settled.length > 0) {
		lines.push(
			`${converted.settled.length} earlier ${mode} step(s) had already finished and are not in this batch: ${converted.settled.map((run) => run.receipt.runId).join(", ")}. Read them with monitor(mode="receipt", run_id=<id>).`,
		);
	}
	if (converted.undispatched.length > 0) {
		lines.push(
			`${converted.undispatched.length} later ${mode} step(s) were never dispatched (agents: ${converted.undispatched.join(", ")}); re-issue them if they are still wanted.`,
		);
	}
	lines.push(
		"",
		`Runs continue in the background. Collect results with monitor(mode="collect", batch_id="${converted.batchId}"); block on one run with monitor(mode="wait", run_id=<id>).`,
	);
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: {
			mode: "detached",
			conversion: "operator-backgrounded",
			batchId: converted.batchId,
			assignmentIds: liveIds,
			runs: converted.live.map((run) => ({ runId: run.runId, assignmentId: run.assignmentId, agentId: run.agentId })),
			settledRunIds: converted.settled.map((run) => run.receipt.runId),
			undispatchedAgentIds: [...converted.undispatched],
		},
	};
}

/**
 * Surfaces a succeeded run's outcomeDetail to the calling model. Today that
 * detail is only set for runs that finished without a successful tool call;
 * the dispatch summary must not flatter such a run as plainly "completed".
 */
function successNote(receipt: RunReceipt): string | null {
	if (receipt.outcome !== undefined && receipt.outcome !== "succeeded") return null;
	if (receipt.exitCode !== 0) return null;
	return receipt.outcomeDetail ?? null;
}

interface CompletedRun {
	receipt: RunReceipt;
	receiptPath: string | null;
	summary: EventSummary;
	/**
	 * Sealed-receipt integrity verified against the ledger envelope at
	 * completion. Fails closed: a missing envelope reads as FAILED, never as
	 * verified. Rendering only; it never feeds retry, reroute, or outcome.
	 */
	integrity: ReceiptIntegrityResult;
	/** Reviewer/judge output staged before its receipt settlement boundary. */
	pendingGate?: PendingGateDecisionHandle;
}

/**
 * Assemble the parent-facing completion record for a settled run: resolve the
 * ledger envelope once for both the receipt path and the integrity check.
 */
function completeRun(
	deps: DispatchToolDeps,
	receipt: RunReceipt,
	summary: EventSummary,
	pendingGate?: PendingGateDecisionHandle,
): CompletedRun {
	const envelope = deps.dispatch.getRun(receipt.runId);
	return {
		receipt,
		receiptPath: envelope?.receiptPath ?? null,
		summary,
		integrity:
			envelope === null
				? { ok: false, reason: "run ledger envelope unavailable" }
				: verifyReceiptIntegrity(receipt, envelope),
		...(pendingGate !== undefined ? { pendingGate } : {}),
	};
}

class PipelineHaltError extends Error {
	constructor(
		message: string,
		readonly runs: ReadonlyArray<CompletedRun>,
	) {
		super(message);
		this.name = "PipelineHaltError";
	}
}

function integrityFailureBanner(run: CompletedRun): string | null {
	if (run.integrity.ok) return null;
	return `RECEIPT INTEGRITY FAILED for ${run.receipt.runId} (${run.integrity.reason}); treat this run's receipt fields and worker text as untrusted.`;
}

/**
 * The settled board, appended after the per-run lines. Its budget is reserved
 * out of the output ceiling rather than taken from it, so the board a topology
 * produced is never the part the truncation drops. A topology with no board
 * passes null and the output is byte-identical to what it was before boards
 * reached the main model at all.
 */
function withAgentLedgerBoard(body: string, board: string | null): string {
	return board === null ? body : `${body}\n\n${board}`;
}

function formatDispatchOutput(
	mode: string,
	runs: ReadonlyArray<CompletedRun>,
	maxOutputBytes: number,
	board: string | null = null,
): string {
	const failed = runs.filter((run) => run.receipt.exitCode !== 0);
	const perRunOutputBytes = Math.max(1024, Math.floor(maxOutputBytes / Math.max(1, runs.length)));
	// Integrity failures and the spot-check reminder lead the summary: the
	// truncation below keeps the head and drops the tail, and neither warning
	// may be hidden behind a successful process outcome or a long answer.
	const integrityBanners = runs
		.map((run) => integrityFailureBanner(run))
		.filter((banner): banner is string => banner !== null);
	const needsSpotCheck = runs.some((run) => {
		const state = adaptRunReceiptTrustStatus(run.receipt, { integrity: run.integrity }).validationGrounding.state;
		return state === "absent" || state === "unknown" || state === "ungrounded";
	});
	const lines = [
		`dispatch (${mode}) total=${runs.length} failed=${failed.length}`,
		`runs=${runs.map((run) => run.receipt.runId).join(", ")}`,
		...integrityBanners,
		...(needsSpotCheck ? [SPOT_CHECK_GUIDANCE] : []),
		"",
		...runs.flatMap((run, index) => {
			const { receipt, receiptPath } = run;
			const note = successNote(receipt);
			const noteSuffix = note !== null ? ` note=${note}` : "";
			// A non-success outcome is load-bearing evidence (a timeout has no
			// failureMessage at all); render it and its detail on the run line.
			const outcomeSuffix =
				receipt.outcome !== undefined && receipt.outcome !== "succeeded"
					? ` outcome=${receipt.outcome}${receipt.outcomeDetail ? ` detail=${receipt.outcomeDetail}` : ""}`
					: "";
			const failure = receipt.failureMessage ? ` failure=${receipt.failureMessage}` : "";
			// Pipeline runs are an ordered chain, so each line names its step.
			const stepLabel = mode === "pipeline" ? `step ${index + 1}/${runs.length} ` : "";
			// Provenance suffix is empty when a run carries no
			// pipeline/persona/escalation fields, so the line format is unchanged.
			const provenance = provenanceCompactSuffix(extractRunProvenance(receipt));
			// Evidence confidence comes from the sealed receipt. A receipt that fails
			// integrity cannot be read as evidence at all.
			const verification = run.integrity.ok ? receipt.verification : UNVERIFIABLE_RECEIPT_VERIFICATION;
			const trustStatus = adaptRunReceiptTrustStatus(
				{ ...receipt, verification: verification },
				{ integrity: run.integrity },
			);
			const evidenceSuffix = ` ${receiptEvidenceLabels(receipt, verification, run.integrity).join(" ")}`;
			const routingSuffix =
				run.integrity.ok && receipt.routeDecision !== undefined && receipt.routingIntent !== undefined
					? ` route_decision=${receipt.routeDecision.decisionHash} route_mode=${receipt.routeDecision.mode}`
					: "";
			// The sealed receipt is authoritative. Live summaries remain useful for
			// monitoring but can contain transient tool-use prose and never override
			// a missing, partial, or integrity-invalid durable answer.
			const answerText =
				run.integrity.ok &&
				(receipt.output?.state === "final" || (receipt.outcome !== undefined && receipt.outcome !== "succeeded"))
					? (receipt.output?.text ?? "")
					: "";
			const output =
				answerText.length > 0
					? truncateUtf8(answerText, perRunOutputBytes, TRUNCATION_MARKER)
					: run.integrity.ok
						? "(no receipt-sealed assistant text captured)"
						: "(worker text withheld because receipt integrity failed)";
			return [
				`- ${stepLabel}${receipt.runId} agent=${receipt.agentId} exit=${receipt.exitCode} target=${receipt.targetId} model=${receipt.wireModelId} tokens=${receipt.tokenCount} receipt=${receiptPath ?? "n/a"}${evidenceSuffix}${outcomeSuffix}${noteSuffix}${failure}${provenance}${routingSuffix}`,
				`  ${workerTextLabel(trustStatus)}`,
				...output.split("\n").map((line) => `  ${line}`),
				...workerTextNonEvidenceNotices(receipt, trustStatus, answerText).map((notice) => `  ${notice}`),
			];
		}),
	];
	if (board === null) return truncateUtf8(lines.join("\n"), maxOutputBytes, TRUNCATION_MARKER);
	const runBudget = Math.max(1024, maxOutputBytes - Buffer.byteLength(board, "utf8") - 2);
	return withAgentLedgerBoard(truncateUtf8(lines.join("\n"), runBudget, TRUNCATION_MARKER), board);
}

function dispatchDetails(
	deps: DispatchToolDeps,
	mode: string,
	runs: ReadonlyArray<CompletedRun>,
	board: string | null = null,
): ToolResultDetails {
	const failed = runs.filter((run) => run.receipt.exitCode !== 0);
	let transition: ReturnType<typeof scoutTransitionDetail> = null;
	for (const run of runs) {
		const envelope = deps.dispatch.getRun(run.receipt.runId);
		const candidate =
			run.integrity.ok && envelope !== null
				? scoutTransitionDetail({ receipt: run.receipt, envelope, agentSpecs: deps.getAgentSpecs() })
				: null;
		if (candidate === null) continue;
		if (transition !== null) {
			transition = null;
			break;
		}
		transition = candidate;
	}
	return {
		mode,
		assignmentIds: runs.map((run) => run.receipt.lineage?.rootRunId ?? run.receipt.runId),
		terminalRunIds: runs.map((run) => run.receipt.runId),
		receiptCount: runs.length,
		failedCount: failed.length,
		// Same text the output carries, under a stable key, so a surface that
		// renders details can show the board without re-reading the store.
		...(board !== null ? { agentLedgerBoard: board } : {}),
		...(transition !== null ? { scoutTransition: transition } : {}),
		runs: runs.map(({ receipt, receiptPath, summary, integrity }) => {
			// Additive provenance keys only; folded in when the receipt carries the
			// field so a run entry without them keeps its exact shape.
			const provenance = extractRunProvenance(receipt);
			const trustStatus = adaptRunReceiptTrustStatus(receipt, { integrity });
			return {
				runId: receipt.runId,
				agentId: receipt.agentId,
				exitCode: receipt.exitCode,
				receiptPath,
				eventCount: summary.count,
				// Structured evidence state for downstream consumers: mirrors the
				// sealed receipt read-only, plus the integrity check so a tampered
				// receipt is machine-visible here too.
				verification: integrity.ok ? receipt.verification : UNVERIFIABLE_RECEIPT_VERIFICATION,
				hostVerification: integrity.ok ? (receipt.hostVerification ?? null) : null,
				receiptIntegrity: integrity,
				trustStatus,
				...(receipt.outcome !== undefined && receipt.outcome !== "succeeded"
					? { outcome: receipt.outcome, outcomeDetail: receipt.outcomeDetail ?? null }
					: {}),
				...(provenance.pipeline !== undefined ? { pipeline: provenance.pipeline } : {}),
				...(provenance.personaOverride !== undefined ? { personaOverride: provenance.personaOverride } : {}),
				...(provenance.escalation !== undefined ? { escalation: provenance.escalation } : {}),
				...(provenance.autonomyEnforcement !== undefined ? { autonomyEnforcement: provenance.autonomyEnforcement } : {}),
				...(integrity.ok && receipt.routeDecision !== undefined && receipt.routingIntent !== undefined
					? { routing: explainRouteDecision(receipt.routeDecision, receipt.routingIntent) }
					: {}),
			};
		}),
	};
}

function newGateGroupId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function subjectRef(receipt: RunReceipt): RunGateSubjectRef {
	return { runId: receipt.runId, digest: receipt.integrity?.digest ?? null };
}

/**
 * Sealed correlation between a decider route and the subject route it graded.
 * Reported on every decision, including when no independent route exists.
 */
function gateCorrelationOf(subject: RunReceipt, decider: RunReceipt): GateDecisionCorrelation {
	const facts = (receipt: RunReceipt): RouteCorrelationFacts => ({
		agentId: receipt.agentId,
		targetId: receipt.targetId,
		wireModelId: receipt.wireModelId,
		runtimeId: receipt.runtimeId,
		nodeId: receipt.node?.id ?? "local",
	});
	const { agent, target, modelFamily, runtime, node, independent } = gateRouteCorrelation(
		facts(subject),
		facts(decider),
	);
	return { agent, target, modelFamily, runtime, node, independent };
}

/** Compete candidates share the base request's agent and model, so the first is representative. */
function competeCorrelation(
	candidates: ReadonlyArray<{ receipt: RunReceipt }>,
	decider: RunReceipt,
): GateDecisionCorrelation {
	const subject = candidates[0]?.receipt;
	if (subject === undefined) throw new Error("compete decision requires at least one candidate receipt");
	return gateCorrelationOf(subject, decider);
}

function reviewerTask(originalTask: string, builderRunId: string, cycle: number): string {
	return [
		`Review the work of builder run ${builderRunId} (review cycle ${cycle}).`,
		"The builder's final answer is provided as input data; verify it against the workspace, do not trust it blindly.",
		"Original task the builder was given:",
		originalTask,
	].join("\n\n");
}

type ReviewGateSettings = DispatchReviewSettings;

const REVIEW_SINGLE_TASK_MESSAGE =
	"dispatch: review supports exactly one task; run the fan-out without review, then dispatch one integration task with review to gate the combined result";
const COMPETE_SINGLE_TASK_MESSAGE = "dispatch: compete requires exactly one task";
const COMPETE_NO_REVIEW_MESSAGE = "dispatch: compete has its own judge and cannot combine with review";

interface GateRunOutcome {
	runs: CompletedRun[];
	decisions: Array<{ artifact: GateDecisionArtifact; path: string }>;
	verdict: "pass" | "fail" | null;
	cycles: number;
	/** Set when the gate ended without a pass/fail verdict and needs the operator. */
	needsDecision?: string;
}

/**
 * Reviewer-gated dispatch: the builder runs, a read-only reviewer evaluates
 * the workspace against the task, and a revise verdict re-runs the builder
 * with the findings threaded as input data. Bounded by maxCycles; exhaustion
 * (or an unparseable reviewer answer at the last cycle) surfaces as a
 * needs-decision outcome, never a silent failure. Receipts chain backward:
 * each reviewer references the builder it reviewed, each revise builder
 * references the reviewer whose findings it received.
 */
async function runReviewGated(
	deps: RegisteredDispatchToolDeps,
	base: DispatchRequest,
	review: ReviewGateSettings,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<GateRunOutcome> {
	const group = newGateGroupId("review");
	const runs: CompletedRun[] = [];
	const decisions: Array<{ artifact: GateDecisionArtifact; path: string }> = [];
	const recordDecision = (
		draft: GateDecisionDraft,
		pending?: PendingGateDecisionHandle,
	): { artifact: GateDecisionArtifact; path: string } => {
		const decision = pending
			? finalizePendingGateDecision(pending, draft)
			: materializePendingGateDecision(stagePendingGateDecision(draft));
		decisions.push(decision);
		return decision;
	};
	let expired = false;
	let activeRunId: string | null = null;
	const abortActive = (bySignal: boolean): void => {
		expired = true;
		if (activeRunId !== null) {
			deps.dispatch.abort(
				activeRunId,
				bySignal ? undefined : { cause: "timeout", detail: `timed out after ${timeoutMs}ms` },
			);
		}
	};
	const onSignalAbort = (): void => abortActive(true);
	const timer = timeoutMs !== undefined ? setTimeout(() => abortActive(false), timeoutMs) : null;
	signal?.addEventListener("abort", onSignalAbort, { once: true });

	const runOne = async (request: DispatchRequest): Promise<CompletedRun> => {
		if (expired || signal?.aborted) {
			throw new Error(
				`review dispatch stopped after ${runs.length} run(s): ${signal?.aborted ? "aborted" : `timed out after ${timeoutMs}ms`}`,
			);
		}
		const handle = await deps.dispatch.dispatch(request);
		activeRunId = handle.runId;
		const summary = await consumeGateSensitiveDispatchEvents(deps, handle.runId, request.agentId, handle.events);
		let pendingGate: PendingGateDecisionHandle | undefined;
		if (request.gate?.role === "reviewer") {
			try {
				pendingGate = stagePendingGateOutput({
					group: request.gate.group,
					topology: "review",
					cycle: request.gate.cycle,
					subjects: request.gate.subjects ?? [],
					deciderRunId: summary.terminalAttemptRunId,
					finalOutput: normalizedAssistantText(summary),
					terminalCycle: request.gate.cycle === review.maxCycles,
				});
			} catch (error) {
				try {
					deps.dispatch.abort(handle.runId);
				} catch {
					// The receipt barrier below still observes the admitted process.
				}
				await Promise.allSettled([handle.finalPromise]);
				activeRunId = null;
				throw error;
			}
		}
		let receipt: RunReceipt;
		try {
			receipt = await handle.finalPromise;
		} finally {
			activeRunId = null;
		}
		const completed = completeRun(deps, receipt, summary, pendingGate);
		runs.push(completed);
		return completed;
	};

	try {
		let findings: { reviewer: CompletedRun; text: string } | null = null;
		for (let cycle = 1; cycle <= review.maxCycles; cycle += 1) {
			const builderGate: RunGateProvenance = {
				role: "builder",
				group,
				cycle,
				...(findings !== null ? { subjects: [subjectRef(findings.reviewer.receipt)], verdict: "revise" } : {}),
			};
			const builderRequest: DispatchRequest = {
				...base,
				executionRole: "builder",
				gate: builderGate,
				...(findings !== null
					? { pipelineInput: { fromRunId: findings.reviewer.receipt.runId, position: cycle, text: findings.text } }
					: {}),
			};
			const builder = await runOne(
				withResolvedPlanTaskPin(
					builderRequest,
					review.resolvedTasks?.find((task) => task.role === "builder" && task.position === cycle),
				),
			);
			if (isPipelineStepFailure(builder.receipt)) {
				recordDecision({
					group,
					topology: "review",
					cycle,
					outcome: "exhausted",
					subjects: [subjectRef(builder.receipt)],
					detail: `builder ended ${pipelineFailureReason(builder.receipt)}`,
				});
				return {
					runs,
					decisions,
					verdict: null,
					cycles: cycle,
					needsDecision: `builder run ${builder.receipt.runId} ended ${pipelineFailureReason(builder.receipt)} in cycle ${cycle}`,
				};
			}
			const reviewerRequest: DispatchRequest = {
				agentId: gateDeciderAgentId(review.reviewer),
				executionRole: "reviewer",
				task: reviewerTask(base.task, builder.receipt.runId, cycle),
				systemPrompt: REVIEWER_GATE_PROMPT,
				autonomy: "read-only",
				gate: { role: "reviewer", group, cycle, subjects: [subjectRef(builder.receipt)] },
				pipelineInput: {
					fromRunId: builder.receipt.runId,
					position: cycle,
					text: normalizedAssistantText(builder.summary),
				},
				...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
				...(review.node !== undefined ? { node: review.node } : {}),
				...(review.model !== undefined ? { model: review.model } : {}),
				...(review.target !== undefined ? { target: review.target } : {}),
				...(base.plan !== undefined ? { plan: base.plan } : {}),
				...(base.parentToolCallId !== undefined ? { parentToolCallId: base.parentToolCallId } : {}),
				...(base.reservation !== undefined
					? { reservation: { ownerId: base.reservation.ownerId, memberId: base.reservation.memberId } }
					: {}),
			};
			const reviewer = await runOne(
				withResolvedPlanTaskPin(
					reviewerRequest,
					review.resolvedTasks?.find((task) => task.role === "reviewer" && task.position === cycle),
					{ pinTask: false },
				),
			);
			if (isPipelineStepFailure(reviewer.receipt)) {
				recordDecision(
					{
						group,
						topology: "review",
						cycle,
						outcome: "exhausted",
						subjects: [subjectRef(builder.receipt)],
						decider: subjectRef(reviewer.receipt),
						correlation: gateCorrelationOf(builder.receipt, reviewer.receipt),
						detail: `reviewer ended ${pipelineFailureReason(reviewer.receipt)}`,
					},
					reviewer.pendingGate,
				);
				return {
					runs,
					decisions,
					verdict: null,
					cycles: cycle,
					needsDecision: `reviewer run ${reviewer.receipt.runId} ended ${pipelineFailureReason(reviewer.receipt)} in cycle ${cycle}`,
				};
			}
			const decided = decideReviewGate({
				group,
				cycle,
				terminalCycle: cycle === review.maxCycles,
				subjects: [subjectRef(builder.receipt)],
				decider: subjectRef(reviewer.receipt),
				correlation: gateCorrelationOf(builder.receipt, reviewer.receipt),
				output: normalizedAssistantText(reviewer.summary),
			});
			recordDecision(decided.draft, reviewer.pendingGate);
			if (decided.findings === null) {
				return {
					runs,
					decisions,
					verdict: decided.verdict,
					cycles: cycle,
					...(decided.needsDecision !== null ? { needsDecision: decided.needsDecision } : {}),
				};
			}
			findings = { reviewer, text: decided.findings };
		}
		throw new Error("review gate exhausted without terminal decision evidence");
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
	}
}

function judgeTask(originalTask: string, candidates: ReadonlyArray<CandidateWorktree>, stats: string[]): string {
	const lines = [
		`Rank ${candidates.length} candidate implementations of this task and pick the best one.`,
		"Original task:",
		originalTask,
		"Candidates:",
		...candidates.map(
			(candidate, index) =>
				`  ${candidate.index}. branch=${candidate.branch} worktree=${candidate.path} (${stats[index] ?? "?"})`,
		),
	];
	return lines.join("\n\n");
}

function readVerifiedGateReceipt(deps: DispatchToolDeps, runId: string): RunReceipt | null {
	const envelope = deps.dispatch.getRun(runId);
	if (envelope === null) return null;
	const path = envelope.receiptPath ?? join(clioStateDir(), "receipts", `${runId}.json`);
	if (!existsSync(path)) return null;
	let receipt: RunReceipt;
	try {
		receipt = JSON.parse(readFileSync(path, "utf8")) as RunReceipt;
	} catch (error) {
		throw new Error(`pending gate receipt ${runId} is unreadable: ${competeErrorMessage(error)}`);
	}
	if (receipt.runId !== runId) throw new Error(`pending gate receipt path for ${runId} contains ${receipt.runId}`);
	const verification = verifyReceiptIntegrity(receipt, envelope);
	if (!verification.ok) throw new Error(`pending gate receipt ${runId} failed integrity: ${verification.reason}`);
	if (receipt.integrity?.digest === undefined) throw new Error(`pending gate receipt ${runId} has no integrity digest`);
	return receipt;
}

function recoveredCorrelation(
	deps: DispatchToolDeps,
	subjects: ReadonlyArray<RunGateSubjectRef>,
	decider: RunReceipt,
): GateDecisionCorrelation {
	const first = subjects[0];
	const subject = first === undefined ? null : readVerifiedGateReceipt(deps, first.runId);
	if (subject === null) throw new Error("recovered gate decision has no verified subject receipt for correlation");
	return gateCorrelationOf(subject, decider);
}

function settlePendingCompeteResource(handle: PendingGateDecisionHandle, draft: GateDecisionDraft): void {
	if (draft.topology !== "compete" || (draft.outcome !== "winner" && draft.outcome !== "no-winner")) return;
	const root = handle.record.resourceRoot ?? process.cwd();
	settleRecoveredCompeteDecision(root, draft.group, draft.outcome === "winner" ? (draft.winner?.index ?? null) : null);
}

/**
 * Rebuild decisions whose reviewer/judge output crossed the WAL boundary but
 * whose coordinator died before parsing or materialization. Receipt integrity
 * is verified before the output protocol is trusted. Every resolved record is
 * collision-checked before compete worktrees move to their recovered state.
 */
function recoverPendingGateEvidence(deps: DispatchToolDeps): void {
	const recovery = preparePendingGateDecisionRecovery();
	const resolved: PendingGateDecisionHandle[] = [];
	for (const handle of recovery.unresolved) {
		if (handle.record.kind !== "output") continue;
		const record = handle.record;
		const deciderReceipt = readVerifiedGateReceipt(deps, record.deciderRunId);
		if (deciderReceipt === null) {
			throw new Error(
				`pending ${record.topology} decision ${record.id} has no verified decider receipt for ${record.deciderRunId}`,
			);
		}
		const decider = subjectRef(deciderReceipt);
		let draft: GateDecisionDraft;
		if (record.topology === "review") {
			if (isPipelineStepFailure(deciderReceipt)) {
				draft = {
					group: record.group,
					topology: "review",
					cycle: record.cycle,
					outcome: "exhausted",
					subjects: record.subjects,
					decider,
					correlation: recoveredCorrelation(deps, record.subjects, deciderReceipt),
					detail: `reviewer ended ${pipelineFailureReason(deciderReceipt)}`,
				};
			} else {
				draft = decideReviewGate({
					group: record.group,
					cycle: record.cycle,
					terminalCycle: record.terminalCycle === true,
					subjects: record.subjects,
					decider,
					correlation: recoveredCorrelation(deps, record.subjects, deciderReceipt),
					output: record.finalOutput,
				}).draft;
			}
			resolved.push(resolvePendingGateDecision(handle, draft));
			continue;
		}

		const judged = isPipelineStepFailure(deciderReceipt)
			? null
			: parseCompeteGateResult(record.finalOutput, record.subjects.length);
		const pick = judged?.ok ? judged.result.winner : null;
		const pickedSubject = pick === null ? undefined : record.subjects[pick - 1];
		const candidateReceipt = pickedSubject === undefined ? null : readVerifiedGateReceipt(deps, pickedSubject.runId);
		if (pickedSubject !== undefined && candidateReceipt === null) {
			throw new Error(
				`pending compete decision ${record.id} has no verified candidate receipt for ${pickedSubject.runId}`,
			);
		}
		let blockedProtected: string[] = [];
		if (pick !== null && pickedSubject !== undefined && candidateReceipt !== null) {
			const root = record.resourceRoot ?? process.cwd();
			const protectedPaths = deps.dispatch.protectedArtifactState?.().artifacts.map((artifact) => artifact.path) ?? [];
			blockedProtected = protectedPathsChangedByCompeteBranch(
				root,
				`clio/compete/${record.group}/${pick}`,
				protectedPaths,
			);
		}
		const validWinner =
			pick !== null &&
			pickedSubject !== undefined &&
			candidateReceipt !== null &&
			!isPipelineStepFailure(candidateReceipt) &&
			blockedProtected.length === 0;
		if (validWinner && pick !== null && pickedSubject !== undefined) {
			draft = {
				group: record.group,
				topology: "compete",
				cycle: record.cycle,
				outcome: "winner",
				subjects: record.subjects,
				decider,
				correlation: recoveredCorrelation(deps, record.subjects, deciderReceipt),
				winner: {
					index: pick,
					subject: pickedSubject,
					branch: `clio/compete/${record.group}/${pick}`,
				},
			};
		} else {
			draft = {
				group: record.group,
				topology: "compete",
				cycle: record.cycle,
				outcome: "no-winner",
				subjects: record.subjects,
				decider,
				correlation: recoveredCorrelation(deps, record.subjects, deciderReceipt),
				detail: isPipelineStepFailure(deciderReceipt)
					? `judge ended ${pipelineFailureReason(deciderReceipt)}`
					: judged !== null && !judged.ok
						? judged.reason
						: blockedProtected.length > 0
							? `judge-selected candidate ${pick} changes protected artifact(s): ${blockedProtected.join(", ")}`
							: `judge picked failed or missing candidate ${pick}`,
			};
		}
		resolved.push(resolvePendingGateDecision(handle, draft));
	}

	const ready = [...recovery.ready, ...resolved];
	preflightPendingGateDecisionMaterialization(ready);
	for (const handle of ready) {
		if (handle.record.kind !== "decision") continue;
		settlePendingCompeteResource(handle, handle.record.decision);
		materializePendingGateDecision(handle);
	}

	// A process may have died after the final winner artifact was written but
	// before the worktree manifest moved to winner-preserved. Restore that safe
	// decision point even though no pending WAL remains.
	const durable = readGateDecisionArtifacts();
	const confirmedGroups = new Set(
		durable
			.filter(
				({ artifact }) =>
					artifact.topology === "compete" &&
					(artifact.outcome === "operator-confirmed" || artifact.outcome === "full-auto-applied"),
			)
			.map(({ artifact }) => artifact.group),
	);
	for (const { artifact } of durable) {
		if (
			artifact.topology !== "compete" ||
			artifact.outcome !== "winner" ||
			artifact.winner === undefined ||
			confirmedGroups.has(artifact.group)
		) {
			continue;
		}
		settleRecoveredCompeteDecision(process.cwd(), artifact.group, artifact.winner.index);
	}
}

type CompeteSettings = DispatchCompeteSettings;

interface CompeteOutcome {
	runs: CompletedRun[];
	decisions: Array<{ artifact: GateDecisionArtifact; path: string }>;
	group: string;
	winner: { index: number; branch: string; applied: boolean } | null;
	needsDecision?: string;
	/** Rendered board the candidates and the judge shared, null when empty. */
	board?: string | null;
}

interface OwnedCompeteRun {
	runId: string;
	settled: boolean;
	abortRequested: boolean;
	settlement: Promise<CompletedRun>;
}

interface CompeteStop {
	message: string;
	reason?: AbortReason;
}

function competeErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Prefix the tool name once. Errors raised inside the dispatch domain already
 * name themselves, and blind prefixing turned those into `dispatch: dispatch:
 * ...`, which spends the first eleven bytes of a short error saying the same
 * thing twice.
 */
function dispatchErrorMessage(err: unknown): string {
	const message = competeErrorMessage(err);
	return message.startsWith("dispatch: ") ? message : `dispatch: ${message}`;
}

function rejectedReasons(results: ReadonlyArray<PromiseSettledResult<unknown>>): unknown[] {
	return results
		.filter((result): result is PromiseRejectedResult => result.status === "rejected")
		.map((result) => result.reason as unknown);
}

/**
 * Best-of-N compete: N candidate builders run the same task in isolated
 * scratch git worktrees, each candidate's work is committed on its branch, a
 * read-only judge ranks them, and the winner is applied (full-auto) or handed
 * to the operator (supervised: the winner's branch and worktree survive; the
 * apply_winner action routes through plan approval). Losers are always
 * cleaned, including on abort and on any thrown error.
 */
async function runCompete(
	deps: RegisteredDispatchToolDeps,
	base: DispatchRequest,
	compete: CompeteSettings,
	autonomy: AutonomyLevel,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<CompeteOutcome> {
	const requestedRoot = base.cwd !== undefined && base.cwd.length > 0 ? base.cwd : process.cwd();
	if (!isGitRepository(requestedRoot)) {
		throw new Error(`compete requires a git repository at ${requestedRoot}; scratch worktrees isolate the candidates`);
	}
	const protectedPaths = deps.dispatch.protectedArtifactState?.().artifacts.map((artifact) => artifact.path) ?? [];
	// Startup recovery intentionally sweeps only groups that another lifecycle
	// durably marked cleanup-ready after all of its workers settled. Active,
	// preserved, and malformed crash leftovers remain untouched.
	recoverCleanupReadyCompeteGroups(requestedRoot);
	const group = newGateGroupId("compete");
	// Candidates run concurrently and the judge reads what they contributed, so
	// the board reaches the judge with corroboration and dispute labels instead
	// of only per-candidate output.
	const ledgerId = newGateGroupId("ledger");
	const ledger = { id: ledgerId, sequence: 0 };
	await openAgentLedger(ledgerId);
	let ownership: CompeteGroupOwnership | null = null;
	const worktrees: CandidateWorktree[] = [];
	const runs: CompletedRun[] = [];
	const decisions: Array<{ artifact: GateDecisionArtifact; path: string }> = [];
	const recordDecision = (draft: GateDecisionDraft, pending?: PendingGateDecisionHandle) => {
		const decision = pending
			? finalizePendingGateDecision(pending, draft)
			: materializePendingGateDecision(stagePendingGateDecision(draft, { resourceRoot: requestedRoot }));
		decisions.push(decision);
		return decision;
	};
	const ownedRuns: OwnedCompeteRun[] = [];
	const abortErrors: unknown[] = [];
	let stop: CompeteStop | null = null;
	let primaryError: unknown = null;
	let winner: CompeteOutcome["winner"] = null;
	const currentWinner = (): CompeteOutcome["winner"] => winner;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let signalListenerInstalled = false;

	const abortOwnedRun = (run: OwnedCompeteRun): void => {
		if (run.settled || run.abortRequested || stop === null) return;
		run.abortRequested = true;
		try {
			deps.dispatch.abort(run.runId, stop.reason);
		} catch (err) {
			abortErrors.push(err);
		}
	};
	const requestStop = (next: CompeteStop): void => {
		if (stop === null) stop = next;
		for (const run of ownedRuns) abortOwnedRun(run);
	};
	const onSignalAbort = (): void => requestStop({ message: "compete dispatch aborted" });
	const throwIfStopped = (): void => {
		if (stop !== null) throw new Error(stop.message);
	};
	const settleRun = async (
		handle: Awaited<ReturnType<DispatchContract["dispatch"]>>,
		request: DispatchRequest,
	): Promise<CompletedRun> => {
		const summaryPromise = consumeGateSensitiveDispatchEvents(deps, handle.runId, request.agentId, handle.events).then(
			(summary) => {
				const pendingGate =
					request.gate?.role === "judge"
						? stagePendingGateOutput({
								group: request.gate.group,
								topology: "compete",
								cycle: request.gate.cycle,
								subjects: request.gate.subjects ?? [],
								deciderRunId: summary.terminalAttemptRunId,
								finalOutput: normalizedAssistantText(summary),
								...(request.cwd !== undefined ? { resourceRoot: request.cwd } : {}),
							})
						: undefined;
				return { summary, pendingGate };
			},
		);
		const [summaryResult, receiptResult] = await Promise.allSettled([summaryPromise, handle.finalPromise]);
		const failures = rejectedReasons([summaryResult, receiptResult]);
		if (failures.length > 0) {
			throw new Error(`run ${handle.runId} failed to settle: ${failures.map(competeErrorMessage).join("; ")}`);
		}
		const summaryWithGate = summaryResult.status === "fulfilled" ? summaryResult.value : null;
		const receipt = receiptResult.status === "fulfilled" ? receiptResult.value : null;
		if (summaryWithGate === null || receipt === null) throw new Error(`run ${handle.runId} produced no settled result`);
		return completeRun(deps, receipt, summaryWithGate.summary, summaryWithGate.pendingGate);
	};
	const admitOwnedRun = async (request: DispatchRequest, label: string): Promise<OwnedCompeteRun> => {
		try {
			const handle = await deps.dispatch.dispatch(request, {
				onAdmitted(admission) {
					if (ownership === null) throw new Error(`compete ${group} has no active ownership claim`);
					registerCompeteGroupRun(ownership, admission);
				},
			});
			const owned: OwnedCompeteRun = {
				runId: handle.runId,
				settled: false,
				abortRequested: false,
				settlement: Promise.resolve(null as never),
			};
			ownedRuns.push(owned);
			owned.settlement = (async () => {
				try {
					return await settleRun(handle, request);
				} catch (err) {
					requestStop({ message: `${label} failed to settle: ${competeErrorMessage(err)}` });
					throw err;
				} finally {
					owned.settled = true;
					if (ownership !== null) settleCompeteGroupRun(ownership, owned.runId);
				}
			})();
			// A concurrent admission can fail before this settlement is awaited.
			// Attach a sink immediately while preserving the original promise for
			// the transaction's mandatory all-settled barrier.
			owned.settlement.catch(() => {});
			if (stop !== null) abortOwnedRun(owned);
			return owned;
		} catch (err) {
			requestStop({ message: `${label} admission failed: ${competeErrorMessage(err)}` });
			throw err;
		}
	};
	const settledCompletedRuns = async (owned: ReadonlyArray<OwnedCompeteRun>, phase: string): Promise<CompletedRun[]> => {
		const results = await Promise.allSettled(owned.map((run) => run.settlement));
		const failures = rejectedReasons(results);
		if (failures.length > 0) {
			throw new Error(`${phase} failed: ${failures.map(competeErrorMessage).join("; ")}`);
		}
		return results.map((result) => {
			if (result.status !== "fulfilled") throw new Error(`${phase} produced no completed run`);
			return result.value;
		});
	};

	let outcome: CompeteOutcome | null = null;
	try {
		outcome = await (async (): Promise<CompeteOutcome> => {
			// The owner manifest is the transaction's first group-specific mutation;
			// every branch and worktree created below is covered by finalization.
			ownership = claimCompeteGroup(requestedRoot, group);
			const root = ownership.root;
			const createCandidate = deps.competeWorktrees?.createCandidate ?? createCandidateWorktree;
			for (let index = 1; index <= compete.candidates; index += 1) {
				throwIfStopped();
				worktrees.push(createCandidate(ownership, index, "HEAD"));
			}

			if (timeoutMs !== undefined) {
				timer = setTimeout(
					() =>
						requestStop({
							message: `compete dispatch timed out after ${timeoutMs}ms`,
							reason: { cause: "timeout", detail: `timed out after ${timeoutMs}ms` },
						}),
					timeoutMs,
				);
			}
			signal?.addEventListener("abort", onSignalAbort, { once: true });
			signalListenerInstalled = signal !== undefined;
			if (signal?.aborted) onSignalAbort();
			throwIfStopped();

			// Candidates run concurrently through the normal per-run admission path;
			// every admission promise is observed to settlement. The first rejection
			// aborts known siblings, and any sibling accepted later sees `stop` and is
			// aborted before it can escape the transaction.
			const admissionResults = await Promise.allSettled(
				worktrees.map((worktree) => {
					const request: DispatchRequest = {
						...base,
						executionRole: "builder",
						cwd: worktree.path,
						protectedArtifactRemap: { sourceRoot: root, workerRoot: worktree.path },
						gate: { role: "candidate", group, cycle: worktree.index },
						ledger,
						competeStance: COMPETE_STANCES[(worktree.index - 1) % COMPETE_STANCES.length] as CompeteStance,
					};
					return admitOwnedRun(
						withResolvedPlanTaskPin(
							request,
							compete.resolvedTasks?.find((task) => task.role === "candidate" && task.position === worktree.index),
						),
						`candidate ${worktree.index}`,
					);
				}),
			);
			const admissionFailures = rejectedReasons(admissionResults);
			if (admissionFailures.length > 0) {
				const admissionMessage = `compete candidate admission failed: ${admissionFailures
					.map(competeErrorMessage)
					.join("; ")}`;
				requestStop({ message: admissionMessage });
				// All admission promises have now settled, including late accepts. Wait
				// for every accepted run before finalization removes any path.
				await Promise.allSettled(ownedRuns.map((run) => run.settlement));
				throw new Error(admissionMessage);
			}
			const candidateOwned = admissionResults.map((result) => {
				if (result.status !== "fulfilled") throw new Error("compete candidate admission produced no handle");
				return result.value;
			});
			const candidateRuns = await settledCompletedRuns(candidateOwned, "candidate settlement");
			runs.push(...candidateRuns);
			throwIfStopped();
			const stats = worktrees.map((worktree, index) => {
				const receipt = candidateRuns[index]?.receipt;
				const failed = receipt !== undefined && isPipelineStepFailure(receipt);
				if (failed) return "builder failed";
				commitCandidateWork(worktree, `clio-coder compete ${group} candidate ${worktree.index}`);
				return candidateDiffStat(root, worktree.branch);
			});
			if (candidateRuns.every((run) => isPipelineStepFailure(run.receipt))) {
				recordDecision({
					group,
					topology: "compete",
					cycle: 1,
					outcome: "no-winner",
					subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
					detail: "every candidate builder failed; nothing to judge",
				});
				return { runs, decisions, group, winner: null, needsDecision: "every candidate builder failed; nothing to judge" };
			}
			const judgeRequest: DispatchRequest = {
				agentId: gateDeciderAgentId(compete.judge?.agent),
				executionRole: "judge",
				task: judgeTask(base.task, worktrees, stats),
				systemPrompt: JUDGE_GATE_PROMPT,
				autonomy: "read-only",
				cwd: root,
				gate: {
					role: "judge",
					group,
					cycle: 1,
					subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
				},
				ledger,
				...(compete.judge?.model !== undefined ? { model: compete.judge.model } : {}),
				...(compete.judge?.target !== undefined ? { target: compete.judge.target } : {}),
				...(compete.judge?.node !== undefined ? { node: compete.judge.node } : {}),
				...(base.plan !== undefined ? { plan: base.plan } : {}),
				...(base.parentToolCallId !== undefined ? { parentToolCallId: base.parentToolCallId } : {}),
				...(base.reservation !== undefined
					? { reservation: { ownerId: base.reservation.ownerId, memberId: base.reservation.memberId } }
					: {}),
			};
			throwIfStopped();
			const judgeOwned = await admitOwnedRun(
				withResolvedPlanTaskPin(
					judgeRequest,
					compete.resolvedTasks?.find((task) => task.role === "judge"),
					{ pinTask: false },
				),
				"judge",
			);
			const judgeRun = (await settledCompletedRuns([judgeOwned], "judge settlement"))[0];
			if (judgeRun === undefined) throw new Error("judge produced no completed run");
			runs.push(judgeRun);
			throwIfStopped();
			const judgeReceipt = judgeRun.receipt;
			const judgeSummary = judgeRun.summary;
			// Every judged outcome names the same subjects, decider, and correlation;
			// only the reason the gate produced no applicable winner differs.
			const noWinner = (detail: string): GateDecisionDraft => ({
				group,
				topology: "compete",
				cycle: 1,
				outcome: "no-winner",
				subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
				decider: subjectRef(judgeReceipt),
				correlation: competeCorrelation(candidateRuns, judgeReceipt),
				detail,
			});
			if (isPipelineStepFailure(judgeReceipt)) {
				recordDecision(noWinner(`judge ended ${pipelineFailureReason(judgeReceipt)}`), judgeRun.pendingGate);
				return {
					runs,
					decisions,
					group,
					winner: null,
					needsDecision: `judge run ${judgeReceipt.runId} ended ${pipelineFailureReason(judgeReceipt)}; candidate worktrees were cleaned, their receipts remain; re-run compete or build directly`,
				};
			}
			const judged = parseCompeteGateResult(normalizedAssistantText(judgeSummary), compete.candidates);
			if (!judged.ok) {
				recordDecision(noWinner(judged.reason), judgeRun.pendingGate);
				return {
					runs,
					decisions,
					group,
					winner: null,
					needsDecision: `${judged.reason}; candidate worktrees were cleaned, their receipts remain; re-run compete or build directly`,
				};
			}
			const pick = judged.result.winner;
			const pickedWorktree = worktrees.find((worktree) => worktree.index === pick);
			const pickedRun = candidateRuns[pick - 1];
			if (!pickedWorktree || pickedRun === undefined || isPipelineStepFailure(pickedRun.receipt)) {
				recordDecision(noWinner(`judge picked failed or missing candidate ${pick}`), judgeRun.pendingGate);
				return {
					runs,
					decisions,
					group,
					winner: null,
					needsDecision: `judge picked candidate ${pick}, whose builder failed; the operator decides`,
				};
			}
			const protectedChanges = protectedPathsChangedByCompeteBranch(root, pickedWorktree.branch, protectedPaths);
			if (protectedChanges.length > 0) {
				recordDecision(
					noWinner(`judge-selected candidate ${pick} changes protected artifact(s): ${protectedChanges.join(", ")}`),
					judgeRun.pendingGate,
				);
				return {
					runs,
					decisions,
					group,
					winner: null,
					needsDecision: `candidate ${pick} changes protected artifact(s) and cannot be applied: ${protectedChanges.join(", ")}`,
				};
			}
			const winnerRef = {
				index: pick,
				subject: subjectRef(pickedRun.receipt),
				branch: pickedWorktree.branch,
			};
			const winnerDecision = recordDecision(
				{
					group,
					topology: "compete",
					cycle: 1,
					outcome: "winner",
					subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
					decider: subjectRef(judgeReceipt),
					correlation: competeCorrelation(candidateRuns, judgeReceipt),
					winner: winnerRef,
				},
				judgeRun.pendingGate,
			);
			if (autonomy === "full-auto") {
				const merge = (deps.competeWorktrees?.mergeWinner ?? mergeWinnerBranch)(root, pickedWorktree.branch);
				if (!merge.ok) {
					winner = { index: pick, branch: pickedWorktree.branch, applied: false };
					return {
						runs,
						decisions,
						group,
						winner,
						needsDecision: `winner candidate ${pick} could not be merged (${merge.reason}); its branch ${pickedWorktree.branch} is preserved`,
					};
				}
				try {
					recordDecision({
						group,
						topology: "compete",
						cycle: 1,
						outcome: "full-auto-applied",
						subjects: [winnerRef.subject],
						winner: winnerRef,
						confirmation: {
							id: winnerDecision.artifact.id,
							digest: winnerDecision.artifact.integrity.digest,
						},
						detail: `full-auto applied ${pickedWorktree.branch} under dispatch plan ${base.plan?.hash ?? "unavailable"}`,
					});
				} catch (error) {
					winner = { index: pick, branch: pickedWorktree.branch, applied: false };
					throw new Error(
						`winner ${pickedWorktree.branch} merged but full-auto application evidence failed: ${competeErrorMessage(error)}; branch preserved for recovery`,
					);
				}
				winner = { index: pick, branch: pickedWorktree.branch, applied: true };
				return { runs, decisions, group, winner };
			}
			winner = { index: pick, branch: pickedWorktree.branch, applied: false };
			return { runs, decisions, group, winner };
		})();
	} catch (err) {
		primaryError = err;
	}
	if (timer) clearTimeout(timer);
	if (signalListenerInstalled) signal?.removeEventListener("abort", onSignalAbort);

	// No path may be removed while a worker can still write through it. On
	// every exceptional exit, abort all accepted runs (including late
	// admissions) and await the settlement promise that drains both events
	// and final receipt completion.
	if (ownedRuns.some((run) => !run.settled)) {
		requestStop({ message: "compete lifecycle exited before every worker settled" });
	}
	const finalizationErrors: unknown[] = [];
	await Promise.allSettled(ownedRuns.map((run) => run.settlement));
	// Every worker has settled, so no further post can be admitted. The board is
	// read here, on the way past, for the model that started the compete.
	const board = renderAgentLedgerBoard(ledgerId);
	await closeAgentLedger(ledgerId);
	finalizationErrors.push(...abortErrors);

	// Losers are always cleaned; the winner's worktree and branch survive
	// only while an operator decision is pending (supervised pick or a
	// failed merge). The durable state transition happens after the worker
	// barrier and before deletion, defining the safe restart boundary.
	const winnerAtFinalization = currentWinner();
	if (ownership !== null) {
		if (winnerAtFinalization !== null && !winnerAtFinalization.applied) {
			try {
				ownership = markCompeteGroupWinnerPreserved(ownership, winnerAtFinalization.index);
				for (const worktree of worktrees) {
					if (worktree.index === winnerAtFinalization.index) continue;
					try {
						removeCandidateWorktree(ownership, worktree, true);
					} catch (err) {
						finalizationErrors.push(err);
					}
				}
			} catch (err) {
				// Without the preserved-state record, retain every candidate; a
				// later process must not guess which path is safe to remove.
				finalizationErrors.push(err);
			}
		} else {
			try {
				ownership = markCompeteGroupCleanupReady(ownership);
			} catch (err) {
				finalizationErrors.push(err);
			}
			try {
				const cleanupGroup = deps.competeWorktrees?.cleanupGroup ?? cleanupCompeteGroup;
				cleanupGroup(ownership);
			} catch (err) {
				finalizationErrors.push(err);
			}
		}
	}

	if (finalizationErrors.length > 0) {
		const unique = [...new Set(finalizationErrors)];
		const suffix = unique.map(competeErrorMessage).join("; ");
		if (primaryError !== null) {
			throw new Error(`${competeErrorMessage(primaryError)}; compete finalization also failed: ${suffix}`);
		}
		throw new Error(`compete finalization failed: ${suffix}`);
	}
	if (primaryError !== null) throw primaryError;
	if (outcome === null) throw new Error("compete lifecycle produced no outcome");
	return { ...outcome, board };
}

/**
 * Apply a preserved compete winner. Plan-scale by definition, so supervised
 * autonomy levels park this call for operator confirmation; the approval IS
 * the winner confirmation. After a successful merge the whole compete group
 * is cleaned up.
 */
function runApplyWinner(
	input: { branch: string; cwd: string },
	planHash: string,
	authority:
		| { outcome: "operator-confirmed"; requestId: string; requestedBy: string }
		| { outcome: "full-auto-applied" }
		| null,
	mergeWinner: typeof mergeWinnerBranch = mergeWinnerBranch,
	protectedPaths: ReadonlyArray<string> = [],
): ToolResult {
	if (authority === null) {
		return {
			kind: "error",
			message: "dispatch: apply_winner requires a registry-authenticated operator approval or full-auto authority",
		};
	}
	const branch = input.branch;
	const match = /^clio\/compete\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([1-9]\d*)$/.exec(branch);
	if (!match) {
		return { kind: "error", message: "dispatch: apply_winner.branch must be a clio/compete/<group>/<n> branch" };
	}
	const group = match[1] ?? "";
	const winnerIndex = Number.parseInt(match[2] ?? "", 10);
	const root = input.cwd;
	if (!isGitRepository(root)) {
		return { kind: "error", message: `dispatch: apply_winner requires a git repository at ${root}` };
	}
	recoverCleanupReadyCompeteGroups(root);
	const ownership = loadCompeteGroup(root, group);
	if (ownership === null) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} has no matching compete ownership manifest; refusing to merge or delete unproven state`,
		};
	}
	if (ownership.state !== "winner-preserved" || ownership.winnerIndex !== winnerIndex) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} does not match the preserved winner recorded for compete group ${group}`,
		};
	}
	const winnerDecision = readGateDecisionArtifacts(group)
		.filter(
			(entry) =>
				entry.artifact.outcome === "winner" &&
				entry.artifact.winner?.index === winnerIndex &&
				entry.artifact.winner.branch === branch,
		)
		.sort(
			(left, right) =>
				left.artifact.createdAt.localeCompare(right.artifact.createdAt) ||
				left.artifact.id.localeCompare(right.artifact.id),
		)
		.at(-1);
	if (winnerDecision === undefined || winnerDecision.artifact.winner === undefined) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} has no integrity-valid judge decision; refusing an unauditable confirmation`,
		};
	}
	const winnerRef = winnerDecision.artifact.winner;
	const protectedChanges = protectedPathsChangedByCompeteBranch(root, branch, protectedPaths);
	if (protectedChanges.length > 0) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} changes protected artifact(s) and cannot be merged: ${protectedChanges.join(", ")}`,
		};
	}
	const writeConfirmation = (): { artifact: GateDecisionArtifact; path: string } =>
		materializePendingGateDecision(
			stagePendingGateDecision({
				group,
				topology: "compete",
				cycle: 1,
				outcome: authority.outcome,
				subjects: [winnerRef.subject],
				winner: winnerRef,
				confirmation: {
					id: winnerDecision.artifact.id,
					digest: winnerDecision.artifact.integrity.digest,
				},
				detail:
					authority.outcome === "operator-confirmed"
						? `operator confirmation ${authority.requestId} (${authority.requestedBy}) approved ${branch} under dispatch plan ${planHash}`
						: `full-auto applied ${branch} under dispatch plan ${planHash}`,
			}),
		);
	let confirmation: { artifact: GateDecisionArtifact; path: string } | null = null;
	if (authority.outcome === "operator-confirmed") {
		try {
			confirmation = writeConfirmation();
		} catch (err) {
			return {
				kind: "error",
				message: `dispatch: could not persist operator confirmation for ${branch}: ${competeErrorMessage(err)}`,
			};
		}
	}
	const merge = mergeWinner(root, branch);
	if (!merge.ok) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} could not be merged: ${merge.reason}; the branch is preserved`,
			...(confirmation !== null
				? { details: { confirmationPath: confirmation.path, confirmationId: confirmation.artifact.id } }
				: {}),
		};
	}
	if (authority.outcome === "full-auto-applied") {
		try {
			confirmation = writeConfirmation();
		} catch (err) {
			return {
				kind: "error",
				message: `dispatch: winner branch ${branch} was merged, but full-auto application evidence failed: ${competeErrorMessage(err)}; branch is preserved for recovery`,
				details: { mode: "apply_winner", branch, group, applied: true, evidencePending: true },
			};
		}
	}
	if (confirmation === null) {
		return { kind: "error", message: `dispatch: winner branch ${branch} was merged without confirmation evidence` };
	}
	try {
		const cleanupOwnership = markCompeteGroupCleanupReady(ownership);
		cleanupCompeteGroup(cleanupOwnership);
	} catch (err) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} was merged, but compete cleanup failed: ${competeErrorMessage(err)}`,
			details: {
				mode: "apply_winner",
				branch,
				group,
				applied: true,
				cleanupPending: true,
				confirmationPath: confirmation.path,
				confirmationId: confirmation.artifact.id,
			},
		};
	}
	return {
		kind: "ok",
		output: `winner ${branch} merged into the current branch; compete group ${group} cleaned up`,
		details: {
			mode: "apply_winner",
			branch,
			group,
			confirmationPath: confirmation.path,
			confirmationId: confirmation.artifact.id,
		},
	};
}

function reviewGateResult(deps: DispatchToolDeps, outcome: GateRunOutcome, maxOutputBytes: number): ToolResult {
	const body = formatDispatchOutput("review", outcome.runs, maxOutputBytes);
	const details: ToolResultDetails = {
		...dispatchDetails(deps, "review", outcome.runs),
		gate: {
			verdict: outcome.verdict,
			cycles: outcome.cycles,
			decisions: outcome.decisions.map(({ artifact, path }) => ({
				id: artifact.id,
				outcome: artifact.outcome,
				path,
				digest: artifact.integrity.digest,
			})),
			...(outcome.needsDecision !== undefined ? { needsDecision: outcome.needsDecision } : {}),
		},
	};
	if (outcome.verdict === "pass") {
		return { kind: "ok", output: `review gate passed after ${outcome.cycles} cycle(s)\n\n${body}`, details };
	}
	if (outcome.verdict === "fail") {
		return { kind: "error", message: `dispatch: review gate failed (reviewer verdict fail)\n\n${body}`, details };
	}
	return {
		kind: "error",
		message: `dispatch: review gate needs an operator decision: ${outcome.needsDecision ?? "no verdict"}\n\n${body}`,
		details,
	};
}

function competeResult(
	deps: DispatchToolDeps,
	outcome: CompeteOutcome,
	autonomy: AutonomyLevel,
	maxOutputBytes: number,
): ToolResult {
	const board = outcome.board ?? null;
	const body = formatDispatchOutput("compete", outcome.runs, maxOutputBytes, board);
	const details: ToolResultDetails = {
		...dispatchDetails(deps, "compete", outcome.runs, board),
		compete: {
			group: outcome.group,
			winner: outcome.winner,
			decisions: outcome.decisions.map(({ artifact, path }) => ({
				id: artifact.id,
				outcome: artifact.outcome,
				path,
				digest: artifact.integrity.digest,
			})),
			...(outcome.needsDecision !== undefined ? { needsDecision: outcome.needsDecision } : {}),
		},
	};
	if (outcome.winner?.applied === true) {
		return {
			kind: "ok",
			output: `compete winner candidate ${outcome.winner.index} applied (branch ${outcome.winner.branch} merged)\n\n${body}`,
			details,
		};
	}
	if (outcome.winner !== null && outcome.needsDecision === undefined) {
		const lines = [
			`compete winner: candidate ${outcome.winner.index} (branch ${outcome.winner.branch}), preserved for confirmation at autonomy ${autonomy}`,
			`Apply it with dispatch apply_winner={branch: "${outcome.winner.branch}"}; the approval prompt is the winner confirmation. Losing candidates were cleaned up.`,
		];
		return { kind: "ok", output: `${lines.join("\n")}\n\n${body}`, details };
	}
	return {
		kind: "error",
		message: `dispatch: compete needs an operator decision: ${outcome.needsDecision ?? "no winner"}\n\n${body}`,
		details,
	};
}

export async function runDispatchTool(
	inputDeps: DispatchToolDeps,
	admissionState: DispatchAdmissionState,
	args: Record<string, unknown>,
	options?: ToolInvokeOptions,
): Promise<ToolResult> {
	const deps: RegisteredDispatchToolDeps = {
		...inputDeps,
		runEvents: inputDeps.runEvents ?? createDispatchRunEventRegistry(),
	};
	const snapshot = admissionState.trustedExecutionSnapshots.get(args);
	if (snapshot?.kind === "list") {
		const catalog = deps.getAgentCatalog?.().trim() ?? "";
		if (catalog.length === 0) {
			return { kind: "error", message: "dispatch: no agent catalog is available in this context" };
		}
		return { kind: "ok", output: catalog };
	}
	try {
		recoverPendingGateEvidence(deps);
	} catch (error) {
		return {
			kind: "error",
			message: `dispatch: pending gate evidence recovery failed closed: ${competeErrorMessage(error)}`,
		};
	}
	if (snapshot?.kind === "apply-winner") {
		const trustedWinnerPlan = admissionState.trustedResolvedPlans.get(args);
		if (trustedWinnerPlan === undefined) {
			return { kind: "error", message: "dispatch: trusted winner-application plan is unavailable" };
		}
		const confirmation = trustedWinnerPlan.confirmation;
		if (confirmation !== undefined) {
			if (
				snapshot.branch !== confirmation.branch ||
				(confirmation.cwd !== undefined && snapshot.cwd !== confirmation.cwd)
			) {
				return { kind: "error", message: "dispatch: winner destination differs from the approved plan" };
			}
		}
		const approval = options?.approval;
		const authority =
			approval?.actionClass === "dispatch"
				? {
						outcome: "operator-confirmed" as const,
						requestId: approval.requestId,
						requestedBy: approval.requestedBy,
					}
				: deps.getAutonomy?.() === "full-auto"
					? { outcome: "full-auto-applied" as const }
					: null;
		let protectedPaths: string[];
		try {
			protectedPaths = deps.dispatch.protectedArtifactState?.().artifacts.map((artifact) => artifact.path) ?? [];
		} catch (error) {
			return {
				kind: "error",
				message: `dispatch: protected artifact state is unavailable: ${competeErrorMessage(error)}`,
			};
		}
		const planHash = describeDispatchPlan({
			apply_winner: { branch: snapshot.branch, cwd: snapshot.cwd },
			[RESOLVED_DISPATCH_PLAN_ARGUMENT]: trustedWinnerPlan,
		}).hash;
		return runApplyWinner(snapshot, planHash, authority, deps.competeWorktrees?.mergeWinner, protectedPaths);
	}
	if (snapshot?.kind !== "dispatch") {
		return { kind: "error", message: "dispatch: trusted execution admission snapshot is unavailable" };
	}
	const mode = snapshot.mode;
	if (options?.signal?.aborted) return { kind: "error", message: "dispatch: aborted" };
	const maxOutputBytes = snapshot.maxOutputBytes;
	const timeoutMs = snapshot.timeoutMs;
	let review = snapshot.review === undefined ? undefined : structuredClone(snapshot.review);

	// Plan-scale calls are either approved at supervised admission or run
	// unstopped at full-auto; every run seals the same plan hash.
	const autonomy = deps.getAutonomy?.() ?? "auto-edit";
	const authenticatedApproval = options?.approval?.actionClass === "dispatch" ? options.approval : undefined;
	const trustedResolvedPlan = admissionState.trustedResolvedPlans.get(args) ?? null;
	const planView = snapshot.planView;
	// Production preparation always registers the authoritative snapshot.
	// The parser remains available in dispatch-plan.ts for direct utility
	// tests/tools, but a hidden model-supplied field is never execution trust.
	const resolvedPlan = trustedResolvedPlan;
	const reservationOwnerId = admissionState.trustedReservationOwners.get(args);
	// Stamp this call's own id on every request before the mode branches
	// split them. Derived sub-requests that spread a base request inherit
	// it; the ones built fresh (reviewer, judge) copy it explicitly. A
	// surface that cannot find the parent still renders the run, just not
	// nested, so an absent id is never an error.
	const parentToolCallId = options?.toolCallId;
	let requests: ReadonlyArray<DispatchRequest> =
		parentToolCallId === undefined || parentToolCallId.length === 0
			? structuredClone(snapshot.requests)
			: snapshot.requests.map((request) => ({ ...structuredClone(request), parentToolCallId }));
	if (planView.planScale && deps.dispatch.preview !== undefined && resolvedPlan === null) {
		return { kind: "error", message: "dispatch: resolved plan is missing after admission" };
	}
	if (planView.planScale && autonomy !== "full-auto" && authenticatedApproval === undefined) {
		return {
			kind: "error",
			message: "dispatch: resolved plan requires a registry-authenticated operator approval",
		};
	}
	if (resolvedPlan !== null) {
		const primaryRole = review !== undefined ? "builder" : mode === "compete" ? "candidate" : "task";
		const primaryTasks = resolvedPlan.tasks.filter((task) => task.role === primaryRole);
		const executionTasks = primaryRole === "task" ? primaryTasks : primaryTasks.slice(0, 1);
		if (executionTasks.length !== requests.length) {
			return {
				kind: "error",
				message: `dispatch: resolved plan has ${executionTasks.length} primary task(s), expected ${requests.length}`,
			};
		}
		requests = requests.map((request, index) => {
			const task = executionTasks[index];
			const pinned = withResolvedPlanTaskPin(request, task);
			return reservationOwnerId !== undefined && task?.role !== undefined && task.position !== undefined
				? {
						...pinned,
						reservation: {
							ownerId: reservationOwnerId,
							memberId: task.stepId ?? `${task.role}-${task.position}`,
						},
					}
				: pinned;
		});
		if (review !== undefined) {
			const reviewer = resolvedPlan.tasks.find((task) => task.role === "reviewer");
			if (reviewer === undefined) {
				return { kind: "error", message: "dispatch: resolved review plan has no reviewer task" };
			}
			review = {
				...review,
				reviewer: reviewer.agent,
				target: reviewer.target,
				model: reviewer.model,
				node: reviewer.node,
				resolvedTasks: resolvedPlan.tasks,
			};
		}
	}
	if (planView.planScale) {
		const plan: RunPlanProvenance = {
			hash: planView.hash,
			topology: planView.topology,
			taskCount: planView.taskCount,
			approval: authenticatedApproval !== undefined ? "operator" : "full-auto",
			source:
				resolvedPlan?.source === null || resolvedPlan?.source === undefined
					? null
					: {
							kind: "scout-transition",
							runId: resolvedPlan.source.runId,
							receiptDigest: resolvedPlan.source.receiptDigest,
							executionPlanHash: resolvedPlan.source.executionPlanHash,
						},
			...(authenticatedApproval !== undefined
				? {
						approvalRequestId: authenticatedApproval.requestId,
						approvalRequestedBy: authenticatedApproval.requestedBy,
					}
				: {}),
			...(planView.costCeilingUsd !== undefined ? { costCeilingUsd: planView.costCeilingUsd } : {}),
		};
		requests = requests.map((request) => ({ ...request, plan }));
	}
	const backgroundRefusal =
		resolvedPlan?.topology === "fleet"
			? "a Scout dependency plan drives its stages from this turn"
			: mode === "compete"
				? "compete holds its judge gate in this turn"
				: review !== undefined
					? "a review gate holds its cycle state in this turn"
					: mode === "pipeline" && requests.length > 1
						? "a pipeline threads each step's output through this turn"
						: timeoutMs !== undefined
							? `this call set timeout_ms=${timeoutMs} and nobody would be left to enforce the deadline`
							: deps.dispatch.detached === undefined
								? "detached batch records are unavailable in this context"
								: null;
	const background = createBackgroundSwitch();
	// Review and Scout both execute under mode=parallel, so the operator-facing
	// label names the topology they actually asked for.
	const backgroundLabel = resolvedPlan?.topology === "fleet" ? "fleet" : review !== undefined ? "review" : mode;
	const releaseBackground = registerBackgroundControl(deps, options?.toolCallId, {
		label: `dispatch (${backgroundLabel})`,
		refusal: backgroundRefusal,
		fire: () => background.fire(),
	});
	try {
		if (resolvedPlan?.topology === "fleet") {
			const executionPlan = admissionState.trustedExecutionPlans.get(args);
			if (
				executionPlan === undefined ||
				resolvedPlan.source === null ||
				resolvedPlan.deadlineMs === null ||
				reservationOwnerId === undefined
			) {
				return { kind: "error", message: "dispatch: trusted Scout dependency plan is unavailable" };
			}
			if (executionPlan.hash !== resolvedPlan.source.executionPlanHash) {
				return { kind: "error", message: "dispatch: Scout dependency plan hash drifted after admission" };
			}
			if (!scoutPlanAuthorityGranted(resolvedPlan, authenticatedApproval !== undefined, autonomy === "full-auto")) {
				return { kind: "error", message: "dispatch: Scout dependency plan lacks authenticated authority grants" };
			}
			const executable = compileExecutionPlan({
				topology: executionPlan.topology,
				rootTask: executionPlan.rootTask,
				maxWorkers: executionPlan.maxWorkers,
				...(executionPlan.writers === 1 ? { writers: 1 as const } : {}),
				onFailure: executionPlan.onFailure,
				steps: requireAgentSteps(executionPlan.steps).map((step) => ({
					...step,
					approvedAuthority: step.requestedAuthority,
				})),
			});
			try {
				const outcome = await runScoutContinuationPlan({
					dispatch: deps.dispatch,
					plan: executable,
					artifact: resolvedPlan,
					requests,
					reservationOwnerId,
					...(options?.signal === undefined ? {} : { signal: options.signal }),
					register: (handle, agentId) =>
						deps.runEvents.registerSingle(handle, agentId, fallbackProgressBus(deps)).completion,
					complete: (receipt, summary) => {
						const completed = completeRun(deps, receipt, summary);
						return { value: completed, integrityValid: completed.integrity.ok };
					},
				});
				const output = formatDispatchOutput("fleet", outcome.runs, maxOutputBytes);
				const details = {
					...dispatchDetails(deps, "fleet", outcome.runs),
					executionPlanHash: executable.hash,
					skippedSteps: outcome.skipped,
				};
				const failed = outcome.runs.some((run) => run.receipt.exitCode !== 0) || outcome.skipped.length > 0;
				return failed ? { kind: "error", message: output, details } : { kind: "ok", output, details };
			} catch (error) {
				return {
					kind: "error",
					message: `dispatch: Scout dependency plan failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		if (snapshot.detach) {
			if (mode !== "parallel") {
				return { kind: "error", message: `dispatch: detach only supports parallel mode; got '${mode}'` };
			}
			if (review !== undefined) {
				return {
					kind: "error",
					message: "dispatch: detach cannot combine with a review gate; run gated dispatch attached",
				};
			}
			if (timeoutMs !== undefined) {
				return {
					kind: "error",
					message:
						'dispatch: detach cannot enforce timeout_ms because no caller waits on the runs; monitor(mode="wait") only observes for a bounded time, and steer(action="cancel") stops a run',
				};
			}
			try {
				return await runDetached(deps, requests, options?.sessionId ?? null);
			} catch (err) {
				return { kind: "error", message: dispatchErrorMessage(err) };
			}
		}

		if (mode === "compete") {
			if (requests.length !== 1 || requests[0] === undefined) {
				return { kind: "error", message: COMPETE_SINGLE_TASK_MESSAGE };
			}
			if (review !== undefined) {
				return { kind: "error", message: COMPETE_NO_REVIEW_MESSAGE };
			}
			if (snapshot.compete === undefined) {
				return { kind: "error", message: "dispatch: trusted compete settings are unavailable" };
			}
			let compete = structuredClone(snapshot.compete);
			if (resolvedPlan !== null) {
				const judge = resolvedPlan.tasks.find((task) => task.role === "judge");
				if (judge === undefined) {
					return { kind: "error", message: "dispatch: resolved compete plan has no judge task" };
				}
				compete = {
					...compete,
					judge: { agent: judge.agent, target: judge.target, model: judge.model, node: judge.node },
					resolvedTasks: resolvedPlan.tasks,
				};
			}
			try {
				const outcome = await runCompete(deps, requests[0], compete, autonomy, timeoutMs, options?.signal);
				return competeResult(deps, outcome, autonomy, maxOutputBytes);
			} catch (err) {
				return { kind: "error", message: dispatchErrorMessage(err) };
			}
		}

		if (review !== undefined) {
			if (requests.length !== 1 || requests[0] === undefined) {
				return { kind: "error", message: REVIEW_SINGLE_TASK_MESSAGE };
			}
			if (mode !== "parallel") {
				return { kind: "error", message: `dispatch: review does not combine with mode=${mode}` };
			}
			try {
				const outcome = await runReviewGated(deps, requests[0], review, timeoutMs, options?.signal);
				return reviewGateResult(deps, outcome, maxOutputBytes);
			} catch (err) {
				return { kind: "error", message: dispatchErrorMessage(err) };
			}
		}

		try {
			let runs: CompletedRun[];
			// Only the concurrent fan-out has peers, so only it has a board.
			let board: string | null = null;
			if (mode === "pipeline" && requests.length > 1) {
				runs = await runPipeline(deps, requests, timeoutMs, options?.signal);
			} else if (mode === "sequential" || mode === "pipeline" || requests.length === 1) {
				// A single-task pipeline has nothing to thread, so it degrades to
				// plain sequential and no pipeline-input message is sent.
				runs = await runSequential(deps, requests, mode, timeoutMs, options?.signal, background);
			} else {
				const batch =
					snapshot.writers === 1
						? await runWriterLimitedBatch(deps, requests, timeoutMs, options?.signal)
						: await runBatch(deps, requests, timeoutMs, options?.signal, background);
				runs = batch.runs;
				board = batch.board;
			}
			const output = formatDispatchOutput(mode, runs, maxOutputBytes, board);
			const details = dispatchDetails(deps, mode, runs, board);
			const failed = runs.filter((run) => run.receipt.exitCode !== 0);
			if (failed.length > 0) return { kind: "error", message: output, details };
			return { kind: "ok", output, details };
		} catch (err) {
			if (err instanceof DispatchBackgroundedError) {
				return await backgroundedDispatchResult(deps, err, mode, options?.sessionId ?? null);
			}
			if (err instanceof PipelineHaltError) {
				const haltMessage = `dispatch: ${err.message}`;
				const output = formatDispatchOutput("pipeline", err.runs, maxOutputBytes);
				return {
					kind: "error",
					message: `${haltMessage}\n\n${output}`,
					details: dispatchDetails(deps, "pipeline", err.runs),
				};
			}
			return { kind: "error", message: dispatchErrorMessage(err) };
		}
	} finally {
		releaseBackground();
	}
}

/**
 * One at a time: each run completes before the next dispatches. Also serves
 * single-task parallel calls, where batching adds nothing. The timeout and
 * abort signal cover the whole sequence; remaining tasks are skipped once
 * either fires and the skip is reported through the thrown error.
 */
async function runSequential(
	deps: RegisteredDispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	mode: string,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	background: BackgroundSwitch,
): Promise<CompletedRun[]> {
	const runs: CompletedRun[] = [];
	let expired = false;
	let activeRunId: string | null = null;
	// The operator signal is a cancel; the timer is a timeout. Both stop the
	// sequence, but the timeout carries a cause so the receipt names it.
	const abortActive = (bySignal: boolean): void => {
		expired = true;
		if (activeRunId !== null) {
			deps.dispatch.abort(
				activeRunId,
				bySignal ? undefined : { cause: "timeout", detail: `timed out after ${timeoutMs}ms` },
			);
		}
	};
	const onSignalAbort = (): void => abortActive(true);
	const timer = timeoutMs !== undefined ? setTimeout(() => abortActive(false), timeoutMs) : null;
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	try {
		for (const [index, request] of requests.entries()) {
			if (expired || signal?.aborted) {
				throw new Error(
					`${mode} dispatch stopped after ${runs.length}/${requests.length} task(s): ${signal?.aborted ? "aborted" : `timed out after ${timeoutMs}ms`}`,
				);
			}
			const handle = await deps.dispatch.dispatch(request);
			activeRunId = handle.runId;
			const registered = deps.runEvents.registerSingle(handle, request.agentId, fallbackProgressBus(deps));
			const completion = registered.completion.then((value) => ({ kind: "completed" as const, value }));
			const settled = await Promise.race([completion, background.requested.then(() => ({ kind: "background" as const }))]);
			if (settled.kind === "background") {
				// activeRunId stays set on purpose: the finally below only clears the
				// timer and the abort listener, and the live step must survive both.
				completion.catch(() => {});
				throw new DispatchBackgroundedError(
					newGateGroupId("batch"),
					[{ runId: handle.runId, assignmentId: handle.runId, agentId: request.agentId }],
					[...runs],
					requests.slice(index + 1).map((later) => later.agentId),
				);
			}
			activeRunId = null;
			runs.push(completeRun(deps, settled.value.receipt, settled.value.summary));
		}
		return runs;
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
	}
}

/** A pipeline step failed when its worker exited nonzero or its outcome is not success. */
function isPipelineStepFailure(receipt: RunReceipt): boolean {
	if (receipt.exitCode !== 0) return true;
	return receipt.outcome !== undefined && receipt.outcome !== "succeeded";
}

function pipelineFailureReason(receipt: RunReceipt): string {
	if (receipt.outcome !== undefined && receipt.outcome !== "succeeded") return `outcome=${receipt.outcome}`;
	return `exit=${receipt.exitCode}`;
}

/**
 * Chain worker outputs: each step runs to completion, then its final assistant
 * text is threaded to the next step as `pipelineInput` (data, not instruction
 * text). Step 1 receives none. A failed step halts the chain and the thrown
 * error names the step and how many later steps were skipped, mirroring
 * runSequential's "stopped after N/M" phrasing. Whole-sequence timeout and
 * abort handling match runSequential.
 */
async function runPipeline(
	deps: RegisteredDispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<CompletedRun[]> {
	const runs: CompletedRun[] = [];
	let expired = false;
	let activeRunId: string | null = null;
	// The operator signal is a cancel; the timer is a timeout. Both stop the
	// chain, but the timeout carries a cause so the receipt names it.
	const abortActive = (bySignal: boolean): void => {
		expired = true;
		if (activeRunId !== null) {
			deps.dispatch.abort(
				activeRunId,
				bySignal ? undefined : { cause: "timeout", detail: `timed out after ${timeoutMs}ms` },
			);
		}
	};
	const onSignalAbort = (): void => abortActive(true);
	const timer = timeoutMs !== undefined ? setTimeout(() => abortActive(false), timeoutMs) : null;
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	try {
		let previous: { runId: string; text: string } | null = null;
		for (const [index, base] of requests.entries()) {
			if (expired || signal?.aborted) {
				throw new Error(
					`pipeline dispatch stopped after ${runs.length}/${requests.length} task(s): ${signal?.aborted ? "aborted" : `timed out after ${timeoutMs}ms`}`,
				);
			}
			// Thread the previous step's output as data; the task string the
			// orchestrator authored is sent verbatim. Step 1 (previous === null)
			// carries no pipeline input.
			const request: DispatchRequest =
				previous === null
					? base
					: { ...base, pipelineInput: { fromRunId: previous.runId, position: index + 1, text: previous.text } };
			const handle = await deps.dispatch.dispatch(request);
			activeRunId = handle.runId;
			const registered = deps.runEvents.registerSingle(handle, request.agentId, fallbackProgressBus(deps));
			const { receipt, summary } = await registered.completion;
			activeRunId = null;
			runs.push(completeRun(deps, receipt, summary));
			if (isPipelineStepFailure(receipt)) {
				const skipped = requests.length - (index + 1);
				throw new PipelineHaltError(
					`pipeline dispatch halted at step ${index + 1}/${requests.length} (run ${receipt.runId}, ${pipelineFailureReason(receipt)}); skipped ${skipped} later step(s)`,
					[...runs],
				);
			}
			previous = {
				runId: receipt.runId,
				text: receipt.output?.state === "final" ? receipt.output.text : "",
			};
		}
		return runs;
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
	}
}

interface BatchOutcome {
	runs: CompletedRun[];
	/** Rendered board of the batch's shared ledger, null when nothing was posted. */
	board: string | null;
}

async function runBatch(
	deps: RegisteredDispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	background: BackgroundSwitch,
): Promise<BatchOutcome> {
	// This arm is the concurrent parallel fan-out, so its peers can see each
	// other. The ledger opens before admission and every request carries it, so
	// no worker spawns into a dispatch whose board it cannot reach.
	const ledgerId = newGateGroupId("ledger");
	await openAgentLedger(ledgerId);
	const ledgered = requests.map((request) => ({ ...request, ledger: { id: ledgerId, sequence: 0 } }));
	const handle = await deps.dispatch.dispatchBatch(ledgered);
	const registered = deps.runEvents.registerBatch(
		handle,
		ledgered.map((request) => request.agentId),
		fallbackProgressBus(deps),
	);
	// The operator signal is a cancel; the timer is a timeout. The timeout
	// carries a cause so each killed run's receipt names it.
	const abort = (bySignal: boolean): void => {
		const reason = bySignal ? undefined : ({ cause: "timeout", detail: `timed out after ${timeoutMs}ms` } as const);
		for (const runId of handle.assignmentIds) deps.dispatch.abort(runId, reason);
	};
	const onSignalAbort = (): void => abort(true);
	const timer = timeoutMs !== undefined ? setTimeout(() => abort(false), timeoutMs) : null;
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	// The board closes when the batch settles in this call. A backgrounded
	// batch settles elsewhere: its runs are still live and still posting, so
	// the ledger rides on the converted record and closes at collect instead.
	let backgrounded = false;
	try {
		const completion = registered.completion.then((value) => ({ kind: "completed" as const, value }));
		const settled = await Promise.race([completion, background.requested.then(() => ({ kind: "background" as const }))]);
		if (settled.kind === "background") {
			// The batch drain keeps metering; only this await unwinds. Every run in
			// a parallel batch is already live, so the whole batch converts.
			completion.catch(() => {});
			backgrounded = true;
			throw new DispatchBackgroundedError(
				handle.batchId,
				handle.assignmentIds.map((runId, index) => ({
					runId,
					assignmentId: runId,
					agentId: ledgered[index]?.agentId ?? "unknown",
				})),
				[],
				[],
				ledgerId,
			);
		}
		const { summaries, receipts } = settled.value;
		// Every worker has settled and the board has not closed yet, so this is
		// the whole board the peers built, read once for the model that started
		// them.
		const board = renderAgentLedgerBoard(ledgerId);
		return {
			runs: receipts.map((receipt) =>
				completeRun(
					deps,
					receipt,
					summaries.get(receipt.runId) ?? {
						count: 0,
						types: [],
						lastAssistantText: "",
						terminalAttemptRunId: receipt.runId,
					},
				),
			),
			board,
		};
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
		if (!backgrounded) await closeAgentLedger(ledgerId);
	}
}

/** Admit one checkout writer at a time while every read-only peer remains concurrent. */
async function runWriterLimitedBatch(
	deps: RegisteredDispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<BatchOutcome> {
	const specs = new Map(deps.getAgentSpecs().map((spec) => [spec.id, spec]));
	const readers = requests.filter((request) => specs.get(request.agentId)?.capabilityClass === "read-only");
	const writers = requests.filter((request) => specs.get(request.agentId)?.capabilityClass !== "read-only");
	const ledgerId = newGateGroupId("ledger");
	await openAgentLedger(ledgerId);
	const activeIds = new Set<string>();
	const completed = new Map<DispatchRequest, CompletedRun>();
	const start = async (request: DispatchRequest): Promise<CompletedRun> => {
		const ledgered = { ...request, ledger: { id: ledgerId, sequence: 0 } };
		const handle = await deps.dispatch.dispatch(ledgered);
		activeIds.add(handle.runId);
		const registered = deps.runEvents.registerSingle(handle, request.agentId, fallbackProgressBus(deps));
		const value = await registered.completion;
		activeIds.delete(handle.runId);
		const run = completeRun(deps, value.receipt, value.summary);
		completed.set(request, run);
		return run;
	};
	const abort = (bySignal: boolean): void => {
		const reason = bySignal ? undefined : ({ cause: "timeout", detail: `timed out after ${timeoutMs}ms` } as const);
		for (const runId of activeIds) deps.dispatch.abort(runId, reason);
	};
	const onSignalAbort = (): void => abort(true);
	const timer = timeoutMs === undefined ? null : setTimeout(() => abort(false), timeoutMs);
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	try {
		const readerPromises = readers.map((request) => start(request));
		for (const writer of writers) await start(writer);
		await Promise.all(readerPromises);
		return {
			runs: requests.flatMap((request) => {
				const run = completed.get(request);
				return run === undefined ? [] : [run];
			}),
			board: renderAgentLedgerBoard(ledgerId),
		};
	} finally {
		if (timer !== null) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
		await closeAgentLedger(ledgerId);
	}
}
