import { Value } from "typebox/value";
import { writeDiagnostic } from "../../core/diagnostics.js";
import { normalizeTokenUsage } from "../../core/token-split.js";
/**
 * Reactive telemetry projection. Folds the dispatch and evidence bus
 * channels and the latest throughput into a single bounded
 * {@link TelemetrySnapshot} that product surfaces (footer, overlays, the
 * dispatch board) consume through one seam.
 *
 * Design constraints for this slice:
 * - Bus listeners stay cheap. The bus is synchronous, so each handler only
 *   mutates in-memory state and marks the projection changed; the actual
 *   snapshot build and listener fan-out happen on a short debounce so a burst
 *   of DispatchProgress events coalesces into one notification.
 * - Worker progress retains only bounded answer text and redacted action
 *   descriptors. Tool arguments and reasoning are never stored.
 * - Terminal history is bounded; active runs remain until settlement.
 */

import { resolveDispatchFailureStatus } from "../../core/dispatch-outcome.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { DispatchRunIdentity } from "../../core/telemetry/live-events.js";
import { unobservedRunUsageFacts } from "../../core/telemetry/pricing.js";
import { type RunUsageFacts, RunUsageFactsSchema } from "../../core/telemetry/schemas.js";
import { truncateToWidth } from "../../engine/tui-primitives.js";
import type { AgentAudience } from "../agents/spec.js";
import { cloneRunToolBudgetEnvelope, type RunToolBudgetEnvelope } from "../dispatch/budget-envelope.js";
import type { DispatchSnapshot } from "../dispatch/contract.js";
import type { DispatchRequestOrigin, RunKind } from "../dispatch/types.js";
import { summarizeTrustStatus } from "../evidence/trust-projection.js";
import { sanitizeCallTargetText } from "../safety/call-target.js";
import type {
	TelemetryRunProjection,
	TelemetryRunReaders,
	TelemetryRunSummary,
	TelemetrySnapshot,
} from "./contract.js";
import { createWorkerProgressFold, type WorkerProgressFold } from "./worker-progress.js";

/** Settled run summaries retained, in addition to all active runs. */
export const MAX_PROJECTION_RUNS = 50;
/** Debounce for coalescing listener notifications, in milliseconds. */
export const PROJECTION_FLUSH_DEBOUNCE_MS = 16;

/**
 * What the projection reads beside the bus: the dispatch and run-result readers. Session spend, tokens and timing are
 * the telemetry read model's, never the projection's (#434).
 */
export type ProjectionReadModel = TelemetryRunReaders;

export interface TelemetryProjection extends TelemetryRunProjection {
	snapshot(): TelemetrySnapshot;
	subscribe(listener: (snapshot: TelemetrySnapshot) => void): () => void;
	/** Recompute after a direct session mutation (resetSession/throughput). */
	refresh(): void;
	/** Detach bus listeners and cancel any pending flush. */
	stop(): void;
}

// --- small runtime coercions. Bus payloads that crossed a process boundary
// (DispatchProgress.event) are not validated, so every read is defensive. ---

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asRunId(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isTerminal(status: TelemetryRunSummary["status"]): boolean {
	return status === "completed" || status === "failed" || status === "aborted" || status === "dead";
}

function resolveHeartbeat(status: unknown): TelemetryRunSummary["status"] | null {
	if (status === "alive") return "running";
	if (status === "stale") return "stale";
	if (status === "dead") return "dead";
	return null;
}

interface RunEntry extends TelemetryRunSummary {
	progressFold: WorkerProgressFold;
}

const TASK_SUMMARY_MAX_WIDTH = 240;

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

function parseEndpointCapacity(value: unknown): TelemetryRunSummary["endpoint"] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as { key?: unknown; label?: unknown; limit?: unknown };
	const key = parseNonEmptyString(record.key);
	const label = parseNonEmptyString(record.label);
	const limit = parsePositiveInt(record.limit);
	return key === undefined || label === undefined || limit === undefined ? undefined : { key, label, limit };
}

function parseCouncilBadge(value: unknown): TelemetryRunSummary["council"] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as { group?: unknown; label?: unknown; color?: unknown; round?: unknown };
	const group = parseNonEmptyString(record.group);
	const label = parseNonEmptyString(record.label);
	const round = parsePositiveInt(record.round);
	if (group === undefined || label === undefined || round === undefined) return undefined;
	return {
		group,
		label,
		...(typeof record.color === "string" && record.color.length > 0 ? { color: record.color } : {}),
		round,
	};
}

function sanitizeDispatchTaskSummary(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const sanitized = sanitizeCallTargetText(value);
	if (sanitized.length === 0) return undefined;
	// pi-tui's truncator appends reset sequences when it elides. Strip those
	// again so the stored projection remains plain text, not terminal styling.
	return sanitizeCallTargetText(truncateToWidth(sanitized, TASK_SUMMARY_MAX_WIDTH, "…", false));
}

function parseRetrySnapshot(
	value: DispatchSnapshot["retrying"][number],
): NonNullable<TelemetryRunSummary["retry"]> | null {
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
): Map<string, { agentId: string; taskSummary?: string; retry: NonNullable<TelemetryRunSummary["retry"]> }> {
	const retrying = new Map<
		string,
		{ agentId: string; taskSummary?: string; retry: NonNullable<TelemetryRunSummary["retry"]> }
	>();
	try {
		for (const value of snapshot.retrying) {
			const runId = asRunId(value.runId);
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
		// The projection remains lifecycle-event driven if an optional snapshot fails.
	}
	return retrying;
}

function readRunningSnapshot(
	snapshot: DispatchSnapshot,
): Map<string, { spend: RunUsageFacts; outcomePhase: string; budget?: RunToolBudgetEnvelope }> {
	const running = new Map<string, { spend: RunUsageFacts; outcomePhase: string; budget?: RunToolBudgetEnvelope }>();
	try {
		for (const value of snapshot.running) {
			const runId = asRunId(value.runId);
			if (!runId) continue;
			const budget = cloneRunToolBudgetEnvelope(value.budget);
			running.set(runId, {
				spend: structuredClone(value.spend),
				outcomePhase: value.outcomePhase,
				...(budget !== undefined ? { budget } : {}),
			});
		}
	} catch {
		// Lifecycle/progress events remain authoritative if the optional snapshot fails.
	}
	return running;
}

export function createTelemetryProjection(bus: TelemetryHub, deps: ProjectionReadModel): TelemetryProjection {
	const runs = new Map<string, RunEntry>();
	// Settlement order is independent of enqueue order: an old active run
	// becomes the newest history entry when it finally settles.
	const terminalHistory = new Set<string>();
	const fleetPhases = new Map<string, NonNullable<TelemetryRunSummary["phase"]>>();
	let runReaders: TelemetryRunReaders = deps;

	const listeners = new Set<(snapshot: TelemetrySnapshot) => void>();
	let flushTimer: ReturnType<typeof setTimeout> | null = null;

	function buildSnapshot(): TelemetrySnapshot {
		return {
			generatedAt: Date.now(),
			// Newest-first: Map preserves first-seen (enqueue) order, so reversing
			// surfaces the most recently started runs at the head of the list.
			runs: [...runs.values()].reverse().map((entry) => {
				const { progressFold, ...summary } = entry;
				return structuredClone({
					...summary,
					status: entry.retry ? "retrying" : entry.status,
					progress: progressFold.snapshot(),
				});
			}),
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
				writeDiagnostic(`[clio-coder:telemetry] projection listener crashed: ${message}`, "error");
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
		for (const [runId, summary] of runs) {
			// A dead heartbeat is provisional until dispatch finalization. A failed
			// retry parent restored from the queue is terminal even when its finish
			// time was evicted; only its pending retry keeps it outside the cap.
			if (isTerminal(summary.status) && (summary.status !== "dead" || summary.finishedAtMs !== null) && !summary.retry) {
				terminalHistory.add(runId);
			} else {
				terminalHistory.delete(runId);
			}
		}
		while (terminalHistory.size > MAX_PROJECTION_RUNS) {
			const oldest = terminalHistory.values().next().value;
			if (oldest === undefined) break;
			terminalHistory.delete(oldest);
			runs.delete(oldest);
			fleetPhases.delete(oldest);
		}
		scheduleFlush();
	}

	function putRun(runId: string, summary: RunEntry): void {
		runs.set(runId, summary);
	}

	function emptyRun(runId: string, now: number): RunEntry {
		const phase = fleetPhases.get(runId);
		return {
			runId,
			agentId: "-",
			runtimeKind: "http",
			progressFold: createWorkerProgressFold(),
			...(phase !== undefined ? { phase: { ...phase } } : {}),
			status: "enqueued",
			startedAtMs: now,
			finishedAtMs: null,
			durationMs: null,
			spend: unobservedRunUsageFacts(),
		};
	}

	function applyIdentity(summary: RunEntry, id: Partial<DispatchRunIdentity>): void {
		// A lifecycle update must earn its trust again from the current run record.
		delete summary.trust;
		delete summary.resultContract;
		if (typeof id.agentId === "string" && id.agentId.length > 0) summary.agentId = id.agentId;
		if (typeof id.targetId === "string" && id.targetId.length > 0) summary.targetId = id.targetId;
		if (typeof id.wireModelId === "string" && id.wireModelId.length > 0) summary.modelId = id.wireModelId;
		if (typeof id.runtimeId === "string" && id.runtimeId.length > 0) summary.runtimeId = id.runtimeId;
		summary.runtimeKind = parseRuntimeKind(id.runtimeKind ?? summary.runtimeKind);
		const additions = {
			agentAudience: parseAgentAudience(id.agentAudience, summary.agentAudience),
			requestOrigin: parseRequestOrigin(id.requestOrigin, summary.requestOrigin),
			node: parseNonEmptyString(id.node) ?? summary.node,
			endpoint: parseEndpointCapacity(id.endpoint) ?? summary.endpoint,
			gate: parseGateBadge(id.gate) ?? summary.gate,
			council: parseCouncilBadge(id.council) ?? summary.council,
			rerouteCount: parsePositiveInt(id.rerouteCount) ?? summary.rerouteCount,
			contextWindow: parsePositiveInt(id.contextWindow) ?? summary.contextWindow,
			taskSummary: parseTaskSummary(id, summary.taskSummary),
			budget: cloneRunToolBudgetEnvelope(id.budget) ?? summary.budget,
		};
		Object.assign(summary, Object.fromEntries(Object.entries(additions).filter(([, value]) => value !== undefined)));
	}

	/** A terminal payload crossed the bus untyped; only a spend in the run-usage shape replaces the live one (#434). */
	function applyTerminalTokens(summary: TelemetryRunSummary, payload: Record<string, unknown>): void {
		if (Value.Check(RunUsageFactsSchema, payload.spend)) summary.spend = structuredClone(payload.spend);
	}

	function settleFromRunResult(summary: RunEntry): void {
		delete summary.resultContract;
		try {
			const facts = runReaders.readRunResult?.(summary.runId);
			// A failed or retired seal cannot supply the board's terminal answer.
			const text = facts?.trust?.artifactIntegrity.state === "verified" ? facts.text : undefined;
			summary.progressFold.settle(typeof text === "string" && text.trim().length > 0 ? text : undefined);
			if (
				typeof text === "string" &&
				text.trim().length > 0 &&
				typeof facts?.contractKind === "string" &&
				typeof facts.contract === "string"
			) {
				summary.resultContract = { kind: facts.contractKind, conformance: facts.contract };
			}
			if (facts?.trust !== undefined) summary.trust = summarizeTrustStatus(facts.trust);
		} catch {
			summary.progressFold.settle();
		}
	}

	function applyTerminalDetail(summary: RunEntry, payload: Record<string, unknown>): void {
		const host = payload.hostVerification;
		if (host === "verified" || host === "rejected" || host === "skipped" || host === "not_implicated")
			summary.hostVerification = host;
		if (payload.reason !== "retry_denied") summary.runRecordId = summary.runId;
		delete summary.retry;
		settleFromRunResult(summary);
	}

	function reconcileRuns(): void {
		if (!runReaders.dispatchSnapshot) return;
		let current: DispatchSnapshot;
		try {
			current = runReaders.dispatchSnapshot();
		} catch {
			return;
		}
		if (!Array.isArray(current?.retrying) || !Array.isArray(current?.running)) return;
		const retrying = readRetrySnapshot(current);
		const running = readRunningSnapshot(current);
		const now = Date.now();
		let changed = false;
		for (const entry of runs.values()) {
			if (entry.retry && !retrying.has(entry.runId)) {
				delete entry.retry;
				changed = true;
			}
		}
		for (const [runId, retry] of retrying) {
			const existing = runs.get(runId);
			if (existing && existing.status !== "failed" && existing.status !== "dead") continue;
			const entry = existing ?? emptyRun(runId, now);
			if (!existing) {
				entry.agentId = retry.agentId;
				entry.status = "failed";
			}
			entry.retry = { ...retry.retry };
			if (entry.taskSummary === undefined && retry.taskSummary !== undefined) entry.taskSummary = retry.taskSummary;
			putRun(runId, entry);
			changed = true;
		}
		for (const [runId, live] of running) {
			const entry = runs.get(runId);
			if (!entry || (isTerminal(entry.status) && live.outcomePhase !== "aborting")) continue;
			entry.spend = live.spend;
			if (live.budget !== undefined) entry.budget = live.budget;
			if (live.outcomePhase === "aborting" && entry.status !== "completed" && entry.status !== "aborted") {
				entry.status = "cancelling";
				delete entry.retry;
			}
			changed = true;
		}
		if (changed) markChanged();
	}

	const unsubscribes: Array<() => void> = [
		bus.subscribe("run.enqueued", (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			const runId = asRunId(payload.runId);
			if (!runId) return;
			const now = Date.now();
			const summary = runs.get(runId) ?? emptyRun(runId, now);
			applyIdentity(summary, payload as Partial<DispatchRunIdentity>);
			summary.status = "enqueued";
			delete summary.retry;
			putRun(runId, summary);
			markChanged();
		}),
		bus.subscribe("run.started", (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			const runId = asRunId(payload.runId);
			if (!runId) return;
			const now = Date.now();
			const summary = runs.get(runId) ?? emptyRun(runId, now);
			applyIdentity(summary, payload as Partial<DispatchRunIdentity>);
			summary.status = "running";
			summary.startedAtMs = now;
			delete summary.retry;
			summary.finishedAtMs = null;
			summary.durationMs = null;
			putRun(runId, summary);
			markChanged();
		}),
		bus.subscribe("run.progressed", (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			const runId = asRunId(payload.runId);
			if (!runId) return;
			const summary = runs.get(runId);
			if (!summary) return;
			const now = Date.now();
			const event = (payload.event ?? {}) as Record<string, unknown>;
			const type = typeof event.type === "string" ? event.type : "";
			if (type === "heartbeat_status") {
				const status = resolveHeartbeat(event.status);
				if (status && !isTerminal(summary.status) && summary.status !== "cancelling") summary.status = status;
				if (status === "dead") summary.progressFold.settle();
				markChanged();
				return;
			}
			if (type === "attempt_start") {
				summary.failoverHops = (summary.failoverHops ?? 0) + 1;
				const attemptRunId = asRunId(event.runId);
				if (attemptRunId && attemptRunId !== runId) {
					// Assignment notifications are relayed on the root run. The child
					// has its own lifecycle row; starting it cannot revive this parent.
					delete summary.retry;
					markChanged();
					return;
				}
				summary.status = "running";
				summary.finishedAtMs = null;
				summary.durationMs = null;
				summary.progressFold.restart();
				delete summary.retry;
				markChanged();
				return;
			}
			let changed = false;
			if (type === "clio_coder_write_record_downgraded") {
				const detail = (event.payload ?? {}) as Record<string, unknown>;
				const tool = parseNonEmptyString(detail.tool);
				const toolCallId = parseNonEmptyString(detail.toolCallId);
				if (detail.reason === "opaque_tool_succeeded" && tool !== undefined && toolCallId !== undefined) {
					summary.writeRecordDowngrade = {
						reason: "opaque_tool_succeeded",
						tool: sanitizeCallTargetText(tool),
						toolCallId: sanitizeCallTargetText(toolCallId),
					};
					changed = true;
				}
			}
			changed = summary.progressFold.observe(payload.event) || changed;
			if (type === "clio_coder_steer_received") {
				const detail = (event.payload ?? {}) as Record<string, unknown>;
				summary.steerAcknowledgement = { receivedAtMs: now, chars: Math.max(0, Math.floor(num(detail.chars, 0))) };
				changed = true;
			}
			if (type === "message_end" && !isTerminal(summary.status)) {
				const message = (event.message ?? {}) as { role?: unknown; usage?: Record<string, unknown> };
				if (message.role === "assistant" && message.usage) {
					// The run's spend comes from its call fold; a reply only says how full its context was.
					const usage = normalizeTokenUsage(message.usage);
					summary.lastContextTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
					changed = true;
				}
			}
			// A worker's agent_end settles its displayed progress; only a terminal
			// dispatch event changes the canonical run outcome.
			if (type === "agent_end") changed = summary.progressFold.settle() || changed;
			// Deltas cannot change run retention. Avoid scanning terminal history
			// or publishing snapshots for ignored frames such as thinking repeats (#428).
			if (changed) scheduleFlush();
		}),
		bus.subscribe("run.completed", (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			const runId = asRunId(payload.runId);
			if (!runId) return;
			const now = Date.now();
			const summary = runs.get(runId) ?? emptyRun(runId, now);
			applyIdentity(summary, payload as Partial<DispatchRunIdentity>);
			summary.status = "completed";
			summary.finishedAtMs = now;
			summary.durationMs = num(payload.durationMs, Math.max(0, now - summary.startedAtMs));
			applyTerminalTokens(summary, payload);
			applyTerminalDetail(summary, payload);
			summary.outcomeDetail = typeof payload.outcomeDetail === "string" ? payload.outcomeDetail : null;
			putRun(runId, summary);
			markChanged();
		}),
		bus.subscribe("run.failed", (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			const runId = asRunId(payload.runId);
			if (!runId) return;
			const now = Date.now();
			const summary = runs.get(runId) ?? emptyRun(runId, now);
			applyIdentity(summary, payload as Partial<DispatchRunIdentity>);
			summary.status = resolveDispatchFailureStatus(payload.reason);
			summary.finishedAtMs = now;
			summary.durationMs = num(payload.durationMs, Math.max(0, now - summary.startedAtMs));
			applyTerminalTokens(summary, payload);
			applyTerminalDetail(summary, payload);
			summary.outcomeDetail = typeof payload.outcomeDetail === "string" ? payload.outcomeDetail : null;
			putRun(runId, summary);
			markChanged();
		}),
		bus.subscribe("run.aborted", (raw) => {
			const runId = asRunId(raw?.runId);
			const summary = runId ? runs.get(runId) : undefined;
			if (!summary) return;
			const wasRetrying = summary.retry !== undefined;
			delete summary.retry;
			if (wasRetrying && raw.startedAt === null) {
				summary.status = "aborted";
				summary.finishedAtMs = Date.now();
				summary.progressFold.settle();
			} else {
				if (isTerminal(summary.status) && !wasRetrying) return;
				summary.status = "cancelling";
			}
			summary.outcomeDetail = typeof raw.reason === "string" ? raw.reason : (summary.outcomeDetail ?? null);
			markChanged();
		}),
		bus.subscribe("evidence.assessed", (payload) => {
			const summary = runs.get(asRunId(payload?.runId) ?? "");
			if (!summary) return;
			summary.evidence = { firstPassSuccess: payload.firstPassSuccess, findingCount: payload.findings.length };
			markChanged();
		}),
	];

	return {
		snapshot: buildSnapshot,
		bindRunReaders(readers) {
			runReaders = readers;
			return () => {
				if (runReaders === readers) runReaders = deps;
			};
		},
		reconcileRuns,
		setFleetPhase(runId, phase) {
			fleetPhases.set(runId, { ...phase });
			while (fleetPhases.size > MAX_PROJECTION_RUNS) {
				const oldest = fleetPhases.keys().next().value;
				if (oldest === undefined) break;
				fleetPhases.delete(oldest);
			}
			const summary = runs.get(runId);
			if (summary) summary.phase = { ...phase };
			markChanged();
		},
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
