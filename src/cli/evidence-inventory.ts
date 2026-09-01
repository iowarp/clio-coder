/**
 * Fixed machine-readable projection of recent evidence artifacts.
 *
 * `evidence list` is an operator table and `evidence inspect <id>` needs an id,
 * so neither is a transport a GUI host can invoke blind. This command accepts
 * no identifier, path, or limit, selects a bounded newest-first window itself,
 * and emits provenance, tags, totals, and a trust verdict.
 *
 * An overview carries the working directories the runs executed in, the task
 * text the operator typed, and the file names inside the bundle. None of that
 * appears here. What does is the shape of the artifact and how far it can be
 * trusted, which is what an operator picks a bundle by.
 */

import { clioDataDir } from "../core/xdg.js";
import {
	EVIDENCE_TAGS,
	type EvidenceOverview,
	type EvidenceTag,
	listEvidenceOverviews,
	loadEvidenceTrustStatus,
	type TrustVerdict,
	trustVerdict,
} from "../domains/evidence/index.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { truncateToWidth } from "../engine/tui-primitives.js";

export const EVIDENCE_INVENTORY_MAX_ARTIFACTS = 12;
export const EVIDENCE_INVENTORY_MAX_IDS = 8;

const IDENTITY_WIDTH = 128;

/**
 * Worst verdict first.
 *
 * An artifact covering several runs is only as trustworthy as its weakest run,
 * so the fold takes the worst rather than the newest or the most common. A
 * `compromised` run inside an otherwise clean bundle is the fact the operator
 * needs, and averaging it away would be the one summary worth not printing.
 */
const VERDICT_SEVERITY: ReadonlyArray<TrustVerdict> = ["compromised", "unverified", "unknown", "grounded", "reviewed"];

export interface EvidenceInventoryArtifact {
	readonly evidenceId: string;
	readonly sourceKind: "run" | "session" | "eval";
	readonly generatedAt: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	readonly runIds: readonly string[];
	readonly runIdsTruncated: boolean;
	readonly agentIds: readonly string[];
	readonly statuses: readonly string[];
	readonly tags: readonly EvidenceTag[];
	readonly totals: Readonly<{
		runs: number;
		receipts: number;
		toolCalls: number;
		toolErrors: number;
		blockedToolCalls: number;
		protectedArtifacts: number;
		tokens: number;
		costUsd: number;
		wallTimeMs: number;
	}>;
	/** Secret-shaped values the builder replaced across the bundle's exports. */
	readonly redactionCount: number;
	readonly trust: Readonly<{
		verdict: TrustVerdict;
		/** Runs whose canonical trust status the bundle actually recorded. */
		runsCovered: number;
		/** True when the bundle predates the canonical trust projection. */
		historical: boolean;
	}>;
}

export interface EvidenceInventorySnapshot {
	readonly version: 1;
	readonly generatedAt: string;
	readonly artifacts: readonly EvidenceInventoryArtifact[];
	readonly truncated: boolean;
}

function bounded(value: string, width: number): string {
	const sanitized = sanitizeCallTargetText(value);
	if (sanitized.length === 0) return "unavailable";
	return sanitizeCallTargetText(truncateToWidth(sanitized, width, "…", false));
}

/** Distinct, sanitized, bounded, in first-seen order. */
function identities(values: ReadonlyArray<string>): string[] {
	const seen: string[] = [];
	for (const value of values) {
		const text = bounded(value, IDENTITY_WIDTH);
		if (!seen.includes(text)) seen.push(text);
		if (seen.length >= EVIDENCE_INVENTORY_MAX_IDS) break;
	}
	return seen;
}

function tally(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function amount(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Newest generation first. An unparseable stamp sorts oldest rather than throwing. */
function byNewest(a: EvidenceOverview, b: EvidenceOverview): number {
	return (Date.parse(b.generatedAt) || 0) - (Date.parse(a.generatedAt) || 0);
}

export async function evidenceInventorySnapshot(
	now: () => number = Date.now,
	dataDir: string = clioDataDir(),
): Promise<EvidenceInventorySnapshot> {
	const all = (await listEvidenceOverviews(dataDir)).sort(byNewest);
	const window = all.slice(0, EVIDENCE_INVENTORY_MAX_ARTIFACTS);
	const artifacts: EvidenceInventoryArtifact[] = [];
	for (const overview of window) {
		// One unreadable trust file costs that artifact its verdict, never the
		// whole inventory: the bundle itself is still the thing being listed.
		let verdict: TrustVerdict = "unknown";
		let runsCovered = 0;
		let historical = true;
		try {
			const status = await loadEvidenceTrustStatus(dataDir, overview.evidenceId);
			historical = status.projection !== "canonical";
			runsCovered = status.runs.length;
			const verdicts = status.runs.map((run) => trustVerdict(run.status));
			verdict = VERDICT_SEVERITY.find((candidate) => verdicts.includes(candidate)) ?? "unknown";
		} catch {
			verdict = "unknown";
		}
		artifacts.push({
			evidenceId: bounded(overview.evidenceId, IDENTITY_WIDTH),
			sourceKind: overview.source.kind,
			generatedAt: overview.generatedAt,
			startedAt: overview.startedAt,
			endedAt: overview.endedAt,
			runIds: identities(overview.runIds),
			runIdsTruncated: overview.runIds.length > EVIDENCE_INVENTORY_MAX_IDS,
			agentIds: identities(overview.agentIds),
			statuses: identities(overview.statuses),
			tags: overview.tags.filter((tag) => EVIDENCE_TAGS.includes(tag)),
			totals: {
				runs: tally(overview.totals.runs),
				receipts: tally(overview.totals.receipts),
				toolCalls: tally(overview.totals.toolCalls),
				toolErrors: tally(overview.totals.toolErrors),
				blockedToolCalls: tally(overview.totals.blockedToolCalls),
				protectedArtifacts: tally(overview.totals.protectedArtifacts),
				tokens: tally(overview.totals.tokens),
				costUsd: amount(overview.totals.costUsd),
				wallTimeMs: tally(overview.totals.wallTimeMs),
			},
			redactionCount: tally(overview.redactionCount),
			trust: { verdict, runsCovered, historical },
		});
	}
	return {
		version: 1,
		generatedAt: new Date(now()).toISOString(),
		artifacts,
		truncated: all.length > window.length,
	};
}

/**
 * `clio-coder evidence inventory --json`, and nothing else.
 *
 * `fixed` is false as soon as the caller supplied an id or any other argument.
 * A GUI host invokes this knowing the process it started cannot be steered into
 * reading a different bundle or a wider window.
 */
export async function runEvidenceInventory(fixed: boolean): Promise<number> {
	if (!fixed) {
		process.stderr.write("clio-coder evidence inventory: usage: clio-coder evidence inventory --json\n");
		return 2;
	}
	process.stdout.write(`${JSON.stringify(await evidenceInventorySnapshot(), null, 2)}\n`);
	return 0;
}
