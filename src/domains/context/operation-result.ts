import type { ContextOperationFact } from "../../core/context-operation.js";
import type { RunBootstrapResult } from "./bootstrap.js";
import type { RunContextClearResult } from "./clear.js";
import type { RunContextRefreshResult } from "./refresh.js";

export function bootstrapOperationFacts(result: RunBootstrapResult): ContextOperationFact[] {
	const { summary } = result;
	const facts: ContextOperationFact[] = [
		{ kind: "read", unit: "paths", count: summary.contextFileCount, paths: summary.contextFileNames },
	];
	if (Number.isSafeInteger(summary.codewikiEntries) && summary.codewikiEntries >= 0)
		facts.push({ kind: "indexed", unit: "source-files", count: summary.codewikiEntries });
	if (summary.action === "previewed") return facts;
	if (result.gitignoreChange)
		facts.push({ kind: result.gitignoreChange, unit: "paths", count: 1, paths: [".gitignore"] });
	facts.push({
		kind:
			summary.action === "wrote" || summary.action === "proposed"
				? "created"
				: summary.action === "refreshed"
					? "updated"
					: "preserved",
		unit: "paths",
		count: 1,
		paths: [summary.proposalPath ?? "CLIO-CODER.md"],
	});
	if (summary.action === "proposed")
		facts.push({ kind: "preserved", unit: "paths", count: 1, paths: ["CLIO-CODER.md"] });
	if (summary.adoption.mode === "adopt")
		facts.push({ kind: "ingested", unit: "rules", count: summary.adoption.importedRuleCount });
	if (summary.adoption.rejectedCount)
		facts.push({ kind: "omitted", unit: "paths", count: summary.adoption.rejectedCount });
	return facts;
}
export function refreshOperationFacts(result: RunContextRefreshResult): ContextOperationFact[] {
	return [
		{ kind: "indexed", unit: "source-files", count: result.codewikiEntries },
		...(result.clioMd === "unchanged"
			? [{ kind: "preserved" as const, unit: "paths" as const, count: 1, paths: ["CLIO-CODER.md"] }]
			: []),
	];
}
export function clearOperationFacts(result: RunContextClearResult): ContextOperationFact[] {
	return [
		{ kind: "removed", unit: "paths", count: result.removed.length, paths: result.removed },
		...(result.preservedExisting
			? [
					{
						kind: "preserved" as const,
						unit: "paths" as const,
						count: result.preservedExisting.length,
						paths: result.preservedExisting,
					},
				]
			: []),
	];
}
