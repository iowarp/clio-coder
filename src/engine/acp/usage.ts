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
export const ACP_ACCOUNTING_META_KEY = "clio-coder/accounting";
export const ACP_USAGE_READ_METHOD = "_clio-coder/usage/read";
const MAX_ROWS = 32;
const MAX_PROVIDERS = 16;
const MAX_WINDOWS = 8;
const MAX_TEXT_BYTES = 256;

/** `CostAggregate`, structurally. */
export interface AcpCostAggregate {
	knownUsd: number;
	hasEstimated: boolean;
	hasUnknown: boolean;
	allKnownFree: boolean;
	calls: number;
}

/** The overlay's `CostRow`, structurally. */
export interface AcpUsageRow {
	providerId: string;
	attributedModelId: string;
	runs: number;
	apiCalls: number;
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	sideQuestions: number;
	handoffs: number;
	prewarms: number;
	backgroundMemory: number;
	cost: AcpCostAggregate;
}

/** The quota domain's `UsageSnapshot`, structurally. */
export interface AcpQuotaSnapshot {
	providerId: string;
	displayName: string;
	status: string;
	windows: ReadonlyArray<{
		label: string;
		usedPct: number;
		resetsAt: string | null;
		scope?: string;
		active?: boolean;
	}>;
	credits?: { display: string; usedPct: number | null } | null;
	plan?: string | null;
	message?: string | null;
	retryAfterSeconds?: number | null;
	stale?: boolean;
	fetchedAt: string | null;
}

export interface AcpUsageSource {
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
	return {
		cost: projectCost(session.cost),
		tokens: session.rows.reduce((total, row) => total + count(row.tokens), 0),
		rows: session.rows.slice(0, MAX_ROWS).map((row) => ({
			provider: bounded(row.providerId),
			model: bounded(row.attributedModelId),
			runs: count(row.runs),
			calls: count(row.apiCalls),
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
