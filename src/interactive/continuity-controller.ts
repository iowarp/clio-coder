/** Live ownership and execution around the session domain's durable protocol. */
import { randomUUID } from "node:crypto";
import {
	type AcceptedNote,
	type ContinuityAppendable,
	type ContinuityCheckpointPayload,
	type ContinuityFoldResult,
	type ContinuityPersistencePorts,
	HANDOFF_MAX_WINDOW_MS,
	HANDOFF_POLICY_LIMITS,
	type HandoffEvent,
	type HandoffIdentity,
	type HandoffPolicy,
	type HandoffTransactionEntry,
} from "../domains/session/continuity/contract.js";
import { resolveContinuityEvidence } from "../domains/session/continuity/evidence.js";
import { validateContinuityNote } from "../domains/session/continuity/note.js";
import {
	HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE,
	type HandoffRecoveryRequestEntry,
} from "../domains/session/continuity/operator-request.js";
import { persistContinuityGroup } from "../domains/session/continuity/persistence.js";
import { resolveContinuityProjection } from "../domains/session/continuity/projection.js";
import type { SessionEntry } from "../domains/session/entries.js";

export interface ContinuityReductionHooks {
	beforeSummaryCall(): void;
	/** Called before the summary append; the resulting carry reserves the exact commit. */
	checkpointForSummary(summaryRef: string, tokensBefore: number, tokensAfter: number): ContinuityCheckpointPayload;
}

export interface ContinuityOrigin {
	sessionId: string;
	leafTurnId: string;
	initiatingTurnId: string;
	sourceRevision: string;
	ports: ContinuityPersistencePorts;
}

export interface ContinuityControllerDeps {
	/** Captures navigation/runtime ownership by value. Never follows a changed session. */
	captureOrigin(): ContinuityOrigin;
	entries(): ReadonlyArray<SessionEntry>;
	leaf(): string | null;
	admitNote(note: AcceptedNote): boolean;
	fits(): boolean;
	inputTokens(): number;
	reduce(hooks: ContinuityReductionHooks, signal: AbortSignal): Promise<void>;
	installReplay(): void;
	onCommit?(commitId: string, outcome: "summarized" | "evicted" | "continuity_only"): void;
	notice(text: string): void;
	now?: () => number;
	id?: () => string;
}

interface LiveHandoff {
	origin: ContinuityOrigin;
	identity: HandoffIdentity;
	accepted: AcceptedNote;
	policy: HandoffPolicy;
	deadline: number;
	abort: AbortController;
	deliveryId?: string;
	uncertain: boolean;
	deadlineTimer?: ReturnType<typeof setTimeout>;
}

export class ContinuityController {
	private live: LiveHandoff | null = null;
	private busy = false;
	private readonly now: () => number;
	private readonly id: () => string;

	constructor(private readonly deps: ContinuityControllerDeps) {
		this.now = deps.now ?? Date.now;
		this.id = deps.id ?? randomUUID;
	}

	private armDeadline(live: LiveHandoff): void {
		live.deadlineTimer = setTimeout(
			() => live.abort.abort(new Error("Handoff automatic deadline expired.")),
			Math.max(1, live.deadline - this.now()),
		);
		live.deadlineTimer.unref?.();
	}

	private fold(live = this.live): ContinuityFoldResult | null {
		if (!live?.origin.ports.isOriginCurrent() || live.origin.ports.isStateRemoved()) return null;
		return resolveContinuityProjection({
			entries: this.deps.entries(),
			sessionId: live.origin.sessionId,
			nowMs: this.now(),
		}).current;
	}

	private check(live: LiveHandoff): void {
		live.abort.signal.throwIfAborted();
		if (this.live !== live || !live.origin.ports.isOriginCurrent()) throw new Error("Handoff ownership changed.");
		if (live.uncertain) throw new Error("Handoff persistence is unresolved; inspect before recovery.");
		if (this.now() >= live.deadline) throw new Error("Handoff automatic deadline expired.");
	}

	private async persist(
		live: LiveHandoff,
		entries: ReadonlyArray<ContinuityAppendable | SessionEntry>,
		checkpoint = false,
		closing = false,
	): Promise<void> {
		const result = await persistContinuityGroup(
			{
				entries: entries.map((entry) => ({ ...entry })),
				barrier: checkpoint ? { kind: "checkpoint", reason: "context-handoff" } : { kind: "flush" },
			},
			live.origin.ports,
			{
				limit: live.policy.flushRetryLimit,
				deadlineAtMs: closing ? this.now() + 5000 : live.deadline,
				now: this.now,
				wait: async () => {},
			},
		);
		if (result.status !== "durable" || !result.confirmedWithinDeadline) {
			live.uncertain = true;
			throw new Error(
				`Handoff durability unresolved: ${result.status === "durable" ? "deadline expired" : result.reason}`,
			);
		}
	}

	private async transition(live: LiveHandoff, event: HandoffEvent, closing = false): Promise<void> {
		const fold = this.fold(live);
		if (!fold?.validated || fold.identity?.handoffId !== live.identity.handoffId || !fold.state)
			throw new Error("Handoff head cannot be validated.");
		const entryId = this.id();
		const entry: HandoffTransactionEntry = {
			kind: "handoffTransaction",
			schemaVersion: 1,
			turnId: entryId,
			parentTurnId: live.identity.branchAnchorTurnId,
			timestamp: new Date(this.now()).toISOString(),
			identity: live.identity,
			transition: {
				entryId,
				prevEntryId: fold.state.transition.entryId,
				sequence: fold.state.transition.sequence + 1,
				attempt: fold.attemptsSpent + (event.phase === "reducing" ? 1 : 0),
			},
			event,
		};
		await this.persist(live, [entry], false, closing);
		if (!this.fold(live)?.validated) throw new Error("Persisted handoff transition failed validation.");
	}

	async request(note: unknown, toolCallId: string, signal?: AbortSignal): Promise<string> {
		const validation = validateContinuityNote(note);
		if (!validation.ok) throw new Error(`Invalid handoff note: ${validation.reason}`);
		if (!toolCallId || this.busy || this.live)
			throw new Error("A context handoff is already pending or no tool identity was supplied.");
		signal?.throwIfAborted();
		const origin = this.deps.captureOrigin();
		if (origin.ports.isStateRemoved() || !origin.ports.isOriginCurrent())
			throw new Error("The originating session is unavailable.");
		if (!this.deps.admitNote(validation.accepted))
			throw new Error("Exact handoff note and protected context exceed the replay budget.");
		const prior = resolveContinuityProjection({
			entries: this.deps.entries(),
			sessionId: origin.sessionId,
			nowMs: this.now(),
		}).current;
		if (prior && prior.phase !== "absent" && prior.phase !== "acknowledged")
			throw new Error("An earlier handoff requires operator recovery.");
		const preparedAtMs = this.now();
		const policy = {
			...HANDOFF_POLICY_LIMITS,
			preparedAtMs,
			automaticDeadlineAtMs: preparedAtMs + HANDOFF_MAX_WINDOW_MS,
		};
		const identity: HandoffIdentity = {
			handoffId: this.id(),
			preparedEntryId: this.id(),
			commitId: this.id(),
			commitEntryId: this.id(),
			originSessionId: origin.sessionId,
			branchAnchorTurnId: origin.leafTurnId,
			initiatingTurnId: origin.initiatingTurnId,
			toolCallId,
			sourceRevision: origin.sourceRevision,
		};
		const live: LiveHandoff = {
			origin,
			identity,
			accepted: validation.accepted,
			policy,
			deadline: policy.automaticDeadlineAtMs,
			abort: new AbortController(),
			uncertain: false,
		};
		this.live = live;
		this.armDeadline(live);
		const entry: HandoffTransactionEntry = {
			kind: "handoffTransaction",
			schemaVersion: 1,
			turnId: identity.preparedEntryId,
			parentTurnId: identity.branchAnchorTurnId,
			timestamp: new Date(preparedAtMs).toISOString(),
			identity,
			transition: { entryId: identity.preparedEntryId, prevEntryId: null, sequence: 0, attempt: 0 },
			event: { phase: "prepared", accepted: live.accepted, policy },
		};
		try {
			await this.persist(live, [entry]);
			signal?.throwIfAborted();
			this.check(live);
			return `Context handoff ${identity.handoffId} prepared. The exact note is saved. Reduction and continuation follow after this tool receipt is persisted.`;
		} catch (error) {
			await this.pause();
			throw error;
		}
	}

	private readyPayload(
		live: LiveHandoff,
		outcome: "summarized" | "evicted" | "continuity_only",
		before: number,
		after: number,
		ref?: string,
	): ContinuityCheckpointPayload {
		this.check(live);
		const fold = this.fold(live);
		if (!fold?.validated || fold.phase !== "reducing" || !fold.state)
			throw new Error("No durable reduction attempt owns this checkpoint.");
		const transition = {
			entryId: live.identity.commitEntryId,
			prevEntryId: fold.state.transition.entryId,
			sequence: fold.state.transition.sequence + 1,
			attempt: fold.attemptsSpent,
		};
		return {
			schemaVersion: 1,
			identity: live.identity,
			accepted: live.accepted,
			policy: live.policy,
			commit: {
				outcome,
				entry: {
					turnId: live.identity.commitEntryId,
					parentTurnId: live.identity.branchAnchorTurnId,
					timestamp: new Date(this.now()).toISOString(),
				},
				transition,
				tokensBefore: before,
				tokensAfter: after,
				...(outcome === "summarized" ? { summaryRef: ref ?? "" } : outcome === "evicted" ? { evictionRef: ref ?? "" } : {}),
			},
			state: { transition, event: { phase: "ready" }, activeResume: fold.state.activeResume, delivery: null },
		};
	}

	/** Called only at the settled engine boundary, after awaited result persistence. */
	async settle(signal?: AbortSignal, recovery = false): Promise<boolean> {
		const live = this.live;
		if (!live || this.busy || live.deliveryId) return false;
		this.busy = true;
		const onAbort = () => live.abort.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (signal?.aborted) onAbort();
			this.check(live);
			const fold = this.fold(live);
			if (!fold?.validated) throw new Error("Handoff evidence is unresolved.");
			if (!recovery) {
				const receipt = this.deps
					.entries()
					.some(
						(entry) =>
							entry.kind === "message" &&
							entry.role === "tool_result" &&
							(entry.payload as { toolCallId?: string; isError?: boolean }).toolCallId === live.identity.toolCallId &&
							(entry.payload as { isError?: boolean }).isError === false,
					);
				if (!receipt) throw new Error("Matching successful handoff receipt has not been persisted.");
			}
			await this.persist(live, []);
			this.check(live);
			if (!fold.commit) {
				if (fold.attemptsSpent >= live.policy.maxAttempts) throw new Error("Handoff reduction attempts exhausted.");
				const resumeRef = fold.state?.activeResume?.entryId;
				await this.transition(live, { phase: "reducing", ...(resumeRef ? { resumeRef } : {}) });
				const before = this.deps.inputTokens();
				const priorIds = new Set(this.deps.entries().map((entry) => entry.turnId));
				let payload: ContinuityCheckpointPayload | undefined;
				let calls = 0;
				await this.deps.reduce(
					{
						beforeSummaryCall: () => {
							this.check(live);
							if (++calls > live.policy.maxSummaryCallsPerAttempt)
								throw new Error("Handoff summary invocation limit reached.");
						},
						checkpointForSummary: (ref, tokensBefore, tokensAfter) => {
							payload = this.readyPayload(live, "summarized", tokensBefore, tokensAfter, ref);
							return payload;
						},
					},
					live.abort.signal,
				);
				this.check(live);
				if (!payload) {
					this.deps.installReplay();
					if (!this.deps.fits()) throw new Error("Context remains unsafe after reduction; the exact note is retained.");
					const eviction = [...this.deps.entries()]
						.reverse()
						.find((entry) => entry.kind === "contextEviction" && !priorIds.has(entry.turnId));
					payload = this.readyPayload(
						live,
						eviction ? "evicted" : "continuity_only",
						before,
						this.deps.inputTokens(),
						eviction?.turnId,
					);
				}
				await this.persist(
					live,
					[
						{
							kind: "continuityCommit",
							...payload.commit.entry,
							continuity: { ...payload, state: { ...payload.state, activeResume: null } },
						},
					],
					true,
				);
				this.check(live);
				if (!this.fold(live)?.validated) throw new Error("Handoff checkpoint cannot be validated.");
				this.deps.onCommit?.(live.identity.commitId, payload.commit.outcome);
			}
			this.deps.installReplay();
			if (!this.deps.fits()) throw new Error("Compacted continuation exceeds the request budget.");
			this.check(live);
			const continuationTurnId = this.deps.leaf();
			if (!continuationTurnId) throw new Error("Continuation has no persisted message anchor.");
			const deliveryId = this.id();
			const deliveryFold = this.fold(live);
			const resumeRef = deliveryFold?.phase === "resumed" ? deliveryFold.state?.activeResume?.entryId : undefined;
			await this.transition(live, {
				phase: "delivered",
				deliveryId,
				continuationTurnId,
				...(resumeRef ? { resumeRef } : {}),
			});
			this.check(live);
			live.deliveryId = deliveryId;
			return true;
		} catch (error) {
			await this.pause();
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.busy = false;
		}
	}

	/** Synchronous final provider boundary, including steering drained after prepare. */
	admission(): { block: false; correlationId?: string } | { block: true; reason: string } {
		const live = this.live;
		if (!live) return { block: false };
		try {
			this.check(live);
			if (!live.deliveryId) throw new Error("Context handoff has not durably reached delivery.");
			return { block: false, correlationId: live.deliveryId };
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	async response(entryId: string | undefined, correlationId: string | undefined): Promise<void> {
		const live = this.live;
		if (
			!live ||
			!entryId ||
			!correlationId ||
			correlationId !== live.deliveryId ||
			live.abort.signal.aborted ||
			!live.origin.ports.isOriginCurrent()
		)
			return;
		this.check(live);
		const evidence = resolveContinuityEvidence({
			entries: this.deps.entries(),
			unreadableRecords: 0,
		}).terminalResponses.find((row) => row.entryId === entryId);
		if (evidence?.status !== "success") return;
		await this.transition(live, { phase: "acknowledged", deliveryId: correlationId, terminalResponseEntryId: entryId });
		if (live.deadlineTimer) clearTimeout(live.deadlineTimer);
		this.live = null;
	}

	cancel(): void {
		this.live?.abort.abort(new Error("Operator cancelled the context handoff."));
	}

	async pause(): Promise<void> {
		const live = this.live;
		if (!live) return;
		live.abort.abort();
		if (live.deadlineTimer) clearTimeout(live.deadlineTimer);
		try {
			const fold = this.fold(live);
			if (
				!live.uncertain &&
				fold?.validated &&
				["prepared", "reducing", "ready", "delivered", "resumed"].includes(fold.phase)
			) {
				await this.transition(
					live,
					{ phase: "paused", reason: live.deliveryId ? "delivery_uncertain" : "operator_cancelled" },
					true,
				);
			}
		} catch (error) {
			this.deps.notice(`Handoff ${live.identity.handoffId}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (this.live === live) this.live = null;
		}
	}

	/** Host-only operator action; never reachable through tool arguments. */
	async recover(handoffId: string, action: "reduce" | "deliver"): Promise<void> {
		if (this.live || this.busy) throw new Error("A handoff is already active.");
		const origin = this.deps.captureOrigin();
		let fold = resolveContinuityProjection({
			entries: this.deps.entries(),
			sessionId: origin.sessionId,
			nowMs: this.now(),
		}).current;
		if (!fold?.validated || fold.identity?.handoffId !== handoffId || !fold.accepted || !fold.policy || !fold.state)
			throw new Error("No validated handoff matches that identity on this branch.");
		if (["prepared", "reducing", "ready", "delivered", "resumed"].includes(fold.phase)) {
			// A restarted process has no live delivery lease. Record that fact
			// before accepting this explicit operator request; never auto-redeliver.
			this.live = {
				origin,
				identity: fold.identity,
				accepted: fold.accepted,
				policy: fold.policy,
				deadline: this.now() + HANDOFF_MAX_WINDOW_MS,
				abort: new AbortController(),
				uncertain: false,
			};
			if (fold.missingCommit) {
				const expected = { ...fold.missingCommit.entry };
				const readback = origin.ports.readExact(expected);
				if (readback.status !== "absent" && readback.status !== "matching") {
					this.live = null;
					throw new Error("Commit reconstruction is unresolved.");
				}
				await this.persist(this.live, readback.status === "absent" ? [expected] : [], true);
			}
			await this.pause();
			fold = resolveContinuityProjection({
				entries: this.deps.entries(),
				sessionId: origin.sessionId,
				nowMs: this.now(),
			}).current;
			if (!fold?.validated || !fold.identity || !fold.accepted || !fold.policy || !fold.state)
				throw new Error("Interrupted handoff could not be paused durably.");
		}
		if (!["paused", "failed"].includes(fold.phase))
			throw new Error("Only a paused or failed handoff accepts operator recovery.");
		if (
			action === "reduce" ? fold.commit !== null || fold.attemptsSpent >= fold.policy.maxAttempts : fold.commit === null
		)
			throw new Error("That recovery action is unavailable for this handoff.");
		const now = this.now();
		const live: LiveHandoff = {
			origin,
			identity: fold.identity,
			accepted: fold.accepted,
			policy: fold.policy,
			deadline: now + HANDOFF_MAX_WINDOW_MS,
			abort: new AbortController(),
			uncertain: false,
		};
		this.live = live;
		this.armDeadline(live);
		const request: HandoffRecoveryRequestEntry = {
			kind: "custom",
			customType: HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE,
			turnId: this.id(),
			parentTurnId: origin.leafTurnId,
			timestamp: new Date(now).toISOString(),
			display: false,
			data: {
				version: 1,
				requestKind: "handoff_recovery",
				handoffId,
				action,
				sessionId: origin.sessionId,
				branchAnchorTurnId: fold.identity.branchAnchorTurnId,
				selectedLeafTurnId: origin.leafTurnId,
				pausedOrFailedEntryId: fold.state.transition.entryId,
			},
		};
		try {
			await this.persist(live, [request]);
			await this.transition(live, {
				phase: "resumed",
				authority: {
					operatorRequestEntryId: request.turnId,
					pausedOrFailedEntryId: fold.state.transition.entryId,
					action,
					automaticDeadlineAtMs: live.deadline,
				},
			});
			await this.settle(undefined, true);
		} catch (error) {
			await this.pause();
			throw error;
		}
	}
}
