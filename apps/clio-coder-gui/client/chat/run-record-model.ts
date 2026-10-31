import type { RunResultFacts } from "../../contracts/run-result-facts.js";
import type { TimelineItem } from "../../contracts/sessions.js";
import { compactDuration } from "./overview-model.js";
import { presentTool } from "./tool-presentation.js";

export function runRecordLine(record: RunResultFacts): string {
	if (record.unavailable) return "Run record unavailable";
	const outcome = record.outcome === "succeeded" ? "Execution ok" : (record.outcome ?? "Outcome not reported");
	return [
		outcome,
		record.contract ? `conformance ${record.contract}` : "conformance not reported",
		record.trust ? `trust: ${record.trust}` : "trust not reported",
		record.validation,
		record.tokensDisplay ? `${record.tokensDisplay} tokens` : null,
		record.elapsedMs === null ? null : compactDuration(record.elapsedMs),
		record.placement?.mode === "worktree"
			? `worktree ${record.placement.branch ?? ""}`.trim()
			: record.placement
				? "current workspace"
				: null,
	]
		.filter(Boolean)
		.join(" · ");
}

export function itemRunId(item: TimelineItem): string | null {
	if (item.kind === "tool") {
		const card = presentTool(item, {});
		if (card.body === "dispatch") return card.facts.find((fact) => fact.label === "run")?.value ?? null;
		return null;
	}
	return item.provenance?.filter((agent) => agent.role === "worker" && agent.runId).at(-1)?.runId ?? null;
}
