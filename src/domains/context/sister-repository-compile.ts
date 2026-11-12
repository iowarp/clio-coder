/**
 * The untrusted compile of a sister repository's handbook, run on its worker
 * thread: the rules the tree verifies, under their own headings, and the
 * checker rules. Kept apart from `sister-repository.ts` so the worker loads
 * only the verifier, not the caches the prompt path reads.
 */
import { createHash } from "node:crypto";
import { type HandbookLedgerEntry, verifyHandbookRules } from "./bootstrap.js";
import { instructionUnits } from "./instruction-units.js";
import type { SisterRepositoryRules } from "./sister-repository.js";

/** What the compile reads, all of it plain data so it crosses to the worker thread. */
export interface SisterCompileInput {
	root: string;
	name: string;
	/** Repository-relative handbook files, in load order. */
	files: string[];
	handbooks: Array<{ file: string; path: string; content: string }>;
	/** The repository's visible files, handbooks left out. */
	repositoryFiles: string[];
}

export interface SisterCompileResult {
	rules: SisterRepositoryRules;
	ledger: HandbookLedgerEntry[];
}

export type SisterCompileWorkerMessage = { ok: true; result: SisterCompileResult } | { ok: false; error: string };

/** The units of `content` the tree verified, under their own headings, as a handbook the worker compile can route. */
function verifiedHandbook(
	title: string,
	file: string,
	content: string,
	verified: ReadonlySet<string>,
	checks: ReadonlyArray<string>,
): string {
	const sections = new Map<string, string[]>();
	for (const unit of instructionUnits(content, 600, file)) {
		if (!verified.has(`${unit.file}:${unit.line}`)) continue;
		const heading = unit.heading.trim() || "Rules";
		sections.set(heading, [...(sections.get(heading) ?? []), `- ${unit.text}`]);
	}
	if (checks.length > 0)
		sections.set(
			"Checks",
			checks.map((rule) => `- ${rule}`),
		);
	if (sections.size === 0) return "";
	return [`# ${title}`, ...[...sections].flatMap(([heading, lines]) => ["", `## ${heading}`, "", ...lines])].join("\n");
}

/**
 * The untrusted compile. A repository with no handbook gets nothing yet; a
 * checker-only compile for it would cache inside that repository, which a
 * sister run never writes.
 */
export function compileSisterRules(input: SisterCompileInput): SisterCompileResult {
	const { root, name, files, handbooks, repositoryFiles } = input;
	const title = `Rules of ${name}, compiled from ${files.join(", ")}`;
	const { entries, checkerRules } =
		handbooks.length > 0 ? verifyHandbookRules(root, handbooks, { repositoryFiles }) : { entries: [], checkerRules: [] };
	const verified = new Set(
		entries
			.filter((entry) => entry.verdict === "verified")
			.map((entry) => `${entry.source?.file ?? ""}:${entry.source?.line ?? 0}`),
	);
	const sources = handbooks
		.map((handbook, index) => ({
			path: handbook.path,
			// The checker rules are the repository's, not one file's: they ride with the first.
			source: verifiedHandbook(title, handbook.file, handbook.content, verified, index === 0 ? checkerRules : []),
		}))
		.filter((source) => source.source.length > 0);
	return {
		ledger: entries,
		rules: {
			root,
			name,
			trusted: false,
			files,
			sources,
			withheld: entries.filter((entry) => entry.verdict !== "verified").length,
			hash: createHash("sha256").update(JSON.stringify(sources)).digest("hex"),
		},
	};
}
