import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { factRef } from "../../core/telemetry/dto.js";
import { renderCompactCount } from "../../core/telemetry/render.js";
import { formatCostAggregate } from "../observability/cost.js";
import { TELEMETRY_FOLD_VERSION } from "../observability/folds.js";
import { quantityOf } from "../observability/read-model.js";
import type { LegacySessionUsage, SessionMeta, SessionUsageProjection } from "./contract.js";
import { liveSessionOwner } from "./live-owner.js";
import { loadSessionTelemetrySource } from "./telemetry-source.js";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

/** One session's rebuild: its stored usage and the projection the current fold makes of its journals. */
export interface UsageRebuildRow {
	sessionId: string;
	/** `live` sessions belong to their own process; `unreadable` journals leave the meta as it was. */
	state: "drifted" | "unchanged" | "live" | "unreadable";
	before: string;
	after: string | null;
}

/** meta.json usage in one line: the projection with its fold version, or an older running total. */
function describeUsage(usage: unknown): string {
	if (!usage || typeof usage !== "object") return "none";
	const projected = usage as Partial<SessionUsageProjection>;
	if (projected.usd && projected.tokens && typeof projected.foldVersion === "number")
		return `${renderCompactCount(projected.tokens.fact)} tok · ${projected.usd.display} (fold v${projected.foldVersion})`;
	const legacy = usage as Partial<LegacySessionUsage>;
	const cost = legacy.cost ? formatCostAggregate(legacy.cost) : null;
	return `${typeof legacy.tokens === "number" ? legacy.tokens : "?"} tok${cost ? ` · ${cost}` : ""} (running total, no fold version)`;
}

function projectionKey(usage: unknown): string {
	const projected = usage as Partial<SessionUsageProjection> | undefined;
	return JSON.stringify([
		projected?.foldVersion,
		projected?.tokens?.fact,
		projected?.usd?.fact,
		projected?.usd?.display,
	]);
}

/**
 * Re-project each session's meta.json usage from its journals through the read model, the totals the live session
 * projects, and report every session whose stored projection drifted from them. A meta written before the projection
 * has no fold version and always drifts. Only `apply` writes, and never a live session's meta, which its own process
 * projects (#434 §10, P5).
 */
export function rebuildUsageProjections(
	stateDir: string,
	options: { apply: boolean; only?: string },
): UsageRebuildRow[] {
	const rows: UsageRebuildRow[] = [];
	let buckets: string[];
	try {
		buckets = readdirSync(join(stateDir, "sessions")).sort();
	} catch {
		// No sessions directory: nothing to rebuild.
		return rows;
	}
	for (const cwdHash of buckets) {
		let ids: string[];
		try {
			ids = readdirSync(join(stateDir, "sessions", cwdHash)).sort();
		} catch {
			// A stray file beside the workspace buckets holds no sessions.
			continue;
		}
		for (const sessionId of ids) {
			if ((options.only !== undefined && sessionId !== options.only) || !SAFE_ID.test(sessionId)) continue;
			const directory = join(stateDir, "sessions", cwdHash, sessionId);
			const metaPath = join(directory, "meta.json");
			let meta: SessionMeta;
			try {
				meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
			} catch {
				// No readable meta.json: nothing projects into it.
				continue;
			}
			const before = describeUsage(meta.usage);
			if (liveSessionOwner(meta)) {
				rows.push({ sessionId, state: "live", before, after: null });
				continue;
			}
			let source: ReturnType<typeof loadSessionTelemetrySource> = null;
			try {
				source = loadSessionTelemetrySource(stateDir, sessionId, directory);
			} catch {
				// An unreadable journal projects nothing; the meta keeps what it had.
				source = null;
			}
			const tokens = source && quantityOf(factRef({ scope: "session", owner: sessionId, metric: "total" }), source);
			const usd = source && quantityOf(factRef({ scope: "session", owner: sessionId, metric: "usd" }), source);
			if (!tokens || !usd) {
				rows.push({ sessionId, state: "unreadable", before, after: null });
				continue;
			}
			const next: SessionUsageProjection = { foldVersion: TELEMETRY_FOLD_VERSION, tokens, usd };
			if (projectionKey(meta.usage) === projectionKey(next)) {
				rows.push({ sessionId, state: "unchanged", before, after: before });
				continue;
			}
			rows.push({ sessionId, state: "drifted", before, after: describeUsage(next) });
			// The owner may have come back since the check above; its own projection wins.
			if (options.apply && !liveSessionOwner(meta))
				safeResourceWrite(metaPath, JSON.stringify({ ...meta, usage: next }, null, 2));
		}
	}
	return rows;
}
