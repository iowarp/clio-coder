/**
 * ContextFold's session-control half (CF-1): the structural eviction stage, the
 * replay rebuild every reduction ends on, and the publication tails a summary
 * checkpoint and a step checkpoint run after their entry is on the ledger. The
 * turn context owns the state these read and write and lends it through the
 * port; this module owns no state of its own. The two tails stay separate
 * until one publication function replaces both.
 */

import type { ClioSettings } from "../core/config.js";
import type { ContextOperationFact } from "../core/context-operation.js";
import { sessionTelemetryContext } from "../core/telemetry/context.js";
import type { ContextActivityStatus, ContextFoldPayload, ContextPrunedPayload } from "../core/telemetry/live-events.js";
import { requestFits } from "../domains/context/budget/request-fit.js";
import type { FoldCheckpoint } from "../domains/context/fold/contract.js";
import { createFoldPriceBook } from "../domains/context/fold/price.js";
import { buildEvictionFields, planEviction } from "../domains/context/working-set/engine.js";
import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import { isTurnStart, protectionCutoffIndex } from "../domains/context/working-set/horizon.js";
import { resolveWorkingSetPolicy } from "../domains/context/working-set/policies/index.js";
import { selectVisibleEntries } from "../domains/context/working-set/visible.js";
import type { ContextCompactionVerdict } from "../domains/session/compaction/auto.js";
import type { ContextSnapshot } from "../domains/session/context-accounting.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { replaceEngineMessages } from "../engine/agent.js";
import { renderEvictionSkipLine } from "./compaction-lines.js";
import type { ContinuityReductionHooks } from "./continuity-controller.js";
import type { MessageListDigests } from "./message-list-digest.js";
import { buildModelReplayAgentMessagesFromTurns, continuityContextFromSession } from "./model-session-replay.js";
import { resolveTurnOutputReserve } from "./output-reserve.js";
import { createReplayMessageConverter } from "./session-replay-messages.js";
import type { ExpectedColdReason, LiveContextEstimate, TurnContext, TurnContextDeps } from "./turn-context.js";
import type { AgentRuntime, TurnContextState } from "./turn-state.js";

/** The last reduction a context stage published, as `/context` reports it. */
export interface CompactionEvent {
	stage: string;
	tokensBefore: number;
	tokensAfter: number;
	trigger: string;
}

/** What the fold reads and writes of the turn context that owns it. */
export interface ContextFoldPort {
	deps: Pick<
		TurnContextDeps,
		"session" | "readSessionEntries" | "planEviction" | "bus" | "emitNotice" | "middleware" | "hostInserts"
	>;
	state: TurnContextState;
	syncCodexConfiguration(runtime: AgentRuntime): void;
	observeHistory(agentRuntime: AgentRuntime): MessageListDigests;
	/** Tool results the next request carries as aging stubs; null when nothing is stubbed. */
	agedHistory(agentRuntime: AgentRuntime, observed: MessageListDigests): { saved: ReadonlyArray<{ id: string }> } | null;
	liveContextEstimate(agentRuntime: AgentRuntime, pendingUserText?: string): LiveContextEstimate;
	reconciledHistoryTokens(agentRuntime: AgentRuntime): number | null;
	carryReconciledAnchorThroughProjection(
		agentRuntime: AgentRuntime,
		historyTokens: number | null,
		tokensRemoved: number,
	): void;
	/** A rewrite the attestation did not describe: the next call re-anchors. */
	dropReconciledAnchor(): void;
	captureRuntimeContextSnapshot: TurnContext["captureRuntimeContextSnapshot"];
	setCurrentSnapshot(snapshot: ContextSnapshot): void;
	persistContextSnapshot(snapshot: ContextSnapshot): void;
	noteCompactionEvent(event: CompactionEvent): void;
	notifyMemoryCommit: TurnContext["notifyMemoryCommit"];
	resetCacheCallBaseline(): void;
	noteColdReason(reason: ExpectedColdReason): void;
	refreshLiveBudget(pendingUserText?: string): void;
	emitCompactionActivity(status: ContextActivityStatus, message: string): void;
	compactionFailureMessage(error: unknown): string;
	recordCompactionFact(fact: ContextOperationFact): void;
	recordCompactionTokens(tokens: { before: number; after: number; basis: "runtime-estimate" }): void;
	/** A posture generation is in force, so the prompt recompiles after a summary rebuild. */
	hasPostureGeneration(): boolean;
	ensureSessionPrompt(agentRuntime: AgentRuntime): Promise<unknown>;
	logPromptCompileIfPending(): void;
}

/** One stage's entry in a `context.fold` decision. */
export type FoldStageEntry = ContextFoldPayload["stages"][number];

/** What one fold checkpoint decided, written as one `context.fold` event when it closes. */
export interface FoldDecision {
	/** One stage's outcome; a commit names the ledger record it wrote. */
	stage(entry: FoldStageEntry): void;
	/** A context size the checkpoint measured: the first is its before figure, the latest its after figure. */
	measure(tokens: number): void;
	/** Writes the event when a stage was recorded; a checkpoint that reached no stage writes nothing. */
	close(): void;
}

export interface FoldDecisionInput {
	checkpoint: FoldCheckpoint;
	agentRuntime: AgentRuntime;
	sessionId: string | undefined;
}

/**
 * Where a reduction ran, read from how it was asked for: overflow recovery, a
 * request about to carry a pending prompt, an operator command, or the guard
 * between tool batches.
 */
export function foldCheckpointFor(trigger: CompactionTrigger, pendingUserText: string | undefined): FoldCheckpoint {
	if (trigger === "overflow") return "overflow";
	if (pendingUserText !== undefined) return "submit";
	if (trigger === "force") return "operator";
	return trigger === "step" ? "step" : "tool_batch";
}

/** The expected cold-cache reason each committing stage notes. */
const COMMIT_CAUSE: Partial<Record<FoldStageEntry["stage"], NonNullable<ContextFoldPayload["cause"]>>> = {
	working_set: "working_set_evict",
	llm_summary: "compaction",
	step_checkpoint: "step_checkpoint",
};

export interface EvictionStageInput {
	agentRuntime: AgentRuntime;
	/** The checkpoint's decision, which this stage reports its outcome to. */
	decision: FoldDecision;
	session: SessionContract;
	settings: Readonly<ClioSettings>;
	estimate: LiveContextEstimate;
	verdict: ContextCompactionVerdict;
	beforeSnapshotId: string | null;
	/** Overflow on a known window: the stage plans to fit the request, not to the trigger. */
	requiredFit: boolean;
	compactionWindow: number;
	compactionThreshold: number;
	workingSetTarget: number;
	trigger: CompactionTrigger;
	originSession: string | undefined;
	pendingUserText: string | undefined;
	handoff: ContinuityReductionHooks | undefined;
	shouldCompact(tokens: number): ContextCompactionVerdict;
}

export interface EvictionStageResult {
	/** An eviction record was written. */
	acted: boolean;
	/** The eviction alone brought the context under the trigger, or fitted the request. */
	fit: boolean;
	/** Why the stage declined, held for the transcript until a summary follows. */
	skipNotice: string | null;
}

export interface SummaryPublicationInput {
	agentRuntime: AgentRuntime;
	compactionThreshold: number;
	snapshotMetadata: Parameters<TurnContext["captureRuntimeContextSnapshot"]>[3];
	preCompactSnapshot: ContextSnapshot;
	footerTokensBefore: number;
	pendingUserText: string | undefined;
	trigger: CompactionTrigger;
	originSession: string | undefined;
}

export interface StepPublicationInput {
	agentRuntime: AgentRuntime;
	before: ContextSnapshot;
	threshold: number | null;
	tokensBefore: number;
	sessionId: string | undefined;
}

export interface ContextFold {
	beginDecision(input: FoldDecisionInput): FoldDecision;
	refreshAgentMessagesFromSession(agentRuntime: AgentRuntime): ReadonlyArray<SessionEntry>;
	runEvictionStage(input: EvictionStageInput): EvictionStageResult;
	publishSummaryCheckpoint(input: SummaryPublicationInput): Promise<{ tokensBefore: number; tokensAfter: number }>;
	publishStepCheckpoint(input: StepPublicationInput): { tokensAfter: number };
}

/**
 * Why the working-set stage declined, said in the terms the operator can act
 * on. The two cases are worth separating: a session whose every turn is inside
 * `protectLastTurns` was never offered a candidate, while a longer one was
 * offered candidates the policy refused. The first is the shape smoke pass 2
 * found (G1), and the setting it names is the one that changes it.
 */
function evictionSkipMessage(
	visibleEntries: ReadonlyArray<SessionEntry>,
	workingSet: Readonly<{ protectLastTurns: number; protectLastSteps: number; policy: string }>,
	policyId: string,
): string {
	const turns = visibleEntries.filter(isTurnStart).length;
	// The window is the narrower of the turn and step horizons, so only the
	// cutoff itself says whether the policy was offered anything at all.
	const allProtected = protectionCutoffIndex(visibleEntries, workingSet) === 0;
	return renderEvictionSkipLine({
		reason: allProtected ? "all-protected" : "nothing-evictable",
		turns,
		protectLastTurns: workingSet.protectLastTurns,
		protectLastSteps: workingSet.protectLastSteps,
		policyId,
	});
}

export function createContextFold(port: ContextFoldPort): ContextFold {
	const { deps, state } = port;

	const refreshAgentMessagesFromSession = (agentRuntime: AgentRuntime): ReadonlyArray<SessionEntry> => {
		const refreshedEntries = deps.readSessionEntries?.() ?? [];
		replaceEngineMessages(
			agentRuntime.agent,
			buildModelReplayAgentMessagesFromTurns(refreshedEntries, {
				...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
				// The post-compaction rebuild is where an accepted note has to
				// survive: wiring continuity only into /fork would lose it on the
				// very refresh the reduction triggers.
				continuity: continuityContextFromSession(deps.session),
			}),
		);
		state.replayedContextMessages = [];
		port.syncCodexConfiguration(agentRuntime);
		return refreshedEntries;
	};

	const beginDecision = (input: FoldDecisionInput): FoldDecision => {
		const { modelTier, promptCaching } = input.agentRuntime.runtimeResolution;
		const route: ContextFoldPayload["route"] = {
			...(modelTier !== undefined ? { modelTier } : {}),
			...(promptCaching !== undefined ? { promptCaching } : {}),
		};
		const stages: FoldStageEntry[] = [];
		let tokensBefore: number | null = null;
		let tokensAfter = 0;
		let closed = false;
		return {
			stage: (entry) => {
				stages.push(entry);
			},
			measure: (tokens) => {
				const figure = Math.max(0, Math.round(tokens));
				tokensBefore ??= figure;
				tokensAfter = figure;
			},
			close: () => {
				if (closed || stages.length === 0) return;
				closed = true;
				const cause = stages.filter((entry) => entry.outcome === "committed").at(-1)?.stage;
				const coldReason = cause === undefined ? undefined : COMMIT_CAUSE[cause];
				deps.bus?.emit(
					"context.fold",
					{
						checkpoint: input.checkpoint,
						route,
						stages,
						tokensBefore: tokensBefore ?? tokensAfter,
						tokensAfter,
						...(coldReason !== undefined ? { cause: coldReason } : {}),
					} satisfies ContextFoldPayload,
					sessionTelemetryContext(input.sessionId),
				);
			},
		};
	};

	/** S1: plan and commit one working-set eviction, then re-check pressure (or fit) on the rebuilt request. */
	const runEvictionStage = (input: EvictionStageInput): EvictionStageResult => {
		const { agentRuntime, session, settings, estimate, verdict, beforeSnapshotId, requiredFit } = input;
		const { compactionWindow, compactionThreshold, workingSetTarget, trigger, originSession, pendingUserText } = input;
		const { decision } = input;
		if (!settings.context.workingSet.enabled) {
			decision.stage({ stage: "working_set", outcome: "none", reason: "disabled" });
			return {
				acted: false,
				fit: false,
				skipNotice: renderEvictionSkipLine({
					reason: "disabled",
					turns: 0,
					protectLastTurns: settings.context.workingSet.protectLastTurns,
					protectLastSteps: settings.context.workingSet.protectLastSteps,
					policyId: settings.context.workingSet.policy,
				}),
			};
		}
		let planned: ReturnType<typeof planEviction>;
		let visibleEntries: ReadonlyArray<SessionEntry> = [];
		let policyId = settings.context.workingSet.policy;
		try {
			const entries = deps.readSessionEntries?.() ?? [];
			const view = foldWorkingSet(entries, state.lastTurnId ?? undefined);
			const policy = resolveWorkingSetPolicy(settings.context.workingSet.policy);
			policyId = policy.id;
			visibleEntries = selectVisibleEntries(entries, state.lastTurnId ?? undefined);
			// Results the next request carries as aging stubs: the pressure figure and the anchor hold only
			// the stub, so crediting their ledger bodies would end the plan short of the target (D1-1).
			const aged = new Set(port.agedHistory(agentRuntime, port.observeHistory(agentRuntime))?.saved.map(({ id }) => id));
			const prices = createFoldPriceBook(
				visibleEntries,
				createReplayMessageConverter(entries, {
					...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
				}),
			);
			planned = (deps.planEviction ?? planEviction)(policy, {
				entries: visibleEntries,
				view,
				cwd: session.current()?.cwd ?? null,
				settings: settings.context.workingSet,
				pressure: {
					tokens: port.liveContextEstimate(agentRuntime, pendingUserText).tokens,
					contextWindow: compactionWindow,
					threshold: requiredFit
						? Math.min(
								compactionThreshold,
								Math.max(0, 1 - resolveTurnOutputReserve(agentRuntime, estimate.tokens) / estimate.contextWindow),
							)
						: compactionThreshold,
					target: requiredFit
						? Math.min(
								workingSetTarget,
								Math.max(0, 1 - resolveTurnOutputReserve(agentRuntime, estimate.tokens) / estimate.contextWindow),
							)
						: workingSetTarget,
					...(requiredFit ? { forced: true } : {}),
				},
				estimateTokens: prices.tokens,
				aged,
			});
		} catch (error) {
			decision.stage({ stage: "working_set", outcome: "failed", reason: "error" });
			deps.middleware.fireCompactionHook("working_set_evict", "pressure", estimate.tokens);
			port.emitCompactionActivity("started", "compacting context (working-set eviction)");
			port.emitCompactionActivity("failed", port.compactionFailureMessage(error));
			throw error;
		}
		if (!planned) {
			decision.stage({ stage: "working_set", outcome: "none", reason: "no_candidates" });
			return {
				acted: false,
				fit: false,
				skipNotice: evictionSkipMessage(visibleEntries, settings.context.workingSet, policyId),
			};
		}
		let committed = false;
		deps.middleware.fireCompactionHook("working_set_evict", "pressure", estimate.tokens);
		port.emitCompactionActivity("started", "compacting context (working-set eviction)");
		try {
			const historyTokens = port.reconciledHistoryTokens(agentRuntime);
			const evictionEntry = session.appendEntry({
				...buildEvictionFields(planned, {
					trigger: "pressure",
					pressureBefore: verdict.pressure,
					snapshotIdBefore: beforeSnapshotId,
				}),
				// appendEntry does not infer this anchor; the interactive
				// cursor is the leaf the next message will extend.
				parentTurnId: state.lastTurnId,
			});
			// Read without assuming the append returned its entry, as the commit above does: only the memory notice needs it.
			const recordId = (evictionEntry as SessionEntry | undefined)?.turnId;
			decision.stage({
				stage: "working_set",
				outcome: "committed",
				reason: "evicted",
				...(recordId !== undefined ? { recordId } : {}),
			});
			committed = true;
			if (session.flushAppends) {
				session.flushAppends();
				if (!input.handoff) port.notifyMemoryCommit(evictionEntry.turnId, "summary", "evicted");
			}
			port.resetCacheCallBaseline();
			port.noteColdReason("working_set_evict");
			refreshAgentMessagesFromSession(agentRuntime);
			port.carryReconciledAnchorThroughProjection(agentRuntime, historyTokens, planned.tokensBefore - planned.tokensAfter);

			const postEvictionSnapshot = port.captureRuntimeContextSnapshot(
				agentRuntime,
				state.activeUserTurnId || "compaction",
				compactionThreshold,
			);
			port.setCurrentSnapshot(postEvictionSnapshot);
			port.persistContextSnapshot(postEvictionSnapshot);

			// All event surfaces quote the request anchor less the priced
			// bodies; the live re-check below remains authoritative (#422).
			port.noteCompactionEvent({
				stage: "working_set",
				tokensBefore: planned.tokensBefore,
				tokensAfter: planned.tokensAfter,
				trigger,
			});
			deps.bus?.emit(
				"context.pruned",
				{
					stage: "working_set",
					pressure: verdict.pressure,
					tokensBefore: planned.tokensBefore,
					tokensAfter: planned.tokensAfter,
					trigger,
					snapshotIdBefore: beforeSnapshotId,
					snapshotIdAfter: postEvictionSnapshot.snapshotId,
					policyId: planned.policyId,
					evictedItems: planned.items.length,
					at: Date.now(),
				} satisfies ContextPrunedPayload,
				sessionTelemetryContext(originSession),
			);
			port.recordCompactionFact({ kind: "omitted", unit: "observations", count: planned.items.length });
			const itemsWord = planned.items.length === 1 ? "item" : "items";
			port.emitCompactionActivity("completed", `${planned.items.length} working-set ${itemsWord} evicted`);
			deps.emitNotice(
				`[context engine] working set: ${planned.items.length} ${itemsWord} evicted by ${planned.policyId}; ~${planned.tokensBefore} -> ~${planned.tokensAfter} tokens, recall by ref with context(scope="recall")`,
			);

			// Published only after the carried anchor and the post-eviction
			// capture are both in place: `liveContextEstimate` clears an
			// anchor whose message prefix no longer matches, so pricing the
			// rebuilt list any earlier would discard the attestation the
			// projection carry exists to preserve.
			port.refreshLiveBudget(pendingUserText);
			const after = port.liveContextEstimate(agentRuntime, pendingUserText);
			decision.measure(after.tokens);
			port.recordCompactionTokens({ before: estimate.tokens, after: after.tokens, basis: "runtime-estimate" });
			const fit = requiredFit
				? requestFits(after.tokens, resolveTurnOutputReserve(agentRuntime, after.tokens), after.contextWindow)
				: !input.shouldCompact(after.tokens).shouldCompact;
			return { acted: true, fit, skipNotice: null };
		} catch (error) {
			if (!committed) decision.stage({ stage: "working_set", outcome: "failed", reason: "error" });
			port.emitCompactionActivity("failed", port.compactionFailureMessage(error));
			throw error;
		}
	};

	/** After a summary checkpoint is on the ledger: rebuild, drop the anchor, snapshot, emit `context.pruned`. */
	const publishSummaryCheckpoint = async (
		input: SummaryPublicationInput,
	): Promise<{ tokensBefore: number; tokensAfter: number }> => {
		const { agentRuntime, compactionThreshold, snapshotMetadata, preCompactSnapshot, pendingUserText, trigger } = input;
		port.resetCacheCallBaseline();
		// Durable before the rebuild, so render places what no attempt has carried yet after the checkpoint.
		deps.hostInserts?.reissueUnsent();
		refreshAgentMessagesFromSession(agentRuntime);
		if (port.hasPostureGeneration()) {
			await port.ensureSessionPrompt(agentRuntime);
			port.logPromptCompileIfPending();
		}
		// A summary replaces the conversation the attestation described, so no
		// arithmetic carries it forward; the next call re-anchors it.
		port.dropReconciledAnchor();

		const postCompactSnapshot = port.captureRuntimeContextSnapshot(
			agentRuntime,
			state.activeUserTurnId || "compaction",
			compactionThreshold,
			snapshotMetadata,
		);
		port.setCurrentSnapshot(postCompactSnapshot);
		port.persistContextSnapshot(preCompactSnapshot);
		port.persistContextSnapshot(postCompactSnapshot);

		const tokensBefore = input.footerTokensBefore;
		const tokensAfter = port.liveContextEstimate(agentRuntime, pendingUserText).tokens;
		port.noteCompactionEvent({
			stage: "llm_summary",
			tokensBefore,
			tokensAfter,
			trigger,
		});
		deps.bus?.emit(
			"context.pruned",
			{
				stage: "llm_summary",
				tokensBefore,
				tokensAfter,
				trigger,
				snapshotIdBefore: preCompactSnapshot.snapshotId,
				snapshotIdAfter: postCompactSnapshot.snapshotId,
				at: Date.now(),
			} satisfies ContextPrunedPayload,
			sessionTelemetryContext(input.originSession),
		);
		return { tokensBefore, tokensAfter };
	};

	/** After a step checkpoint is on the ledger: the same publication, with no prompt recompile. */
	const publishStepCheckpoint = (input: StepPublicationInput): { tokensAfter: number } => {
		const { agentRuntime, before, threshold, tokensBefore } = input;
		deps.hostInserts?.reissueUnsent();
		refreshAgentMessagesFromSession(agentRuntime);
		port.dropReconciledAnchor();
		const after = port.captureRuntimeContextSnapshot(agentRuntime, state.activeUserTurnId || "compaction", threshold);
		port.setCurrentSnapshot(after);
		port.persistContextSnapshot(before);
		port.persistContextSnapshot(after);
		const tokensAfter = port.liveContextEstimate(agentRuntime).tokens;
		port.noteCompactionEvent({ stage: "step_checkpoint", tokensBefore, tokensAfter, trigger: "step" });
		deps.bus?.emit(
			"context.pruned",
			{
				stage: "step_checkpoint",
				tokensBefore,
				tokensAfter,
				trigger: "step",
				snapshotIdBefore: before.snapshotId,
				snapshotIdAfter: after.snapshotId,
				at: Date.now(),
			} satisfies ContextPrunedPayload,
			sessionTelemetryContext(input.sessionId),
		);
		return { tokensAfter };
	};

	return {
		beginDecision,
		refreshAgentMessagesFromSession,
		runEvictionStage,
		publishSummaryCheckpoint,
		publishStepCheckpoint,
	};
}
