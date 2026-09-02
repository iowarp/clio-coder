/**
 * Reactive observability projection. Folds the dispatch, provider, and
 * diagnostic bus channels plus the session cost/telemetry trackers into a
 * single bounded {@link ObservabilitySnapshot} that product surfaces (footer,
 * overlays, CLI status) can consume through one seam.
 *
 * Design constraints for this slice:
 * - Bus listeners stay cheap. The bus is synchronous, so each handler only
 *   mutates in-memory state and marks the projection changed; the actual
 *   snapshot build and listener fan-out happen on a short debounce so a burst
 *   of DispatchProgress events coalesces into one notification.
 * - The snapshot never stores raw worker output, tool arguments, or transcript
 *   text. Run summaries carry compact lifecycle fields; notices carry a short
 *   rendered message and a reference id, nothing more.
 * - Run summaries and notices are bounded rings so a long-lived session cannot
 *   grow the projection without limit.
 */

import { BusChannels } from "../../core/bus-events.js";
import { resolveDispatchFailureStatus } from "../../core/dispatch-outcome.js";
import type { SafeEventBus } from "../../core/event-bus.js";
import type { TargetStatus } from "../providers/contract.js";
import { resolveCostProvenance } from "../providers/types/cost-provenance.js";
import type { AccountabilitySummary } from "./accountability.js";
import type {
	ObservabilityNotice,
	ObservabilityRunEvidence,
	ObservabilityRunSummary,
	ObservabilitySnapshot,
	TokenThroughputSnapshot,
} from "./contract.js";
import type { CostAggregate, UsageBreakdown } from "./cost.js";
import type { MetricsView } from "./metrics.js";

/** Recent run summaries retained. Mirrors the dispatch board's window. */
export const MAX_PROJECTION_RUNS = 50;
/** Recent notices retained across all kinds. */
export const MAX_PROJECTION_NOTICES = 100;
/** Debounce for coalescing listener notifications, in milliseconds. */
export const PROJECTION_FLUSH_DEBOUNCE_MS = 16;

/**
 * Read model the projection folds session-local state from. The extension owns
 * the cost/telemetry trackers and the latest-throughput register; the
 * projection reads them at snapshot-build time so ordering with the extension's
 * own bus handlers never matters (both run synchronously before the debounced
 * build).
 */
export interface ProjectionReadModel {
	metrics(): MetricsView;
	sessionCost(): number;
	sessionCostSummary(): CostAggregate;
	sessionTokens(): UsageBreakdown;
	latestThroughput(): TokenThroughputSnapshot | null;
	readAccountability(): AccountabilitySummary;
}

export interface ObservabilityProjection {
	snapshot(): ObservabilitySnapshot;
	subscribe(listener: (snapshot: ObservabilitySnapshot) => void): () => void;
	/** Recompute after a direct session mutation (recordTokens/resetSession/safety counter). */
	refresh(): void;
	/** A forensic evidence build for `runId` has started. */
	evidenceBuildStarted(runId: string): void;
	/** The evidence bundle for `runId` finalized and its index row landed. */
	evidenceBuildSucceeded(runId: string, evidence: ObservabilityRunEvidence): void;
	/** The evidence build for `runId` failed; surface a bounded notice. */
	evidenceBuildFailed(runId: string, message: string): void;
	/** Detach bus listeners and cancel any pending flush. */
	stop(): void;
}

// --- small runtime coercions. Bus payloads that crossed a process boundary
// (DispatchProgress.event) are not validated, so every read is defensive. ---

function str(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asRunId(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isTerminal(status: ObservabilityRunSummary["status"]): boolean {
	return status === "completed" || status === "failed" || status === "aborted" || status === "dead";
}

function resolveHeartbeat(status: unknown): ObservabilityRunSummary["status"] | null {
	if (status === "alive") return "running";
	if (status === "stale") return "stale";
	if (status === "dead") return "dead";
	return null;
}

/** Build a notice ref from candidate parts, dropping anything non-string/empty. */
function makeRef(parts: Record<string, unknown>): ObservabilityNotice["ref"] | undefined {
	const ref: Record<string, string> = {};
	for (const [key, value] of Object.entries(parts)) {
		if (typeof value === "string" && value.length > 0) ref[key] = value;
	}
	return Object.keys(ref).length > 0 ? (ref as ObservabilityNotice["ref"]) : undefined;
}

/** Shared identity fields carried on every dispatch lifecycle event. */
interface RunIdentityLike {
	agentId?: unknown;
	targetId?: unknown;
	wireModelId?: unknown;
	runtimeId?: unknown;
	runtimeKind?: unknown;
}

export function createObservabilityProjection(bus: SafeEventBus, deps: ProjectionReadModel): ObservabilityProjection {
	const runs = new Map<string, ObservabilityRunSummary>();
	const notices: ObservabilityNotice[] = [];
	const providerHealth = new Map<string, TargetStatus>();
	const pendingEvidence = new Set<string>();
	let accountability: AccountabilitySummary = deps.readAccountability();
	let revision = 0;
	let noticeSeq = 0;

	const listeners = new Set<(snapshot: ObservabilitySnapshot) => void>();
	let flushTimer: ReturnType<typeof setTimeout> | null = null;

	function buildSnapshot(): ObservabilitySnapshot {
		const providerHealthRecord: Record<string, TargetStatus> = {};
		for (const [id, status] of providerHealth) providerHealthRecord[id] = status;
		return {
			revision,
			generatedAt: Date.now(),
			session: {
				costUsd: deps.sessionCost(),
				cost: deps.sessionCostSummary(),
				tokens: deps.sessionTokens(),
				latestThroughput: deps.latestThroughput(),
			},
			metrics: deps.metrics(),
			accountability,
			// Newest-first: Map preserves first-seen (enqueue) order, so reversing
			// surfaces the most recently started runs at the head of the list.
			runs: [...runs.values()].reverse(),
			providerHealth: providerHealthRecord,
			notices: [...notices],
			pendingEvidenceBuildRunIds: [...pendingEvidence],
		};
	}

	function flush(): void {
		flushTimer = null;
		if (listeners.size === 0) return;
		const snapshot = buildSnapshot();
		for (const listener of [...listeners]) {
			try {
				listener(snapshot);
			} catch (error) {
				const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
				console.error(`[clio-coder:observability] projection listener crashed: ${message}`);
			}
		}
	}

	function scheduleFlush(): void {
		if (flushTimer !== null) return;
		flushTimer = setTimeout(flush, PROJECTION_FLUSH_DEBOUNCE_MS);
		// A pending flush must never keep a one-shot `clio-coder run` process alive.
		flushTimer.unref?.();
	}

	function markChanged(): void {
		revision += 1;
		scheduleFlush();
	}

	function putRun(runId: string, summary: ObservabilityRunSummary): void {
		runs.set(runId, summary);
		while (runs.size > MAX_PROJECTION_RUNS) {
			const oldest = runs.keys().next().value;
			if (oldest === undefined) break;
			runs.delete(oldest);
		}
	}

	function emptyRun(runId: string, now: number): ObservabilityRunSummary {
		return {
			runId,
			agentId: "-",
			status: "enqueued",
			startedAtMs: now,
			updatedAtMs: now,
			finishedAtMs: null,
			durationMs: null,
			tokens: { input: 0, output: 0, reasoning: 0, total: 0 },
			costUsd: 0,
			costProvenance: "unknown",
		};
	}

	function applyIdentity(summary: ObservabilityRunSummary, id: RunIdentityLike): void {
		if (typeof id.agentId === "string" && id.agentId.length > 0) summary.agentId = id.agentId;
		if (typeof id.targetId === "string" && id.targetId.length > 0) summary.targetId = id.targetId;
		if (typeof id.wireModelId === "string" && id.wireModelId.length > 0) summary.modelId = id.wireModelId;
		if (typeof id.runtimeId === "string" && id.runtimeId.length > 0) summary.runtimeId = id.runtimeId;
		if (typeof id.runtimeKind === "string" && id.runtimeKind.length > 0) summary.runtimeKind = id.runtimeKind;
	}

	// num()'s Number.isFinite check matters here specifically: a NaN or
	// Infinity costUsd/tokenCount from a payload used to pass the bare
	// `typeof === "number"` check this function had instead, so the projection
	// could corrupt a run's running total on a malformed terminal payload while
	// the dispatch board's parseFiniteNumber (an identical check) rejected it.
	function applyTerminalTokens(summary: ObservabilityRunSummary, payload: Record<string, unknown>): void {
		summary.tokens.total = num(payload.tokenCount, summary.tokens.total);
		if (typeof payload.inputTokenCount === "number") {
			summary.tokens.input = num(payload.inputTokenCount, summary.tokens.input) + num(payload.cacheReadTokenCount, 0);
		}
		summary.tokens.output = num(payload.outputTokenCount, summary.tokens.output);
		summary.tokens.reasoning = num(payload.reasoningTokenCount, summary.tokens.reasoning);
		summary.costUsd = num(payload.costUsd, summary.costUsd);
		summary.costProvenance = resolveCostProvenance(payload.costProvenance, summary.costProvenance);
	}

	function pushNotice(
		kind: ObservabilityNotice["kind"],
		level: ObservabilityNotice["level"],
		message: string,
		ref?: ObservabilityNotice["ref"],
	): void {
		const notice: ObservabilityNotice = {
			id: `n${noticeSeq++}`,
			at: Date.now(),
			kind,
			level,
			message,
			...(ref ? { ref } : {}),
		};
		notices.push(notice);
		if (notices.length > MAX_PROJECTION_NOTICES) {
			notices.splice(0, notices.length - MAX_PROJECTION_NOTICES);
		}
		markChanged();
	}

	const unsubscribes: Array<() => void> = [
		bus.on(BusChannels.DispatchEnqueued, (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			const runId = asRunId(payload.runId);
			if (!runId) return;
			const now = Date.now();
			const summary = runs.get(runId) ?? emptyRun(runId, now);
			applyIdentity(summary, payload);
			summary.status = "enqueued";
			summary.updatedAtMs = now;
			putRun(runId, summary);
			markChanged();
		}),
		bus.on(BusChannels.DispatchStarted, (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			const runId = asRunId(payload.runId);
			if (!runId) return;
			const now = Date.now();
			const summary = runs.get(runId) ?? emptyRun(runId, now);
			applyIdentity(summary, payload);
			summary.status = "running";
			summary.startedAtMs = now;
			summary.updatedAtMs = now;
			summary.finishedAtMs = null;
			summary.durationMs = null;
			putRun(runId, summary);
			markChanged();
		}),
		bus.on(BusChannels.DispatchProgress, (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			const runId = asRunId(payload.runId);
			if (!runId) return;
			// Only track progress for a run we already know; a bare progress relay
			// carries no identity to seed a summary from.
			const summary = runs.get(runId);
			if (!summary) return;
			const now = Date.now();
			summary.updatedAtMs = now;
			const event = (payload.event ?? {}) as Record<string, unknown>;
			const type = typeof event.type === "string" ? event.type : "";
			if (type === "heartbeat_status") {
				const status = resolveHeartbeat(event.status);
				if (status && !isTerminal(summary.status)) summary.status = status;
				markChanged();
				return;
			}
			if (type === "message_end" && !isTerminal(summary.status)) {
				const message = (event.message ?? {}) as { role?: unknown; usage?: Record<string, unknown> };
				if (message.role === "assistant" && message.usage) {
					const input = num(message.usage.input, 0) + num(message.usage.cacheRead, 0);
					const output = num(message.usage.output, 0);
					summary.tokens.input += input;
					summary.tokens.output += output;
					summary.tokens.total += input + output + num(message.usage.cacheWrite, 0);
				}
			}
			markChanged();
		}),
		bus.on(BusChannels.DispatchCompleted, (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			const runId = asRunId(payload.runId);
			if (!runId) return;
			const now = Date.now();
			const summary = runs.get(runId) ?? emptyRun(runId, now);
			applyIdentity(summary, payload);
			summary.status = "completed";
			summary.updatedAtMs = now;
			summary.finishedAtMs = now;
			summary.durationMs = num(payload.durationMs, Math.max(0, now - summary.startedAtMs));
			applyTerminalTokens(summary, payload);
			summary.outcome = str(payload.outcome, "succeeded");
			summary.outcomeDetail = typeof payload.outcomeDetail === "string" ? payload.outcomeDetail : null;
			putRun(runId, summary);
			markChanged();
		}),
		bus.on(BusChannels.DispatchFailed, (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			const runId = asRunId(payload.runId);
			if (!runId) return;
			const now = Date.now();
			const summary = runs.get(runId) ?? emptyRun(runId, now);
			applyIdentity(summary, payload);
			summary.status = resolveDispatchFailureStatus(payload.reason);
			summary.updatedAtMs = now;
			summary.finishedAtMs = now;
			summary.durationMs = num(payload.durationMs, Math.max(0, now - summary.startedAtMs));
			applyTerminalTokens(summary, payload);
			summary.outcome = str(payload.outcome, str(payload.reason, "failed"));
			summary.outcomeDetail = typeof payload.outcomeDetail === "string" ? payload.outcomeDetail : null;
			putRun(runId, summary);
			markChanged();
		}),
		bus.on(BusChannels.ProviderHealth, (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			if (typeof payload.id !== "string" || payload.id.length === 0) return;
			// status is the full TargetStatus record (an object); store it as-is.
			if (payload.status === null || typeof payload.status !== "object") return;
			providerHealth.set(payload.id, payload.status as TargetStatus);
			markChanged();
		}),
	];

	return {
		snapshot: buildSnapshot,
		subscribe(listener) {
			listeners.add(listener);
			listener(buildSnapshot());
			return () => {
				listeners.delete(listener);
			};
		},
		refresh() {
			markChanged();
		},
		evidenceBuildStarted(runId) {
			if (typeof runId !== "string" || runId.length === 0) return;
			pendingEvidence.add(runId);
			markChanged();
		},
		evidenceBuildSucceeded(runId, evidence) {
			pendingEvidence.delete(runId);
			const summary = runs.get(runId);
			if (summary) {
				summary.evidence = {
					evidenceId: evidence.evidenceId,
					firstPassSuccess: evidence.firstPassSuccess,
					findingCount: evidence.findingCount,
					tags: [...evidence.tags],
				};
			}
			// The index row that feeds accountability was written before this fires,
			// so refresh the cached summary from the sidecar index.
			accountability = deps.readAccountability();
			markChanged();
		},
		evidenceBuildFailed(runId, message) {
			pendingEvidence.delete(runId);
			pushNotice(
				"evidence",
				"warning",
				message.length > 0 ? message : `evidence build failed for ${runId}`,
				makeRef({ runId }),
			);
		},
		stop() {
			for (const off of unsubscribes) off();
			unsubscribes.length = 0;
			if (flushTimer !== null) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			listeners.clear();
		},
	};
}
