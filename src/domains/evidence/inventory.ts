/**
 * Fixed machine-readable projection of recent runs' evidence (#434).
 *
 * `evidence list` is an operator table and `evidence inspect <runId>` needs an id, so neither is a transport a host
 * can invoke blind. This read selects a bounded newest-first window itself and emits each run's identity, finding
 * tags, totals and trust verdict. The run's finding prose and its task text do not appear here.
 */

import { clioStateDir } from "../../core/xdg.js";
import { truncateToWidth } from "../../engine/tui-primitives.js";
import { sanitizeCallTargetText } from "../safety/call-target.js";
import { listRunEvidence } from "./run-evidence.js";
import { type TrustVerdict, trustVerdict } from "./trust-projection.js";
import { EVIDENCE_TAGS, type EvidenceTag, type RunEvidence } from "./types.js";

export const EVIDENCE_INVENTORY_MAX_ARTIFACTS = 12;

const IDENTITY_WIDTH = 128;

export interface EvidenceInventoryArtifact {
	readonly runId: string;
	readonly assessedAt: string | null;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	readonly agentId: string | null;
	readonly outcome: string | null;
	readonly integrity: "verified" | "unsealed" | "failed";
	readonly firstPassSuccess: boolean | null;
	readonly tags: readonly EvidenceTag[];
	readonly totals: Readonly<{
		toolCalls: number;
		toolErrors: number;
		blockedToolCalls: number;
		/** The run's token and cost quantities as the canonical renderer words them, coverage marker included. */
		tokens: string;
		cost: string;
		wallTimeMs: number;
	}> | null;
	readonly verdict: TrustVerdict;
}

export interface EvidenceInventorySnapshot {
	readonly version: 1;
	readonly generatedAt: string;
	readonly artifacts: readonly EvidenceInventoryArtifact[];
	readonly truncated: boolean;
	/** Present only on explicitly paginated reads; pass this to the next read. */
	readonly nextCursor?: string | null;
}

export interface EvidenceInventoryPage {
	readonly cursor?: string;
	readonly limit?: number;
}

function bounded(value: string): string {
	const sanitized = sanitizeCallTargetText(value);
	if (sanitized.length === 0) return "unavailable";
	return sanitizeCallTargetText(truncateToWidth(sanitized, IDENTITY_WIDTH, "…", false));
}

function artifactOf(run: RunEvidence): EvidenceInventoryArtifact {
	return {
		runId: bounded(run.runId),
		assessedAt: run.assessedAt,
		startedAt: run.settled?.startedAt ?? null,
		endedAt: run.settled?.endedAt ?? null,
		agentId: run.settled ? bounded(run.settled.agentId) : null,
		outcome: run.settled?.outcome ?? null,
		integrity: run.integrity.state,
		firstPassSuccess: run.firstPassSuccess,
		tags: run.tags.filter((tag) => EVIDENCE_TAGS.includes(tag)),
		totals:
			run.totals === null
				? null
				: {
						toolCalls: run.totals.toolCalls,
						toolErrors: run.totals.toolErrors,
						blockedToolCalls: run.totals.blockedToolCalls,
						tokens: run.totals.tokens.display,
						cost: run.totals.usd.display,
						wallTimeMs: run.totals.wallTimeMs,
					},
		verdict: trustVerdict(run.trust),
	};
}

/**
 * `include` narrows the runs before the newest-first window is taken, so a caller scoping the inventory to one session
 * or project still gets a full window of its own runs rather than whatever survived a machine-wide cut.
 */
export async function evidenceInventorySnapshot(
	now: () => number = Date.now,
	stateDir: string = clioStateDir(),
	include?: (run: RunEvidence) => boolean,
	page?: EvidenceInventoryPage,
): Promise<EvidenceInventorySnapshot> {
	const listed = await listRunEvidence(stateDir);
	const all = include === undefined ? listed : listed.filter(include);
	const cursorIndex = page?.cursor === undefined ? -1 : all.findIndex((item) => item.runId === page.cursor);
	if (page?.cursor !== undefined && cursorIndex < 0) throw new Error("cursor unavailable in visible evidence inventory");
	const start = cursorIndex + 1;
	const limit = Math.min(EVIDENCE_INVENTORY_MAX_ARTIFACTS, Math.max(1, page?.limit ?? EVIDENCE_INVENTORY_MAX_ARTIFACTS));
	const window = all.slice(start, start + limit);
	const hasMore = start + window.length < all.length;
	return {
		version: 1,
		generatedAt: new Date(now()).toISOString(),
		artifacts: window.map(artifactOf),
		truncated: hasMore,
		...(page === undefined ? {} : { nextCursor: hasMore ? (window.at(-1)?.runId ?? null) : null }),
	};
}
