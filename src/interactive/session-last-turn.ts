/**
 * Rebuild the footer's last-turn line from the newest turn on the active branch.
 *
 * The line is a live accumulator: it describes whatever turn this process last
 * ran. current.jsonl is append-only, so after a `/tree` switch that turn can sit
 * on a branch the reader just left, and the line kept describing it while the Σ
 * total and `/cost` beside it had already been rescoped by the usage reseed. One
 * footer, two branches, no way to tell which line belonged to which.
 *
 * The fold reads the same lineage the reseed does, through
 * `filterEntriesToActivePath`, and reports only what the ledger recorded:
 * provider usage, the persisted stop reason, the tool result rows the turn
 * produced, and the wall time between the user message that opened the turn and
 * the last row it wrote. Fields the ledger does not carry are left at their
 * neutral value rather than reconstructed: the watchdog peak is zero, and
 * reasoning tokens appear only when a provider reported them, never estimated
 * back off replayed thinking text.
 */

import { extractReasoningTokens } from "../domains/session/context-accounting.js";
import type { MessageEntry, SessionEntry, SessionUsageDefaults } from "../domains/session/index.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { TurnStopReason, TurnSummary } from "./status/index.js";

function payloadRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function positiveNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function nonEmptyString(source: Record<string, unknown>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return null;
}

function stopReasonOf(value: unknown): TurnStopReason | null {
	switch (value) {
		case "stop":
		case "length":
		case "toolUse":
		case "error":
		case "aborted":
		case "cancelled":
			return value;
		default:
			return null;
	}
}

function millisBetween(startIso: string, endIso: string): number {
	const start = Date.parse(startIso);
	const end = Date.parse(endIso);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
	return Math.max(0, end - start);
}

/** The message rows of the newest turn on the branch, plus the target it ran under. */
interface BranchTurn {
	rows: MessageEntry[];
	startedAt: string;
	targetId: string | null;
	modelId: string | null;
}

/**
 * Everything after the last user message on the active path. That is the same
 * window the live summary folds: one submit, the assistant calls it took, and
 * the tool rows between them.
 */
function newestTurnOnBranch(entries: ReadonlyArray<SessionEntry>, defaults: SessionUsageDefaults): BranchTurn | null {
	let target = defaults.target ?? null;
	let model = defaults.model ?? null;
	let turn: BranchTurn | null = null;
	for (const entry of entries) {
		if (entry.kind === "modelChange") {
			const change = entry as { target?: unknown; provider?: unknown; modelId?: unknown };
			if (typeof change.target === "string" && change.target.length > 0) target = change.target;
			else if (typeof change.provider === "string" && change.provider.length > 0) target = change.provider;
			if (typeof change.modelId === "string" && change.modelId.length > 0) model = change.modelId;
			continue;
		}
		if (entry.kind !== "message") continue;
		if (entry.role === "user") {
			turn = { rows: [], startedAt: entry.timestamp, targetId: target, modelId: model };
			continue;
		}
		if (entry.role !== "assistant" && entry.role !== "tool_call" && entry.role !== "tool_result") continue;
		// A ledger whose first rows predate any user message (an imported or
		// repaired session) still has a turn to report; it just starts where the
		// assistant does.
		if (!turn) turn = { rows: [], startedAt: entry.timestamp, targetId: target, modelId: model };
		if (entry.role === "assistant") {
			turn.targetId = target;
			turn.modelId = model;
		}
		turn.rows.push(entry);
	}
	return turn;
}

/**
 * The newest turn on the active path, in the shape the footer's last-turn line
 * renders. Null when the branch holds no assistant reply, which is the honest
 * answer for a leaf whose turn never produced one.
 *
 * `activeLeafTurnId` pins the branch, exactly as it does for the usage reseed.
 * Omitted, the fold follows the newest message's ancestry.
 */
export function lastTurnSummaryFromLedger(
	entries: ReadonlyArray<SessionEntry>,
	defaults: SessionUsageDefaults = {},
	activeLeafTurnId?: string | null,
): TurnSummary | null {
	const scoped = filterEntriesToActivePath(entries, activeLeafTurnId ?? undefined);
	const turn = newestTurnOnBranch(scoped, defaults);
	if (!turn || turn.rows.length === 0) return null;

	let sawAssistant = false;
	let stopReason: TurnStopReason = "stop";
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let reasoningTokens = 0;
	let sawReasoning = false;
	let toolCount = 0;
	let toolErrorCount = 0;
	let targetId = turn.targetId;
	let modelId = turn.modelId;

	for (const row of turn.rows) {
		const record = payloadRecord(row.payload);
		// The live tally counts a tool by its result, so a call still in flight
		// when the branch was left contributes nothing here either.
		if (row.role === "tool_result") {
			toolCount += 1;
			if (record?.isError === true || record?.error === true) toolErrorCount += 1;
			continue;
		}
		if (row.role !== "assistant" || !record) continue;
		sawAssistant = true;
		const reason = stopReasonOf(record.stopReason);
		if (reason && reason !== "stop") stopReason = reason;
		targetId = targetId ?? nonEmptyString(record, "provider", "api");
		modelId = modelId ?? nonEmptyString(record, "responseModel", "model");
		const usage = payloadRecord(record.usage);
		if (!usage) continue;
		inputTokens += positiveNumber(usage.input);
		outputTokens += positiveNumber(usage.output);
		cacheReadTokens += positiveNumber(usage.cacheRead);
		cacheWriteTokens += positiveNumber(usage.cacheWrite);
		const reasoning = extractReasoningTokens(usage);
		if (reasoning !== null) {
			reasoningTokens += reasoning;
			sawReasoning = true;
		}
	}
	if (!sawAssistant) return null;

	const lastRow = turn.rows[turn.rows.length - 1];
	const summary: TurnSummary = {
		elapsedMs: lastRow ? millisBetween(turn.startedAt, lastRow.timestamp) : 0,
		modelId: modelId ?? "unknown",
		targetId: targetId ?? "unknown",
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		toolCount,
		toolErrorCount,
		stopReason,
		watchdogPeak: 0,
		truncated: false,
	};
	if (sawReasoning) {
		summary.reasoningTokens = reasoningTokens;
		summary.reasoningTokenProvenance = "provider";
	}
	return summary;
}
