/**
 * Fold a session ledger's assistant turns into the per-call usage the rest of
 * Clio reports: tokens in and out, cache reads and writes, reasoning tokens,
 * and provider-reported cost, attributed to the target and wire model that
 * served each call.
 *
 * This lives in the session domain because the ledger is the only durable
 * record of what a session spent, and three surfaces read it: the `/cost`
 * overlay and footer reseed from it on every session change, and `clio usage
 * report` folds it across sessions. It was written for the overlay first and
 * sat under src/interactive; a headless report reaching into the TUI surface's
 * directory for it would have made one surface's presentation a dependency of
 * every surface's accounting, which is the same thing the tools/interactive
 * boundary rule exists to prevent.
 *
 * Assistant turns marked aborted or error are skipped for the same reason the
 * context estimator skips them: their usage is not a completed call. A
 * cancelled partial persists a fully populated all-zero usage object, so
 * counting it would add an API call worth nothing.
 */

import type { SessionEntry } from "./entries.js";

/** One completed assistant API call, as the ledger recorded it. */
export interface LedgerUsageCall {
	providerId: string;
	modelId: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	totalTokens: number;
	costUsd: number;
	/** API calls this row accounts for. Absent means one, which is every message row. */
	apiCalls?: number;
}

/** The target and model a session ran under before any modelChange row. */
export interface SessionUsageDefaults {
	target?: string | null;
	model?: string | null;
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
 */
export function ledgerUsageCalls(
	entries: ReadonlyArray<SessionEntry>,
	defaults: SessionUsageDefaults = {},
): LedgerUsageCall[] {
	const calls: LedgerUsageCall[] = [];
	let currentTarget = defaults.target ?? null;
	let currentModel = defaults.model ?? null;
	for (const entry of entries) {
		// A compaction summarizes history through a real model call, billed like
		// any other. Its usage rides on the compactionSummary entry rather than on
		// an assistant message, because the summary is context machinery and never
		// enters the conversation; folding it here is what puts it on `/cost` and
		// in `clio usage report`.
		if (entry?.kind === "compactionSummary") {
			const usage = entry.usage;
			if (!usage || usage.totalTokens <= 0) continue;
			calls.push({
				providerId: currentTarget ?? "unknown",
				modelId: currentModel ?? "unknown",
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				reasoningTokens: usage.reasoning,
				totalTokens: usage.totalTokens,
				costUsd: usage.cost.total,
				// A split turn runs two summarization streams under one entry; the
				// provider served that many calls even though one row records them.
				apiCalls: Math.max(1, Math.round(usage.apiCalls)),
			});
			continue;
		}
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
