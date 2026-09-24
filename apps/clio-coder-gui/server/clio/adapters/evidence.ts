import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import { clioDataDir } from "../../../../../src/core/xdg.js";
import { admitRunProvenance, provenanceTranscriptLines } from "../../../../../src/domains/evidence/provenance.js";
import {
	inspectEvidence,
	listEvidenceOverviews,
	loadEvidenceGateDecisions,
	loadEvidenceRunProvenance,
	loadEvidenceTrustStatus,
} from "../../../../../src/domains/evidence/store.js";
import { summarizeTrustStatus, trustVerdict } from "../../../../../src/domains/evidence/trust-projection.js";
import type { EvidenceTrustStatusView } from "../../../../../src/domains/evidence/types.js";
import { Id } from "../../../contracts/common.js";
import { EvidenceOverview, type EvidenceRequest } from "../../../contracts/evidence.js";
import { AppProblem } from "../../services/problem.js";
import { artifactPage, containedFile } from "./storage.js";

/** Preflight the exact files a root seam reads, including optional files. Never follow an escaping symlink. */
function guard(data: string, id: string, names: string[]): number {
	let bytes = 0;
	for (const name of names) {
		try {
			lstatSync(join(data, "evidence", id, name));
		} catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
			throw error;
		}
		const path = containedFile(data, "evidence", id, name);
		if (!path) throw new AppProblem("unavailable", "Evidence storage contains an unsafe or oversized artifact.");
		bytes += statSync(path).size;
	}
	return bytes;
}
// Bundle presentation follows the CLI inventory's severity order; axis interpretation remains in src/.
function verdict(trust: EvidenceTrustStatusView) {
	const values = trust.runs.map((run) => trustVerdict(run.status));
	return (
		(["compromised", "unverified", "unknown", "grounded", "reviewed"] as const).find((value) => values.includes(value)) ??
		"unknown"
	);
}
async function inventory(data: string) {
	let entries: string[];
	try {
		entries = readdirSync(join(data, "evidence"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (entries.length > 10_000) throw new AppProblem("unavailable", "Evidence inventory exceeds 10,000 directories.");
	let bytes = 0;
	for (const id of entries) {
		// The canonical listing also ignores identifiers rejected by assertSafeId.
		bytes += guard(data, id, ["overview.json"]);
		if (bytes > 64 * 1024 * 1024) throw new AppProblem("unavailable", "Evidence overview inventory exceeds 64 MiB.");
	}
	return (await listEvidenceOverviews(data)).filter(
		(row) => Value.Check(EvidenceOverview, row) && Number.isFinite(Date.parse(row.generatedAt)),
	);
}
async function item(data: string, overview: Awaited<ReturnType<typeof inventory>>[number]) {
	guard(data, overview.evidenceId, ["trust-status.json"]);
	try {
		return { overview, verdict: verdict(await loadEvidenceTrustStatus(data, overview.evidenceId)) };
	} catch {
		return { overview, verdict: "unknown" as const };
	}
}

/** Only link-confidence counts cross into the GUI; event text stays in the artifact. */
function attributionCounts(data: string, id: string) {
	const counts = { exact: 0, bestEffort: 0, unclassified: 0 };
	const path = containedFile(data, "evidence", id, "tool-events.jsonl");
	if (!path) return counts;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			counts.unclassified += 1;
			continue;
		}
		if (row === null || typeof row !== "object" || Array.isArray(row)) {
			counts.unclassified += 1;
			continue;
		}
		const event = row as { confidence?: unknown; runLink?: { confidence?: unknown } };
		const direct = event.confidence;
		const linked = event.runLink?.confidence;
		const confidence = direct === undefined ? linked : linked === undefined || linked === direct ? direct : null;
		if (confidence === "exact") counts.exact += 1;
		else if (confidence === "best-effort") counts.bestEffort += 1;
		else counts.unclassified += 1;
	}
	return counts;
}
export async function readEvidence(input: EvidenceRequest): Promise<unknown> {
	const data = clioDataDir();
	if (input.kind === "list" || input.kind === "built") {
		const rows = await inventory(data);
		if (input.kind === "built") {
			const row = rows
				.filter((row) => row.source.kind === "run" && row.source.runId === input.runId)
				.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
			if (!row) throw new AppProblem("unavailable", "The completed build has no readable evidence artifact.");
			return item(data, row);
		}
		const page = artifactPage(
			rows.map((overview) => ({ id: overview.evidenceId, startedAt: overview.generatedAt, overview })),
			input.limit,
			input.cursor,
		);
		return { items: await Promise.all(page.items.map((row) => item(data, row.overview))), nextCursor: page.nextCursor };
	}
	if (!Value.Check(Id, input.id)) throw new AppProblem("validation", "Invalid evidence identifier.");
	guard(data, input.id, [
		"overview.json",
		"findings.json",
		"trust-status.json",
		"receipt.json",
		"gate-decisions.json",
		"tool-events.jsonl",
	]);
	if (!containedFile(data, "evidence", input.id, "overview.json"))
		throw new AppProblem("not_found", "Evidence artifact was not found.");
	try {
		const detail = await inspectEvidence(data, input.id);
		const provenance = await loadEvidenceRunProvenance(data, input.id);
		return {
			overview: detail.overview,
			findings: detail.findings,
			verdict: verdict(detail.trustStatus),
			projection: detail.trustStatus.projection,
			runs: detail.trustStatus.runs.map((run) => ({ ...run, summary: summarizeTrustStatus(run.status) })),
			provenance: provenance.flatMap((run) => {
				const status = detail.trustStatus.runs.find((entry) => entry.runId === run.runId)?.status;
				// A historical bundle has no authenticated projection to admit provenance against.
				return status
					? [
							{
								runId: run.runId,
								view: admitRunProvenance(run.view, status),
								lines: provenanceTranscriptLines(run.view, status),
							},
						]
					: [];
			}),
			gateDecisions: await loadEvidenceGateDecisions(data, input.id),
			attribution: attributionCounts(data, input.id),
		};
	} catch {
		throw new AppProblem(
			"unavailable",
			"This evidence artifact is incomplete or unreadable. Other artifacts remain available.",
		);
	}
}
