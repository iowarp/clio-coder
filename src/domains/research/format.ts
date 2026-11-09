import { renderUsdLimit, renderUsdSpend } from "../../core/telemetry/render.js";
import { aaLabel } from "./grader.js";
import type { ResearchCampaignView } from "./report.js";
import type { ResearchAgentAutonomy, ResearchCost, ResearchDirection } from "./types.js";

/**
 * One line for a grade. Given the objective, an `unchanged` verdict whose interval excludes zero is named for what
 * it is: a real move smaller than the minimum improvement, toward better or worse. The verdict itself, and so the
 * archiving, stays `unchanged`.
 */
export function describeGrade(
	result: {
		verdict: string;
		delta: number | null;
		ci: { low: number; high: number } | null;
	},
	objective?: { direction: ResearchDirection; minImprovement: number },
): string {
	const delta = result.delta === null ? "delta n/a" : `median delta ${pct(result.delta)}`;
	const ci = result.ci === null ? "CI n/a" : `95% CI [${pct(result.ci.low)}, ${pct(result.ci.high)}]`;
	return `${gradeLabel(result, objective)}, ${delta}, ${ci}`;
}

function gradeLabel(
	result: { verdict: string; delta: number | null; ci: { low: number; high: number } | null },
	objective: { direction: ResearchDirection; minImprovement: number } | undefined,
): string {
	const { ci, delta } = result;
	if (result.verdict !== "unchanged" || objective === undefined || ci === null || delta === null) return result.verdict;
	if (ci.low <= 0 && ci.high >= 0) return result.verdict;
	const better = objective.direction === "min" ? ci.high < 0 : ci.low > 0;
	const required = objective.direction === "min" ? -objective.minImprovement : objective.minImprovement;
	return better
		? `below threshold (${pct(delta)} vs required ${pct(required)})`
		: `small regression (${pct(delta)}, inside the ±${(objective.minImprovement * 100).toFixed(2)}% threshold)`;
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

/** One clause naming a yolo run's pause and open decisions, or empty when there is nothing to say. */
function autonomyText(audit: ResearchAgentAutonomy | null): string {
	if (audit === null) return "";
	const open = audit.openDecisions.length + audit.openDecisionsOmitted;
	const parts = [
		...(audit.halted !== null ? [`yolo paused (${audit.halted.kind})`] : []),
		...(open > 0 ? [`${open} open decision${open === 1 ? "" : "s"}`] : []),
	];
	return parts.length > 0 ? `; ${parts.join(", ")}` : "";
}

export function campaignStatusLines(view: ResearchCampaignView): string[] {
	const { campaign } = view;
	const objective = campaign.objective;
	const lines = [
		`campaign ${campaign.id} (${view.state}${view.stop !== null ? `: ${view.stop.reason}` : ""})`,
		`objective: ${objective.direction} ${objective.metric} from check ${objective.check}; min improvement ${pct(objective.minImprovement)}, ${objective.trials} pairs`,
		`gates: ${campaign.gates.length > 0 ? campaign.gates.join(", ") : "none"}; scope: ${campaign.scope.length > 0 ? campaign.scope.join(", ") : "any unprotected file"}`,
		`protected: ${campaign.protected.join(", ")}`,
		`agent: autonomy ${campaign.agent.autonomy === "yolo" ? "yolo (contained: sandbox, safety judge and autonomous caps on; a call that needs you is refused and recorded as an open decision)" : "default"}`,
		`branch: ${campaign.ref.replace("refs/heads/", "")} at ${view.best.slice(0, 12)} (base ${campaign.base.slice(0, 12)}, ${view.ratchets} ratchet${view.ratchets === 1 ? "" : "s"})`,
		`budget: ${view.iterations.length}/${campaign.budget.maxIterations} iterations${campaign.budget.maxWallMinutes !== undefined ? `, ${campaign.budget.maxWallMinutes} min wall` : ""}${campaign.budget.maxCostUsd !== undefined ? `, ${renderUsdLimit(campaign.budget.maxCostUsd)} cap` : ""}; spend ${spendText(view)}`,
	];
	if (view.aa !== null)
		lines.push(
			`A/A: ${view.aa.noisy ? "noisy" : aaLabel(view.aa.grade)}${view.aa.noisy && view.aa.allowed ? " (allowed)" : ""}; ${describeGrade(view.aa.grade, objective)}`,
		);
	for (const iteration of view.iterations) {
		const graded = iteration.grade !== null ? `; ${describeGrade(iteration.grade, objective)}` : "";
		const gates =
			iteration.gates.length > 0
				? `; gates ${iteration.gates.map((gate) => `${gate.check} ${gate.passed ? "pass" : "fail"}`).join(", ")}`
				: "";
		lines.push(
			`  it-${String(iteration.iteration).padStart(4, "0")}  ${iteration.outcome}${graded}${gates}${autonomyText(iteration.autonomy)}; cost ${costText(iteration.cost)}${iteration.outcome !== "ratcheted" && iteration.detail.length > 0 && iteration.grade === null ? `; ${iteration.detail}` : ""}`,
		);
	}
	const open = view.iterations.flatMap((iteration) =>
		(iteration.autonomy?.openDecisions ?? []).map(
			(decision) =>
				`  it-${String(iteration.iteration).padStart(4, "0")}  ${decision.tool} \`${decision.command}\` (${decision.kind}${decision.rule !== undefined ? `, rule ${decision.rule}` : ""})`,
		),
	);
	if (open.length > 0) lines.push("open decisions left for you:", ...open);
	if (view.stop !== null) lines.push(`stopped: ${view.stop.reason}: ${view.stop.detail}`);
	if (view.unreadableJournalLines > 0)
		lines.push(`note: ${view.unreadableJournalLines} journal line(s) were unreadable`);
	return lines;
}
