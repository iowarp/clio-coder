/**
 * Rebuild the running usage totals from a session's own ledger.
 *
 * The `/cost` overlay and the footer both render one process-lifetime
 * accumulator, and only `startNewSession` ever reset it. Resuming did not, so a
 * resumed session showed the *previous* session's numbers under the resumed
 * session's id: one process, two sessions, byte-identical totals relabelled.
 * That is misattribution rather than an undercount, and a process that resumed
 * and sent nothing reported zero for a session holding tens of thousands of
 * tokens on disk.
 *
 * The ledger is the only thing that knows what a session actually spent, so a
 * session change reseeds from it. Assistant turns marked aborted or error are
 * skipped for the same reason the context estimator skips them: their usage is
 * not a completed call. A cancelled partial persists a fully populated all-zero
 * usage object, so counting it would add an API call worth nothing.
 */

import type { SessionEntry } from "../domains/session/index.js";

/** The slice of ObservabilityContract a reseed needs. */
export interface SessionUsageSink {
	resetSession(): void;
	recordTokens(
		providerId: string,
		modelId: string,
		tokens: number,
		costUsd?: number,
		breakdown?: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			reasoningTokens: number;
			totalTokens: number;
			apiCalls?: number;
		},
		costProvenance?: never,
	): void;
}

interface LedgerCall {
	providerId: string;
	modelId: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	totalTokens: number;
	costUsd: number;
}

function numberAt(source: Record<string, unknown>, key: string): number {
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function reasoningTokensOf(usage: Record<string, unknown>): number {
	const direct = numberAt(usage, "reasoningTokens");
	if (direct > 0) return direct;
	const details = usage.outputTokensDetails ?? usage.completionTokensDetails;
	if (details && typeof details === "object") return numberAt(details as Record<string, unknown>, "reasoningTokens");
	return 0;
}

function stringAt(source: Record<string, unknown>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return null;
}

/** The target and model a session ran under before any modelChange row. */
export interface SessionUsageDefaults {
	target?: string | null;
	model?: string | null;
}

/**
 * One entry per completed assistant API call that carried provider usage.
 *
 * Attribution follows the live path, which records under the *target* id and
 * the wire model rather than the runtime name. Reading the runtime out of the
 * payload instead split one endpoint into two blocks in `/cost`, so a single
 * `dynamo` target on `llamacpp` rendered as two providers whose turn counts
 * diverged with every resume. `modelChange` rows are replayed in order so a
 * session that switched targets mid-way attributes each call to the one that
 * served it.
 *
 * Exported for the contract test; the reseed itself is the only other caller.
 */
export function ledgerUsageCalls(
	entries: ReadonlyArray<SessionEntry>,
	defaults: SessionUsageDefaults = {},
): LedgerCall[] {
	const calls: LedgerCall[] = [];
	let currentTarget = defaults.target ?? null;
	let currentModel = defaults.model ?? null;
	for (const entry of entries) {
		if (entry?.kind === "modelChange") {
			const change = entry as { target?: unknown; modelId?: unknown; provider?: unknown };
			if (typeof change.target === "string" && change.target.length > 0) currentTarget = change.target;
			else if (typeof change.provider === "string" && change.provider.length > 0) currentTarget = change.provider;
			if (typeof change.modelId === "string" && change.modelId.length > 0) currentModel = change.modelId;
			continue;
		}
		if (entry?.kind !== "message" || entry.role !== "assistant") continue;
		const payload = entry.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
		const record = payload as Record<string, unknown>;
		const stopReason = record.stopReason;
		if (stopReason === "aborted" || stopReason === "error") continue;
		const rawUsage = record.usage;
		if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) continue;
		const usage = rawUsage as Record<string, unknown>;
		const input = numberAt(usage, "input");
		const output = numberAt(usage, "output");
		const cacheRead = numberAt(usage, "cacheRead");
		const cacheWrite = numberAt(usage, "cacheWrite");
		const totalTokens = numberAt(usage, "totalTokens") || input + output + cacheRead + cacheWrite;
		// An all-zero usage block is a call that never reported anything. Adding it
		// would inflate the call count while contributing no tokens.
		if (totalTokens === 0) continue;
		const cost = usage.cost;
		const costUsd = cost && typeof cost === "object" ? numberAt(cost as Record<string, unknown>, "total") : 0;
		calls.push({
			providerId: currentTarget ?? stringAt(record, "provider", "api") ?? "unknown",
			modelId: currentModel ?? stringAt(record, "responseModel", "model") ?? "unknown",
			input,
			output,
			cacheRead,
			cacheWrite,
			reasoningTokens: reasoningTokensOf(usage),
			totalTokens,
			costUsd,
		});
	}
	return calls;
}

/**
 * Clear the running totals and replay the supplied session's recorded calls
 * into them. Safe to call with an empty ledger: the totals reset to zero, which
 * is the honest answer for a session that has spent nothing.
 */
export function reseedSessionUsageFromLedger(
	sink: SessionUsageSink,
	entries: ReadonlyArray<SessionEntry>,
	defaults: SessionUsageDefaults = {},
): void {
	sink.resetSession();
	for (const call of ledgerUsageCalls(entries, defaults)) {
		sink.recordTokens(call.providerId, call.modelId, call.totalTokens, call.costUsd, {
			input: call.input,
			output: call.output,
			cacheRead: call.cacheRead,
			cacheWrite: call.cacheWrite,
			reasoningTokens: call.reasoningTokens,
			totalTokens: call.totalTokens,
			apiCalls: 1,
		});
	}
}
