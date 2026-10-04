/**
 * The always-on observational memory guardian.
 *
 * The intervention middleware runs model steps at turn boundaries. Between
 * turns nothing used to run at all, so completed work the turn-end pass did
 * not cover, steps that yielded to a busy endpoint, and the repository's
 * earlier sessions were never reviewed. The guardian owns that time. It is a
 * wake-driven loop, not a cadence: it keeps running while there is useful work
 * and the endpoint admits it. When there is none it stops making model calls,
 * and once all history is reviewed only a slow ledger-stat discovery timer
 * remains armed.
 *
 * Priorities, in order:
 *   1. Pending live work after a turn has settled: triggers that yielded to
 *      occupancy, or shell activity no lesson pass has seen.
 *   2. Repository history: the current repository's and its linked worktrees'
 *      earlier sessions, read incrementally from durable cursors.
 *
 * Past the deepest horizon there is no deeper history to open, but the main
 * checkout and its linked worktrees keep writing sessions while this one sits
 * idle. The guardian then looks again on a slow, doubling discovery timer.
 * Each look is a directory listing and ledger stats against the durable
 * cursors, so unchanged ledgers never reach a model.
 *
 * Idle time sets depth, never a quota. Right after a turn, and during one, the
 * guardian reads only the newest history in short excerpts; the longer the
 * session stays idle, the older the sessions it reaches and the longer each
 * excerpt and request may be. During a turn it still works when the memory
 * endpoint admits it (an independent secondary endpoint, or spare slots on a
 * shared one); admission refuses it otherwise, and a foreground claim preempts
 * a request already holding a one-slot shared endpoint.
 *
 * Every model call goes through the same routed client and endpoint admission
 * as the boundary steps, so capacity, fallback, cache-disturbance accounting
 * and information-flow admission are the existing ones. Lessons it finds are
 * handed to the composition root with their source session; the durable
 * store's own gate decides what they become.
 */

import { performance } from "node:perf_hooks";
import type { HistoryReviewSlice, HistoryReviewSource } from "../memory/history-review.js";
import { lessonEvidence } from "../memory/lesson-evidence.js";
import type { TaskMemoryEntry } from "../memory/task-bank.js";
import { TaskMemoryBank } from "../memory/task-bank.js";
import type {
	TaskMemoryModelClient,
	TaskMemoryPolicyResult,
	TaskMemoryStepUsage,
} from "../memory/task-memory-policy.js";
import { runTaskMemoryPolicy } from "../memory/task-memory-policy.js";
import type { TaskMemoryGuardianState } from "../memory/task-memory-status.js";
import type { TaskMemoryTelemetrySink } from "../memory/task-memory-telemetry.js";
import { taskMemoryBankDelta } from "../memory/task-memory-telemetry.js";
import { MEMORY_HISTORY_REVIEW_SYSTEM_PROMPT } from "../prompts/memory-intervention.js";
import type { MemoryInterventionRegistration, MemoryStepLaunchOutcome } from "./memory-intervention.js";

/** What operator surfaces show for the guardian. `off` covers a disabled or rules-only tier. */
export type MemoryGuardianState = TaskMemoryGuardianState;

interface GuardianDepth {
	/** Idle time after which this depth applies. */
	afterIdleMs: number;
	/** How far back session history is read. */
	horizonMs: number;
	/** Excerpt budget for one request. */
	maxChars: number;
	/** Request deadline relative to the configured memory timeout. */
	timeoutScale: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEPTHS: ReadonlyArray<GuardianDepth> = [
	{ afterIdleMs: 0, horizonMs: DAY_MS, maxChars: 2_000, timeoutScale: 1 },
	{ afterIdleMs: 20_000, horizonMs: 7 * DAY_MS, maxChars: 4_000, timeoutScale: 1 },
	{ afterIdleMs: 3 * 60_000, horizonMs: 30 * DAY_MS, maxChars: 8_000, timeoutScale: 1.5 },
	{ afterIdleMs: 15 * 60_000, horizonMs: Number.POSITIVE_INFINITY, maxChars: 12_000, timeoutScale: 2 },
];
/** Lets a just-finished turn release its endpoint slot before the guardian looks. */
const WAKE_DEBOUNCE_MS = 1_500;
const CAPACITY_RETRY_MIN_MS = 2_000;
const CAPACITY_RETRY_MAX_MS = 30_000;
/** Discovery looks for new related-checkout sessions once the deepest horizon is exhausted. */
const DISCOVERY_MIN_MS = 60_000;
const DISCOVERY_MAX_MS = 10 * 60_000;
/** Ledger bytes one wake may read before it yields to the event loop. */
const HISTORY_READ_BYTES_PER_WAKE = 8 * 1024 * 1024;
/**
 * Two unusable answers in a row (full deadlines or malformed envelopes) park
 * the model tier until the next turn, like the boundary steps' backoff. The
 * excerpt stays unreviewed and is offered again after that wake.
 */
const HISTORY_UNANSWERED_LIMIT = 2;

export interface MemoryGuardianClient {
	getModelClient(): TaskMemoryModelClient | null;
	getFallbackModelClient(): TaskMemoryModelClient | null;
	getModelMaxTokens(configuredMaxTokens: number): number;
	backgroundEndpointBusy(): boolean;
}

export interface MemoryGuardianDeps {
	/** Memory on and a model tier configured. False parks the guardian in `off`. */
	enabled(): boolean;
	/** True while the visible turn is streaming. */
	isForegroundActive(): boolean;
	live: Pick<MemoryInterventionRegistration, "pendingWork" | "runIdleStep" | "stepInFlight">;
	/** History source for the current session and repository, rebuilt when either changes. */
	historySource(): HistoryReviewSource | null;
	/** Its own routed client: capacity and fallback state must not race the boundary steps' client. */
	client: MemoryGuardianClient;
	settings(): { maxTokens: number; timeoutMs: number };
	/** Current checkout a source-cited lesson's quote is verified against. */
	workspaceRoot(): string;
	getKeptLessons(): ReadonlyArray<{ id: string; text: string }>;
	/** Lessons from one history excerpt, with the session that produced them. */
	onHistoryLessons(input: {
		sessionId: string;
		root: string;
		grounded: ReadonlyArray<TaskMemoryEntry>;
		ungrounded: ReadonlyArray<TaskMemoryEntry>;
	}): void;
	captureStepUsage?: () => (usage: TaskMemoryStepUsage, isCurrent: boolean) => void;
	telemetry?: TaskMemoryTelemetrySink;
	onStateChange(state: MemoryGuardianState): void;
	/** Session and workspace the history source belongs to; a change retires in-flight history work. */
	scopeKey(): string;
}

export interface MemoryGuardian {
	state(): MemoryGuardianState;
	/** A turn started or ended, a step settled, or settings changed. Cheap and synchronous. */
	wake(reason: "turn-start" | "turn-end" | "step-settled" | "settings" | "ready"): void;
	/** Retire in-flight work and results for a session, branch or repository change. */
	reset(): void;
	dispose(): void;
}

export function createMemoryGuardian(deps: MemoryGuardianDeps): MemoryGuardian {
	let generation = 0;
	let disposed = false;
	let running = false;
	let timer: NodeJS.Timeout | null = null;
	/**
	 * A wake arrived while a tick was running. The running tick may belong to a
	 * retired generation and return without scheduling anything, so the wake is
	 * kept here and replayed when it finishes instead of being lost.
	 */
	let wakePending = false;
	let current: MemoryGuardianState = "idle";
	// Monotonic: idle spans live inside one process and must not jump with the wall clock.
	let idleSinceMs = performance.now();
	let controller = new AbortController();
	let capacityRetryMs = CAPACITY_RETRY_MIN_MS;
	let discoveryMs = DISCOVERY_MIN_MS;
	let historyUnanswered = 0;
	/** The model tier failed; stay parked until a turn or settings change says to look again. */
	let parkedUnavailable = false;
	let source: HistoryReviewSource | null = null;
	let sourceScope: string | null = null;

	const setState = (next: MemoryGuardianState): void => {
		if (next === current) return;
		current = next;
		try {
			deps.onStateChange(next);
		} catch {
			// Status publication never steers the guardian.
		}
	};
	const schedule = (delayMs: number): void => {
		if (disposed) return;
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(
			() => {
				timer = null;
				void tick();
			},
			Math.max(0, delayMs),
		);
		timer.unref?.();
	};
	const retire = (): void => {
		generation += 1;
		controller.abort();
		controller = new AbortController();
		if (timer !== null) clearTimeout(timer);
		timer = null;
		source = null;
		historyUnanswered = 0;
		parkedUnavailable = false;
		capacityRetryMs = CAPACITY_RETRY_MIN_MS;
		discoveryMs = DISCOVERY_MIN_MS;
		idleSinceMs = performance.now();
	};

	async function tick(): Promise<void> {
		if (disposed) return;
		if (running) {
			wakePending = true;
			return;
		}
		running = true;
		wakePending = false;
		const stepGeneration = generation;
		let next: number | null = null;
		try {
			next = await step(stepGeneration);
		} catch {
			// A guardian failure is never the session's failure; look again on the next wake.
			if (stepGeneration === generation) setState("idle");
		} finally {
			running = false;
		}
		if (disposed) return;
		if (wakePending) {
			// A wake (reset, settings, turn end) landed during this tick; it wins
			// over whatever a possibly retired tick decided.
			wakePending = false;
			schedule(0);
		} else if (stepGeneration === generation && next !== null) schedule(next);
	}

	/** One unit of work. Returns the delay before the next look, or null to park until a wake. */
	async function step(stepGeneration: number): Promise<number | null> {
		if (!deps.enabled()) {
			setState("off");
			return null;
		}
		if (parkedUnavailable) {
			setState("unavailable");
			return null;
		}
		const foreground = deps.isForegroundActive();
		if (deps.live.stepInFlight()) {
			// The boundary step's settlement wakes the guardian again.
			setState("reviewing");
			return null;
		}
		// Live review waits for the turn to settle: mid-turn, the boundary steps own
		// the trajectory and a lesson pass would read an unfinished turn.
		if (!foreground && deps.live.pendingWork()) {
			setState("reviewing");
			const outcome = await deps.live.runIdleStep();
			if (stepGeneration !== generation) return null;
			return afterOutcome(outcome);
		}
		const scope = deps.scopeKey();
		if (scope !== sourceScope) {
			// A new session or repository: whatever the old source was reading
			// belongs to a scope this guardian no longer serves.
			source = null;
			sourceScope = scope;
		}
		source ??= deps.historySource();
		if (source === null) {
			setState("idle");
			return null;
		}
		const idleMs = foreground ? 0 : performance.now() - idleSinceMs;
		const depthIndex = foreground ? 0 : deepestDepth(idleMs);
		const depth = DEPTHS[depthIndex] ?? DEPTHS[0];
		if (depth === undefined) return null;
		const { slice, exhausted } = source.next({
			horizonMs: depth.horizonMs,
			maxChars: depth.maxChars,
			maxReadBytes: HISTORY_READ_BYTES_PER_WAKE,
		});
		if (slice === null) {
			if (!exhausted) return 0;
			setState("idle");
			// Nothing new in range. A deeper horizon opens only with more idle time;
			// mid-turn, the turn's end wakes the guardian.
			if (foreground) return null;
			const deeper = DEPTHS[depthIndex + 1];
			if (deeper !== undefined) return Math.max(0, idleSinceMs + deeper.afterIdleMs - performance.now());
			// All history is reviewed, but a related checkout may still record
			// sessions. Rebuild the source on the next look so a newly linked
			// worktree and another process's cursor progress are both seen.
			source = null;
			const delay = discoveryMs;
			discoveryMs = Math.min(DISCOVERY_MAX_MS, discoveryMs * 2);
			return delay;
		}
		discoveryMs = DISCOVERY_MIN_MS;
		setState("reviewing");
		const outcome = await reviewHistory(slice, depth, stepGeneration);
		if (stepGeneration !== generation) return null;
		return afterOutcome(outcome);
	}

	function afterOutcome(outcome: MemoryStepLaunchOutcome): number | null {
		switch (outcome) {
			case "yielded": {
				setState("waiting-capacity");
				const delay = capacityRetryMs;
				capacityRetryMs = Math.min(CAPACITY_RETRY_MAX_MS, capacityRetryMs * 2);
				return delay;
			}
			case "unavailable":
				parkedUnavailable = true;
				setState("unavailable");
				return null;
			default:
				capacityRetryMs = CAPACITY_RETRY_MIN_MS;
				// More may be waiting; look again at once instead of on a timer.
				return 0;
		}
	}

	async function reviewHistory(
		slice: HistoryReviewSlice,
		depth: GuardianDepth,
		stepGeneration: number,
	): Promise<MemoryStepLaunchOutcome> {
		const isCurrent = () => !disposed && stepGeneration === generation;
		let client: TaskMemoryModelClient | null;
		try {
			client = deps.client.getModelClient();
		} catch {
			return "unavailable";
		}
		if (client === null) return "unavailable";
		if (deps.client.backgroundEndpointBusy()) return "yielded";
		const live = deps.settings();
		const usageSink = deps.captureStepUsage?.();
		const bank = new TaskMemoryBank();
		const run = (selected: TaskMemoryModelClient): Promise<TaskMemoryPolicyResult> => {
			const started = process.hrtime.bigint();
			return runTaskMemoryPolicy(bank, selected, {
				isCurrent,
				signal: controller.signal,
				onStepUsage: (usage) => usageSink?.(usage, isCurrent()),
				task: "Review an earlier session in this repository for lessons a future session needs.",
				trajectory: [],
				deterministicTrigger: false,
				maxTokens: live.maxTokens,
				modelMaxTokens: deps.client.getModelMaxTokens(live.maxTokens),
				timeoutMs: Math.round(live.timeoutMs * depth.timeoutScale),
				pass: {
					systemPrompt: MEMORY_HISTORY_REVIEW_SYSTEM_PROMPT,
					trajectoryText: slice.text,
					keptLessons: safeKeptLessons(),
					trajectoryMaxChars: depth.maxChars,
				},
			}).then((result) => {
				record(result, selected, started);
				return result;
			});
		};
		let result = await run(client);
		if ((result.reason === "client_error" || result.reason === "information_flow_blocked") && isCurrent()) {
			let fallback: TaskMemoryModelClient | null = null;
			try {
				fallback = deps.client.getFallbackModelClient();
			} catch {
				fallback = null;
			}
			if (fallback !== null && !deps.client.backgroundEndpointBusy()) result = await run(fallback);
		}
		if (!isCurrent()) return "none";
		if (result.reason === "endpoint_busy" || result.reason === "endpoint_preempted") return "yielded";
		if (result.reason === "client_error" || result.reason === "information_flow_blocked" || result.reason === "no_client")
			return "unavailable";
		// A malformed envelope is a rejected answer, not a review: committing it
		// would retire the excerpt with nothing learned from it.
		if (result.decision === "timeout" || result.decision === "malformed") {
			historyUnanswered += 1;
			return historyUnanswered >= HISTORY_UNANSWERED_LIMIT ? "unavailable" : "ran";
		}
		historyUnanswered = 0;
		// The excerpt was answered, whatever the answer chose to keep: it is reviewed.
		source?.commit(slice);
		const lessons = bank.snapshot().knowledge.filter((entry) => entry.durable === true);
		const root = deps.workspaceRoot();
		const grounded = lessons.filter(
			(entry) =>
				lessonEvidence(entry, {
					succeededCommands: slice.succeededCommands,
					observedReads: slice.observedReads,
					workspaceRoot: root,
				}) !== null,
		);
		const ungrounded = lessons.filter((entry) => !grounded.includes(entry));
		if (lessons.length > 0) {
			try {
				deps.onHistoryLessons({ sessionId: slice.sessionId, root: slice.root, grounded, ungrounded });
			} catch {
				// The store's failure is the composition root's to report.
			}
		}
		return "ran";
	}

	function record(result: TaskMemoryPolicyResult, client: TaskMemoryModelClient, started: bigint): void {
		try {
			deps.telemetry?.record({
				triggerReasons: ["idle_review"],
				tier: "llm",
				bankDelta: taskMemoryBankDelta(EMPTY_SNAPSHOT, EMPTY_SNAPSHOT),
				decision: result.reason === "endpoint_busy" || result.reason === "endpoint_preempted" ? "dropped" : result.decision,
				reason: result.reason,
				bankOperations: result.bankOperations,
				droppedOperations: result.droppedOperations,
				citedEntries: 0,
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				latencyMs: Number(process.hrtime.bigint() - started) / 1_000_000,
				...(client.route === undefined ? {} : { route: client.route }),
			});
		} catch {
			// Observability must never steer the guardian.
		}
	}

	function safeKeptLessons(): ReadonlyArray<{ id: string; text: string }> {
		try {
			return deps.getKeptLessons();
		} catch {
			return [];
		}
	}

	return {
		state: () => current,
		wake(reason) {
			if (disposed) return;
			if (reason === "turn-end" || reason === "turn-start") {
				idleSinceMs = performance.now();
				discoveryMs = DISCOVERY_MIN_MS;
			}
			if (reason === "turn-end" || reason === "settings") {
				parkedUnavailable = false;
				historyUnanswered = 0;
				capacityRetryMs = CAPACITY_RETRY_MIN_MS;
			}
			schedule(reason === "turn-end" ? WAKE_DEBOUNCE_MS : 0);
		},
		reset() {
			if (disposed) return;
			retire();
			setState(deps.enabled() ? "idle" : "off");
			schedule(WAKE_DEBOUNCE_MS);
		},
		dispose() {
			if (disposed) return;
			retire();
			disposed = true;
			setState("off");
		},
	};
}

const EMPTY_SNAPSHOT = new TaskMemoryBank().snapshot();

function deepestDepth(idleMs: number): number {
	let index = 0;
	for (let candidate = 0; candidate < DEPTHS.length; candidate += 1) {
		if ((DEPTHS[candidate]?.afterIdleMs ?? Number.POSITIVE_INFINITY) <= idleMs) index = candidate;
	}
	return index;
}
