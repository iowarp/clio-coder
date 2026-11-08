import { renderUsdLimit, renderUsdSpend } from "../../core/telemetry/render.js";
import type { ResearchCampaignView } from "./report.js";
import type { ResearchCost } from "./types.js";

export function describeGrade(result: {
	verdict: string;
	delta: number | null;
	ci: { low: number; high: number } | null;
}): string {
	const pct = (value: number): string => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
	const delta = result.delta === null ? "delta n/a" : `median delta ${pct(result.delta)}`;
	const ci = result.ci === null ? "CI n/a" : `95% CI [${pct(result.ci.low)}, ${pct(result.ci.high)}]`;
	return `${result.verdict}, ${delta}, ${ci}`;
}

function pct(value: number | null): string {
	return value === null ? "n/a" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function costText(cost: ResearchCost | null): string {
	if (cost === null) return "-";
	if (cost.kind === "free") return "free";
	if (cost.kind === "unknown") return "unknown";
	return renderUsdSpend(cost.usd, { estimated: cost.kind === "estimated", unpriced: false });
}

function spendText(view: ResearchCampaignView): string {
	const spend = view.spend;
	const known = renderUsdSpend(spend.usd, { estimated: spend.estimated, unpriced: spend.unknownRuns > 0 });
	return spend.unknownRuns > 0 ? `${known}; ${spend.unknownRuns} run(s) had unknown spend` : known;
}

export function campaignStatusLines(view: ResearchCampaignView): string[] {
	const { campaign } = view;
	const objective = campaign.objective;
	const lines = [
		`campaign ${campaign.id} (${view.state}${view.stop !== null ? `: ${view.stop.reason}` : ""})`,
		`objective: ${objective.direction} ${objective.metric} from check ${objective.check}; min improvement ${pct(objective.minImprovement)}, ${objective.trials} pairs`,
		`gates: ${campaign.gates.length > 0 ? campaign.gates.join(", ") : "none"}; scope: ${campaign.scope.length > 0 ? campaign.scope.join(", ") : "any unprotected file"}`,
		`protected: ${campaign.protected.join(", ")}`,
		`branch: ${campaign.ref.replace("refs/heads/", "")} at ${view.best.slice(0, 12)} (base ${campaign.base.slice(0, 12)}, ${view.ratchets} ratchet${view.ratchets === 1 ? "" : "s"})`,
		`budget: ${view.iterations.length}/${campaign.budget.maxIterations} iterations${campaign.budget.maxWallMinutes !== undefined ? `, ${campaign.budget.maxWallMinutes} min wall` : ""}${campaign.budget.maxCostUsd !== undefined ? `, ${renderUsdLimit(campaign.budget.maxCostUsd)} cap` : ""}; spend ${spendText(view)}`,
	];
	if (view.aa !== null)
		lines.push(
			`A/A: ${view.aa.noisy ? "noisy" : "quiet"}${view.aa.noisy && view.aa.allowed ? " (allowed)" : ""}; ${describeGrade(view.aa.grade)}`,
		);
	for (const iteration of view.iterations) {
		const graded = iteration.grade !== null ? `; ${describeGrade(iteration.grade)}` : "";
		const gates =
			iteration.gates.length > 0
				? `; gates ${iteration.gates.map((gate) => `${gate.check} ${gate.passed ? "pass" : "fail"}`).join(", ")}`
				: "";
		lines.push(
			`  it-${String(iteration.iteration).padStart(4, "0")}  ${iteration.outcome}${graded}${gates}; cost ${costText(iteration.cost)}${iteration.outcome !== "ratcheted" && iteration.detail.length > 0 && iteration.grade === null ? `; ${iteration.detail}` : ""}`,
		);
	}
	if (view.stop !== null) lines.push(`stopped: ${view.stop.reason}: ${view.stop.detail}`);
	if (view.unreadableJournalLines > 0)
		lines.push(`note: ${view.unreadableJournalLines} journal line(s) were unreadable`);
	return lines;
}
