import type { Codewiki } from "../codewiki/indexer.js";

export type WikiDepth = "auto" | "simple" | "medium" | "detailed";
export type ResolvedWikiDepth = Exclude<WikiDepth, "auto">;

export interface WikiGenerationPlan {
	requestedDepth: WikiDepth;
	depth: ResolvedWikiDepth;
	sourceFiles: number;
	sourceLines: number;
	researchAgents: number;
	minPages: number;
	maxPages: number;
	minPageBytes: number;
	focusAreas: ReadonlyArray<string>;
}

interface AreaWeight {
	files: number;
	lines: number;
}

/** Per-depth breadth and substance policy. The one place these numbers are chosen. */
export const WIKI_DEPTH_STRATEGY: Record<ResolvedWikiDepth, DepthStrategy> = {
	simple: { researchAgents: 0, minPages: 1, maxPages: 5, minPageBytes: 0 },
	medium: { researchAgents: 4, minPages: 4, maxPages: 10, minPageBytes: 800 },
	detailed: { researchAgents: 8, minPages: 10, maxPages: 16, minPageBytes: 1_200 },
};

export interface DepthStrategy {
	researchAgents: number;
	minPages: number;
	maxPages: number;
	minPageBytes: number;
}

function areaForPath(path: string): string {
	const parts = path.split("/").filter(Boolean);
	if (parts[0] === "src" && parts[1] === "domains" && parts[2]) return parts.slice(0, 3).join("/");
	if (parts.length >= 2) return parts.slice(0, 2).join("/");
	return parts[0] ?? path;
}

function classifyDepth(sourceFiles: number, sourceLines: number): ResolvedWikiDepth {
	if (sourceFiles <= 150 && sourceLines <= 30_000) return "simple";
	if (sourceFiles <= 800 && sourceLines <= 150_000) return "medium";
	return "detailed";
}

/**
 * Turn index size into a bounded multi-agent wiki strategy. Scale increases
 * horizontally through independent area researchers; it never grants one
 * model an unbounded tool loop or lets concurrent writers race on pages.
 */
export function planWikiGeneration(codewiki: Codewiki, requestedDepth: WikiDepth = "auto"): WikiGenerationPlan {
	const source = codewiki.files.filter((file) => file.lang !== "config");
	const sourceFiles = source.length;
	const sourceLines = source.reduce((total, file) => total + Math.max(0, file.loc), 0);
	const depth = requestedDepth === "auto" ? classifyDepth(sourceFiles, sourceLines) : requestedDepth;
	const { researchAgents, minPages, maxPages, minPageBytes } = WIKI_DEPTH_STRATEGY[depth];
	const weights = new Map<string, AreaWeight>();
	for (const file of source) {
		const area = areaForPath(file.path);
		const weight = weights.get(area) ?? { files: 0, lines: 0 };
		weight.files += 1;
		weight.lines += Math.max(0, file.loc);
		weights.set(area, weight);
	}
	const focusAreas = [...weights.entries()]
		.sort(([leftName, left], [rightName, right]) => {
			const byLines = right.lines - left.lines;
			if (byLines !== 0) return byLines;
			const byFiles = right.files - left.files;
			return byFiles !== 0 ? byFiles : leftName.localeCompare(rightName);
		})
		.slice(0, researchAgents)
		.map(([area]) => area);
	return {
		requestedDepth,
		depth,
		sourceFiles,
		sourceLines,
		researchAgents: focusAreas.length,
		minPages,
		maxPages,
		minPageBytes,
		focusAreas,
	};
}
