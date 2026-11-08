import type {
	ResearchCampaign,
	ResearchCampaignSummary,
	ResearchGrade,
	ResearchIteration,
	ResearchReport,
	ResearchStartRequest,
} from "../../contracts/research.js";
import { eyebrow, type PanelCopy } from "../design/panel-model.js";

export const RESEARCH_PANEL: PanelCopy = {
	eyebrow: eyebrow("Research campaigns", "this workspace", "hill climb"),
	title: "Research",
	boundary:
		"Campaigns, raw samples and verdicts live under .clio-coder/research in this workspace. Candidates run in isolated worktrees; only the research branch moves, never your checkout.",
};

const signed = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
export const percent = (value: number | null) => (value === null ? "n/a" : signed(value));
export const shortSha = (sha: string | null) => (sha ? sha.slice(0, 12) : "none");

/** The same words `research status` prints for a grade. */
export function describeGrade(grade: Pick<ResearchGrade, "verdict" | "delta" | "ci">): string {
	const delta = grade.delta === null ? "delta n/a" : `median delta ${signed(grade.delta)}`;
	const ci = grade.ci === null ? "CI n/a" : `95% CI [${signed(grade.ci.low)}, ${signed(grade.ci.high)}]`;
	return `${grade.verdict}, ${delta}, ${ci}`;
}

export interface Fact {
	label: string;
	value: string;
}

/** What the campaign froze when it opened: the objective, its budget and what no candidate may touch. */
export function campaignFacts(view: ResearchCampaign): Fact[] {
	const { campaign } = view;
	const { objective, budget } = campaign;
	const caps = [
		`${view.iterations.length} of ${budget.maxIterations} iterations`,
		...(budget.maxWallMinutes !== undefined ? [`${budget.maxWallMinutes} min wall`] : []),
		...(view.display?.cap !== undefined ? [`${view.display.cap} cap`] : []),
		...(budget.allowUnpriced ? ["unpriced runs allowed"] : []),
	];
	return [
		{
			label: "Objective",
			value: `${objective.direction} ${objective.metric} from check ${objective.check}; at least ${(objective.minImprovement * 100).toFixed(2)}% better over ${objective.trials} pairs`,
		},
		{ label: "Budget", value: caps.join(", ") },
		{ label: "Spend", value: view.display?.spend ?? "not rendered" },
		{ label: "Gates", value: campaign.gates.length > 0 ? campaign.gates.join(", ") : "none" },
		{ label: "Scope", value: campaign.scope.length > 0 ? campaign.scope.join(", ") : "any unprotected file" },
		{ label: "Protected", value: campaign.protected.join(", ") || "none" },
		{
			label: "Branch",
			value: `${campaign.ref.replace("refs/heads/", "")} at ${shortSha(view.best)} (base ${shortSha(campaign.base)}, ${view.ratchets} ${view.ratchets === 1 ? "ratchet" : "ratchets"})`,
		},
		{
			label: "Agent",
			value: [campaign.agent.target, campaign.agent.model].filter(Boolean).join("/") || "the workspace's default target",
		},
		...(campaign.agent.goal ? [{ label: "Goal", value: campaign.agent.goal }] : []),
	];
}

/** The A/A check: base against itself, which says how much of a difference is only noise. */
export function aaLine(aa: ResearchCampaign["aa"]): string {
	if (aa === null) return "The A/A check has not run yet.";
	const verdict = aa.noisy ? (aa.allowed ? "noisy (allowed)" : "noisy, so the campaign stopped") : "quiet";
	return `A/A ${verdict}: ${describeGrade(aa.grade)}`;
}

const OUTCOME: Readonly<Record<ResearchIteration["outcome"], string>> = {
	ratcheted: "ratcheted",
	running: "running",
	"agent-failed": "archived: the agent failed",
	"no-op": "archived: no change",
	duplicate: "archived: same tree as an earlier candidate",
	"out-of-scope": "archived: changed files outside the scope",
	protected: "archived: touched a protected file",
	"measure-failed": "archived: the measurement failed",
	"gate-failed": "archived: a gate failed",
	"not-improved": "archived: not improved",
	"ratchet-lost": "archived: the branch moved first",
	deadline: "archived: the wall budget ran out",
	interrupted: "archived: interrupted",
};

export interface IterationRow {
	key: number;
	label: string;
	outcome: string;
	ratcheted: boolean;
	grade: string;
	gates: string;
	commit: string;
	hypothesis: string;
	cost: string;
	detail: string;
	changed: string;
}

export function iterationRows(view: ResearchCampaign): IterationRow[] {
	return view.iterations.map((iteration, index) => ({
		key: iteration.iteration,
		label: `it-${String(iteration.iteration).padStart(4, "0")}`,
		outcome: OUTCOME[iteration.outcome],
		ratcheted: iteration.outcome === "ratcheted",
		grade: iteration.grade ? describeGrade(iteration.grade) : "not graded",
		gates:
			iteration.gates.length > 0
				? iteration.gates.map((gate) => `${gate.check} ${gate.passed ? "pass" : "fail"}`).join(", ")
				: "none run",
		commit:
			iteration.outcome === "ratcheted"
				? `${shortSha(iteration.parent)} → ${shortSha(iteration.commit)}`
				: iteration.commit
					? `${shortSha(iteration.commit)} (archived)`
					: "no commit",
		hypothesis: iteration.hypothesisVerdict ?? (iteration.hypothesis ? "recorded" : "none"),
		cost: view.display?.costs[index] ?? "not rendered",
		detail: iteration.detail,
		changed: iteration.changed.length > 0 ? iteration.changed.join(", ") : "nothing",
	}));
}

export interface CurvePoint {
	iteration: number;
	value: number;
	ratcheted: boolean;
}

/**
 * The best objective value against the iteration: the A/A base median at 0, then each ratchet's candidate median.
 * Iterations that did not ratchet keep the best so far, so the line only ever steps toward the objective.
 */
export function bestCurve(view: ResearchCampaign): CurvePoint[] {
	const start = view.aa?.grade.baseMedian ?? view.iterations.find((row) => row.grade)?.grade?.baseMedian ?? null;
	if (start === null) return [];
	const points: CurvePoint[] = [{ iteration: 0, value: start, ratcheted: false }];
	let best = start;
	for (const iteration of view.iterations) {
		if (iteration.outcome === "running") break;
		const ratcheted = iteration.outcome === "ratcheted" && iteration.grade?.candidateMedian != null;
		if (ratcheted) best = iteration.grade?.candidateMedian as number;
		points.push({ iteration: iteration.iteration, value: best, ratcheted });
	}
	return points;
}

export interface Chart {
	path: string;
	dots: { x: number; y: number; ratcheted: boolean; label: string }[];
	min: number;
	max: number;
}

/** A step line through the curve in a `width` by `height` box; the y axis runs from the lowest to the highest value. */
export function curveChart(points: readonly CurvePoint[], width: number, height: number, pad = 8): Chart | null {
	if (points.length < 2) return null;
	const values = points.map((point) => point.value);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const last = points.at(-1)?.iteration ?? 1;
	const x = (iteration: number) => pad + ((width - 2 * pad) * iteration) / Math.max(last, 1);
	const y = (value: number) => (max === min ? height / 2 : pad + ((height - 2 * pad) * (max - value)) / (max - min));
	const round = (value: number) => Math.round(value * 10) / 10;
	let path = "";
	points.forEach((point, index) => {
		const px = round(x(point.iteration));
		const py = round(y(point.value));
		if (index === 0) path = `M${px} ${py}`;
		else path += `H${px}V${py}`;
	});
	return {
		path,
		dots: points.map((point) => ({
			x: round(x(point.iteration)),
			y: round(y(point.value)),
			ratcheted: point.ratcheted,
			label: `${point.iteration === 0 ? "base" : `it-${point.iteration}`}: ${point.value.toPrecision(4)}`,
		})),
		min,
		max,
	};
}

export function summaryMeta(row: ResearchCampaignSummary): string {
	if ("error" in row) return `unreadable: ${row.error}`;
	const kept = `${row.ratchets} of ${row.iterations} kept`;
	return `${row.state === "running" ? "running" : (row.stop ?? "stopped")} · ${kept}`;
}

export function summaryObjective(row: ResearchCampaignSummary): string {
	return "error" in row ? row.id : `${row.objective.direction} ${row.objective.metric} (${row.objective.check})`;
}

export type RegradeLine = { of: string; text: string; agrees: boolean };

/** `research report` per grade: the recomputation and whether it matches what the journal says. */
export function regradeLines(report: ResearchReport): RegradeLine[] {
	return report.recomputed.map((entry) => ({
		of: entry.of === "aa" ? "A/A" : `it-${String(entry.of).padStart(4, "0")}`,
		text: describeGrade(entry.recomputed),
		agrees: entry.agrees,
	}));
}

const CAMPAIGN_LINE = /^research (r[0-9]{8}-[0-9]{6}-[0-9a-f]{4}): /;

/** The campaign a running start opened, from its first progress line. */
export function campaignFromProgress(messages: readonly string[]): string | null {
	for (const message of messages) {
		const match = CAMPAIGN_LINE.exec(message);
		if (match?.[1]) return match[1];
	}
	return null;
}

/** The progress line without its campaign prefix, for the live log. */
export function logLine(message: string): string {
	return message.replace(CAMPAIGN_LINE, "");
}

export interface ResearchDraft {
	check: string;
	metric: string;
	direction: "min" | "max";
	maxIterations: string;
	minImprovement: string;
	trials: string;
	gates: readonly string[];
	scope: string;
	maxWallMinutes: string;
	maxCostUsd: string;
	allowUnpriced: boolean;
	goal: string;
	target: string;
	model: string;
}

export const emptyResearchDraft = (): ResearchDraft => ({
	check: "",
	metric: "",
	direction: "min",
	maxIterations: "3",
	minImprovement: "0.05",
	trials: "5",
	gates: [],
	scope: "",
	maxWallMinutes: "30",
	maxCostUsd: "",
	allowUnpriced: false,
	goal: "",
	target: "",
	model: "",
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const METRIC = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

/** The request the form would send, or the first reason it cannot be sent yet. */
export function researchRequest(draft: ResearchDraft): { request: ResearchStartRequest } | { problem: string } {
	if (!ID.test(draft.check)) return { problem: "Pick the check whose output is the objective." };
	const metric = draft.metric.trim();
	if (!METRIC.test(metric)) return { problem: "Name the metric, a key of the JSON the check prints, such as wall_ms." };
	const maxIterations = Number(draft.maxIterations);
	if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 1000)
		return { problem: "Max iterations is a whole number from 1 to 1000." };
	const minImprovement = Number(draft.minImprovement);
	if (!Number.isFinite(minImprovement) || minImprovement <= 0 || minImprovement > 100)
		return { problem: "Min improvement is a positive fraction, such as 0.05 for 5%." };
	if (draft.direction === "min" && minImprovement >= 1)
		return { problem: "A min objective cannot fall by 100% or more; use a fraction below 1." };
	const trials = Number(draft.trials);
	if (!Number.isInteger(trials) || trials < 2 || trials > 100)
		return { problem: "Trials is a whole number of pairs from 2 to 100." };
	const scope = draft.scope
		.split(/[\n,]/)
		.map((glob) => glob.trim())
		.filter(Boolean);
	if (scope.some((glob) => glob.startsWith("-") || glob.length > 256))
		return { problem: "A scope glob is a repository path pattern and cannot start with a dash." };
	const optional = (raw: string, max: number, what: string): number | undefined | string => {
		if (!raw.trim()) return undefined;
		const value = Number(raw);
		return Number.isFinite(value) && value > 0 && value <= max ? value : `${what} is a positive number up to ${max}.`;
	};
	const maxWallMinutes = optional(draft.maxWallMinutes, 10_080, "Max wall minutes");
	if (typeof maxWallMinutes === "string") return { problem: maxWallMinutes };
	const maxCostUsd = optional(draft.maxCostUsd, 10_000, "Max cost in USD");
	if (typeof maxCostUsd === "string") return { problem: maxCostUsd };
	const goal = draft.goal.replace(/\s+/g, " ").trim();
	if (goal.startsWith("-")) return { problem: "The goal cannot start with a dash." };
	if (goal.length > 2000) return { problem: "The goal is longer than 2000 characters." };
	if (draft.target && !ID.test(draft.target)) return { problem: "Pick a configured target." };
	const model = draft.model.trim();
	if (model && !MODEL.test(model)) return { problem: "The model id has characters a target never uses." };
	if (model && !draft.target) return { problem: "Pick the target that serves this model." };
	return {
		request: {
			check: draft.check,
			metric,
			direction: draft.direction,
			maxIterations,
			minImprovement,
			trials,
			gates: [...draft.gates],
			scope,
			...(maxWallMinutes !== undefined ? { maxWallMinutes } : {}),
			...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
			allowUnpriced: draft.allowUnpriced,
			...(goal ? { goal } : {}),
			...(draft.target ? { target: draft.target } : {}),
			...(model ? { model } : {}),
		},
	};
}
