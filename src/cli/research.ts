import {
	campaignStatusLines,
	createSpawnAgentRunner,
	describeGrade,
	isResearchCampaignId,
	listCampaigns,
	openResearchCampaign,
	RESEARCH_DEFAULT_MIN_IMPROVEMENT,
	RESEARCH_DEFAULT_TRIALS,
	type ResearchCampaignView,
	type ResearchDirection,
	type ResearchRunOutcome,
	recomputeCampaign,
	researchProjectRoot,
	runResearchCampaign,
	summarizeCampaign,
} from "../domains/research/index.js";
import { printError } from "./argv.js";

const HELP = `Usage:
  clio-coder research start --check <id> --metric <key> --direction min|max --max-iterations <N> [options]
  clio-coder research status [<id>] [--json]
  clio-coder research report <id> [--json]
  clio-coder research list [--json]

Hill climbs an objective metric within a budget. The objective is one key of
the JSON payload a check in .clio-coder/verifiers.yaml prints (a perf-budget
check's wall_ms falls back to its measured duration). Each iteration runs
Clio's own agent (clio-coder run, autonomy default, no dispatch) in a fresh
worktree under .clio-coder/worktrees/ at the current best commit, measures the
change against that commit with interleaved trials, and keeps it only when
the median moves by at least --min-improvement and a bootstrap 95% interval
(2,000 resamples, recorded seed) excludes zero, and every --gate check passes.
A judged objective (numeric-compare) is a gate too: it must match its reference.
A kept change moves the branch clio/research/<id> by compare-and-swap; your
own branch is never touched.

Before the first iteration an A/A check measures the base against itself. A
campaign whose A/A check already calls a change refuses to run unless
--allow-noisy is given. A change that is a no-op, repeats an earlier tree,
touches a protected path (the verifier catalog and every file the checks
name), or changes a file outside --scope is archived without measuring.

start options:
  --check <id>              objective check id (required)
  --metric <key>            payload key to optimize (required)
  --direction min|max       which way is better (required)
  --max-iterations <N>      hard stop on iterations (required)
  --min-improvement <frac>  relative improvement to clear (default ${RESEARCH_DEFAULT_MIN_IMPROVEMENT})
  --trials <N>              interleaved base/candidate pairs (default ${RESEARCH_DEFAULT_TRIALS})
  --scope <glob>            files a change may touch; repeatable (default: any unprotected file)
  --gate <id>               check that must pass on every candidate; repeatable
  --goal <text>             extra direction for the agent
  --max-wall-minutes <M>    campaign-wide deadline: ends the agent run, measurement or
                            gate in flight, and nothing after it is ratcheted
  --max-cost-usd <X>        hard stop on spend summed from each run's cost, passed down as run --max-cost-usd
  --allow-unpriced          keep going when a run's spend is unknown (the cost cap then cannot bind)
  --allow-noisy             run even when the A/A check calls a change
  --target <id> --model <id>  target and model for the agent runs
  --keep                    keep every worktree after grading
  --json                    print the final status as JSON

Unknown spend is never counted as zero: with --max-cost-usd and without
--allow-unpriced, a run whose cost is unknown stops the campaign as
budget-unenforceable. Ctrl-C, SIGTERM and SIGHUP stop the campaign cleanly:
the agent run is stopped and awaited, the stop is journaled and the worktrees
are removed.

Everything lands under .clio-coder/research/<id>/: campaign.json (the frozen
spec and checks), journal.jsonl (one event per step) and samples/ (the raw
measurements). report regrades every iteration from those samples with the
recorded seed and says whether each grade agrees with the journal. Judged gate
checks (numeric-compare, reproduce) also record claims, and each measured
iteration records the agent's plan as a hypothesis; see clio-coder claims.

Exit codes: 0 when a budget cap ended the campaign, 1 on an error, a noisy
A/A check or unenforceable spend, 2 on a usage error, 130 on Ctrl-C, 143 on SIGTERM, 129 on SIGHUP.`;

interface StartFlags {
	check?: string;
	metric?: string;
	direction?: ResearchDirection;
	maxIterations?: number;
	minImprovement: number;
	trials: number;
	scope: string[];
	gates: string[];
	goal?: string;
	maxWallMinutes?: number;
	maxCostUsd?: number;
	allowUnpriced: boolean;
	allowNoisy: boolean;
	target?: string;
	model?: string;
	keep: boolean;
}

function parseStart(args: ReadonlyArray<string>): StartFlags | string {
	const flags: StartFlags = {
		minImprovement: RESEARCH_DEFAULT_MIN_IMPROVEMENT,
		trials: RESEARCH_DEFAULT_TRIALS,
		scope: [],
		gates: [],
		allowUnpriced: false,
		allowNoisy: false,
		keep: false,
	};
	const positive = (flag: string, raw: string, integer: boolean): number | string => {
		const value = Number(raw);
		if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value)))
			return `${flag} needs a positive ${integer ? "integer" : "number"}, got '${raw}'`;
		return value;
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg === "--allow-unpriced") flags.allowUnpriced = true;
		else if (arg === "--allow-noisy") flags.allowNoisy = true;
		else if (arg === "--keep") flags.keep = true;
		else if (arg.startsWith("--")) {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--")) return `${arg} needs a value`;
			index += 1;
			switch (arg) {
				case "--check":
					flags.check = value;
					break;
				case "--metric":
					flags.metric = value;
					break;
				case "--direction":
					if (value !== "min" && value !== "max") return `--direction is min or max, got '${value}'`;
					flags.direction = value;
					break;
				case "--goal":
					flags.goal = value;
					break;
				case "--scope":
					flags.scope.push(value);
					break;
				case "--gate":
					flags.gates.push(value);
					break;
				case "--target":
					flags.target = value;
					break;
				case "--model":
					flags.model = value;
					break;
				case "--autonomy":
					if (value !== "default")
						return `research runs its agent at autonomy default only; '${value}' is refused until contained yolo exists`;
					break;
				case "--max-iterations":
				case "--trials":
				case "--min-improvement":
				case "--max-wall-minutes":
				case "--max-cost-usd": {
					const parsed = positive(arg, value, arg === "--max-iterations" || arg === "--trials");
					if (typeof parsed === "string") return parsed;
					if (arg === "--max-iterations") flags.maxIterations = parsed;
					if (arg === "--trials") flags.trials = parsed;
					if (arg === "--min-improvement") flags.minImprovement = parsed;
					if (arg === "--max-wall-minutes") flags.maxWallMinutes = parsed;
					if (arg === "--max-cost-usd") flags.maxCostUsd = parsed;
					break;
				}
				default:
					return `unknown option '${arg}'`;
			}
		} else return `unexpected argument '${arg}'`;
	}
	if (flags.check === undefined) return "--check <id> is required";
	if (flags.metric === undefined) return "--metric <key> is required";
	if (flags.direction === undefined) return "--direction min|max is required";
	if (flags.maxIterations === undefined) return "--max-iterations <N> is required";
	if (flags.trials < 2) return "--trials needs at least 2 pairs for an interval";
	if (flags.minImprovement >= 1 && flags.direction === "min")
		return "--min-improvement is a fraction; a min objective cannot fall by 100% or more";
	return flags;
}

function viewJson(view: ResearchCampaignView): Record<string, unknown> {
	return {
		id: view.campaign.id,
		state: view.state,
		stop: view.stop,
		best: view.best,
		ratchets: view.ratchets,
		spend: view.spend,
		aa: view.aa,
		iterations: view.iterations,
		campaign: view.campaign,
		unreadableJournalLines: view.unreadableJournalLines,
	};
}

const STOP_SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
type StopSignal = keyof typeof STOP_SIGNALS;

/**
 * Stop the campaign on SIGINT, SIGTERM or SIGHUP the same way: abort the controller so the loop stops the agent
 * child, waits for it, journals `stopped` and removes the worktrees. Returns the exit code the first signal implies
 * (130, 143 or 129) and a dispose that takes the listeners off again.
 */
export function installResearchStopSignals(
	controller: AbortController,
	log: (line: string) => void,
): { received: () => StopSignal | null; exitCode: () => number; dispose: () => void } {
	let received: StopSignal | null = null;
	const handlers = (Object.keys(STOP_SIGNALS) as StopSignal[]).map((name) => {
		const handler = (): void => {
			if (received === null) {
				received = name;
				log(`${name} received; stopping after the current step`);
			}
			controller.abort();
		};
		process.on(name, handler);
		return [name, handler] as const;
	});
	return {
		received: () => received,
		exitCode: () => STOP_SIGNALS[received ?? "SIGINT"],
		dispose: () => {
			for (const [name, handler] of handlers) process.off(name, handler);
		},
	};
}

function exitFor(outcome: ResearchRunOutcome, stopCode: number): number {
	if (outcome.reason === "stopped") return stopCode;
	if (outcome.reason === "max-iterations" || outcome.reason === "max-wall-minutes" || outcome.reason === "max-cost-usd")
		return 0;
	return 1;
}

async function start(args: ReadonlyArray<string>, json: boolean): Promise<number> {
	const flags = parseStart(args);
	if (typeof flags === "string") {
		printError(`research start: ${flags}`, HELP.split("\n")[1]);
		return 2;
	}
	let campaign: ReturnType<typeof openResearchCampaign>;
	try {
		campaign = openResearchCampaign({
			cwd: process.cwd(),
			objective: {
				check: flags.check as string,
				metric: flags.metric as string,
				direction: flags.direction as ResearchDirection,
				minImprovement: flags.minImprovement,
				trials: flags.trials,
			},
			gates: flags.gates,
			scope: flags.scope,
			budget: {
				maxIterations: flags.maxIterations as number,
				allowUnpriced: flags.allowUnpriced,
				...(flags.maxWallMinutes !== undefined ? { maxWallMinutes: flags.maxWallMinutes } : {}),
				...(flags.maxCostUsd !== undefined ? { maxCostUsd: flags.maxCostUsd } : {}),
			},
			allowNoisy: flags.allowNoisy,
			keep: flags.keep,
			agent: {
				...(flags.target !== undefined ? { target: flags.target } : {}),
				...(flags.model !== undefined ? { model: flags.model } : {}),
				...(flags.goal !== undefined ? { goal: flags.goal } : {}),
			},
		});
	} catch (error) {
		printError(`research start: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const log = (line: string): void => {
		process.stderr.write(`research ${campaign.id}: ${line}\n`);
	};
	log(`opened at ${campaign.base.slice(0, 12)} on ${campaign.ref.replace("refs/heads/", "")}`);
	const controller = new AbortController();
	const stops = installResearchStopSignals(controller, log);
	let outcome: ResearchRunOutcome;
	try {
		outcome = await runResearchCampaign(campaign, {
			agent: createSpawnAgentRunner(),
			log,
			signal: controller.signal,
		});
	} finally {
		stops.dispose();
	}
	const view = summarizeCampaign(campaign.project, campaign.id);
	console.log(json ? JSON.stringify(viewJson(view), null, 2) : campaignStatusLines(view).join("\n"));
	return exitFor(outcome, stops.exitCode());
}

export async function runResearchCommand(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return 0;
	}
	const json = args.includes("--json");
	const rest = args.filter((arg) => arg !== "--json");
	const [action = "list", ...operands] = rest;
	if (action === "start") return start(operands, json);
	const project = researchProjectRoot(process.cwd());
	if (action === "list") {
		if (operands.length > 0) {
			printError(`research list: unexpected argument '${operands[0]}'`, HELP.split("\n")[4]);
			return 2;
		}
		const views = listCampaigns(project);
		if (json) {
			console.log(
				JSON.stringify({ project, campaigns: views.map((view) => ("error" in view ? view : viewJson(view))) }, null, 2),
			);
			return 0;
		}
		if (views.length === 0) {
			console.log(`no research campaigns in ${project}`);
			return 0;
		}
		for (const view of views) {
			if ("error" in view) {
				console.log(`${view.id}  unreadable: ${view.error}`);
				continue;
			}
			const objective = view.campaign.objective;
			console.log(
				`${view.campaign.id}  ${view.state === "stopped" ? (view.stop?.reason ?? "stopped") : "running"}  ${objective.direction} ${objective.metric} (${objective.check})  ${view.iterations.length}/${view.campaign.budget.maxIterations} iterations, ${view.ratchets} kept`,
			);
		}
		return 0;
	}
	if (action === "status" || action === "report") {
		if (operands.length > 1 || (action === "report" && operands.length === 0)) {
			printError(
				`research ${action}: name ${action === "report" ? "one campaign id" : "at most one campaign id"}`,
				HELP.split("\n")[action === "report" ? 3 : 2],
			);
			return 2;
		}
		let id = operands[0];
		if (id === undefined) {
			const views = listCampaigns(project).filter((view) => !("error" in view));
			const latest = views.at(-1);
			if (latest === undefined || "error" in latest) {
				console.log(json ? JSON.stringify({ project, campaign: null }, null, 2) : `no research campaigns in ${project}`);
				return 0;
			}
			id = latest.campaign.id;
		}
		if (!isResearchCampaignId(id)) {
			printError(`research ${action}: '${id}' is not a campaign id (r<yyyymmdd>-<hhmmss>-<hex>)`);
			return 2;
		}
		try {
			if (action === "status") {
				const view = summarizeCampaign(project, id);
				console.log(json ? JSON.stringify(viewJson(view), null, 2) : campaignStatusLines(view).join("\n"));
				return 0;
			}
			const report = recomputeCampaign(project, id);
			if (json) {
				console.log(
					JSON.stringify({ ...viewJson(report.view), recomputed: report.grades, agrees: report.agrees }, null, 2),
				);
				return report.agrees ? 0 : 1;
			}
			const lines = campaignStatusLines(report.view);
			lines.push("", "recomputed from raw samples with the recorded seeds:");
			for (const entry of report.grades)
				lines.push(
					`  ${entry.of === "aa" ? "A/A    " : `it-${String(entry.of).padStart(4, "0")}`}  ${describeGrade(entry.recomputed, report.view.campaign.objective)}  ${entry.agrees ? "agrees with the journal" : "DISAGREES with the journal"}`,
				);
			if (report.grades.length === 0) lines.push("  nothing measured yet");
			console.log(lines.join("\n"));
			return report.agrees ? 0 : 1;
		} catch (error) {
			printError(`research ${action}: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
	}
	printError(`research: unknown subcommand '${action}'`, HELP.split("\n")[1]);
	return 2;
}
