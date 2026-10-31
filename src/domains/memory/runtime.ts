import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { MemoryCommitScope } from "./commit-state.js";
import type { RetentionStatus } from "./completion-retention.js";
import { EMPTY_RETENTION, readRetention, retainCompletedTask, retentionPath } from "./completion-retention.js";
import type {
	MemoryConsumptionReceipt,
	MemoryContract,
	MemoryObservationCommands,
	MemoryOfferInput,
	MemoryOfferUse,
	MemoryPromptSelection,
	ObservationSource,
	ObservationSourceUnit,
	ObservationStatus,
	SessionObservation,
} from "./contract.js";
import type { MemoryGuardian, MemoryGuardianDeps } from "./guardian.js";
import { createMemoryGuardian } from "./guardian.js";
import { type CompletedLessonSource, recordReviewedHistoryCalls } from "./history-review.js";
import type {
	MemoryInterventionDeps,
	MemoryInterventionRegistration,
	MemoryStepLaunchOutcome,
} from "./intervention.js";
import { createMemoryInterventionRegistration } from "./intervention.js";
import { type HistoryFiling, type HistoryLessons, MemoryLessonFeedback } from "./lesson-feedback.js";
import type { MemoryLessonJudge } from "./lesson-judge.js";
import { createKeptLessonSource, type KeptLesson } from "./lesson-projection.js";
import type { MemoryObservationEvent } from "./observation-events.js";
import { observationEvent, observationTracing, traceObservation } from "./observation-events.js";
import {
	loadObservations,
	persistObservation,
	pruneConsumedObservations,
	retireObservations,
} from "./observation-store.js";
import {
	buildObservationOffer,
	compatibleObservation,
	OBSERVATION_MAX_BATCHES,
	OBSERVATION_PROMPT,
	observationBudgets,
	observationDigest,
	observationTokens,
	prepareObservation,
	reflectionRequest,
	sourceCoverageDigest,
} from "./observations.js";
import { memorySectionBlocks } from "./prompt-section.js";
import { TaskMemoryBank } from "./task-bank.js";
import type { TaskMemoryModelClient, TaskMemoryStepUsage } from "./task-memory-policy.js";
import {
	TaskMemoryBudgetSkipError,
	TaskMemoryEndpointBusyError,
	TaskMemoryEndpointPreemptedError,
} from "./task-memory-policy.js";

export interface MemoryRuntimeInfrastructure {
	stateDir(): string;
	dataDir?(): string;
	cwd?(): string;
	lessonSource?(): CompletedLessonSource | null;
	/**
	 * The completed task a closed session of this workspace ended on, rebuilt
	 * from its own ledger, or null for another workspace's or an unreadable one.
	 * Session owns the reading.
	 */
	closedLessonSource?(sessionId: string): { scope: MemoryCommitScope; source: CompletedLessonSource } | null;
	getLessonJudge?(): MemoryLessonJudge | null;
	settings(): { enabled: boolean; observations: { enabled: boolean }; maxOutputTokens: number; timeoutMs: number };
	/** Session owns active ancestry, original bytes and checkpoint lineage. */
	source(): ObservationSource | null;
	usableHistoryTokens(): number;
	/**
	 * Fraction of the main route's usable history capacity the live context
	 * occupies (0 to 1 and beyond), or null when unknown. Preparation waits
	 * until compaction is plausibly near; most sessions end before it. A port
	 * that answers null defers new preparation; leaving it unwired removes the
	 * gate.
	 */
	historyPressure?(): number | null;
	/** Preparation can use its own route before an actor exists; offers still require the actual compactor's fit. */
	observerHistoryTokens?(): number;
	client: {
		getModelClient(): TaskMemoryModelClient | null;
		getModelMaxTokens(max: number): number;
		backgroundEndpointBusy(): boolean;
	};
	/** The current session and its workspace, for lesson provenance; a read-only query. */
	currentSession?(): { id: string; cwd: string } | null;
	/** Where lesson gate decisions reach the operator. */
	notice?(line: string): void;
	/** Where durable store failures are reported; never steers a session. */
	diagnostic?(line: string): void;
}

/** Composition supplies scheduling infrastructure; memory supplies its own lesson queries and filing. */
export type MemoryGuardianInfrastructure = Omit<
	MemoryGuardianDeps,
	"observations" | "getKeptLessons" | "onHistoryLessons"
> &
	Partial<Pick<MemoryGuardianDeps, "getKeptLessons" | "onHistoryLessons">>;

/** Retention markers read per discovery step, and closed ledgers rebuilt per step. */
const RETENTION_SCAN_BATCH = 16;
const RETENTION_SCAN_LEDGERS = 2;
/** Settled retention markers older than this are removed; the ledger stays the work source. */
const RETENTION_TERMINAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Artifact slots only consolidation may use, so a full journal can still be reflected. */
const OBSERVATION_RESERVED_ARTIFACTS = 4;
/** Prepared-observation wrapper and the smallest useful note set, in estimated tokens. */
const OBSERVATION_WRAPPER_TOKENS = 48;
const OBSERVATION_MIN_NOTE_TOKENS = 64;
/**
 * No preparation below this share of usable main-route history: a session
 * that never nears compaction never pays for notes it cannot use. The share
 * leaves the ordinary idle cadence time to cover the backlog before the
 * compaction threshold (0.9 of the window by default).
 */
const OBSERVATION_PRESSURE_START = 0.4;
/**
 * Smallest source group worth a model call. The observer's fixed cost (its
 * prompt and a full note set) is paid per call, so a group may span user
 * turns until it reaches this size; above it, groups end at a user turn so a
 * cut at a turn boundary keeps whole batches usable.
 */
const OBSERVATION_MIN_GROUP_TOKENS = 1024;

/** The sole composition-owned lifecycle. No additional timer, commit epoch or task bank. */
export class MemoryRuntime implements MemoryObservationCommands {
	readonly bank = new TaskMemoryBank();
	readonly contract: MemoryContract = {
		promptSelection: () => (this.#promptSelection ? structuredClone(this.#promptSelection) : null),
		observationStatus: () => this.observationStatus(),
		taskSnapshot: () => this.bank.snapshot(),
		interventionStatus: () => ({
			stepInFlight: this.#registration?.stepInFlight() ?? false,
			lastDecision: this.#registration?.lastDecision() ?? null,
			activity: this.#registration?.recentActivity() ?? [],
		}),
		guardianState: () => this.#guardian?.state() ?? "off",
		retentionStatus: () => ({
			phase: this.#retention.phase,
			reason: this.#retention.reason,
			extracted: this.#retention.extracted,
			retained: this.#retention.retained.map((record) => ({ ...record })),
			attempts: this.#retention.attempts,
			revision: this.#retention.revision,
			...(this.#retention.candidateIds ? { candidateIds: [...this.#retention.candidateIds] } : {}),
		}),
	};
	#registration: MemoryInterventionRegistration | null = null;
	#guardian: MemoryGuardian | null = null;
	#infrastructure: MemoryRuntimeInfrastructure | null = null;
	#batches: SessionObservation[] = [];
	#loadedScope: string | null = null;
	#consumed = new Map<string, string>();
	#commits = new Map<string, string>();
	#attempts = new Map<string, number>();
	#controller: AbortController | null = null;
	#issued = new Map<string, MemoryConsumptionReceipt>();
	#lastCommit: string | null = null;
	#lastReceipt: string | null = null;
	#lastReason: string | null = null;
	#usage: TaskMemoryStepUsage | null = null;
	#durationMs: number | null = null;
	#reflection = false;
	#disposed = false;
	#enabled = false;
	#retention: RetentionStatus = EMPTY_RETENTION;
	/** The completed task the current session scope last offered for retention. */
	#lastRetention: { scope: MemoryCommitScope; source: CompletedLessonSource } | null = null;
	/**
	 * A closed session's completed task whose retention its own close cut off. A
	 * live operator closes a session right after its last turn, which aborted the
	 * extraction 25 ms in and left the lesson to nothing: retention only ever
	 * looked at the current session. It finishes later under its own identity.
	 */
	#orphan: { scope: MemoryCommitScope; source: CompletedLessonSource } | null = null;
	/**
	 * Retentions a process started and never settled, found on disk once per
	 * process. The in-memory orphan dies with its process: a live cold exit right
	 * after a session left its retention pending, and the next process's session
	 * repeated the whole validator discovery the lesson would have saved.
	 */
	#closedQueue: { scope: MemoryCommitScope; source: CompletedLessonSource }[] = [];
	/** The job in flight belongs to a closed session; navigation does not cancel it. */
	#orphanJob = false;
	#promptSelection: MemoryPromptSelection | null = null;
	/** What the last request carried, so lifecycle rows record changes rather than every request. */
	#submittedSection: string | null = null;
	/** Incremental, bounded discovery of retention markers left by earlier processes. */
	#retentionScan: { names: string[]; index: number } | null = null;
	/** Pending history candidates may exist on disk; cleared once a replay finds none. */
	#historyReplayDue = true;
	readonly #keptLessons = createKeptLessonSource(() => {
		const dataDir = this.#infrastructure?.dataDir?.();
		if (!dataDir) throw new Error("memory data root unavailable");
		return dataDir;
	});
	/** Proposal tracking, delivery feedback and history filing, owned here rather than by composition. */
	readonly #feedback = new MemoryLessonFeedback({
		dataDir: () => {
			const dataDir = this.#infrastructure?.dataDir?.();
			if (!dataDir) throw new Error("memory data root unavailable");
			return dataDir;
		},
		stateDir: () => {
			const stateDir = this.#infrastructure?.stateDir();
			if (!stateDir) throw new Error("memory state root unavailable");
			return stateDir;
		},
		session: () => this.#infrastructure?.currentSession?.() ?? null,
		notice: (line) => {
			try {
				this.#infrastructure?.notice?.(line);
			} catch {
				// A notice sink failure never reaches the store or the session.
			}
		},
		diagnostic: (line) => {
			try {
				this.#infrastructure?.diagnostic?.(line);
			} catch {
				// Diagnostics are best effort.
			}
		},
		event: (name, facts) => this.#event(name, facts),
	});

	configure(infrastructure: MemoryRuntimeInfrastructure): void {
		this.#infrastructure = infrastructure;
	}

	/**
	 * Approved repository lessons for the configured workspace, with conditions
	 * and provenance, cached by store revision and repository authority.
	 */
	keptLessons(): readonly KeptLesson[] {
		const infra = this.#infrastructure;
		if (!infra?.settings().enabled || !infra.dataDir) return [];
		try {
			return this.#keptLessons.lessons(infra.cwd?.() ?? process.cwd());
		} catch {
			return []; /* An unreadable store surfaces nothing; the session continues without it. */
		}
	}

	/** Resolves when lesson store writes started so far have settled, for a caller that must wait on them. */
	whenLessonsSettled(): Promise<void> {
		return this.#feedback.whenSettled();
	}

	createIntervention(deps: Omit<MemoryInterventionDeps, "bank">): MemoryInterventionRegistration {
		if (this.#registration) throw new Error("memory intervention already bound");
		const original = createMemoryInterventionRegistration({
			...deps,
			getKeptLessons: deps.getKeptLessons ?? (() => this.keptLessons()),
			// Only a job actually in flight holds the boundary step back. Pending observation
			// work runs only when idle, so waiting on it starved every mid-turn step.
			deferBoundaryPolicy: () => this.#controller !== null,
			// Called at submission, never at production: the host saw the reminder in an admitted request.
			onInjectedEntries: (entries) => {
				this.#event("reminder-entries-submitted", { count: entries.length, ids: entries.map((entry) => entry.id) });
				this.#feedback.delivered(entries);
				deps.onInjectedEntries?.(entries);
			},
			onDurableLessonOutcomes: (input) => {
				if (input.delivered.length) this.#event("durable-lessons-submitted", { ids: input.delivered });
				if (input.held.length) this.#event("durable-lessons-held", { ids: input.held });
				this.#feedback.durableOutcomes(input);
				deps.onDurableLessonOutcomes?.(input);
			},
			onDeliveryOutcomes: (outcomes, final) => {
				this.#event("reminder-outcomes", {
					final,
					outcomes: outcomes.map((outcome) => ({ kind: outcome.kind, ids: outcome.entries.map((entry) => entry.id) })),
				});
				this.#feedback.settleDeliveries(outcomes, final);
				deps.onDeliveryOutcomes?.(outcomes, final);
			},
			onKnowledgeReview: (review) => {
				this.#feedback.reviewKnowledge(review);
				deps.onKnowledgeReview?.(review);
			},
			onKeptLessonsRetired: (memoryIds) => {
				this.#feedback.retiredKept(memoryIds);
				deps.onKeptLessonsRetired?.(memoryIds);
			},
			bank: this.bank,
			onContentCancelled: () => this.#invalidate("cancelled"),
			onScopeEnd: (input) => {
				const scoped = {
					...input,
					// The bounded retention job owns these proposals, including its recoverable pending candidates.
					lessons: input.lessons.filter((entry) => !this.#retention.candidateIds?.includes(entry.id)),
				};
				this.#feedback.scopeEnd(scoped);
				deps.onScopeEnd?.(scoped);
			},
		});
		const registration: MemoryInterventionRegistration = {
			...original,
			observations: this,
			acknowledgeRestoration: (offer) => {
				const accepted = original.acknowledgeRestoration(offer);
				if (accepted) this.#event("restoration-delivered", { commitId: offer.commitId, count: offer.citedEntryIds.length });
				return accepted;
			},
			reset: () => {
				original.reset();
				this.#resetObservations();
			},
			dispose: () => this.dispose(),
			bindCommitScope: (scope) => {
				const current = original.captureMemoryAuthority()?.scope;
				original.bindCommitScope(scope);
				if (current && observationDigest(current) !== observationDigest(scope)) this.#resetObservations();
			},
			notifyContextCommitted: (input) => {
				const verdict = original.notifyContextCommitted(input);
				if (verdict !== "accepted" && verdict !== "duplicate") return;
				if (input.memoryReceipt) this.consume(input.commitId, input.memoryReceipt);
				if (verdict === "duplicate") return verdict;
				this.#invalidate("checkpoint-changed");
				return verdict;
			},
		};
		this.#registration = registration;
		// Keep the original disposal; calling the public adapter again would recurse.
		this.#disposeIntervention = () => original.dispose();
		return registration;
	}
	#disposeIntervention: (() => void) | null = null;

	startGuardian(deps: MemoryGuardianInfrastructure): MemoryGuardian {
		if (this.#guardian) throw new Error("memory guardian already bound");
		this.#guardian = createMemoryGuardian({
			getKeptLessons: () => this.keptLessons(),
			onHistoryLessons: (input) => this.#fileHistory(input),
			...deps,
			observations: this,
		});
		return this.#guardian;
	}

	async #fileHistory(input: HistoryLessons): Promise<HistoryFiling> {
		const filing = await this.#feedback.fileHistory(input);
		if (filing === "pending") this.#historyReplayDue = true;
		this.#event("history-lessons-filed", {
			sourceSessionId: input.sessionId,
			filing,
			grounded: input.grounded.length,
			ungrounded: input.ungrounded.length,
		});
		return filing;
	}

	reset(): void {
		this.#registration?.reset();
		this.#guardian?.reset();
	}

	/**
	 * Settings changed or a new turn applied them. Disabling memory or its
	 * observations revokes every issued offer now, rather than whenever the next
	 * preparation step happens to look, so a quick disable and re-enable cannot
	 * leave an old offer valid.
	 */
	settingsChanged(): void {
		this.#source();
	}
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#invalidate("disposed");
		this.#guardian?.dispose();
		this.#disposeIntervention?.();
	}

	#invalidate(reason: string): void {
		// A closed session's retention has its own authority: navigation and the observation
		// switch leave it running, its own isCurrent checks memory being enabled, and shutdown ends it.
		if (!this.#orphanJob || reason === "disposed") {
			this.#controller?.abort();
			this.#controller = null;
		}
		this.#issued.clear();
		this.#lastReason = reason;
		this.#event("invalidated", { reason });
	}
	#resetObservations(): void {
		const last = this.#lastRetention;
		const infra = this.#infrastructure;
		if (last && infra && !retentionSettled(readRetention(retentionPath(infra.stateDir(), last.scope, last.source)))) {
			// An orphan already waiting or running keeps its place; the newly closed session queues behind it.
			if (this.#orphan) this.#closedQueue.unshift(last);
			else this.#orphan = last;
		}
		this.#lastRetention = null;
		this.#invalidate("navigation");
		this.#batches = [];
		this.#loadedScope = null;
		this.#consumed.clear();
		this.#commits.clear();
		this.#attempts.clear();
		this.#lastCommit = null;
		this.#lastReceipt = null;
		this.#retention = EMPTY_RETENTION;
		this.#promptSelection = null;
		this.#submittedSection = null;
	}

	#source(): ObservationSource | null {
		const infra = this.#infrastructure;
		const enabled = !!infra && infra.settings().enabled && infra.settings().observations.enabled;
		if (this.#enabled && !enabled) this.#invalidate("disabled");
		this.#enabled = enabled;
		if (!infra || !enabled || this.#disposed) return null;
		const source = infra.source();
		if (!source) return null;
		const key = observationDigest([source.sessionId, source.branchAnchorTurnId, source.checkpoint]);
		if (this.#loadedScope !== key) {
			this.#batches = loadObservations(infra.stateDir(), source.sessionId).filter((batch) =>
				compatibleObservation(batch, source),
			);
			this.#loadedScope = key;
		}
		return source;
	}

	/** Current representations: a valid reflection hides the batches it consolidated. */
	#ready(source: ObservationSource): SessionObservation[] {
		const ready = this.#offerable(source);
		const replaced = new Set(ready.flatMap((batch) => batch.inputs.map((input) => input.id)));
		return ready.filter((batch) => !replaced.has(batch.id));
	}

	/**
	 * Everything a compaction offer may choose from. A reflection's inputs stay
	 * available so a cut that splits the reflected run can still use the
	 * originals inside it; the offer never takes both for the same units.
	 */
	#offerable(source: ObservationSource): SessionObservation[] {
		return this.#batches.filter((batch) => !this.#consumed.has(batch.id) && compatibleObservation(batch, source));
	}

	/**
	 * Free artifact slots before deciding work: artifacts no offer on this
	 * lineage can use, then, under pressure, batches a valid reflection already
	 * replaces. Only optimization artifacts are removed; raw history and
	 * committed checkpoints are untouched.
	 */
	#makeArtifactRoom(source: ObservationSource, stateDir: string): void {
		if (this.#batches.length < OBSERVATION_MAX_BATCHES - OBSERVATION_RESERVED_ARTIFACTS) return;
		const retired = new Map<string, string>();
		for (const batch of this.#batches)
			if (!this.#consumed.has(batch.id) && !compatibleObservation(batch, source)) retired.set(batch.id, batch.digest);
		const live = this.#offerable(source);
		for (const reflection of live)
			for (const input of reflection.inputs)
				if (live.some((batch) => batch.id === input.id && batch.digest === input.digest))
					retired.set(input.id, input.digest);
		if (retired.size === 0) return;
		this.#batches = this.#batches.filter((batch) => retired.get(batch.id) !== batch.digest);
		retireObservations(stateDir, source.sessionId, retired);
		this.#event("artifacts-retired", { count: retired.size, reason: "capacity" });
	}

	#work() {
		const source = this.#source();
		const infra = this.#infrastructure;
		if (!source || !infra) return null;
		const budgets = observationBudgets(this.#historyBudget().tokens);
		if (budgets.source < 512) {
			this.#lastReason = "insufficient-budget";
			return null;
		}
		// Null from a wired port means the live budget view is unavailable (before
		// the first measured turn, or only a persisted one), and an unknown budget
		// defers new preparation (SPEC R13): the observer's own capacity says
		// nothing about how near the main route's compaction is. Reflection over
		// batches already prepared still runs. An unwired port is a bare runtime
		// with no live budget to consult, which prepares ungated.
		const pressure = infra.historyPressure === undefined ? undefined : infra.historyPressure();
		if (pressure !== undefined && pressure !== null && pressure < OBSERVATION_PRESSURE_START) {
			this.#lastReason = "below-pressure";
			return null;
		}
		this.#makeArtifactRoom(source, infra.stateDir());
		const ready = this.#ready(source);
		// New preparation stops short of the cap; the reserved slots are for consolidation.
		const hasRoom = this.#batches.length < OBSERVATION_MAX_BATCHES - OBSERVATION_RESERVED_ARTIFACTS;
		if (hasRoom && pressure !== null) {
			const covered = new Set(ready.flatMap((batch) => batch.coverage.flatMap((unit) => unit.refs)));
			// Half the source budget, between 256 and the ceiling: a small window
			// still prepares its tool units, a large one no longer pays per turn.
			const minimum = Math.min(OBSERVATION_MIN_GROUP_TOKENS, Math.max(256, Math.floor(budgets.source / 2)));
			let noGain = false;
			// A group that cannot gain or already used its attempts is passed over,
			// so it never starves the groups after it. A group still under the
			// minimum waits for more source rather than paying a call for little.
			for (let index = 0; index < source.units.length; ) {
				const group = observationGroup(source.units, index, covered, budgets.source, minimum);
				index = group.next;
				if (group.units.length === 0) continue;
				if (group.tokens < minimum) continue;
				if (!plausibleObservationGain(group.units)) {
					noGain = true;
					continue;
				}
				const revision = observationDigest([
					source.sessionId,
					source.branchAnchorTurnId,
					source.checkpoint,
					sourceCoverageDigest(group.units),
					source.units.at(-1)?.digest,
					infra.settings(),
				]);
				if ((this.#attempts.get(revision) ?? 0) >= 2) continue;
				return { source, units: group.units, revision, inputs: [] as SessionObservation[] };
			}
			if (noGain) this.#lastReason = "no-plausible-gain";
		}
		// A captured reflection is prepared through this same one-in-flight lane,
		// over one run of batches whose coverage is contiguous in the source. It is
		// never refused for capacity: writing it frees the inputs it replaces, so
		// a full journal can still consolidate.
		const tokens = ready.reduce((n, batch) => n + observationTokens(batch.rendered), 0);
		if (ready.length >= 2 && tokens > budgets.journal) {
			for (const inputs of contiguousRuns(source, ready)) {
				const reflectionRevision = observationDigest(inputs.map((batch) => [batch.id, batch.digest]));
				if ((this.#attempts.get(reflectionRevision) ?? 0) < 2)
					return { source, units: inputs.flatMap((batch) => batch.coverage), revision: reflectionRevision, inputs };
			}
		}
		if (pressure === null) this.#lastReason = "pressure-unknown";
		else if (!hasRoom) this.#lastReason = "artifact-limit";
		return null;
	}
	#historyBudget(): { tokens: number; basis: "main" | "memory" | "unknown" } {
		const main = this.#infrastructure?.usableHistoryTokens() ?? 0;
		if (main > 0) return { tokens: main, basis: "main" };
		const memory = this.#infrastructure?.observerHistoryTokens?.() ?? 0;
		return { tokens: memory, basis: memory > 0 ? "memory" : "unknown" };
	}

	/**
	 * Work for the guardian's next step. While a turn streams only a closed
	 * session's retention qualifies: it reads nothing the turn is changing, and
	 * the routed client still yields when the memory endpoint is the turn's own.
	 */
	pendingWork(foreground = false): boolean {
		// Beside a streaming turn only a closed session's retention qualifies, and
		// finding one is the bounded discovery step this wake gets.
		if (foreground) return this.#controller === null && this.#retentionWork(true, true) !== null;
		if (this.#yieldsToBoundaryStep()) return false;
		return (
			this.#controller !== null ||
			this.#work() !== null ||
			this.#historyReplayPending() ||
			this.#retentionWork() !== null ||
			this.#retentionScanPending()
		);
	}

	/**
	 * Between turns this lane waits while the intervention owes a boundary step
	 * (SPEC R05). Both serve the current session, but the owed step reviews a
	 * turn that already ended and is one call, while preparation is a run of
	 * calls for a compaction that may never come. Live, a turn-end lesson pass
	 * that yielded at the turn's own endpoint release waited behind up to eight
	 * batches (36 s); the guardian now runs it first and this lane resumes after.
	 * A job already in flight is never preempted, so the wait is at most one batch.
	 */
	#yieldsToBoundaryStep(): boolean {
		return this.#controller === null && (this.#registration?.owesBoundaryStep() ?? false);
	}

	async runIdleStep(foreground = false): Promise<MemoryStepLaunchOutcome> {
		if (this.#controller) return "none";
		if (!foreground && this.#yieldsToBoundaryStep()) return "none";
		const work = foreground ? null : this.#work();
		const infra = this.#infrastructure;
		const authority = this.#registration?.captureMemoryAuthority();
		if (!work || !infra || !authority) {
			// Saved history candidates are filed before any new model work: no call, bounded files per step.
			if (!foreground && this.#historyReplayPending()) {
				const filed = await this.#feedback.replayHistory();
				const remaining = this.#feedback.hasPendingHistory();
				if (!remaining) this.#historyReplayDue = false;
				// Files that failed again wait for the next process rather than looping on a broken store.
				return filed > 0 || !remaining ? "ran" : "skipped";
			}
			// The step advances marker discovery by one bounded batch.
			if (this.#retentionWork(foreground, true)) {
				const result = await this.retainTask("resume", undefined, foreground);
				if (
					[
						"cost_ceiling",
						"quota_unknown",
						"quota_window",
						"quota_retry",
						"time_budget",
						"information_flow_blocked",
						"store-error",
						"judge-unavailable",
					].includes(result.reason ?? "")
				)
					return "skipped";
				return ["endpoint-busy", "endpoint_busy", "endpoint_preempted", "other-process-extracting"].includes(
					result.reason ?? "",
				)
					? "yielded"
					: result.reason === "no-client"
						? "unavailable"
						: "ran";
			}
			// A discovery step that found nothing yet still made bounded progress.
			return this.#retentionScanPending() ? "ran" : "none";
		}
		let client: TaskMemoryModelClient | null;
		try {
			client = infra.client.getModelClient();
		} catch {
			this.#lastReason = "no-client";
			return "unavailable";
		}
		if (!client) return "unavailable";
		if (infra.client.backgroundEndpointBusy()) {
			this.#lastReason = "endpoint-busy";
			return "yielded";
		}
		const settings = infra.settings();
		const maxTokens = Math.min(settings.maxOutputTokens, infra.client.getModelMaxTokens(settings.maxOutputTokens));
		if (maxTokens < 256) {
			this.#lastReason = "output-budget";
			return "skipped";
		}
		const { systemPrompt, userPrompt } = work.inputs.length
			? reflectionRequest(work.inputs, work.units)
			: {
					systemPrompt: OBSERVATION_PROMPT,
					userPrompt: JSON.stringify({
						source: work.units.map((unit) => JSON.parse(unit.text)),
						successfulResultRefs: work.units.flatMap((unit) => unit.successfulResultRefs),
					}),
				};
		const controller = new AbortController();
		this.#controller = controller;
		this.#reflection = work.inputs.length > 0;
		const guard = this.#registration?.isContentCurrent() ?? (() => false);
		const isCurrent = () =>
			this.#controller === controller &&
			!controller.signal.aborted &&
			guard() &&
			this.#enabled &&
			!!this.#infrastructure?.settings().observations.enabled &&
			!!this.#infrastructure?.settings().enabled;
		let usage: TaskMemoryStepUsage | null = null;
		const recordUsage = (next: TaskMemoryStepUsage) => {
			usage = next;
		};
		const started = performance.now();
		const timeout = setTimeout(() => controller.abort(new Error("observation deadline")), settings.timeoutMs);
		if (this.#attempts.size >= 128) this.#attempts.delete(this.#attempts.keys().next().value ?? "");
		this.#attempts.set(work.revision, (this.#attempts.get(work.revision) ?? 0) + 1);
		try {
			if (observationTracing())
				traceObservation(this.#reflection ? "reflection-input" : "observation-input", {
					source: work.source,
					authority,
					revision: work.revision,
					systemPrompt,
					userPrompt,
					maxTokens,
					route: client.route ?? null,
				});
			// Race an abort-ignoring client; late usage still belongs to its captured launch.
			const completion = client.complete({
				purpose: work.inputs.length ? "reflection" : "observation",
				systemPrompt,
				userPrompt,
				maxTokens,
				signal: controller.signal,
				onUsage: recordUsage,
			});
			// The race below abandons a late completion; its rejection is the step's own and already handled there.
			void completion.catch(() => {});
			const aborted = new Promise<never>((_, reject) =>
				controller.signal.addEventListener(
					"abort",
					() => reject(controller.signal.reason ?? new Error("observation cancelled")),
					{ once: true },
				),
			);
			const response = await Promise.race([completion, aborted]);
			usage = response.usage ?? usage;
			if (observationTracing())
				traceObservation(work.inputs.length ? "reflection-output" : "observation-output", { response: response.text });
			if (!isCurrent()) {
				if (this.#controller === controller) this.#lastReason = "stale-result";
				return "none";
			}
			const current = infra.source();
			const batch = prepareObservation({
				response: response.text,
				source: work.source,
				units: work.units,
				authority: authority.stamp,
				revision: work.revision,
				priorObservationRevision: this.#ready(work.source).at(-1)?.digest ?? null,
				route: client.route ?? null,
				usage,
				...(work.inputs.length ? { inputs: work.inputs } : {}),
				onRejectedNotes: (rejected, offered) => {
					this.#event("notes-rejected", { revision: work.revision, rejected, offered });
					if (observationTracing()) traceObservation("notes-rejected", { revision: work.revision, rejected, offered });
				},
			});
			if (
				!current ||
				!compatibleObservation(batch, current) ||
				work.inputs.some(
					(input) => !this.#ready(current).some((ready) => ready.id === input.id && ready.digest === input.digest),
				)
			) {
				this.#lastReason = "stale-result";
				this.#event("invalidated", { reason: "stale-result", batchId: batch.id });
				return "none";
			}
			if (!persistObservation(infra.stateDir(), batch)) {
				this.#lastReason = "artifact-unavailable";
				return "none";
			}
			this.#batches.push(batch);
			this.#lastReason = null;
			this.#event(work.inputs.length ? "reflection-ready" : "batch-ready", {
				batchId: batch.id,
				digest: batch.digest,
				sourceDigest: batch.sourceDigest,
				sourceTokens: batch.sourceTokens,
				noteTokens: observationTokens(batch.rendered),
				inputs: batch.inputs,
			});
			if (observationTracing()) traceObservation("prepared", { batch });
			return "ran";
		} catch (error) {
			if (error instanceof TaskMemoryEndpointBusyError || error instanceof TaskMemoryEndpointPreemptedError) {
				this.#attempts.set(work.revision, Math.max(0, (this.#attempts.get(work.revision) ?? 1) - 1));
				this.#lastReason = "endpoint-busy";
				return "yielded";
			}
			if (error instanceof TaskMemoryBudgetSkipError) {
				this.#attempts.set(work.revision, Math.max(0, (this.#attempts.get(work.revision) ?? 1) - 1));
				this.#lastReason = error.reason;
				return "skipped";
			}
			this.#lastReason = controller.signal.aborted ? "cancelled-or-timeout" : "invalid-or-unavailable";
			this.#event("preparation-failed", {
				revision: work.revision,
				reason: this.#lastReason,
				attempts: this.#attempts.get(work.revision),
			});
			if (observationTracing())
				traceObservation("preparation-failed", { error: error instanceof Error ? error.message : String(error) });
			return "ran";
		} finally {
			clearTimeout(timeout);
			if (this.#controller === controller) {
				this.#usage = usage;
				this.#durationMs = performance.now() - started;
			}
			this.#event("preparation-settled", {
				revision: work.revision,
				priorObservationRevision: this.#ready(work.source).at(-1)?.digest ?? null,
				route: client.route ?? null,
				usage,
				durationMs: performance.now() - started,
				sessionId: work.source.sessionId,
			});
			if (this.#controller === controller) {
				this.#controller = null;
				this.#reflection = false;
			}
		}
	}

	/**
	 * The current session's completed task first, then a closed session's: the
	 * one this process saw close, then any found on disk. A settled current task
	 * no longer hides the closed ones behind it.
	 */
	#retentionWork(
		orphanOnly = false,
		discover = false,
	): {
		infra: MemoryRuntimeInfrastructure;
		scope: MemoryCommitScope;
		source: CompletedLessonSource;
		orphan: { scope: MemoryCommitScope; source: CompletedLessonSource } | null;
	} | null {
		const infra = this.#infrastructure;
		if (!infra?.settings().enabled || !infra.lessonSource || this.#disposed) return null;
		const current = this.#registration?.captureMemoryAuthority()?.scope ?? null;
		const currentSource = current && !orphanOnly ? infra.lessonSource() : null;
		if (current && currentSource) {
			this.#lastRetention = { scope: current, source: currentSource };
			const existing = readRetention(retentionPath(infra.stateDir(), current, currentSource));
			if (existing) this.#restoreRetention(existing);
			if (!retentionSettled(existing)) return { infra, scope: current, source: currentSource, orphan: null };
		}
		let orphan = this.#orphan;
		if (orphan && retentionSettled(readRetention(retentionPath(infra.stateDir(), orphan.scope, orphan.source))))
			orphan = null;
		orphan ??= this.#nextClosedSession(infra, current?.sessionId ?? null, discover);
		this.#orphan = orphan;
		return orphan ? { infra, scope: orphan.scope, source: orphan.source, orphan } : null;
	}

	#restoreRetention(existing: NonNullable<ReturnType<typeof readRetention>>): void {
		if (this.#retention.revision !== existing.revision || this.#retention.phase !== existing.phase)
			this.#event("lesson-retention-restored", {
				revision: existing.revision,
				phase: existing.phase,
				attempts: existing.attempts,
				retainedIds: existing.retained.map((record) => record.id),
				reason: existing.reason,
			});
		this.#retention = {
			phase: existing.phase,
			reason: existing.reason,
			extracted: existing.extracted,
			retained: existing.retained,
			attempts: existing.attempts,
			revision: existing.revision,
			...(existing.candidateIds ? { candidateIds: existing.candidateIds } : {}),
		};
	}

	/** The next closed session whose retention a process started and never settled. */
	#nextClosedSession(
		infra: MemoryRuntimeInfrastructure,
		currentSessionId: string | null,
		discover: boolean,
	): { scope: MemoryCommitScope; source: CompletedLessonSource } | null {
		// Interrupted retentions run ahead of historical mining, but discovering
		// them is bounded per step: a long-lived state root holds a marker for
		// every task ever retained, and reading all of them blocked the first wake.
		for (let pass = 0; pass < 2; pass++) {
			for (let next = this.#closedQueue.shift(); next; next = this.#closedQueue.shift()) {
				if (next.scope.sessionId === currentSessionId) continue;
				if (!retentionSettled(readRetention(retentionPath(infra.stateDir(), next.scope, next.source)))) return next;
			}
			if (pass === 0 && discover) this.#scanRetentionMarkers(infra, currentSessionId);
		}
		return null;
	}

	#historyReplayPending(): boolean {
		return this.#historyReplayDue && !!this.#infrastructure?.settings().enabled && this.#feedback.hasPendingHistory();
	}

	#retentionScanPending(): boolean {
		const infra = this.#infrastructure;
		if (!infra?.settings().enabled || !infra.closedLessonSource) return false;
		// Listing first: a state root with no markers has nothing to discover, and
		// reporting work for it showed every fresh session's guardian as reviewing.
		const scan = this.#retentionMarkers(infra);
		return scan.index < scan.names.length;
	}

	/** The marker names this process walks, listed once on first use. */
	#retentionMarkers(infra: MemoryRuntimeInfrastructure): { names: string[]; index: number } {
		if (this.#retentionScan !== null) return this.#retentionScan;
		let names: string[] = [];
		try {
			names = readdirSync(join(infra.stateDir(), "memory", "retention"))
				.filter((name) => name.endsWith(".json"))
				.sort();
		} catch {
			/* No retention ever ran here. */
		}
		this.#retentionScan = { names, index: 0 };
		return this.#retentionScan;
	}

	/**
	 * One bounded discovery step over retention markers: at most
	 * `RETENTION_SCAN_BATCH` markers read and `RETENTION_SCAN_LEDGERS` closed
	 * ledgers rebuilt. An unsettled marker whose session belongs to this
	 * workspace and still ends on the marked task is queued for recovery. A
	 * settled marker past its lifetime is removed; the ledger stays the
	 * recoverable source, so this costs at most one more review of an old task.
	 */
	#scanRetentionMarkers(infra: MemoryRuntimeInfrastructure, currentSessionId: string | null): void {
		if (!infra.closedLessonSource) return;
		const directory = join(infra.stateDir(), "memory", "retention");
		const scan = this.#retentionMarkers(infra);
		let ledgers = 0;
		const stop = Math.min(scan.names.length, scan.index + RETENTION_SCAN_BATCH);
		while (scan.index < stop && ledgers < RETENTION_SCAN_LEDGERS) {
			const name = scan.names[scan.index++] ?? "";
			const path = join(directory, name);
			const marker = readRetention(path);
			if (marker === null) continue;
			if (retentionSettled(marker)) {
				try {
					if (Date.now() - statSync(path).mtimeMs > RETENTION_TERMINAL_TTL_MS) unlinkSync(path);
				} catch {
					// Another process removed it first.
				}
				continue;
			}
			const sessionId = (marker as { sessionId?: unknown }).sessionId;
			if (typeof sessionId !== "string" || sessionId === currentSessionId || !marker.revision) continue;
			ledgers += 1;
			let closed: ReturnType<NonNullable<MemoryRuntimeInfrastructure["closedLessonSource"]>> = null;
			try {
				closed = infra.closedLessonSource(sessionId);
			} catch {
				// An unreadable ledger leaves its task to history review.
			}
			if (closed && closed.source.revision === marker.revision) this.#closedQueue.push(closed);
		}
	}

	async retainTask(reason: "headless" | "resume", timeoutCapMs?: number, orphanOnly = false): Promise<RetentionStatus> {
		if (!this.#infrastructure?.settings().enabled) {
			this.#retention = { ...EMPTY_RETENTION, phase: "skipped", reason: "disabled" };
			this.#event("lesson-extraction-skipped", { reason: "disabled" });
			return this.#retention;
		}
		if (this.#controller || this.#registration?.stepInFlight()) {
			if (this.#retention.phase !== "extracting")
				this.#retention = { ...EMPTY_RETENTION, phase: "pending", reason: "memory-in-flight" };
			this.#event("lesson-extraction-deferred", { reason: "memory-in-flight" });
			return this.#retention;
		}
		const work = this.#retentionWork(orphanOnly);
		if (!work?.infra.dataDir || !work.infra.cwd || !this.#registration) {
			if (this.#retention.phase === "idle") {
				this.#retention = { ...EMPTY_RETENTION, phase: "skipped", reason: "no-completed-source" };
				this.#event("lesson-extraction-skipped", { reason: "no-completed-source" });
			}
			return this.#retention;
		}
		const { infra, scope, source, orphan } = work;
		const timeoutMs = Math.min(
			infra.settings().timeoutMs,
			timeoutCapMs ?? (reason === "headless" ? 5000 : infra.settings().timeoutMs),
		);
		if (timeoutMs <= 0) {
			this.#retention = { ...EMPTY_RETENTION, phase: "skipped", reason: "deadline", revision: source.revision };
			this.#event("lesson-extraction-skipped", { reason: "deadline", revision: source.revision });
			return this.#retention;
		}
		let client: TaskMemoryModelClient | null;
		try {
			client = infra.client.getModelClient();
		} catch {
			client = null;
		}
		// A closed session's status is its own. This session's status, and the candidate
		// ids its scope end filters on, must never show ids from another session's bank.
		let status = this.#retention;
		const publish = (next: RetentionStatus): void => {
			status = next;
			if (!orphan) this.#retention = next;
		};
		if (!client || infra.client.backgroundEndpointBusy()) {
			publish({
				...EMPTY_RETENTION,
				phase: "pending",
				reason: client ? "endpoint-busy" : "no-client",
				revision: source.revision,
			});
			this.#event("lesson-extraction-deferred", { reason: status.reason, revision: source.revision });
			return status;
		}
		const controller = new AbortController();
		this.#controller = controller;
		this.#orphanJob = orphan !== null;
		// A closed session's task is no longer the current session's content, so its
		// authority is its own: the job stays valid until another navigation replaces it.
		const guard = orphan ? () => this.#orphan === orphan : this.#registration.isContentCurrent();
		const isCurrent = () =>
			!this.#disposed &&
			this.#controller === controller &&
			!controller.signal.aborted &&
			guard() &&
			infra.settings().enabled;
		if (orphan) this.#event("lesson-retention-orphan", { sourceSessionId: scope.sessionId, revision: source.revision });
		publish({
			...EMPTY_RETENTION,
			phase: "extracting",
			attempts: (readRetention(retentionPath(infra.stateDir(), scope, source))?.attempts ?? 0) + 1,
			revision: source.revision,
		});
		const judge = infra.getLessonJudge?.();
		try {
			const retained = await retainCompletedTask({
				stateDir: infra.stateDir(),
				dataDir: infra.dataDir?.() ?? "",
				cwd: infra.cwd?.() ?? "",
				scope,
				source,
				// The current session's bank belongs to the current session; an orphan writes nowhere it can be read.
				bank: orphan ? new TaskMemoryBank() : this.bank,
				client: {
					...(client.route ? { route: client.route } : {}),
					complete: (request) => client.complete({ ...request, purpose: "lesson" }),
				},
				maxTokens: Math.min(
					infra.settings().maxOutputTokens,
					infra.client.getModelMaxTokens(infra.settings().maxOutputTokens),
				),
				timeoutMs,
				signal: controller.signal,
				isCurrent,
				...(judge ? { judge } : {}),
				onProgress: (next) => {
					if (isCurrent()) publish(next);
				},
				keptLessons: () => this.keptLessons(),
			});
			if (isCurrent() || orphan) publish(retained);
			// A settled review covers this task: history review need not pay for it again.
			if (retentionSettled(retained))
				recordReviewedHistoryCalls(infra.stateDir(), infra.cwd?.() ?? "", source.callIds ?? []);
			if (orphan && this.#orphan === orphan && retentionSettled(retained)) this.#orphan = null;
		} catch (error) {
			if (isCurrent() || orphan)
				publish({ ...EMPTY_RETENTION, phase: "pending", reason: "retention-error", revision: source.revision });
			if (observationTracing())
				traceObservation("retention-error", { error: error instanceof Error ? error.message : String(error) });
		} finally {
			if (this.#controller === controller) {
				this.#controller = null;
				this.#orphanJob = false;
			}
		}
		return status;
	}

	recordRecall(ids: readonly string[]): void {
		this.#event("memory-recall-results", { count: ids.length, ids });
	}

	recordPromptSelection(selection: MemoryPromptSelection): void {
		this.#promptSelection = structuredClone(selection);
	}

	/**
	 * Submission follows request admission and actual stream invocation; it does
	 * not certify model uptake. `framed` holds only the texts the host itself
	 * framed in that request (reminder blocks, tool-result notes), so a tool
	 * output that merely quotes a reminder, such as the agent reading its own
	 * ledger, never acknowledges one.
	 */
	recordSubmittedMemoryContext(framed: readonly string[], systemPrompt?: string): void {
		const selection = this.#promptSelection;
		// #423: the session prompt keeps the memory section it was compiled with,
		// and later records ride in a host-framed reminder, so a record counts as
		// submitted when its exact rendered text is in either place.
		const delivered = new Set(
			memorySectionBlocks(selection?.section ?? "")
				.filter((block) => systemPrompt?.includes(block.text) || framed.some((text) => text.includes(block.text)))
				.map((block) => block.id),
		);
		const recordIds =
			selection?.items.filter((item) => item.reason === "selected" && delivered.has(item.id)).map((item) => item.id) ?? [];
		const section = recordIds.length > 0 ? (selection?.section ?? "") : "";
		const at = new Date().toISOString();
		if (selection && section) this.#promptSelection = { ...selection, submittedAt: at };
		if (observationTracing())
			traceObservation("memory-section-submitted", {
				at,
				sessionId: this.#registration?.captureMemoryAuthority()?.scope.sessionId ?? null,
				turnId: selection?.turnId ?? null,
				text: section,
				recordIds,
			});
		// Lifecycle rows record a change, not every request that carried the same section again.
		const sectionKey = recordIds.length ? observationDigest([selection?.turnId ?? null, section, ...recordIds]) : null;
		if (sectionKey !== null && sectionKey !== this.#submittedSection)
			this.#event("memory-section-submitted", { ids: recordIds, count: recordIds.length });
		this.#submittedSection = sectionKey;
		// Reminders are acknowledged by their exact offered text inside the
		// admitted request, never by matching cited ids in arbitrary prose.
		const registration = this.#registration;
		if (!registration?.hasPendingOffers()) return;
		const submitted = registration.acknowledgeSubmission(framed.filter((text) => text.includes("Memory:")));
		if (submitted.length)
			this.#event("memory-reminders-submitted", {
				count: submitted.length,
				offers: submitted.map((offer) => ({
					id: offer.id,
					kind: offer.kind,
					tier: offer.tier,
					cited: offer.cited.map((cited) => cited.id),
					trigger: offer.trigger.reasons,
					lessons: offer.lessons.map((lesson) => ({
						id: lesson.id,
						approval: lesson.approval,
						appliesWhen: lesson.appliesWhen.length,
						avoidWhen: lesson.avoidWhen.length,
						evidence: lesson.evidenceRefs.length,
					})),
				})),
			});
	}

	offerCompaction(input: MemoryOfferInput) {
		const current = this.#source();
		if (!current || !this.#registration) return null;
		const guard = this.#registration.isContentCurrent();
		// The closure checks its own issuance: cancellation, navigation, disabling
		// and any other invalidation clear the registry, and a cleared offer stays
		// invalid even if memory is enabled again in the same scope.
		let issued: MemoryConsumptionReceipt | null = null;
		const offer = buildObservationOffer(input, this.#offerable(current), () => {
			if (issued === null || this.#issued.get(issued.offerId) !== issued) return false;
			const live =
				guard() &&
				this.#enabled &&
				!!this.#infrastructure?.settings().observations.enabled &&
				!!this.#infrastructure?.settings().enabled;
			// Revocation is permanent: an offer seen invalid once never comes back.
			if (!live) this.#issued.delete(issued.offerId);
			return live;
		});
		if (!offer) {
			this.#lastReason = "no-eligible-gain";
			this.#event("offer-declined", {
				reason: "no-eligible-gain",
				offerable: this.#offerable(current).length,
				units: input.source.units.length,
				incompleteUnits: input.source.units.filter((unit) => !unit.complete).length,
			});
			return null;
		}
		if (this.#issued.size >= 4) this.#issued.delete(this.#issued.keys().next().value ?? "");
		issued = offer.receipt;
		this.#issued.set(offer.receipt.offerId, offer.receipt);
		return Object.freeze({
			...offer,
			onUse: (use: MemoryOfferUse) =>
				this.#event("offer-used", {
					receipt: offer.receipt,
					originalInputTokens: use.originalInputTokens,
					substitutedInputTokens: use.substitutedInputTokens,
				}),
		});
	}

	consume(commitId: string, receipt: MemoryConsumptionReceipt): void {
		const digest = observationDigest(receipt);
		const previous = this.#commits.get(commitId);
		if (previous !== undefined) {
			if (previous !== digest) this.#lastReason = "receipt-conflict";
			return;
		}
		if (observationDigest(this.#issued.get(receipt.offerId)) !== digest) {
			this.#lastReason = "receipt-mismatch";
			return;
		}
		this.#recordConsumption(commitId, receipt, "checkpoint-committed");
	}
	#recordConsumption(commitId: string, receipt: MemoryConsumptionReceipt, event: MemoryObservationEvent): void {
		this.#commits.set(commitId, observationDigest(receipt));
		for (const batch of receipt.batches) this.#consumed.set(batch.id, batch.digest);
		const infra = this.#infrastructure;
		const artifacts = new Map(
			[...(infra ? loadObservations(infra.stateDir(), receipt.scope.sessionId) : []), ...this.#batches].map((batch) => [
				batch.id,
				batch,
			]),
		);
		const retireInputs = (id: string, digest: string) => {
			const parent = artifacts.get(id);
			if (!parent || parent.digest !== digest) return;
			for (const input of parent.inputs) {
				const child = artifacts.get(input.id);
				if (
					!child ||
					child.digest !== input.digest ||
					this.#consumed.get(child.id) === child.digest ||
					observationDigest(child.scope) !== observationDigest(parent.scope) ||
					observationDigest(child.checkpoint) !== observationDigest(parent.checkpoint) ||
					!child.coverage.every((unit) =>
						parent.coverage.some(
							(covered) => covered.digest === unit.digest && observationDigest(covered.refs) === observationDigest(unit.refs),
						),
					)
				)
					continue;
				this.#consumed.set(child.id, child.digest);
				retireInputs(child.id, child.digest);
			}
		};
		for (const batch of receipt.batches) retireInputs(batch.id, batch.digest);
		this.#lastCommit = commitId;
		this.#lastReceipt = receipt.offerId;
		this.#issued.delete(receipt.offerId);
		this.#event(event, { commitId, receipt });
		this.#batches = this.#batches.filter((batch) => this.#consumed.get(batch.id) !== batch.digest);
		if (infra) pruneConsumedObservations(infra.stateDir(), receipt.scope.sessionId, this.#consumed);
	}
	recoverConsumption(
		source: MemoryCommitScope,
		commits: readonly { commitId: string; receipt: MemoryConsumptionReceipt }[],
	): void {
		const scope = this.#registration?.captureMemoryAuthority()?.scope;
		if (!scope || scope.sessionId !== source.sessionId || scope.branchAnchorTurnId !== source.branchAnchorTurnId) return;
		for (const { commitId, receipt } of commits) {
			if (receipt.scope.sessionId !== source.sessionId) continue;
			const existing = this.#commits.get(commitId);
			if (existing && existing !== observationDigest(receipt)) {
				this.#lastReason = "receipt-conflict";
				continue;
			}
			if (!existing) this.#recordConsumption(commitId, receipt, "consumption-recovered");
		}
	}

	observationStatus(): ObservationStatus {
		const source = this.#source();
		const ready = source ? this.#ready(source) : [];
		const covered = new Set(ready.flatMap((batch) => batch.coverage.flatMap((unit) => unit.refs)));
		const capacity = this.#historyBudget();
		const budgets = observationBudgets(capacity.tokens);
		return {
			enabled: this.#enabled,
			scope: source ? { sessionId: source.sessionId, branchAnchorTurnId: source.branchAnchorTurnId } : null,
			unobserved: source?.units.filter((unit) => unit.complete && !unit.refs.some((ref) => covered.has(ref))).length ?? 0,
			ready: ready.length,
			offered: this.#issued.size,
			consumed: this.#consumed.size,
			sourceTokens: ready.reduce((n, b) => n + b.sourceTokens, 0),
			noteTokens: ready.reduce((n, b) => n + observationTokens(b.rendered), 0),
			sourceTargetTokens: budgets.source,
			journalTargetTokens: budgets.journal,
			budgetBasis: capacity.basis,
			reflection: this.#reflection ? "preparing" : "idle",
			lastCommit: this.#lastCommit,
			lastReceipt: this.#lastReceipt,
			lastReason: this.#lastReason,
			route: ready.at(-1)?.route ?? null,
			usage: this.#usage,
			durationMs: this.#durationMs,
		};
	}
	#event(event: MemoryObservationEvent, facts: Record<string, unknown>): void {
		const { sessionId, ...structural } = facts;
		observationEvent(
			event,
			structural,
			typeof sessionId === "string" ? sessionId : this.#registration?.captureMemoryAuthority()?.scope.sessionId,
		);
	}
}

/** Retention reached a decision that another attempt would not change. */
function retentionSettled(
	status: { phase: RetentionStatus["phase"]; attempts: number; candidates?: readonly unknown[] } | null,
): boolean {
	return (
		status !== null &&
		(status.phase === "retained" ||
			status.phase === "abstained" ||
			status.phase === "gated" ||
			status.phase === "exhausted" ||
			(status.attempts >= 2 && !status.candidates?.length))
	);
}

/**
 * The next observation group from `start`: consecutive complete, uncovered
 * units within the source budget. Once the group holds at least `minimum`
 * tokens it ends before the next unit that carries exact user material;
 * below that it spans user turns, so a run of small turns shares one call.
 * `next` is where the following group starts.
 */
function observationGroup(
	units: readonly ObservationSourceUnit[],
	start: number,
	covered: ReadonlySet<string>,
	budget: number,
	minimum: number,
): { units: ObservationSourceUnit[]; tokens: number; next: number } {
	const group: ObservationSourceUnit[] = [];
	let tokens = 0;
	for (let index = start; index < units.length; index++) {
		const unit = units[index];
		if (unit === undefined) continue;
		if (!unit.complete || unit.refs.some((ref) => covered.has(ref))) {
			if (group.length) return { units: group, tokens, next: index };
			continue;
		}
		if (group.length && unit.exact.length > 0 && tokens >= minimum) return { units: group, tokens, next: index };
		const cost = observationTokens(unit.text);
		if (cost > budget) {
			if (group.length) return { units: group, tokens, next: index };
			continue;
		}
		if (tokens + cost > budget) return { units: group, tokens, next: index };
		group.push(unit);
		tokens += cost;
	}
	return { units: group, tokens, next: units.length };
}

/**
 * Notes replace a group's ordinary representation only if they are smaller,
 * and the exact user material and wrapper ride along unchanged. A group whose
 * protected material already fills its ordinary cost cannot gain, so no model
 * call is spent on it.
 */
function plausibleObservationGain(units: readonly ObservationSourceUnit[]): boolean {
	const ordinary = units.reduce((n, unit) => n + (unit.ordinaryTokens ?? observationTokens(unit.text)), 0);
	const exact = units.reduce((n, unit) => n + observationTokens(JSON.stringify(unit.exact)), 0);
	return exact + OBSERVATION_WRAPPER_TOKENS + OBSERVATION_MIN_NOTE_TOKENS < ordinary;
}

/** Runs of two or more ready batches whose coverage is contiguous in the source, oldest first. */
function contiguousRuns(source: ObservationSource, ready: readonly SessionObservation[]): SessionObservation[][] {
	const position = (unit: ObservationSourceUnit | undefined) =>
		unit === undefined
			? -1
			: source.units.findIndex(
					(current) => current.digest === unit.digest && observationDigest(current.refs) === observationDigest(unit.refs),
				);
	const placed = ready
		.map((batch) => ({ batch, start: position(batch.coverage[0]), end: position(batch.coverage.at(-1)) }))
		.filter((item) => item.start >= 0 && item.end >= item.start)
		.sort((a, b) => a.start - b.start);
	const runs: SessionObservation[][] = [];
	let run: typeof placed = [];
	for (const item of placed) {
		const previous = run.at(-1);
		if (previous !== undefined && item.start !== previous.end + 1) {
			if (run.length >= 2) runs.push(run.map((entry) => entry.batch));
			run = [];
		}
		run.push(item);
	}
	if (run.length >= 2) runs.push(run.map((entry) => entry.batch));
	return runs;
}
