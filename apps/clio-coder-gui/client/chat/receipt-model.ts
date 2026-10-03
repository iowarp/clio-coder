import type { ReceiptFacts } from "../../contracts/receipt-facts.js";
import type { TimelineItem } from "../../contracts/sessions.js";
import { compactCount, compactDuration } from "./overview-model.js";
import { presentTool } from "./tool-presentation.js";

export function receiptLine(receipt: ReceiptFacts): string {
	if (receipt.unavailable) return "Receipt unavailable";
	const outcome = receipt.outcome === "succeeded" ? "Execution ok" : (receipt.outcome ?? "Outcome not reported");
	return [
		outcome,
		receipt.contract ? `conformance ${receipt.contract}` : "conformance not reported",
		receipt.trust ? `trust: ${receipt.trust}` : "trust not reported",
		receipt.validation,
		receipt.tokens === null ? null : `${compactCount(receipt.tokens)} tokens`,
		receipt.elapsedMs === null ? null : compactDuration(receipt.elapsedMs),
		receipt.placement?.mode === "worktree"
			? `worktree ${receipt.placement.branch ?? ""}`.trim()
			: receipt.placement
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
