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
import { evictionPressure } from "../domains/context/fold/pressure.js";
import type { EvictionPlan, PolicyInput } from "../domains/context/working-set/contract.js";
import { buildEvictionFields } from "../domains/context/working-set/engine.js";
import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import { isTurnStart, protectionCutoffIndex } from "../domains/context/working-set/horizon.js";
import { type FoldPlan, planFold, planSelection } from "../domains/context/working-set/plan.js";
import { resolveWorkingSetPolicy } from "../domains/context/working-set/policies/index.js";
import {
	type ClassifyCall,
	LEGACY_AGING_POLICY_ID,
	type SupersededCandidate,
	selectSuperseded,
} from "../domains/context/working-set/superseded.js";
import { selectVisibleEntries } from "../domains/context/working-set/visible.js";
import type { ContextCompactionVerdict } from "../domains/session/compaction/auto.js";
import { createTokenEstimator } from "../domains/session/compaction/tokens.js";
import type { ContextSnapshot } from "../domains/session/context-accounting.js";
import type { SessionContract } from "../domains/session/contract.js";
import type {
	CompactionTrigger,
	EvictionAnchor,
	EvictionRoute,
	EvictionTrigger,
	SessionEntry,
} from "../domains/session/entries.js";
import { activePath } from "../domains/session/tree/active-path.js";
import { replaceEngineMessages } from "../engine/agent.js";
import { renderEvictionSkipLine } from "./compaction-lines.js";
import type { ContinuityReductionHooks } from "./continuity-controller.js";
import {
	buildModelReplayAgentMessagesFromTurns,
	continuityContextFromSession,
	continuityRenderTime,
	renderModelReplay,
} from "./model-session-replay.js";
import { legacyAgingOnPath } from "./observation-aging.js";
import { resolveFitOutputReserve } from "./output-reserve.js";
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
	liveContextEstimate(agentRuntime: AgentRuntime, pendingUserText?: string): LiveContextEstimate;
	/** The overflow path's one count (A4): the live estimate or Pi's chars/3.5 count, whichever is larger. */
	overflowFitTokens(agentRuntime: AgentRuntime, pendingUserText?: string): number;
	/** An overflow fold fit: the next main request pins the same count. */
	armOverflowInputPin(): void;
	/** `commit` seeds a live anchor from a replayed usage when none exists, so the carry has a figure (§4 Commit). */
	reconciledHistoryTokens(agentRuntime: AgentRuntime, commit?: boolean): number | null;
	/** What the carry will leave behind, stored on the eviction record; undefined with no live anchor (§4). */
	evictionAnchor(
		agentRuntime: AgentRuntime,
		historyTokens: number | null,
		tokensRemoved: number,
	): EvictionAnchor | undefined;
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
	/** What the checkpoint did with a v6 session's aging stubs. */
	legacy(outcome: Omit<NonNullable<ContextFoldPayload["legacy"]>, "priorState">): void;
	/**
	 * A committed stage's own figures, as its `context.pruned` states them. Once one is reported, the event's before
	 * is the first committed stage's and its after the latest one's; a later re-measure no longer replaces them.
	 */
	committed(tokens: { tokensBefore: number; tokensAfter: number }): void;
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
	superseded: "observation_aging",
	working_set: "working_set_evict",
	llm_summary: "compaction",
	step_checkpoint: "step_checkpoint",
};

export interface LegacyAdoptionInput {
	agentRuntime: AgentRuntime;
	/** The checkpoint's decision, which this stage reports its outcome to. */
	decision: FoldDecision;
	session: SessionContract;
	settings: Readonly<ClioSettings>;
	compactionThreshold: number;
	/** S0 runs: an uncached route, on a checkpoint that may evict (SPEC §3.4). Adoption releases the stubs otherwise. */
	superseded: boolean;
	estimate: LiveContextEstimate;
	beforeSnapshotId: string | null;
	trigger: CompactionTrigger;
	originSession: string | undefined;
	pendingUserText: string | undefined;
	handoff: ContinuityReductionHooks | undefined;
	/** The loop guard's call identity and read test, for S0. */
	classify: ClassifyCall;
}

export interface EvictionStageInput extends LegacyAdoptionInput {
	/** Overflow on a known window: the stage plans to fit the request, not to the trigger. */
	requiredFit: boolean;
	compactionWindow: number;
	workingSetTarget: number;
	shouldCompact(tokens: number): ContextCompactionVerdict;
	/** S1 runs: the checkpoint is past the trigger, or forced. False runs S0 alone. */
	structural: boolean;
	/** The fraction of the window at which the automatic trigger fires, counting the reserve for `tokens`. */
	triggerFraction(tokens: number): number;
}

export interface EvictionStageResult {
	/** S1 placed items in an eviction record. */
	acted: boolean;
	/** An eviction record was written, by either stage. */
	committed: boolean;
	/** The eviction alone brought the context under the trigger, or fitted the request. */
	fit: boolean;
	/** Why the stage declined, held for the transcript until a summary follows. */
	skipNotice: string | null;
}

export interface CheckpointPublicationInput {
	/** The checkpoint's turn id, which the ledger must already hold. */
	checkpointId: string;
	kind: "summary" | "step";
	agentRuntime: AgentRuntime;
	/** The snapshot captured before the checkpoint was written. */
	before: ContextSnapshot;
	threshold: number | null;
	snapshotMetadata?: Parameters<TurnContext["captureRuntimeContextSnapshot"]>[3];
	tokensBefore: number;
	pendingUserText: string | undefined;
	trigger: CompactionTrigger;
	sessionId: string | undefined;
}

export interface CheckpointPublication {
	checkpointId: string;
	tokensBefore: number;
	tokensAfter: number;
}

/** The ledger holds a compaction checkpoint with this turn id. */
export function ledgerHoldsCheckpoint(entries: ReadonlyArray<SessionEntry>, checkpointId: string): boolean {
	return entries.some((entry) => entry.kind === "compactionSummary" && entry.turnId === checkpointId);
}

export interface ContextFold {
	beginDecision(input: FoldDecisionInput): FoldDecision;
	refreshAgentMessagesFromSession(agentRuntime: AgentRuntime): ReadonlyArray<SessionEntry>;
	runEvictionStage(input: EvictionStageInput): EvictionStageResult;
	/** The first checkpoint of a session whose path holds v6 aging records: adopt or release them, once. */
	adoptLegacyAging(input: LegacyAdoptionInput): boolean;
	/** The one publication for a checkpoint of either kind, keyed on the id the ledger confirmed. */
	publishCheckpoint(input: CheckpointPublicationInput): Promise<CheckpointPublication>;
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
		const messages = buildModelReplayAgentMessagesFromTurns(refreshedEntries, {
			...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
			// The post-compaction rebuild is where an accepted note has to
			// survive: wiring continuity only into /fork would lose it on the
			// very refresh the reduction triggers.
			continuity: continuityContextFromSession(deps.session),
		});
		replaceEngineMessages(agentRuntime.agent, messages);
		state.continuityAtMs = continuityRenderTime(messages) ?? null;
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
		let legacy: ContextFoldPayload["legacy"];
		let tokensBefore: number | null = null;
		let tokensAfter = 0;
		let reported: { tokensBefore: number; tokensAfter: number } | null = null;
		let closed = false;
		const figure = (tokens: number): number => Math.max(0, Math.round(tokens));
		return {
			stage: (entry) => {
				stages.push(entry);
			},
			legacy: (outcome) => {
				legacy = { ...outcome, priorState: "unknown" };
			},
			measure: (tokens) => {
				tokensBefore ??= figure(tokens);
				tokensAfter = figure(tokens);
			},
			committed: (tokens) => {
				reported = {
					tokensBefore: reported?.tokensBefore ?? figure(tokens.tokensBefore),
					tokensAfter: figure(tokens.tokensAfter),
				};
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
						...(reported ?? { tokensBefore: tokensBefore ?? tokensAfter, tokensAfter }),
						...(coldReason !== undefined ? { cause: coldReason } : {}),
						...(legacy !== undefined ? { legacy } : {}),
					} satisfies ContextFoldPayload,
					sessionTelemetryContext(input.sessionId),
				);
			},
		};
	};

	/** The request's superseded results, read over the render `refreshAgentMessagesFromSession` builds. */
	const supersededIn = (
		entries: ReadonlyArray<SessionEntry>,
		view: PolicyInput["view"],
		classify: ClassifyCall,
	): SupersededCandidate[] => {
		const { sourceIds } = renderModelReplay(entries, {
			...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
			continuity: continuityContextFromSession(deps.session),
		});
		return selectSuperseded({ entries, sourceIds, view, classify });
	};

	/** The selection's view of the ledger: what the model sees, priced as the replay converter prices it. */
	const selectionInput = (
		entries: ReadonlyArray<SessionEntry>,
		session: SessionContract,
		settings: Readonly<ClioSettings>,
		pressure: PolicyInput["pressure"],
	): PolicyInput => {
		const leaf = state.lastTurnId ?? undefined;
		const visibleEntries = selectVisibleEntries(entries, leaf);
		const estimator = createTokenEstimator(
			visibleEntries,
			createReplayMessageConverter(entries, { ...(leaf ? { activeLeafTurnId: leaf } : {}) }),
		);
		return {
			entries: visibleEntries,
			view: foldWorkingSet(entries, leaf),
			cwd: session.current()?.cwd ?? null,
			settings: settings.context.workingSet,
			pressure,
			estimateTokens: (entry) => estimator.estimateEntry(entry),
		};
	};

	const evictionRoute = (agentRuntime: AgentRuntime): EvictionRoute | undefined => {
		const { modelTier, promptCaching } = agentRuntime.runtimeResolution;
		return modelTier !== undefined && promptCaching !== undefined ? { tier: modelTier, promptCaching } : undefined;
	};

	interface CommitInput {
		agentRuntime: AgentRuntime;
		decision: FoldDecision;
		session: SessionContract;
		planned: EvictionPlan;
		/** No S1 item: the superseded stage's commit, which has no rail activity and its own cold reason. */
		superseded: boolean;
		stages(recordId: string | undefined): FoldStageEntry[];
		pressureBefore: number | null;
		beforeSnapshotId: string | null;
		compactionThreshold: number;
		trigger: CompactionTrigger;
		originSession: string | undefined;
		pendingUserText: string | undefined;
		handoff: ContinuityReductionHooks | undefined;
		route: EvictionRoute | undefined;
		notice: string;
	}

	/** Append one eviction record and publish it: rebuild, carry the anchor, snapshot, `context.pruned`, budget. */
	const commitEviction = (input: CommitInput): void => {
		const { agentRuntime, decision, session, planned, superseded, trigger, pendingUserText } = input;
		const stage = superseded ? "superseded" : "working_set";
		let committed = false;
		try {
			const historyTokens = port.reconciledHistoryTokens(agentRuntime, true);
			const tokensRemoved = planned.tokensBefore - planned.tokensAfter;
			const anchor = port.evictionAnchor(agentRuntime, historyTokens, tokensRemoved);
			const evictionEntry = session.appendEntry({
				...buildEvictionFields(planned, {
					trigger: superseded ? "superseded" : ("pressure" satisfies EvictionTrigger),
					pressureBefore: input.pressureBefore,
					snapshotIdBefore: input.beforeSnapshotId,
				}),
				...(input.route !== undefined ? { route: input.route } : {}),
				...(anchor !== undefined ? { anchor } : {}),
				// appendEntry does not infer this anchor; the interactive
				// cursor is the leaf the next message will extend.
				parentTurnId: state.lastTurnId,
			});
			// Read without assuming the append returned its entry, as the commit above does: only the memory notice needs it.
			const recordId = (evictionEntry as SessionEntry | undefined)?.turnId;
			for (const entry of input.stages(recordId)) decision.stage(entry);
			committed = true;
			if (session.flushAppends) {
				session.flushAppends();
				if (!input.handoff) port.notifyMemoryCommit(evictionEntry.turnId, "summary", "evicted");
			}
			port.resetCacheCallBaseline();
			port.noteColdReason(superseded ? "observation_aging" : "working_set_evict");
			refreshAgentMessagesFromSession(agentRuntime);
			port.carryReconciledAnchorThroughProjection(agentRuntime, historyTokens, tokensRemoved);

			const postEvictionSnapshot = port.captureRuntimeContextSnapshot(
				agentRuntime,
				state.activeUserTurnId || "compaction",
				input.compactionThreshold,
			);
			port.setCurrentSnapshot(postEvictionSnapshot);
			port.persistContextSnapshot(postEvictionSnapshot);

			// All event surfaces quote the request anchor less the priced
			// bodies; the live re-check below remains authoritative (#422).
			port.noteCompactionEvent({ stage, tokensBefore: planned.tokensBefore, tokensAfter: planned.tokensAfter, trigger });
			deps.bus?.emit(
				"context.pruned",
				{
					stage,
					pressure: input.pressureBefore,
					tokensBefore: planned.tokensBefore,
					tokensAfter: planned.tokensAfter,
					trigger,
					snapshotIdBefore: input.beforeSnapshotId,
					snapshotIdAfter: postEvictionSnapshot.snapshotId,
					policyId: planned.policyId,
					evictedItems: planned.items.length,
					at: Date.now(),
				} satisfies ContextPrunedPayload,
				sessionTelemetryContext(input.originSession),
			);
			if (!superseded) {
				port.recordCompactionFact({ kind: "omitted", unit: "observations", count: planned.items.length });
				const itemsWord = planned.items.length === 1 ? "item" : "items";
				port.emitCompactionActivity("completed", `${planned.items.length} working-set ${itemsWord} evicted`);
			}
			deps.emitNotice(input.notice);

			// Published only after the carried anchor and the post-eviction
			// capture are both in place: `liveContextEstimate` clears an
			// anchor whose message prefix no longer matches, so pricing the
			// rebuilt list any earlier would discard the attestation the
			// projection carry exists to preserve.
			port.refreshLiveBudget(pendingUserText);
			// The event and the card state the record's own figures, as `context.pruned` does. The live re-estimate the
			// fit check reads can sit on another basis: after a resume no live anchor carries through the rebuild, and
			// the replayed usage this eviction invalidated leaves only the structural estimate (bt-47 D1).
			decision.committed({ tokensBefore: planned.tokensBefore, tokensAfter: planned.tokensAfter });
			if (!superseded) {
				port.recordCompactionTokens({
					before: planned.tokensBefore,
					after: planned.tokensAfter,
					basis: "runtime-estimate",
				});
			}
		} catch (error) {
			if (!committed) decision.stage({ stage, outcome: "failed", reason: "error" });
			if (!superseded) port.emitCompactionActivity("failed", port.compactionFailureMessage(error));
			throw error;
		}
	};

	const supersededNotice = (planned: EvictionPlan, lead: string): string =>
		`[context engine] superseded: ${lead}; ~${planned.tokensBefore} -> ~${planned.tokensAfter} tokens, recall by ref with context(scope="recall")`;

	/**
	 * S0 and S1 as one record (SPEC §2.4), then a re-check of pressure (or fit) on the rebuilt request. S0 alone
	 * commits below the trigger once its floor is met; S1 runs only when the checkpoint reached it.
	 */
	const runEvictionStage = (input: EvictionStageInput): EvictionStageResult => {
		const { agentRuntime, session, settings, estimate, beforeSnapshotId, requiredFit } = input;
		const { compactionWindow, compactionThreshold, workingSetTarget, trigger, originSession, pendingUserText } = input;
		const { decision } = input;
		const workingSet = settings.context.workingSet;
		const structural = input.structural && workingSet.enabled;
		let skipNotice: string | null = null;
		if (input.structural && !workingSet.enabled) {
			decision.stage({ stage: "working_set", outcome: "none", reason: "disabled" });
			skipNotice = renderEvictionSkipLine({
				reason: "disabled",
				turns: 0,
				protectLastTurns: workingSet.protectLastTurns,
				protectLastSteps: workingSet.protectLastSteps,
				policyId: workingSet.policy,
			});
		}
		if (!structural && !input.superseded) return { acted: false, committed: false, fit: false, skipNotice };
		// An overflow fold must leave Pi's clamp the output floor too, so it plans and fits on the A4 count (cf-q15).
		const fitTokens = (): number =>
			requiredFit
				? port.overflowFitTokens(agentRuntime, pendingUserText)
				: port.liveContextEstimate(agentRuntime, pendingUserText).tokens;
		let folded: FoldPlan;
		let visibleEntries: ReadonlyArray<SessionEntry> = [];
		let policyId = workingSet.policy;
		try {
			const entries = deps.readSessionEntries?.() ?? [];
			const policy = structural ? resolveWorkingSetPolicy(workingSet.policy) : null;
			if (policy !== null) policyId = policy.id;
			const tokens = fitTokens();
			const fitShare = () =>
				Math.max(0, 1 - resolveFitOutputReserve(agentRuntime, Math.max(tokens, estimate.tokens)) / estimate.contextWindow);
			// S1's figures (ContextFold A3); S0's selection reads neither, so its floor and gate are unchanged.
			const pressure = evictionPressure({
				automatic: trigger === "auto" && !requiredFit,
				window: agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow,
				threshold: compactionThreshold,
				target: workingSetTarget,
				triggerFraction: () => input.triggerFraction(estimate.tokens),
				prefixTokens: estimate.breakdown.systemPromptTokens + estimate.breakdown.toolSchemaTokens,
			});
			const policyInput = selectionInput(entries, session, settings, {
				tokens,
				contextWindow: compactionWindow,
				threshold: requiredFit ? Math.min(compactionThreshold, fitShare()) : pressure.threshold,
				target: requiredFit ? Math.min(workingSetTarget, fitShare()) : pressure.target,
				...(requiredFit ? { forced: true } : {}),
			});
			visibleEntries = policyInput.entries;
			folded = planFold({
				policy,
				superseded: input.superseded ? supersededIn(entries, policyInput.view, input.classify) : [],
				input: policyInput,
				...(deps.planEviction !== undefined ? { planner: deps.planEviction } : {}),
			});
		} catch (error) {
			if (!structural) {
				// S0 alone is never what lets a request through, so a failed selection costs only its gain.
				decision.stage({ stage: "superseded", outcome: "failed", reason: "error" });
				return { acted: false, committed: false, fit: false, skipNotice };
			}
			decision.stage({ stage: "working_set", outcome: "failed", reason: "error" });
			deps.middleware.fireCompactionHook("working_set_evict", "pressure", estimate.tokens);
			port.emitCompactionActivity("started", "compacting context (working-set eviction)");
			port.emitCompactionActivity("failed", port.compactionFailureMessage(error));
			throw error;
		}
		const { plan: planned, superseded } = folded;
		if (superseded.outcome === "held") decision.stage({ stage: "superseded", outcome: "held", reason: "below_floor" });
		if (superseded.outcome === "dropped") decision.stage({ stage: "superseded", outcome: "none", reason: "no_gain" });
		const structuralSkip = () => evictionSkipMessage(visibleEntries, workingSet, policyId);
		if (!planned) {
			if (!structural) return { acted: false, committed: false, fit: false, skipNotice };
			decision.stage({ stage: "working_set", outcome: "none", reason: "no_candidates" });
			return { acted: false, committed: false, fit: false, skipNotice: structuralSkip() };
		}
		const alone = !folded.structural;
		if (alone) deps.middleware.fireCompactionHook("superseded", "superseded", estimate.tokens);
		else {
			deps.middleware.fireCompactionHook("working_set_evict", "pressure", estimate.tokens);
			port.emitCompactionActivity("started", "compacting context (working-set eviction)");
		}
		const s0Items = superseded.outcome === "planned" ? superseded.items : 0;
		const itemsWord = planned.items.length === 1 ? "item" : "items";
		commitEviction({
			agentRuntime,
			decision,
			session,
			planned,
			superseded: alone,
			stages: (recordId) => {
				const ref = recordId !== undefined ? { recordId } : {};
				const entries: FoldStageEntry[] = [];
				if (s0Items > 0) entries.push({ stage: "superseded", outcome: "committed", reason: "evicted", ...ref });
				if (folded.structural) entries.push({ stage: "working_set", outcome: "committed", reason: "evicted", ...ref });
				else if (structural) entries.push({ stage: "working_set", outcome: "none", reason: "no_candidates" });
				return entries;
			},
			pressureBefore: input.shouldCompact(estimate.tokens).pressure,
			beforeSnapshotId,
			compactionThreshold,
			trigger,
			originSession,
			pendingUserText,
			handoff: input.handoff,
			route: s0Items > 0 ? evictionRoute(agentRuntime) : undefined,
			notice: alone
				? supersededNotice(
						planned,
						`${s0Items} ${s0Items === 1 ? "result" : "results"} a later identical call covers evicted`,
					)
				: `[context engine] working set: ${planned.items.length} ${itemsWord} evicted by ${planned.policyId}; ~${planned.tokensBefore} -> ~${planned.tokensAfter} tokens, recall by ref with context(scope="recall")`,
		});
		const after = port.liveContextEstimate(agentRuntime, pendingUserText);
		let fit: boolean;
		if (requiredFit) {
			const fitAfter = fitTokens();
			fit = requestFits(fitAfter, resolveFitOutputReserve(agentRuntime, fitAfter), after.contextWindow);
			if (fit) port.armOverflowInputPin();
		} else fit = !input.shouldCompact(after.tokens).shouldCompact;
		return { acted: !alone, committed: true, fit, skipNotice: alone && structural ? structuralSkip() : skipNotice };
	};

	const adoptLegacyAging = (input: LegacyAdoptionInput): boolean => {
		const { agentRuntime, decision, session } = input;
		const entries = deps.readSessionEntries?.() ?? [];
		const path = activePath(entries, state.lastTurnId ?? undefined);
		const found = legacyAgingOnPath(path, []);
		if (found.kind === "none") return false;
		if (!input.superseded) {
			// A cached route never had these results stubbed and S0 does not run on it: nothing to adopt.
			decision.stage({ stage: "superseded", outcome: "none", reason: "disabled" });
			decision.legacy({ outcome: "legacy_aging_released", results: found.results });
			return false;
		}
		const settings = input.settings;
		const policyInput = selectionInput(entries, session, settings, {
			tokens: port.liveContextEstimate(agentRuntime, input.pendingUserText).tokens,
			contextWindow: input.estimate.contextWindow,
			threshold: 1,
			target: 1,
		});
		const legacy = legacyAgingOnPath(path, supersededIn(entries, policyInput.view, input.classify));
		const planned =
			legacy.kind === "found" && legacy.adopt.length > 0
				? planSelection(LEGACY_AGING_POLICY_ID, legacy.adopt, policyInput)
				: null;
		if (planned === null) {
			decision.stage({ stage: "superseded", outcome: "none", reason: "no_candidates" });
			decision.legacy({ outcome: "adopted", results: 0 });
			return false;
		}
		deps.middleware.fireCompactionHook("superseded", "superseded", input.estimate.tokens);
		const results = planned.items.length;
		commitEviction({
			agentRuntime,
			decision,
			session,
			planned,
			superseded: true,
			stages: (recordId) => [
				{ stage: "superseded", outcome: "committed", reason: "adopted", ...(recordId !== undefined ? { recordId } : {}) },
			],
			pressureBefore: null,
			beforeSnapshotId: input.beforeSnapshotId,
			compactionThreshold: input.compactionThreshold,
			trigger: input.trigger,
			originSession: input.originSession,
			pendingUserText: input.pendingUserText,
			handoff: input.handoff,
			route: evictionRoute(agentRuntime),
			notice: supersededNotice(
				planned,
				`${results} ${results === 1 ? "result" : "results"} this session's earlier requests stubbed kept as eviction markers`,
			),
		});
		const earliest = planned.items[0]?.ref.entry;
		decision.legacy({ outcome: "adopted", results, ...(earliest !== undefined ? { earliest } : {}) });
		return true;
	};

	/**
	 * After a checkpoint is on the ledger, for either kind: confirm the ledger holds
	 * `checkpointId`, rebuild, drop the anchor, snapshot, emit `context.pruned` once.
	 * A summary also restarts the cache baseline and recompiles a posture prompt;
	 * a step checkpoint does neither.
	 */
	const publishCheckpoint = async (input: CheckpointPublicationInput): Promise<CheckpointPublication> => {
		const { agentRuntime, kind, before, threshold, pendingUserText, tokensBefore, trigger } = input;
		if (!ledgerHoldsCheckpoint(deps.readSessionEntries?.() ?? [], input.checkpointId))
			throw new Error(`checkpoint ${input.checkpointId} is not on the session ledger; nothing was published`);
		if (kind === "summary") port.resetCacheCallBaseline();
		// Durable before the rebuild, so render places what no attempt has carried yet after the checkpoint.
		deps.hostInserts?.reissueUnsent();
		refreshAgentMessagesFromSession(agentRuntime);
		if (kind === "summary" && port.hasPostureGeneration()) {
			await port.ensureSessionPrompt(agentRuntime);
			port.logPromptCompileIfPending();
		}
		// A checkpoint replaces the conversation the attestation described, so no
		// arithmetic carries it forward; the next call re-anchors it.
		port.dropReconciledAnchor();

		const after = port.captureRuntimeContextSnapshot(
			agentRuntime,
			state.activeUserTurnId || "compaction",
			threshold,
			input.snapshotMetadata,
		);
		port.setCurrentSnapshot(after);
		port.persistContextSnapshot(before);
		port.persistContextSnapshot(after);

		const tokensAfter = port.liveContextEstimate(agentRuntime, pendingUserText).tokens;
		const stage = kind === "summary" ? "llm_summary" : "step_checkpoint";
		port.noteCompactionEvent({ stage, tokensBefore, tokensAfter, trigger });
		deps.bus?.emit(
			"context.pruned",
			{
				stage,
				tokensBefore,
				tokensAfter,
				trigger,
				snapshotIdBefore: before.snapshotId,
				snapshotIdAfter: after.snapshotId,
				at: Date.now(),
			} satisfies ContextPrunedPayload,
			sessionTelemetryContext(input.sessionId),
		);
		return { checkpointId: input.checkpointId, tokensBefore, tokensAfter };
	};

	return {
		beginDecision,
		refreshAgentMessagesFromSession,
		runEvictionStage,
		adoptLegacyAging,
		publishCheckpoint,
	};
}
