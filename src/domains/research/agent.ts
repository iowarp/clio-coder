/**
 * PLAN+EDIT: one headless main-agent run of this same build in the iteration's worktree, through `run --json
 * --json-events terminal`. Clio's own agent both plans and edits. The run inherits the operator's environment so its
 * targets and credentials resolve as an interactive run's would; it runs at the campaign's autonomy (`default`, or
 * contained `yolo` with the operator's autonomous caps) with dispatch off, and the campaign's remaining wall time and
 * spend are passed down as `--timeout` and `--max-cost-usd`. A yolo run's audit comes back on `turn_end.autonomy`.
 */
import { spawn } from "node:child_process";
import { withContainedYoloPin } from "../safety/autonomy.js";
import { costFromPricing } from "./budget.js";
import {
	RESEARCH_OPEN_DECISION_LIMIT,
	type ResearchAgentAutonomy,
	type ResearchAutonomy,
	type ResearchCampaign,
	type ResearchCost,
	type ResearchJournalEvent,
} from "./types.js";

export interface AgentRunRequest {
	worktree: string;
	prompt: string;
	autonomy: ResearchAutonomy;
	target?: string;
	model?: string;
	timeoutSeconds?: number;
	maxCostUsd?: number;
	signal?: AbortSignal;
}

export interface AgentRunResult {
	exitCode: number | null;
	sessionId: string | null;
	outcome: string | null;
	/** The final answer text, or the error the run ended with. */
	summary: string;
	cost: ResearchCost;
	/** The yolo run's audit, when it reported one. */
	autonomy?: ResearchAgentAutonomy;
}

export type AgentRunner = (request: AgentRunRequest) => Promise<AgentRunResult>;

export function agentRunArgv(request: Omit<AgentRunRequest, "signal">): string[] {
	return [
		"run",
		"--json",
		"--json-events",
		"terminal",
		"--cwd",
		request.worktree,
		"--no-delegate",
		"--autonomy",
		request.autonomy,
		...(request.target !== undefined ? ["--target", request.target] : []),
		...(request.model !== undefined ? ["--model", request.model] : []),
		...(request.timeoutSeconds !== undefined ? ["--timeout", String(request.timeoutSeconds)] : []),
		...(request.maxCostUsd !== undefined ? ["--max-cost-usd", String(request.maxCostUsd)] : []),
		request.prompt,
	];
}

/** Fold the frames of a `run --json --json-events terminal` stream into the run's result. */
export function parseAgentRunFrames(stdout: string, exitCode: number | null, stderr: string): AgentRunResult {
	let sessionId: string | null = null;
	let outcome: string | null = null;
	let text: string | null = null;
	let error: string | null = null;
	const costs: unknown[] = [];
	let autonomy: ResearchAgentAutonomy | undefined;
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (frame.type === "session" && typeof frame.id === "string") sessionId = frame.id;
		if (frame.type === "agent_end") {
			const usage = frame.usage as { cost?: unknown } | undefined;
			costs.push(usage?.cost);
		}
		if (frame.type === "turn_end" && typeof frame.exitCode === "number") {
			if (typeof frame.text === "string") text = frame.text;
			if (typeof frame.error === "string") error = frame.error;
			if (typeof frame.outcome === "string")
				outcome = typeof frame.outcomeDetail === "string" ? `${frame.outcome}:${frame.outcomeDetail}` : frame.outcome;
			autonomy = readAutonomyAudit(frame.autonomy) ?? autonomy;
		}
	}
	const stderrTail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
	const summary = (error ?? text ?? stderrTail).trim().slice(0, 2000);
	return {
		exitCode,
		sessionId,
		outcome,
		summary,
		cost: costFromPricing(costs),
		...(autonomy !== undefined ? { autonomy } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parts of a `run --json` autonomy audit a campaign keeps; anything malformed reads as absent. */
function readAutonomyAudit(value: unknown): ResearchAgentAutonomy | undefined {
	if (!isRecord(value)) return undefined;
	if (value.confinement !== "contained" && value.confinement !== "unconfined") return undefined;
	const usage = isRecord(value.usage) ? value.usage : {};
	const halted = isRecord(value.halted) && typeof value.halted.kind === "string" ? value.halted : null;
	const decisions = (Array.isArray(value.openDecisions) ? value.openDecisions : []).filter(isRecord).map((entry) => ({
		tool: typeof entry.tool === "string" ? entry.tool : "?",
		kind: typeof entry.kind === "string" ? entry.kind : "?",
		...(typeof entry.rule === "string" ? { rule: entry.rule } : {}),
		command: typeof entry.command === "string" ? entry.command : "",
	}));
	const omitted = typeof value.openDecisionsOmitted === "number" ? value.openDecisionsOmitted : 0;
	const kept = decisions.slice(-RESEARCH_OPEN_DECISION_LIMIT);
	return {
		confinement: value.confinement,
		toolCalls: typeof usage.toolCalls === "number" ? usage.toolCalls : 0,
		halted:
			halted === null
				? null
				: { kind: halted.kind as string, detail: typeof halted.detail === "string" ? halted.detail : "" },
		openDecisions: kept,
		openDecisionsOmitted: omitted + decisions.length - kept.length,
	};
}

/** Spawn this build's `run` for one iteration. `entry` is the CLI script; the current process's is the default. */
export function createSpawnAgentRunner(
	entry: string | undefined = process.argv[1],
	execArgv: ReadonlyArray<string> = process.execArgv,
): AgentRunner {
	return (request) =>
		new Promise((resolve, reject) => {
			if (entry === undefined) {
				reject(new Error("cannot find this build's CLI entry to start the agent run"));
				return;
			}
			const child = spawn(process.execPath, [...execArgv, entry, ...agentRunArgv(request)], {
				cwd: request.worktree,
				env: request.autonomy === "yolo" ? withContainedYoloPin(process.env) : process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr = `${stderr}${chunk}`.slice(-16_384);
			});
			const abort = (): void => {
				child.kill("SIGINT");
			};
			request.signal?.addEventListener("abort", abort, { once: true });
			child.once("error", (error) => {
				request.signal?.removeEventListener("abort", abort);
				reject(error);
			});
			child.once("close", (code) => {
				request.signal?.removeEventListener("abort", abort);
				resolve(parseAgentRunFrames(stdout, code, stderr));
			});
		});
}

function percent(value: number | null): string {
	return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

/**
 * The prompt for one iteration: the objective, what the agent may change, and every earlier attempt with its
 * verdict, so the agent does not retry what already failed. The measurement itself is never the agent's to run or
 * change.
 */
export function iterationPrompt(
	campaign: ResearchCampaign,
	iteration: number,
	events: ReadonlyArray<ResearchJournalEvent>,
): string {
	const objective = campaign.objective;
	const goal = objective.direction === "min" ? "lower" : "higher";
	const lines = [
		`You are iteration ${iteration} of a research hill climb in this git worktree.`,
		`Objective: make the metric '${objective.metric}' printed by the verifier check '${objective.check}' ${goal}, by at least ${percent(objective.minImprovement)} relative to the current code, while keeping behavior correct.`,
	];
	if (campaign.agent.goal !== undefined) lines.push(`Operator's goal: ${campaign.agent.goal}`);
	lines.push(
		campaign.scope.length > 0
			? `Change only files matching: ${campaign.scope.join(", ")}.`
			: "Change whatever source files you need.",
		`Never change these protected files; a change to any of them is discarded unmeasured: ${campaign.protected.join(", ")}.`,
		...(campaign.gates.length > 0
			? [`These checks must still pass after your change: ${campaign.gates.join(", ")}.`]
			: []),
		"Make one focused change you expect to improve the metric, then stop. Do not run the benchmark in a loop; the harness measures your change itself against the current code with interleaved trials.",
		"Finish with two short lines: 'Hypothesis: <what you changed and why it should help>' and 'Prediction: <the effect you expect on the metric>'.",
	);
	const history = attemptHistory(events);
	if (history.length > 0) lines.push("", "Earlier attempts in this campaign (most recent last):", ...history);
	return lines.join("\n");
}

function attemptHistory(events: ReadonlyArray<ResearchJournalEvent>): string[] {
	const byIteration = new Map<number, { summary?: string; verdict?: string; detail?: string }>();
	const entry = (iteration: number) => {
		const existing = byIteration.get(iteration);
		if (existing !== undefined) return existing;
		const created = {};
		byIteration.set(iteration, created);
		return created as { summary?: string; verdict?: string; detail?: string };
	};
	for (const event of events) {
		if (event.type === "agent-finished") entry(event.iteration).summary = event.summary.split("\n").slice(-4).join(" ");
		if (event.type === "graded")
			entry(event.iteration).detail =
				`median delta ${percent(event.grade.delta)}, 95% CI ${event.grade.ci === null ? "n/a" : `[${percent(event.grade.ci.low)}, ${percent(event.grade.ci.high)}]`}`;
		if (event.type === "ratcheted") entry(event.iteration).verdict = "kept (improved)";
		if (event.type === "archived") entry(event.iteration).verdict = `discarded: ${event.reason} (${event.detail})`;
	}
	return [...byIteration.entries()]
		.slice(-8)
		.map(
			([iteration, value]) =>
				`- iteration ${iteration}: ${value.verdict ?? "unfinished"}${value.detail !== undefined ? `; ${value.detail}` : ""}${value.summary !== undefined ? `; agent said: ${value.summary.slice(0, 300)}` : ""}`,
		);
}

/** The `Hypothesis:` and `Prediction:` lines of the agent's final answer, when it wrote them. */
export function hypothesisFromSummary(summary: string): { statement: string; prediction: string } | null {
	const statement = /^\s*Hypothesis:\s*(.+)$/imu.exec(summary)?.[1]?.trim();
	const prediction = /^\s*Prediction:\s*(.+)$/imu.exec(summary)?.[1]?.trim();
	if (statement === undefined || statement.length === 0) return null;
	return { statement: statement.slice(0, 500), prediction: (prediction ?? "").slice(0, 500) };
}
