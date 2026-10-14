import { readdir } from "node:fs/promises";
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
	MemoryPromptSelection,
	ObservationSource,
	ObservationStatus,
	SessionObservation,
} from "./contract.js";
import type { MemoryGuardian, MemoryGuardianDeps } from "./guardian.js";
import { createMemoryGuardian } from "./guardian.js";
import type { CompletedLessonSource } from "./history-review.js";
import type {
	MemoryInterventionDeps,
	MemoryInterventionRegistration,
	MemoryStepLaunchOutcome,
} from "./intervention.js";
import { createMemoryInterventionRegistration } from "./intervention.js";
import type { MemoryLessonJudge } from "./lesson-judge.js";
import { loadObservations, persistObservation, pruneConsumedObservations } from "./observation-store.js";
import { observationEvent, traceObservation } from "./observation-trace.js";
import {
	buildObservationOffer,
	compatibleObservation,
	OBSERVATION_MAX_BATCHES,
	OBSERVATION_PROMPT,
	observationBudgets,
	observationDigest,
	observationTokens,
	prepareObservation,
	sourceCoverageDigest,
} from "./observations.js";
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
	closedLessonSource?(sessionId: string): Promise<{ scope: MemoryCommitScope; source: CompletedLessonSource } | null>;
	getLessonJudge?(): MemoryLessonJudge | null;
	settings(): { enabled: boolean; observations: { enabled: boolean }; maxOutputTokens: number; timeoutMs: number };
	/** Session owns active ancestry, original bytes and checkpoint lineage. */
	source(): ObservationSource | null;
	usableHistoryTokens(): number;
	/** Preparation can use its own route before an actor exists; offers still require the actual compactor's fit. */
	observerHistoryTokens?(): number;
	client: {
		getModelClient(): TaskMemoryModelClient | null;
		getModelMaxTokens(max: number): number;
		backgroundEndpointBusy(): boolean;
	};
	captureStepUsage?: () => (usage: TaskMemoryStepUsage, isCurrent: boolean) => void;
}

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
	#closedDiscovery: Promise<void> | null = null;
	#discovering = false;
	/** The job in flight belongs to a closed session; navigation does not cancel it. */
	#orphanJob = false;
	#promptSelection: MemoryPromptSelection | null = null;
	/** What the last request carried, so lifecycle rows record changes rather than every request. */
	#submittedSection: string | null = null;
	#submittedReminders = new Set<string>();

	configure(infrastructure: MemoryRuntimeInfrastructure): void {
		this.#infrastructure = infrastructure;
	}

	createIntervention(deps: Omit<MemoryInterventionDeps, "bank">): MemoryInterventionRegistration {
		if (this.#registration) throw new Error("memory intervention already bound");
		const original = createMemoryInterventionRegistration({
			...deps,
			// Only a job actually in flight holds the boundary step back. Pending observation
			// work runs only when idle, so waiting on it starved every mid-turn step.
			deferBoundaryPolicy: () => this.#controller !== null,
			onInjectedEntries: (entries) => {
				this.#event("reminder-produced", { count: entries.length, ids: entries.map((entry) => entry.id) });
				deps.onInjectedEntries?.(entries);
			},
			onDurableLessonOutcomes: (input) => {
				if (input.delivered.length) this.#event("durable-lessons-surfaced", { ids: input.delivered });
				if (input.held.length) this.#event("durable-lessons-held", { ids: input.held });
				deps.onDurableLessonOutcomes?.(input);
			},
			onDeliveryOutcomes: (outcomes, final) => {
				this.#event("reminder-outcomes", {
					final,
					outcomes: outcomes.map((outcome) => ({ kind: outcome.kind, ids: outcome.entries.map((entry) => entry.id) })),
				});
				deps.onDeliveryOutcomes?.(outcomes, final);
			},
			bank: this.bank,
			onContentCancelled: () => this.#invalidate("cancelled"),
			onScopeEnd: (input) =>
				deps.onScopeEnd?.({
					...input,
					// The bounded retention job owns these proposals, including its recoverable pending candidates.
					lessons: input.lessons.filter((entry) => !this.#retention.candidateIds?.includes(entry.id)),
				}),
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

	startGuardian(deps: MemoryGuardianDeps): MemoryGuardian {
		if (this.#guardian) throw new Error("memory guardian already bound");
		this.#guardian = createMemoryGuardian({ ...deps, observations: this });
		return this.#guardian;
	}

	reset(): void {
		this.#registration?.reset();
		this.#guardian?.reset();
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
		this.#submittedReminders.clear();
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

	#ready(source: ObservationSource): SessionObservation[] {
		const ready = this.#batches.filter((batch) => !this.#consumed.has(batch.id) && compatibleObservation(batch, source));
		const replaced = new Set(ready.flatMap((batch) => batch.inputs.map((input) => input.id)));
		return ready.filter((batch) => !replaced.has(batch.id));
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
		if (this.#batches.length >= OBSERVATION_MAX_BATCHES) {
			this.#lastReason = "artifact-limit";
			return null;
		}
		const ready = this.#ready(source);
		const covered = new Set(ready.flatMap((batch) => batch.coverage.flatMap((unit) => unit.refs)));
		const units: (typeof source.units)[number][] = [];
		let tokens = 0;
		for (const unit of source.units) {
			if (!unit.complete || unit.refs.some((ref) => covered.has(ref))) {
				if (units.length) break;
				continue;
			}
			if (units.length && unit.exact.length > 0) break;
			const cost = observationTokens(unit.text);
			if (cost > budgets.source) {
				if (units.length) break;
				continue;
			}
			if (tokens + cost > budgets.source) break;
			units.push(unit);
			tokens += cost;
		}
		const revision = observationDigest([
			source.sessionId,
			source.branchAnchorTurnId,
			source.checkpoint,
			sourceCoverageDigest(units),
			source.units.at(-1)?.digest,
			infra.settings(),
		]);
		if (
			units.length > 0 &&
			(tokens >= 512 ||
				source.units.some(
					(unit) => unit.complete && unit.toolCallIds.length > 0 && !unit.refs.some((ref) => covered.has(ref)),
				)) &&
			(this.#attempts.get(revision) ?? 0) < 2
		)
			return { source, units, revision, inputs: [] as SessionObservation[] };
		// A captured reflection is prepared through this same one-in-flight lane.
		if (ready.length >= 2 && ready.reduce((n, batch) => n + observationTokens(batch.rendered), 0) > budgets.journal) {
			const inputs = ready
				.slice()
				.sort(
					(a, b) =>
						source.units.findIndex((unit) => unit.digest === a.coverage[0]?.digest) -
						source.units.findIndex((unit) => unit.digest === b.coverage[0]?.digest),
				);
			const reflectionRevision = observationDigest(inputs.map((batch) => [batch.id, batch.digest]));
			if ((this.#attempts.get(reflectionRevision) ?? 0) < 2)
				return { source, units: inputs.flatMap((batch) => batch.coverage), revision: reflectionRevision, inputs };
		}
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
		// Interrupted retentions come before historical mining: a live cold start spent its
		// first seconds re-mining the closed session while its finished-in-a-second retention waited.
		if (this.#startDiscovery()) return true;
		if (foreground) return this.#controller === null && this.#retentionWork(true) !== null;
		return this.#controller !== null || this.#work() !== null || this.#retentionWork() !== null;
	}

	async runIdleStep(foreground = false): Promise<MemoryStepLaunchOutcome> {
		if (this.#startDiscovery()) await this.#closedDiscovery;
		if (this.#controller) return "none";
		const work = foreground ? null : this.#work();
		const infra = this.#infrastructure;
		const authority = this.#registration?.captureMemoryAuthority();
		if (!work || !infra || !authority) {
			if (this.#retentionWork(foreground)) {
				const result = await this.retainTask("resume", undefined, foreground);
				if (
					[
						"cost_ceiling",
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
			return "none";
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
		const userPrompt = work.inputs.length
			? JSON.stringify({
					consolidate: work.inputs.map((batch) => ({ id: batch.id, digest: batch.digest, notes: batch.notes })),
					sourceRefs: work.units.flatMap((unit) => unit.refs),
					successfulResultRefs: work.units.flatMap((unit) => unit.successfulResultRefs),
				})
			: JSON.stringify({
					source: work.units.map((unit) => JSON.parse(unit.text)),
					successfulResultRefs: work.units.flatMap((unit) => unit.successfulResultRefs),
				});
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
		const usageSink = infra.captureStepUsage?.();
		let usage: TaskMemoryStepUsage | null = null;
		let recorded = false;
		let lateRecorded = false;
		const recordUsage = (next: TaskMemoryStepUsage) => {
			usage = next;
			if (recorded && !lateRecorded) {
				lateRecorded = true;
				usageSink?.(next, false);
			}
		};
		const started = performance.now();
		const timeout = setTimeout(() => controller.abort(new Error("observation deadline")), settings.timeoutMs);
		if (this.#attempts.size >= 128) this.#attempts.delete(this.#attempts.keys().next().value ?? "");
		this.#attempts.set(work.revision, (this.#attempts.get(work.revision) ?? 0) + 1);
		try {
			traceObservation(this.#reflection ? "reflection-input" : "observation-input", {
				source: work.source,
				authority,
				revision: work.revision,
				systemPrompt: OBSERVATION_PROMPT,
				userPrompt,
				maxTokens,
				route: client.route ?? null,
			});
			// Race an abort-ignoring client; late usage still belongs to its captured launch.
			const completion = client.complete({
				purpose: work.inputs.length ? "reflection" : "observation",
				systemPrompt: OBSERVATION_PROMPT,
				userPrompt,
				maxTokens,
				signal: controller.signal,
				onUsage: recordUsage,
			});
			void completion.then(
				(late) => {
					if (recorded && late.usage && !lateRecorded) {
						lateRecorded = true;
						usageSink?.(late.usage, false);
					}
				},
				() => {},
			);
			const aborted = new Promise<never>((_, reject) =>
				controller.signal.addEventListener(
					"abort",
					() => reject(controller.signal.reason ?? new Error("observation cancelled")),
					{ once: true },
				),
			);
			const response = await Promise.race([completion, aborted]);
			usage = response.usage ?? usage;
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
			traceObservation("prepared", { batch });
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
			traceObservation("preparation-failed", { error: error instanceof Error ? error.message : String(error) });
			return "ran";
		} finally {
			clearTimeout(timeout);
			recorded = true;
			if (this.#controller === controller) {
				this.#usage = usage;
				this.#durationMs = performance.now() - started;
			}
			if (usage) usageSink?.(usage, isCurrent());
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
	#retentionWork(orphanOnly = false): {
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
		orphan ??= this.#nextClosedSession(infra, current?.sessionId ?? null);
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

	/** Starts the once-per-process disk discovery; true while it is still reading. */
	#startDiscovery(): boolean {
		const infra = this.#infrastructure;
		if (this.#closedDiscovery === null && infra?.settings().enabled && !this.#disposed) {
			this.#discovering = true;
			this.#closedDiscovery = this.#discoverInterrupted(infra)
				.catch(() => {
					// Discovery is best effort: history review still covers every past session.
				})
				.finally(() => {
					this.#discovering = false;
				});
		}
		return this.#discovering;
	}

	/** The next closed session whose retention a process started and never settled. */
	#nextClosedSession(
		infra: MemoryRuntimeInfrastructure,
		currentSessionId: string | null,
	): { scope: MemoryCommitScope; source: CompletedLessonSource } | null {
		for (let next = this.#closedQueue.shift(); next; next = this.#closedQueue.shift()) {
			if (next.scope.sessionId === currentSessionId) continue;
			if (!retentionSettled(readRetention(retentionPath(infra.stateDir(), next.scope, next.source)))) return next;
		}
		return null;
	}

	/**
	 * Every unsettled retention marker, rebuilt from its own session's ledger
	 * when that session belongs to this workspace and still ends on the task the
	 * marker was written for. No count or age bound: each marker settles once.
	 */
	async #discoverInterrupted(infra: MemoryRuntimeInfrastructure): Promise<void> {
		if (!infra.closedLessonSource) return;
		const directory = join(infra.stateDir(), "memory", "retention");
		let names: string[];
		try {
			names = await readdir(directory);
		} catch {
			return; /* No retention ever ran here. */
		}
		const unsettled = new Map<string, string>();
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const marker = readRetention(join(directory, name));
			const sessionId = (marker as { sessionId?: unknown } | null)?.sessionId;
			if (marker && typeof sessionId === "string" && marker.revision && !retentionSettled(marker))
				unsettled.set(sessionId, marker.revision);
		}
		for (const [sessionId, revision] of unsettled) {
			if (this.#disposed) return;
			const closed = await infra.closedLessonSource(sessionId).catch(() => null);
			if (closed && closed.source.revision === revision) this.#closedQueue.push(closed);
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
		const usageSink = infra.captureStepUsage?.();
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
				...(usageSink ? { onUsage: usageSink } : {}),
				...(judge ? { judge } : {}),
				onProgress: (next) => {
					if (isCurrent()) publish(next);
				},
			});
			if (isCurrent() || orphan) publish(retained);
			if (orphan && this.#orphan === orphan && retentionSettled(retained)) this.#orphan = null;
		} catch (error) {
			if (isCurrent() || orphan)
				publish({ ...EMPTY_RETENTION, phase: "pending", reason: "retention-error", revision: source.revision });
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

	/** Submission follows request admission and actual stream invocation; it does not certify model uptake. */
	recordSubmittedMemoryContext(messages: readonly { role: string; content: unknown }[], systemPrompt?: string): void {
		const selection = this.#promptSelection;
		const section = selection?.section && systemPrompt?.includes(selection.section) ? selection.section : "";
		const at = new Date().toISOString();
		const recordIds = section
			? (selection?.items.filter((item) => item.reason === "selected").map((item) => item.id) ?? [])
			: [];
		if (selection && section) this.#promptSelection = { ...selection, submittedAt: at };
		traceObservation("memory-section-submitted", {
			at,
			sessionId: this.#registration?.captureMemoryAuthority()?.scope.sessionId ?? null,
			turnId: selection?.turnId ?? null,
			text: section,
			recordIds,
		});
		// Lifecycle rows record a change, not every request that carried the same section again.
		const sectionKey = recordIds.length ? observationDigest([selection?.turnId ?? null, section]) : null;
		if (sectionKey !== null && sectionKey !== this.#submittedSection)
			this.#event("memory-section-submitted", { ids: recordIds, count: recordIds.length });
		this.#submittedSection = sectionKey;
		const visible = new Set(
			this.bank
				.snapshot()
				.knowledge.concat(this.bank.snapshot().procedural)
				.map((entry) => entry.id),
		);
		const ids = new Set<string>();
		for (const message of messages) {
			if (message.role !== "user" && message.role !== "toolResult") continue;
			const blocks =
				typeof message.content === "string" ? [message.content] : Array.isArray(message.content) ? message.content : [];
			for (const block of blocks) {
				const text = typeof block === "string" ? block : block?.type === "text" ? block.text : null;
				if (typeof text !== "string") continue;
				for (const line of text.matchAll(/(?:^|\n)Memory:[^\n]*/gu))
					for (const citation of line[0].matchAll(/\[([a-zA-Z0-9_-]+)\]/gu))
						if (citation[1] && visible.has(citation[1])) ids.add(citation[1]);
			}
		}
		const fresh = [...ids].filter((id) => !this.#submittedReminders.has(id));
		for (const id of fresh) this.#submittedReminders.add(id);
		if (fresh.length) this.#event("memory-reminders-submitted", { count: fresh.length, ids: fresh });
	}

	offerCompaction(input: MemoryOfferInput) {
		const current = this.#source();
		if (!current || !this.#registration) return null;
		const guard = this.#registration.isContentCurrent();
		const offer = buildObservationOffer(
			input,
			this.#ready(current),
			() =>
				guard() &&
				this.#enabled &&
				!!this.#infrastructure?.settings().observations.enabled &&
				!!this.#infrastructure?.settings().enabled,
		);
		if (!offer) {
			this.#lastReason = "no-eligible-gain";
			return null;
		}
		if (this.#issued.size >= 4) this.#issued.delete(this.#issued.keys().next().value ?? "");
		this.#issued.set(offer.receipt.offerId, offer.receipt);
		return Object.freeze({ ...offer, onUse: () => this.#event("offer-used", { receipt: offer.receipt }) });
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
	#recordConsumption(commitId: string, receipt: MemoryConsumptionReceipt, event: string): void {
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
	#event(event: string, facts: Record<string, unknown>): void {
		const infra = this.#infrastructure;
		if (infra)
			observationEvent(infra.stateDir(), event, {
				sessionId: this.#registration?.captureMemoryAuthority()?.scope.sessionId ?? null,
				...facts,
			});
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
