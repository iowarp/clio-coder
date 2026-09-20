import { buildCustomizationGraph } from "../../../../../src/cli/config-inspect.js";
import type { ConfigGraph } from "../../../contracts/settings.js";

export function inspectConfigGraph(cwd: string): ConfigGraph {
	const graph = buildCustomizationGraph(cwd);
	const issueCounts = new Map<string, number>();
	for (const issue of graph.issues) {
		const category =
			/^(settings|clio-md|rules|operator-profile|hooks?|hook-receipts|extensions|resources|safety|memory)\b/.exec(
				issue,
			)?.[1] ?? "configuration";
		issueCounts.set(category, (issueCounts.get(category) ?? 0) + 1);
	}
	return {
		categories: [...new Set(graph.entries.map((entry) => entry.category))].sort(),
		entries: graph.entries.map(({ detail, ...entry }) => ({
			...entry,
			// Root details contain heterogeneous source metadata. Expose only bounded numeric/boolean facts;
			// never forward hook arguments, environment maps, source contents, or provider credentials.
			facts: Object.fromEntries(
				Object.entries(detail ?? {}).filter(
					(pair): pair is [string, boolean | number] =>
						typeof pair[1] === "boolean" || (typeof pair[1] === "number" && Number.isFinite(pair[1])),
				),
			),
		})),
		issues: [...issueCounts].map(([category, count]) => ({
			category,
			count,
			message: "This source reported an inspection issue. Inspect it locally for details.",
		})),
	};
}
