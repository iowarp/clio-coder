/**
 * Best-effort proactive-memory telemetry. Records contain counts and outcomes,
 * never task text, trajectory content, bank content, or reminder text.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import type { TaskMemoryEntry, TaskMemorySnapshot } from "./task-bank.js";
import type { TaskMemoryPolicyDecision, TaskMemoryPolicyReason } from "./task-memory-policy.js";

/**
 * Version 2 adds `reason`, `bankOperations`, and `droppedOperations`. Version 1
 * rows recorded a decision and a bank delta and nothing that explained either,
 * so a session of `silent` steps with an empty bank could not be diagnosed at
 * all. The parser rejects v1 rows rather than defaulting the new fields, because
 * a defaulted reason would assert something about a step nobody measured.
 */
export const TASK_MEMORY_TELEMETRY_VERSION = 2;
export const TASK_MEMORY_TELEMETRY_MAX_BYTES = 1024 * 1024;
export const TASK_MEMORY_TELEMETRY_FILE = "steps.jsonl";

export type TaskMemoryTelemetryTrigger =
	| "interval"
	| "tool_error_streak"
	| "loop_signal"
	| "repeated_failure"
	| "turn_end"
	| "post_compaction"
	| "manual";

export type TaskMemoryTelemetryTier = "rules" | "llm";

/**
 * A memory boundary that never ran has no policy decision, but it is exactly the
 * outcome an operator needs to distinguish a starved cadence from a quiet one.
 * `dropped` is therefore a telemetry-only outcome: the boundary triggered, a
 * step was already in flight, and its triggers stayed pending for a later
 * boundary.
 */
export type TaskMemoryTelemetryDecision = TaskMemoryPolicyDecision | "dropped";

export interface TaskMemoryClassDelta {
	added: number;
	updated: number;
	deleted: number;
}

export interface TaskMemoryBankDelta {
	status: TaskMemoryClassDelta;
	knowledge: TaskMemoryClassDelta;
	procedural: TaskMemoryClassDelta;
}

export interface TaskMemoryTokenCost {
	input: number;
	output: number;
	total: number;
}

export interface TaskMemoryTelemetryRecord {
	version: 2;
	at: string;
	triggerReasons: TaskMemoryTelemetryTrigger[];
	tier: TaskMemoryTelemetryTier;
	bankDelta: TaskMemoryBankDelta;
	decision: TaskMemoryTelemetryDecision;
	/** What produced the decision. The field that makes a `silent` row actionable. */
	reason: TaskMemoryPolicyReason;
	/** Operations the bank accepted from the model. */
	bankOperations: number;
	/** Operations the bank refused. Nonzero beside a zero `bankOperations` is a total loss. */
	droppedOperations: number;
	citedEntries: number;
	tokenCost: TaskMemoryTokenCost;
	latencyMs: number;
}

export interface TaskMemoryTelemetryStep {
	triggerReasons: ReadonlyArray<TaskMemoryTelemetryTrigger>;
	tier: TaskMemoryTelemetryTier;
	bankDelta: TaskMemoryBankDelta;
	decision: TaskMemoryTelemetryDecision;
	reason: TaskMemoryPolicyReason;
	bankOperations: number;
	droppedOperations: number;
	citedEntries: number;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
}

export interface TaskMemoryTelemetrySink {
	record(step: TaskMemoryTelemetryStep): void;
}

export interface CreateTaskMemoryTelemetrySinkOptions {
	/** Defaults to `<state>/memory`; primarily overridden by contract tests. */
	logDir?: string;
	now?: () => Date;
}

export function createTaskMemoryTelemetrySink(
	options: CreateTaskMemoryTelemetrySinkOptions = {},
): TaskMemoryTelemetrySink {
	const now = options.now ?? (() => new Date());
	return {
		record(step) {
			try {
				const logDir = options.logDir ?? join(clioStateDir(), "memory");
				const record = taskMemoryTelemetryRecord(step, now());
				mkdirSync(logDir, { recursive: true });
				const path = join(logDir, TASK_MEMORY_TELEMETRY_FILE);
				try {
					if (statSync(path).size > TASK_MEMORY_TELEMETRY_MAX_BYTES) renameSync(path, `${path}.1`);
				} catch {
					// A missing file is the normal first-write case. Rotation is best effort.
				}
				appendFileSync(path, `${JSON.stringify(record)}\n`);
			} catch {
				// Telemetry is observational. It can never change memory behavior.
			}
		},
	};
}

export function taskMemoryTelemetryRecord(step: TaskMemoryTelemetryStep, at: Date): TaskMemoryTelemetryRecord {
	const input = nonNegativeInteger(step.inputTokens);
	const output = nonNegativeInteger(step.outputTokens);
	return {
		version: TASK_MEMORY_TELEMETRY_VERSION,
		at: at.toISOString(),
		triggerReasons: [...new Set(step.triggerReasons)],
		tier: step.tier,
		bankDelta: step.bankDelta,
		decision: step.decision,
		reason: step.reason,
		bankOperations: nonNegativeInteger(step.bankOperations),
		droppedOperations: nonNegativeInteger(step.droppedOperations),
		citedEntries: nonNegativeInteger(step.citedEntries),
		tokenCost: { input, output, total: input + output },
		latencyMs: nonNegativeFinite(step.latencyMs),
	};
}

export function taskMemoryBankDelta(before: TaskMemorySnapshot, after: TaskMemorySnapshot): TaskMemoryBankDelta {
	return {
		status: entryDelta(before.status === null ? [] : [before.status], after.status === null ? [] : [after.status]),
		knowledge: entryDelta(before.knowledge, after.knowledge),
		procedural: entryDelta(before.procedural, after.procedural),
	};
}

export function parseTaskMemoryTelemetryRecord(value: unknown): TaskMemoryTelemetryRecord | null {
	if (!isRecord(value) || !hasExactKeys(value, TELEMETRY_KEYS)) return null;
	if (value.version !== TASK_MEMORY_TELEMETRY_VERSION || !validIsoTimestamp(value.at)) return null;
	if (!validTriggerReasons(value.triggerReasons) || !isTier(value.tier) || !isDecision(value.decision)) return null;
	if (!isReason(value.reason) || !isNonNegativeInteger(value.citedEntries)) return null;
	if (!isNonNegativeInteger(value.bankOperations) || !isNonNegativeInteger(value.droppedOperations)) return null;
	const bankDelta = parseBankDelta(value.bankDelta);
	const tokenCost = parseTokenCost(value.tokenCost);
	if (bankDelta === null || tokenCost === null || !isNonNegativeFinite(value.latencyMs)) return null;
	return {
		version: TASK_MEMORY_TELEMETRY_VERSION,
		at: value.at,
		triggerReasons: value.triggerReasons,
		tier: value.tier,
		bankDelta,
		decision: value.decision,
		reason: value.reason,
		bankOperations: value.bankOperations,
		droppedOperations: value.droppedOperations,
		citedEntries: value.citedEntries,
		tokenCost,
		latencyMs: value.latencyMs,
	};
}

const TELEMETRY_KEYS = [
	"version",
	"at",
	"triggerReasons",
	"tier",
	"bankDelta",
	"decision",
	"reason",
	"bankOperations",
	"droppedOperations",
	"citedEntries",
	"tokenCost",
	"latencyMs",
] as const;
const DELTA_KEYS = ["status", "knowledge", "procedural"] as const;
const CLASS_DELTA_KEYS = ["added", "updated", "deleted"] as const;
const TOKEN_KEYS = ["input", "output", "total"] as const;
const TRIGGERS = new Set<TaskMemoryTelemetryTrigger>([
	"interval",
	"tool_error_streak",
	"loop_signal",
	"repeated_failure",
	"turn_end",
	"post_compaction",
	"manual",
]);
const DECISIONS = new Set<TaskMemoryTelemetryDecision>([
	"silent",
	"injected",
	"gated",
	"timeout",
	"malformed",
	"dropped",
]);
const REASONS = new Set<TaskMemoryPolicyReason>([
	"intervened",
	"model_silent",
	"duplicate_reminder",
	"suppressed",
	"uncited",
	"over_budget",
	"unparseable",
	"all_operations_invalid",
	"deadline",
	"timed_out",
	"endpoint_busy",
	"client_error",
	"no_client",
	"no_consumer",
	"step_in_flight",
	"llm_timeout_backoff",
	"no_repeated_failure",
	"bank_empty",
]);

function entryDelta(
	before: ReadonlyArray<TaskMemoryEntry>,
	after: ReadonlyArray<TaskMemoryEntry>,
): TaskMemoryClassDelta {
	const old = new Map(before.map((entry) => [entry.id, entry]));
	const next = new Map(after.map((entry) => [entry.id, entry]));
	let added = 0;
	let updated = 0;
	let deleted = 0;
	for (const [id, entry] of next) {
		const previous = old.get(id);
		if (previous === undefined) added += 1;
		else if (!sameEntry(previous, entry)) updated += 1;
	}
	for (const id of old.keys()) {
		if (!next.has(id)) deleted += 1;
	}
	return { added, updated, deleted };
}

/**
 * Only durable content decides whether an entry changed. `lastTouchedAt` and
 * `injectionCount` also move when the bank records that an entry contributed to
 * a visible reminder, and attribution is not a write: counting it made every
 * intervening step report one bank write per cited entry, which is why the
 * intervened steps in the shipped telemetry disagree with `bankOperations`.
 * `createdAt` stays in the comparison because `clear()` restarts id allocation,
 * so one window can straddle a session switch that reuses an id.
 */
function sameEntry(left: TaskMemoryEntry, right: TaskMemoryEntry): boolean {
	return left.content === right.content && left.createdAt === right.createdAt;
}

function parseBankDelta(value: unknown): TaskMemoryBankDelta | null {
	if (!isRecord(value) || !hasExactKeys(value, DELTA_KEYS)) return null;
	const status = parseClassDelta(value.status);
	const knowledge = parseClassDelta(value.knowledge);
	const procedural = parseClassDelta(value.procedural);
	return status === null || knowledge === null || procedural === null ? null : { status, knowledge, procedural };
}

function parseClassDelta(value: unknown): TaskMemoryClassDelta | null {
	if (!isRecord(value) || !hasExactKeys(value, CLASS_DELTA_KEYS)) return null;
	return isNonNegativeInteger(value.added) && isNonNegativeInteger(value.updated) && isNonNegativeInteger(value.deleted)
		? { added: value.added, updated: value.updated, deleted: value.deleted }
		: null;
}

function parseTokenCost(value: unknown): TaskMemoryTokenCost | null {
	if (!isRecord(value) || !hasExactKeys(value, TOKEN_KEYS)) return null;
	if (!isNonNegativeInteger(value.input) || !isNonNegativeInteger(value.output) || !isNonNegativeInteger(value.total))
		return null;
	if (value.total !== value.input + value.output) return null;
	return { input: value.input, output: value.output, total: value.total };
}

function validTriggerReasons(value: unknown): value is TaskMemoryTelemetryTrigger[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= 3 &&
		new Set(value).size === value.length &&
		value.every((item) => typeof item === "string" && TRIGGERS.has(item as TaskMemoryTelemetryTrigger))
	);
}

function isTier(value: unknown): value is TaskMemoryTelemetryTier {
	return value === "rules" || value === "llm";
}

function isDecision(value: unknown): value is TaskMemoryTelemetryDecision {
	return typeof value === "string" && DECISIONS.has(value as TaskMemoryTelemetryDecision);
}

function isReason(value: unknown): value is TaskMemoryPolicyReason {
	return typeof value === "string" && REASONS.has(value as TaskMemoryPolicyReason);
}

/**
 * Canonical UTC only, the same rule capacity-lease.ts and memory/validate.ts
 * enforce. `Date.parse` alone admits `2026-08-15T06:18:32-05:00`, a valid
 * instant whose string sorts wrong against a `Z` row, and telemetry rows are
 * compared lexicographically downstream. The length bound stays as a cheap
 * guard so a megabyte string is rejected before it is parsed.
 */
function validIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 40) return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonNegativeInteger(value: number): number {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeFinite(value: number): number {
	return Number.isFinite(value) && value >= 0 ? value : 0;
}
