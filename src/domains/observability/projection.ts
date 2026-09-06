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
 * - Worker progress retains only bounded answer text and redacted action
 *   descriptors. Tool arguments and reasoning are never stored.
 * - Terminal history and notices are bounded; active runs remain until settlement.
 */

import { performance } from "node:perf_hooks";
import { BusChannels, type DispatchRunIdentity } from "../../core/bus-events.js";
import { resolveDispatchFailureStatus } from "../../core/dispatch-outcome.js";
import type { SafeEventBus } from "../../core/event-bus.js";
import { truncateToWidth } from "../../engine/tui-primitives.js";
import type { AgentAudience } from "../agents/spec.js";
import { cloneRunToolBudgetEnvelope, type RunToolBudgetEnvelope } from "../dispatch/budget-envelope.js";
import type { DispatchSnapshot } from "../dispatch/contract.js";
import type { DispatchRequestOrigin, RunKind } from "../dispatch/types.js";
import { summarizeTrustStatus } from "../evidence/trust-projection.js";
import type { TargetStatus } from "../providers/contract.js";
import { type CostProvenance, resolveCostProvenance } from "../providers/types/cost-provenance.js";
import { sanitizeCallTargetText } from "../safety/call-target.js";
import type { AccountabilitySummary } from "./accountability.js";
import type {
	ObservabilityNotice,
	ObservabilityRunEvidence,
	ObservabilityRunProjection,
	ObservabilityRunReaders,
	ObservabilityRunSummary,
	ObservabilitySnapshot,
	TokenThroughputSnapshot,
} from "./contract.js";
import type { CostAggregate, UsageBreakdown } from "./cost.js";
import type { MetricsView } from "./metrics.js";
import { createWorkerProgressFold, type WorkerProgressFold } from "./worker-progress.js";

/** Settled run summaries retained, in addition to all active runs. */
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
export interface ProjectionReadModel extends ObservabilityRunReaders {
	metrics(): MetricsView;
	sessionCost(): number;
	sessionCostSummary(): CostAggregate;
	sessionTokens(): UsageBreakdown;
	latestThroughput(): TokenThroughputSnapshot | null;
	readAccountability(): AccountabilitySummary;
}

export interface ObservabilityProjection extends ObservabilityRunProjection {
	snapshot(): ObservabilitySnapshot;
	subscribe(listener: (snapshot: ObservabilitySnapshot) => void): () => void;
	/** Recompute after a direct session mutation (recordTokens/resetSession/safety counter). */
	refresh(): void;
	/** A forensic evidence build for `runId` has started. */
	evidenceBuildStarted(runId: string): void;
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

interface RunEntry extends ObservabilityRunSummary {
	progressFold: WorkerProgressFold;
	startedAtClockMs: number | null;
}

const TASK_SUMMARY_MAX_WIDTH = 240;

function finiteOrZero(value: unknown): number {
	return num(value, 0);
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

function parseEndpointCapacity(value: unknown): ObservabilityRunSummary["endpoint"] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as { key?: unknown; label?: unknown; limit?: unknown };
	const key = parseNonEmptyString(record.key);
	const label = parseNonEmptyString(record.label);
	const limit = parsePositiveInt(record.limit);
	return key === undefined || label === undefined || limit === undefined ? undefined : { key, label, limit };
}

function parseCouncilBadge(value: unknown): ObservabilityRunSummary["council"] | undefined {
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
): NonNullable<ObservabilityRunSummary["retry"]> | null {
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
): Map<string, { agentId: string; taskSummary?: string; retry: NonNullable<ObservabilityRunSummary["retry"]> }> {
	const retrying = new Map<
		string,
		{ agentId: string; taskSummary?: string; retry: NonNullable<ObservabilityRunSummary["retry"]> }
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
			const runId = asRunId(value.runId);
			if (!runId) continue;
			const budget = cloneRunToolBudgetEnvelope(value.budget);
			running.set(runId, {
				inputTokens: finiteOrZero(value.tokens.input),
				outputTokens: finiteOrZero(value.tokens.output),
				tokenCount: finiteOrZero(value.tokens.total),
				costUsd: finiteOrZero(value.costUsd),
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

export function createObservabilityProjection(bus: SafeEventBus, deps: ProjectionReadModel): ObservabilityProjection {
	const runs = new Map<string, RunEntry>();
	// Settlement order is independent of enqueue order: an old active run
	// becomes the newest history entry when it finally settles.
	const terminalHistory = new Set<string>();
	const fleetPhases = new Map<string, NonNullable<ObservabilityRunSummary["phase"]>>();
	let runReaders: ObservabilityRunReaders = deps;
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
			runs: [...runs.values()].reverse().map((entry) => {
				const { progressFold, startedAtClockMs: _clock, ...summary } = entry;
				return structuredClone({
					...summary,
					status: entry.retry ? "retrying" : entry.status,
					progress: progressFold.snapshot(),
				});
			}),
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
		revision += 1;
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
			startedAtClockMs: null,
			ttftMs: null,
			lastContextTokens: 0,
			...(phase !== undefined ? { phase: { ...phase } } : {}),
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

	function applyIdentity(summary: RunEntry, id: Partial<DispatchRunIdentity>): void {
		// A lifecycle update must earn its trust again from the current receipt.
		delete summary.trust;
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

	function settleFromReceipt(summary: RunEntry): void {
		try {
			const facts = runReaders.readReceipt?.(summary.runId);
			// A failed or retired seal cannot supply the board's terminal answer.
			const text = facts?.trust?.artifactIntegrity.state === "verified" ? facts.text : undefined;
			summary.progressFold.settle(typeof text === "string" && text.trim().length > 0 ? text : undefined);
			if (facts?.trust !== undefined) summary.trust = summarizeTrustStatus(facts.trust);
		} catch {
			summary.progressFold.settle();
		}
	}

	function applyTerminalDetail(summary: RunEntry, payload: Record<string, unknown>): void {
		const host = payload.hostVerification;
		if (host === "verified" || host === "rejected" || host === "skipped" || host === "not_implicated")
			summary.hostVerification = host;
		if (payload.reason !== "retry_denied") summary.receiptId = summary.runId;
		delete summary.retry;
		settleFromReceipt(summary);
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
			entry.tokens.input = live.inputTokens;
			entry.tokens.output = live.outputTokens;
			entry.tokens.total = live.tokenCount;
			entry.costUsd = live.costUsd;
			entry.costProvenance = live.costProvenance;
			if (live.budget !== undefined) entry.budget = live.budget;
			if (live.outcomePhase === "aborting" && entry.status !== "completed" && entry.status !== "aborted") {
				entry.status = "cancelling";
				delete entry.retry;
			}
			changed = true;
		}
		if (changed) markChanged();
	}

	function evidenceBuildSucceeded(runId: string, evidence: ObservabilityRunEvidence): void {
		pendingEvidence.delete(runId);
		const summary = runs.get(runId);
		if (summary) summary.evidence = { ...evidence, tags: [...evidence.tags] };
		accountability = deps.readAccountability();
		markChanged();
	}

	const unsubscribes: Array<() => void> = [
		bus.on(BusChannels.DispatchEnqueued, (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			const runId = asRunId(payload.runId);
			if (!runId) return;
			const now = Date.now();
			const summary = runs.get(runId) ?? emptyRun(runId, now);
			applyIdentity(summary, payload as Partial<DispatchRunIdentity>);
			summary.status = "enqueued";
			delete summary.retry;
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
			applyIdentity(summary, payload as Partial<DispatchRunIdentity>);
			summary.status = "running";
			summary.startedAtMs = now;
			summary.startedAtClockMs = performance.now();
			delete summary.retry;
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
			const summary = runs.get(runId);
			if (!summary) return;
			const now = Date.now();
			summary.updatedAtMs = now;
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
			// Agent startup provides the monotonic origin for TTFT. Lifecycle
			// timestamps remain owned by DispatchStarted.
			if (type === "agent_start") summary.startedAtClockMs = performance.now();
			if (type === "message_update") {
				const assistantEvent = (event.assistantMessageEvent ?? {}) as Record<string, unknown>;
				const hasDelta = ["text_delta", "thinking_delta", "toolcall_start", "toolcall_delta"].includes(
					String(assistantEvent.type),
				);
				if (hasDelta && summary.ttftMs === null && summary.startedAtClockMs !== null)
					summary.ttftMs = Math.round(performance.now() - summary.startedAtClockMs);
			}
			if (type === "clio_coder_write_record_downgraded") {
				const detail = (event.payload ?? {}) as Record<string, unknown>;
				const tool = parseNonEmptyString(detail.tool);
				const toolCallId = parseNonEmptyString(detail.toolCallId);
				if (detail.reason === "opaque_tool_succeeded" && tool !== undefined && toolCallId !== undefined)
					summary.writeRecordDowngrade = {
						reason: "opaque_tool_succeeded",
						tool: sanitizeCallTargetText(tool),
						toolCallId: sanitizeCallTargetText(toolCallId),
					};
			}
			summary.progressFold.observe(payload.event);
			if (type === "clio_coder_steer_received") {
				const detail = (event.payload ?? {}) as Record<string, unknown>;
				summary.steerAcknowledgement = { receivedAtMs: now, chars: Math.max(0, Math.floor(num(detail.chars, 0))) };
			}
			if (type === "message_end" && !isTerminal(summary.status)) {
				const message = (event.message ?? {}) as { role?: unknown; usage?: Record<string, unknown> };
				if (message.role === "assistant" && message.usage) {
					const input = num(message.usage.input, 0) + num(message.usage.cacheRead, 0);
					const output = num(message.usage.output, 0);
					summary.tokens.input += input;
					summary.tokens.output += output;
					summary.tokens.total += input + output + num(message.usage.cacheWrite, 0);
					summary.lastContextTokens = input + output;
				}
			}
			// A worker's agent_end settles its displayed progress; only a terminal
			// dispatch event changes the canonical run outcome.
			if (type === "agent_end") summary.progressFold.settle();
			markChanged();
		}),
		bus.on(BusChannels.DispatchCompleted, (raw: unknown) => {
			const payload = (raw ?? {}) as Record<string, unknown>;
			const runId = asRunId(payload.runId);
			if (!runId) return;
			const now = Date.now();
			const summary = runs.get(runId) ?? emptyRun(runId, now);
			applyIdentity(summary, payload as Partial<DispatchRunIdentity>);
			summary.status = "completed";
			summary.updatedAtMs = now;
			summary.finishedAtMs = now;
			summary.durationMs = num(payload.durationMs, Math.max(0, now - summary.startedAtMs));
			applyTerminalTokens(summary, payload);
			applyTerminalDetail(summary, payload);
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
			applyIdentity(summary, payload as Partial<DispatchRunIdentity>);
			summary.status = resolveDispatchFailureStatus(payload.reason);
			summary.updatedAtMs = now;
			summary.finishedAtMs = now;
			summary.durationMs = num(payload.durationMs, Math.max(0, now - summary.startedAtMs));
			applyTerminalTokens(summary, payload);
			applyTerminalDetail(summary, payload);
			summary.outcome = str(payload.outcome, str(payload.reason, "failed"));
			summary.outcomeDetail = typeof payload.outcomeDetail === "string" ? payload.outcomeDetail : null;
			putRun(runId, summary);
			markChanged();
		}),
		bus.on(BusChannels.RunAborted, (raw) => {
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
			summary.updatedAtMs = Date.now();
			markChanged();
		}),
		bus.on(BusChannels.AccountabilityEvidenceReady, (payload) => {
			const runId = asRunId(payload?.runId);
			if (runId) evidenceBuildSucceeded(runId, payload);
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
		evidenceBuildStarted(runId) {
			if (typeof runId !== "string" || runId.length === 0) return;
			pendingEvidence.add(runId);
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
