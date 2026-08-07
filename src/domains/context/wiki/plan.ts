import type { Codewiki } from "../codewiki/indexer.js";

export type WikiDepth = "auto" | "simple" | "medium" | "detailed";
export type ResolvedWikiDepth = Exclude<WikiDepth, "auto">;

export interface WikiGenerationPlan {
	requestedDepth: WikiDepth;
	depth: ResolvedWikiDepth;
	sourceFiles: number;
	sourceLines: number;
	/** Retained in metadata for compatibility. Wiki generation uses one documenter pass. */
	researchAgents: number;
	/** Guidance for the documenter prompt; not enforced as a hard validation rule. */
	focusAreas: ReadonlyArray<string>;
	/** Target breadth and substance for the documenter prompt; not hard limits. */
	minPages: number;
	maxPages: number;
	minPageBytes: number;
}

interface AreaWeight {
	files: number;
	lines: number;
}

/** Per-depth guidance for the documenter prompt. These are not hard limits. */
export const WIKI_DEPTH_STRATEGY: Record<ResolvedWikiDepth, DepthStrategy> = {
	simple: { focusAreas: 0, minPages: 1, maxPages: 5, minPageBytes: 0 },
	medium: { focusAreas: 4, minPages: 4, maxPages: 10, minPageBytes: 800 },
	detailed: { focusAreas: 8, minPages: 10, maxPages: 16, minPageBytes: 1_200 },
};

export interface DepthStrategy {
	focusAreas: number;
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
 * Turn index size into a single-owner wiki strategy. The documenter does one
 * pass; bounded recovery only runs when deterministic validation finds a real
 * defect in the staged artifact.
 */
export function planWikiGeneration(codewiki: Codewiki, requestedDepth: WikiDepth = "auto"): WikiGenerationPlan {
	const source = codewiki.files.filter((file) => file.lang !== "config");
	const sourceFiles = source.length;
	const sourceLines = source.reduce((total, file) => total + Math.max(0, file.loc), 0);
	const depth = requestedDepth === "auto" ? classifyDepth(sourceFiles, sourceLines) : requestedDepth;
	const { focusAreas: focusAreaLimit, minPages, maxPages, minPageBytes } = WIKI_DEPTH_STRATEGY[depth];
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
		.slice(0, focusAreaLimit)
		.map(([area]) => area);
	return {
		requestedDepth,
		depth,
		sourceFiles,
		sourceLines,
		researchAgents: 0,
		minPages,
		maxPages,
		minPageBytes,
		focusAreas,
	};
}
