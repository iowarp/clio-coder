import type { CallRowV1, CostReportV1, FactMetric, Quantity } from "../../core/telemetry/dto.js";
import { factRef } from "../../core/telemetry/dto.js";
import { COST_NOT_MEASURED } from "../../core/telemetry/render.js";
import type { TelemetryView } from "../../domains/telemetry/contract.js";
import type { AcpQuotaSnapshot } from "./types.js";

export type { AcpCostAggregate, AcpQuotaSnapshot, AcpUsageRow } from "./types.js";
export { ACP_ACCOUNTING_META_KEY, ACP_USAGE_READ_METHOD } from "./types.js";

/**
 * `_clio-coder/usage/read`: the numbers the terminal's /usage overlay shows.
 *
 * Session cost and tokens are the telemetry read model's, per target and model
 * as its cost report groups them, so a client never recomputes a total
 * differently (#434 §11.3). The v1 schema's plain numbers carry each figure's
 * known part, and its gaps ride beside it: `missingTokenCalls` and the cost's
 * `unknown` flag. Estimated and unknown cost stay flagged rather than being
 * rounded into a number. Quota is each provider's own report, read through
 * the quota service's cache; a read that fails is reported as failed, never
 * as an empty plan.
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
const percent = (value: number) => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);

/** The known part of a read-model quantity: measured plus estimated, never a number for what went unknown. */
export function knownPart(quantity: Quantity | null | undefined): number {
	if (!quantity) return 0;
	const fact = quantity.fact;
	if ("kind" in fact) return fact.kind === "measured" || fact.kind === "estimated" ? fact.value : 0;
	return fact.measured + fact.estimated;
}

const partial = (quantity: Quantity): boolean =>
	"kind" in quantity.fact ? quantity.fact.kind === "unknown" : quantity.fact.unknownCount > 0;
const estimated = (quantity: Quantity): boolean =>
	"kind" in quantity.fact ? quantity.fact.kind === "estimated" : quantity.fact.coverage.estimated > 0;

/**
 * The contributions to a call count whose number is unknown. Only a worker run leaves one, by recording no call
 * telemetry, so it is v1's `unknownCallCoverageRuns`: a plain `calls` number never says it is short (#434 §11.3).
 */
export function unknownCallCoverage(calls: Quantity): number {
	return "kind" in calls.fact ? (calls.fact.kind === "unknown" ? 1 : 0) : calls.fact.unknownCount;
}

/** Free only when every priced call was free and nothing went unpriced. */
export function knownFree(pricedBy: CostReportV1["total"]["pricedBy"], usd: Quantity): boolean {
	const { free, ...priced } = pricedBy;
	return free > 0 && !partial(usd) && Object.values(priced).every((count) => count === 0);
}

/** A v1 cost block: the usd quantity's known part and its display, with its provenance as flags. */
function costV1(usd: Quantity, calls: Quantity, pricedBy: CostReportV1["total"]["pricedBy"]) {
	const unknownCallCoverageRuns = unknownCallCoverage(calls);
	return {
		knownUsd: knownPart(usd),
		display: usd.display,
		calls: knownPart(calls),
		...(unknownCallCoverageRuns > 0 ? { unknownCallCoverageRuns } : {}),
		estimated: estimated(usd),
		unknown: partial(usd),
		free: knownFree(pricedBy, usd),
	};
}

const EMPTY_COST: ReturnType<typeof costV1> = {
	knownUsd: 0,
	display: COST_NOT_MEASURED,
	calls: 0,
	estimated: false,
	unknown: false,
	free: false,
};
const EMPTY_SESSION_USAGE = {
	cost: EMPTY_COST,
	tokens: 0,
	rows: [],
	truncated: false,
};

/** The side labels a v1 row counts beside its calls, keyed as the cost report keys the row's target and model. */
type Beside = Record<
	"btw" | "handoff" | "prewarm" | "memory" | "system-one" | "compaction" | "failedCompaction",
	number
>;
const BESIDE_LABELS = ["btw", "handoff", "prewarm", "memory", "system-one", "compaction"] as const;

function modelKey(row: CallRowV1): string {
	const reported = row.target.reportedModel.fact;
	return `${row.target.targetId}/${reported.kind === "measured" ? reported.value : row.target.requestedModel}`;
}

/** Each target and model's side calls by label, a call counted once across its attempts and never if never sent. */
function besideCounts(view: TelemetryView): Map<string, Beside> {
	const counts = new Map<string, Beside>();
	const seen = new Set<string>();
	for (const row of view.calls({ labels: [...BESIDE_LABELS], limit: 100_000 }).calls) {
		if (row.disposition === "never_sent" || seen.has(row.callId)) continue;
		seen.add(row.callId);
		const key = modelKey(row);
		const beside = counts.get(key) ?? {
			btw: 0,
			handoff: 0,
			prewarm: 0,
			memory: 0,
			"system-one": 0,
			compaction: 0,
			failedCompaction: 0,
		};
		if (row.label === "compaction" && row.stop?.failure) beside.failedCompaction += 1;
		else if (row.label in beside) beside[row.label as keyof Beside] += 1;
		counts.set(key, beside);
	}
	return counts;
}

/**
 * `_clio-coder/usage/read`'s v1 `session` block from the read model's view of the session: its own calls and the
 * worker runs it referenced, one row per target and model. Without a view nothing was measured.
 */
export function sessionUsageV1(view: TelemetryView | null) {
	if (view === null) return EMPTY_SESSION_USAGE;
	const read = (scope: "session" | "own" | "runs", metric: FactMetric, key?: string) =>
		view.quantity(
			factRef({ scope, owner: view.sessionId, metric, ...(key === undefined ? {} : { group: { by: "model", key } }) }),
		);
	const report = view.cost("model");
	const besides = besideCounts(view);
	const missingTokenCalls = knownPart(read("session", "missingTokenCalls"));
	return {
		cost: costV1(report.total.usd, report.total.calls, report.total.pricedBy),
		...(missingTokenCalls > 0 ? { missingTokenCalls } : {}),
		tokens: knownPart(report.total.tokens),
		rows: report.groups.slice(0, MAX_ROWS).map((group) => {
			const slash = group.key.indexOf("/");
			const workers = knownPart(read("runs", "runs", group.key));
			const missing = knownPart(read("session", "missingTokenCalls", group.key));
			const beside = besides.get(group.key);
			return {
				provider: bounded(slash < 0 ? group.key : group.key.slice(0, slash)),
				model: bounded(slash < 0 ? "" : group.key.slice(slash + 1)),
				// One per own call and one per worker run, as the cost ledger counted its entries.
				runs: knownPart(read("own", "calls", group.key)) + workers,
				calls: knownPart(group.calls),
				...(missing > 0 ? { missingTokenCalls: missing } : {}),
				tokens: {
					input: knownPart(read("session", "input", group.key)),
					output: knownPart(read("session", "output", group.key)),
					cacheRead: knownPart(read("session", "cacheRead", group.key)),
					cacheWrite: knownPart(read("session", "cacheWrite", group.key)),
					reasoning: knownPart(read("session", "reasoning", group.key)),
					total: knownPart(group.tokens),
				},
				beside: {
					sideQuestions: beside?.btw ?? 0,
					handoffs: beside?.handoff ?? 0,
					prewarms: beside?.prewarm ?? 0,
					backgroundMemory: beside?.memory ?? 0,
					...(beside?.["system-one"] ? { systemOne: beside["system-one"] } : {}),
					...(beside?.failedCompaction ? { failedCompaction: beside.failedCompaction } : {}),
					...(workers > 0 ? { workers } : {}),
					...(beside?.compaction ? { compactions: beside.compaction } : {}),
				},
				cost: costV1(group.usd, group.calls, group.pricedBy),
			};
		}),
		truncated: report.groups.length > MAX_ROWS,
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
