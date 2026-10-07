/**
 * Fold a session ledger's assistant turns into the per-call usage the rest of
 * Clio reports: tokens in and out, cache reads and writes, reasoning tokens,
 * and provider-reported cost, attributed to the target and observed model id
 * for each call.
 *
 * This lives in the session domain because the ledger is the only durable
 * record of what a session spent, and three surfaces read it: the `/usage`
 * overlay and footer reseed from it on every session change, and `clio-coder usage
 * report` folds it across sessions. It was written for the overlay first and
 * sat under src/interactive; a headless report reaching into the TUI surface's
 * directory for it would have made one surface's presentation a dependency of
 * every surface's accounting, which is the same thing the tools/interactive
 * boundary rule exists to prevent.
 *
 * Failed and aborted calls still consumed resources. Missing provider counts
 * contribute to coverage, without adding estimates to the token subtotal.
 */

import {
	attributedModelId,
	type ResponseModelIdObservation,
	responseModelIdObservationFromRecord,
} from "../../core/response-model-id.js";
import { normalizeTokenUsage } from "../../core/token-split.js";
import type { CostEntryLabel } from "../observability/cost.js";
import type { CostProvenance } from "../providers/types/cost-provenance.js";
import { resolveCostProvenance } from "../providers/types/cost-provenance.js";
import type { SessionEntry } from "./entries.js";

/** One completed assistant API call, as the ledger recorded it. */
export interface LedgerUsageCall {
	providerId: string;
	/** Model id the accounting row uses, or `unknown` when an observed response omitted it. */
	attributedModelId: string;
	/** The id the session asked for (the configured model, or the message's own `model`). */
	requestedModelId: string;
	/** Direct presence observation, with the pre-#193 difference-only shape labeled separately. */
	responseModelIdObservation: ResponseModelIdObservation;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoningTokens: number;
	totalTokens: number;
	costUsd: number;
	/** API calls this row accounts for. Absent means one, which is every message row. */
	apiCalls?: number;
	missingTokenCalls?: number;
	label?: CostEntryLabel;
	costProvenance?: CostProvenance;
}

/** The target and model a session ran under before any modelChange row. */
export interface SessionUsageDefaults {
	target?: string | null;
	model?: string | null;
	sessionId?: string | null;
}

function numberAt(source: Record<string, unknown>, key: string): number {
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
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
 * `node-a` target on `llamacpp` rendered as two providers whose turn counts
 * diverged with every resume. `modelChange` rows are replayed in order so a
 * session that switched targets mid-way attributes each call to the active
 * target.
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
		// enters the conversation; folding it here is what puts it on `/usage` and
		// in `clio-coder usage report`.
		if (entry?.kind === "compactionSummary") {
			const usage = entry.usage;
			if (!usage) continue;
			calls.push({
				providerId: usage.targetId ?? currentTarget ?? "unknown",
				attributedModelId: usage.modelId ?? currentModel ?? "unknown",
				requestedModelId: usage.modelId ?? currentModel ?? "unknown",
				responseModelIdObservation: { state: "not-observed" },
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
				reasoningTokens: usage.reasoning,
				totalTokens: usage.totalTokens,
				costUsd: usage.cost.total,
				label: "compaction",
				...(usage.missingTokenCalls ? { missingTokenCalls: usage.missingTokenCalls } : {}),
				costProvenance: resolveCostProvenance(usage.costProvenance, usage.cost.total > 0 ? "estimated" : "unknown"),
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
		const rawUsage = record.usage;
		if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) continue;
		const usage = rawUsage as Record<string, unknown>;
		if (usage.callInvoked === false) continue;
		const { input, output, cacheRead, cacheWrite, totalTokens, reasoning, observed } = normalizeTokenUsage(usage);
		const cost = usage.cost;
		const costUsd =
			usage.estimated !== true && cost && typeof cost === "object"
				? numberAt(cost as Record<string, unknown>, "total")
				: 0;
		const requestedModelId = currentModel ?? stringAt(record, "model") ?? "unknown";
		const differingResponseModelId = stringAt(record, "responseModel");
		const responseModelIdObservation = responseModelIdObservationFromRecord(record, "legacy-difference-only");
		calls.push({
			providerId: stringAt(usage, "targetId") ?? currentTarget ?? stringAt(record, "provider", "api") ?? "unknown",
			attributedModelId: attributedModelId(responseModelIdObservation, requestedModelId, differingResponseModelId),
			requestedModelId,
			responseModelIdObservation,
			input,
			output,
			cacheRead,
			cacheWrite,
			...(typeof usage.cacheWrite1h === "number" ? { cacheWrite1h: numberAt(usage, "cacheWrite1h") } : {}),
			reasoningTokens: reasoning,
			totalTokens,
			costUsd,
			costProvenance:
				usage.estimated !== true
					? resolveCostProvenance(usage.costProvenance, costUsd > 0 ? "estimated" : "unknown")
					: "unknown",
			...(!observed ? { missingTokenCalls: 1 } : {}),
		});
	}
	return calls;
}
