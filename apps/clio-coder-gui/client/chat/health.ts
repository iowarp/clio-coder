// The session-health taxonomy. `SessionSnapshot.health` is a bounded 32-entry strip of the four
// facts that describe this conversation rather than a dispatched run: the context window was cut,
// it is close to full, the loop guard stopped a turn on call volume, and a target changed state.
//
// An operator needs the newest of each, not a history, so this reduces the strip to one row per
// live concern and one row per target. Two rules carry the weight:
//
//  - `health.contextWarning` with `warning: null` is the CLEARING edge. It retires the banner. It
//    must never render as the word "null", and it must not be mistaken for "no warning seen yet",
//    which is also an absent banner but for a different reason.
//  - The supervisor logs and drops an event kind it does not recognise rather than killing the
//    session, so a fact type this build has never heard of must reduce to a readable row rather
//    than being dropped silently or throwing.

import type { HealthItem } from "../../contracts/fleet-events.js";
import type { StatusTone } from "../design/status.js";

/**
 * The strip as it may actually arrive. A newer engine can put a fact type on the wire that this
 * build's union does not name, so the reducer reads the envelope structurally and never assumes the
 * payload has the shape its type claims.
 */
export type HealthItemLike = Omit<HealthItem, "fact"> & {
	readonly fact: { readonly type: string; readonly payload?: unknown };
};

export type HealthRowKind = "contextWarning" | "compaction" | "toolBudget" | "provider" | "unknown";

export interface HealthRow {
	readonly id: string;
	readonly kind: HealthRowKind;
	/** The target id for a provider row, the fact type for an unknown row, otherwise the kind. */
	readonly key: string;
	readonly at: string;
	readonly sourceSequence: number;
	readonly label: string;
	readonly detail: string | null;
	readonly tone: StatusTone;
	/** True when this row is a thing the operator should act on now. */
	readonly attention: boolean;
}

export interface HealthSummary {
	/** The standing context warning, or null when none was ever raised or the latest edge cleared it. */
	readonly contextWarning: HealthRow | null;
	/** The most recent compaction, which explains why earlier conversation vanished. */
	readonly compaction: HealthRow | null;
	/** The most recent tool-budget breach, which explains why a turn stopped making progress. */
	readonly toolBudget: HealthRow | null;
	/** One row per target, newest state, ordered by target id. */
	readonly providers: readonly HealthRow[];
	/** One row per unrecognised fact type, newest first seen, ordered by type. */
	readonly unknown: readonly HealthRow[];
	/** Every row above in display order, most actionable first. */
	readonly rows: readonly HealthRow[];
	readonly attention: boolean;
	readonly worst: StatusTone;
}

const SEVERITY: Readonly<Record<StatusTone, number>> = {
	fail: 5,
	warn: 4,
	unverified: 3,
	running: 2,
	success: 1,
	neutral: 0,
};

const record = (value: unknown): Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const integer = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
const flag = (value: unknown): boolean => value === true;
const amount = (value: number | null): string => (value === null ? "not reported" : value.toLocaleString("en-US"));

const PROVIDER_TONES: Readonly<Record<string, StatusTone>> = {
	healthy: "success",
	degraded: "warn",
	down: "fail",
	unknown: "unverified",
};

function providerDetail(status: string, available: boolean, latencyMs: number | null): string {
	const reach = available ? "Reachable" : "Not reachable";
	const latency = latencyMs === null ? "latency not reported" : `${amount(latencyMs)} ms last check`;
	return `${reach}, reported ${status}, ${latency}.`;
}

function toolBudgetDetail(
	tool: string,
	callsThisTurn: number | null,
	softBudget: number | null,
	hardCeiling: number | null,
	interrupted: boolean,
): string {
	const counts = `${tool} was called ${amount(callsThisTurn)} times this turn against a soft budget of ${amount(softBudget)} and a hard ceiling of ${amount(hardCeiling)}.`;
	return interrupted ? `${counts} Clio Coder interrupted the turn.` : counts;
}

function toRow(item: HealthItemLike): HealthRow | null {
	const base = { id: item.id, at: item.at, sourceSequence: item.sourceSequence };
	const payload = record(item.fact.payload);
	switch (item.fact.type) {
		case "health.contextWarning": {
			const warning = text(payload.warning);
			// The clearing edge is a real row so the reducer can retire an older warning with it; the
			// summary drops it afterwards rather than showing it.
			return warning === null
				? {
						...base,
						kind: "contextWarning",
						key: "contextWarning",
						label: "Context window",
						detail: null,
						tone: "success",
						attention: false,
					}
				: {
						...base,
						kind: "contextWarning",
						key: "contextWarning",
						label: "Context window",
						detail: warning,
						tone: "warn",
						attention: true,
					};
		}
		case "health.compacted":
			return {
				...base,
				kind: "compaction",
				key: "compaction",
				label: "Context compacted",
				detail: `Triggered by ${text(payload.trigger) ?? "an unreported condition"}. Earlier conversation was summarised to make room.`,
				tone: "neutral",
				attention: false,
			};
		case "health.toolBudget": {
			const interrupted = flag(payload.interrupted);
			return {
				...base,
				kind: "toolBudget",
				key: "toolBudget",
				label: interrupted ? "Tool budget stopped the turn" : "Tool budget exceeded",
				detail: toolBudgetDetail(
					text(payload.tool) ?? "a tool",
					integer(payload.callsThisTurn),
					integer(payload.softBudget),
					integer(payload.hardCeiling),
					interrupted,
				),
				tone: interrupted ? "fail" : "warn",
				attention: true,
			};
		}
		case "health.provider": {
			const targetId = text(payload.targetId) ?? "unnamed target";
			const status = text(payload.status) ?? "unknown";
			const available = flag(payload.available);
			return {
				...base,
				kind: "provider",
				key: targetId,
				label: `Target ${targetId}`,
				detail: providerDetail(status, available, integer(payload.latencyMs)),
				tone: PROVIDER_TONES[status] ?? "unverified",
				attention: status !== "healthy",
			};
		}
		default: {
			const type = text(item.fact.type);
			if (type === null) return null;
			return {
				...base,
				kind: "unknown",
				key: type,
				label: "Unrecognised health report",
				detail: `Clio Coder reported "${type}", which this build does not understand. The report was kept rather than dropped.`,
				tone: "unverified",
				attention: false,
			};
		}
	}
}

const newer = (candidate: HealthRow, held: HealthRow | undefined): boolean =>
	held === undefined || candidate.sourceSequence >= held.sourceSequence;

/**
 * Reduces the strip to what an operator reads at a glance. Order within `rows` is fixed rather than
 * chronological, so a row does not move under the pointer when an unrelated fact arrives.
 */
export function summarizeHealth(items: readonly HealthItemLike[]): HealthSummary {
	let contextWarning: HealthRow | undefined;
	let compaction: HealthRow | undefined;
	let toolBudget: HealthRow | undefined;
	const providers = new Map<string, HealthRow>();
	const unknown = new Map<string, HealthRow>();
	for (const item of items) {
		const row = toRow(item);
		if (row === null) continue;
		switch (row.kind) {
			case "contextWarning":
				if (newer(row, contextWarning)) contextWarning = row;
				break;
			case "compaction":
				if (newer(row, compaction)) compaction = row;
				break;
			case "toolBudget":
				if (newer(row, toolBudget)) toolBudget = row;
				break;
			case "provider":
				if (newer(row, providers.get(row.key))) providers.set(row.key, row);
				break;
			case "unknown":
				if (newer(row, unknown.get(row.key))) unknown.set(row.key, row);
				break;
		}
	}
	// A cleared warning is the absence of a banner, not a banner saying "cleared".
	const standing = contextWarning !== undefined && contextWarning.detail !== null ? contextWarning : null;
	const byKey = (left: HealthRow, right: HealthRow) => left.key.localeCompare(right.key, "en-US");
	const providerRows = [...providers.values()].sort(byKey);
	const unknownRows = [...unknown.values()].sort(byKey);
	const rows = [
		...(standing === null ? [] : [standing]),
		...(toolBudget === undefined ? [] : [toolBudget]),
		...providerRows,
		...(compaction === undefined ? [] : [compaction]),
		...unknownRows,
	];
	return {
		contextWarning: standing,
		compaction: compaction ?? null,
		toolBudget: toolBudget ?? null,
		providers: providerRows,
		unknown: unknownRows,
		rows,
		attention: rows.some((row) => row.attention),
		worst: rows.reduce<StatusTone>((worst, row) => (SEVERITY[row.tone] > SEVERITY[worst] ? row.tone : worst), "neutral"),
	};
}
