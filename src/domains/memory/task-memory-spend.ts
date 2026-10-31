import type { TaskMemorySpendSummary } from "../telemetry/index.js";

export {
	emptyTaskMemorySpendSummary,
	readTaskMemorySpendSummary,
	type TaskMemorySpendSummary,
} from "../telemetry/index.js";

/** Compact operator wording, with incomplete-history warnings before any known totals. */
export function formatTaskMemorySpend(summary: TaskMemorySpendSummary): string {
	const missing = [
		...((summary.unresolvedCalls ?? 0) > 0 ? [`${summary.unresolvedCalls} call records unresolved`] : []),
		...(summary.unreadableFiles > 0 ? [`${summary.unreadableFiles} unreadable files`] : []),
		...(summary.invalidRows > 0 ? [`${summary.invalidRows} invalid rows`] : []),
		...(summary.missingTokenCalls > 0 ? [`${summary.missingTokenCalls} calls missing usage`] : []),
		...(summary.unreportedUsageSteps > 0 ? [`usage coverage unreported for ${summary.unreportedUsageSteps} steps`] : []),
	];
	const scope = missing.length > 0 ? `partial retained spend (${missing.join(", ")})` : "retained spend";
	if (summary.llmSteps === 0) {
		if (summary.unreadableFiles > 0 && summary.readableFiles === 0) return `${scope} · unavailable`;
		if (missing.length > 0) return `${scope} · no readable LLM steps`;
		return `${scope} · ${summary.readableFiles === 0 ? "no history" : "no LLM steps"}`;
	}
	const tokens =
		summary.totalTokens >= 1_000 ? `${(summary.totalTokens / 1_000).toFixed(1)}k tok` : `${summary.totalTokens} tok`;
	const seconds = summary.modelMs / 1_000;
	const time = seconds >= 60 ? `${(seconds / 60).toFixed(1)}m` : `${seconds.toFixed(1)}s`;
	const rate = `${Math.round(summary.hitRate * 100)}%`;
	return `${scope} ${summary.llmSteps} steps · known ${tokens} · ${time} · hit ${summary.injections}/${summary.llmSteps} (${rate})`;
}
