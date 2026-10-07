import type { AcpCostAggregate, AcpQuotaSnapshot, AcpUsageRow } from "./types.js";

export type { AcpCostAggregate, AcpQuotaSnapshot, AcpUsageRow } from "./types.js";
export { ACP_ACCOUNTING_META_KEY, ACP_USAGE_READ_METHOD } from "./types.js";

/**
 * `_clio-coder/usage/read`: the numbers the terminal's /usage overlay shows.
 *
 * Session cost and tokens are Clio Coder's own accounting, already folded per
 * provider and model by the host the way the overlay folds them, so a client
 * never recomputes a total differently. Estimated and unknown cost stay
 * flagged rather than being rounded into a number. Quota is each provider's
 * own report, read through the quota service's cache; a read that fails is
 * reported as failed, never as an empty plan.
 */

/** Not `clio-coder/usage`, which is the per-turn usage key on every prompt response. */
const MAX_ROWS = 32;
const MAX_PROVIDERS = 16;
const MAX_WINDOWS = 8;
const MAX_TEXT_BYTES = 256;

/** `CostAggregate`, structurally. */

/** The overlay's `CostRow`, structurally. */

/** The quota domain's `UsageSnapshot`, structurally. */

export interface AcpUsageSource {
	resetSession?: (sessionId: string) => void;
	subscribe?: (listener: () => void) => () => void;
	session(): { cost: AcpCostAggregate; rows: ReadonlyArray<AcpUsageRow> };
	/** Snapshots through the quota service's cache; a provider that fails reports a status, and a throw fails the read. */
	quota(): Promise<ReadonlyArray<AcpQuotaSnapshot>>;
}

function bounded(text: string): string {
	let safe = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		safe += code <= 0x1f || code === 0x7f ? " " : character;
	}
	if (Buffer.byteLength(safe, "utf8") <= MAX_TEXT_BYTES) return safe;
	let cut = safe.slice(0, MAX_TEXT_BYTES);
	while (Buffer.byteLength(cut, "utf8") > MAX_TEXT_BYTES - 3) cut = cut.slice(0, -1);
	return `${cut}…`;
}

const optional = (text: string | null | undefined) => (typeof text === "string" ? bounded(text) : null);
const count = (value: number) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const percent = (value: number) => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);
const usd = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);

function projectCost(cost: AcpCostAggregate) {
	return {
		knownUsd: usd(cost.knownUsd),
		calls: count(cost.calls),
		estimated: cost.hasEstimated,
		unknown: cost.hasUnknown,
		free: cost.allKnownFree,
	};
}

export function projectSessionUsage(session: ReturnType<AcpUsageSource["session"]>) {
	const missingTokenCalls = session.rows.reduce((sum, row) => sum + (row.missingTokenCalls ?? 0), 0);
	return {
		cost: projectCost(session.cost),
		...(missingTokenCalls > 0 ? { missingTokenCalls } : {}),
		tokens: session.rows.reduce((total, row) => total + count(row.tokens), 0),
		rows: session.rows.slice(0, MAX_ROWS).map((row) => ({
			provider: bounded(row.providerId),
			model: bounded(row.attributedModelId),
			runs: count(row.runs),
			calls: count(row.apiCalls),
			...(row.missingTokenCalls ? { missingTokenCalls: count(row.missingTokenCalls) } : {}),
			tokens: {
				input: count(row.input),
				output: count(row.output),
				cacheRead: count(row.cacheRead),
				cacheWrite: count(row.cacheWrite),
				reasoning: count(row.reasoningTokens),
				total: count(row.tokens),
			},
			beside: {
				sideQuestions: count(row.sideQuestions),
				handoffs: count(row.handoffs),
				prewarms: count(row.prewarms),
				backgroundMemory: count(row.backgroundMemory),
				...((row.systemOne ?? 0) > 0 ? { systemOne: count(row.systemOne ?? 0) } : {}),
				...(row.failedCompaction ? { failedCompaction: count(row.failedCompaction) } : {}),
				...(row.workers ? { workers: count(row.workers) } : {}),
				...(row.compactions ? { compactions: count(row.compactions) } : {}),
			},
			cost: projectCost(row.cost),
		})),
		truncated: session.rows.length > MAX_ROWS,
	};
}

export function projectQuota(snapshots: ReadonlyArray<AcpQuotaSnapshot>) {
	return {
		status: "read" as const,
		providers: snapshots.slice(0, MAX_PROVIDERS).map((snapshot) => ({
			provider: bounded(snapshot.providerId),
			name: bounded(snapshot.displayName),
			status: bounded(snapshot.status),
			plan: optional(snapshot.plan),
			message: optional(snapshot.message),
			credits:
				snapshot.credits === null || snapshot.credits === undefined
					? null
					: {
							display: bounded(snapshot.credits.display),
							usedPct: snapshot.credits.usedPct === null ? null : percent(snapshot.credits.usedPct),
						},
			stale: snapshot.stale === true,
			fetchedAt: optional(snapshot.fetchedAt),
			retryAfterSeconds:
				typeof snapshot.retryAfterSeconds === "number" && Number.isFinite(snapshot.retryAfterSeconds)
					? Math.max(0, Math.round(snapshot.retryAfterSeconds))
					: null,
			windows: snapshot.windows.slice(0, MAX_WINDOWS).map((window) => ({
				label: bounded(window.label),
				usedPct: percent(window.usedPct),
				resetsAt: optional(window.resetsAt),
				scope: optional(window.scope),
				active: window.active === true,
			})),
		})),
	};
}
