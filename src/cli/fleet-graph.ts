import type { ExecutionPlanStep } from "../domains/dispatch/execution-plan.js";
import { inspectFleet } from "./fleet-preflight.js";

/**
 * The contract-level kind of a compiled step. The execution plan knows only
 * `agent` and `code`; a version 5 `gate` or `plan` step compiles to an agent
 * step carrying `gate` or `plan` facts, and the graph names it as the author
 * wrote it.
 */
function contractKind(step: ExecutionPlanStep): "agent" | "code" | "gate" | "plan" {
	if (step.kind === "code") return "code";
	if (step.gate !== undefined) return "gate";
	if (step.plan !== undefined) return "plan";
	return "agent";
}

function projectedStep(step: ExecutionPlanStep): Record<string, unknown> {
	return {
		id: step.id,
		kind: contractKind(step),
		...(step.kind === "agent" ? { agent: step.agentId } : { command: step.commandId }),
		...(step.kind === "agent" && step.gate !== undefined
			? { gate: { path: step.gate.path, command: step.gate.commandId } }
			: {}),
		...(step.kind === "agent" && step.plan !== undefined
			? { plan: { roster: [...step.plan.roster], maxTasks: step.plan.maxTasks, proposals: step.plan.proposals } }
			: {}),
		...(step.kind === "agent" && step.target !== undefined ? { target: step.target } : {}),
		...(step.kind === "agent" && step.profile !== undefined ? { profile: step.profile } : {}),
		scope: step.scope,
		writes: [...(step.writes ?? [])],
		dependencies: [...step.dependencies],
	};
}

export function runFleetGraph(args: ReadonlyArray<string>): number {
	const json = args.includes("--json");
	const name = args.find((arg) => !arg.startsWith("-"));
	const unknown = args.find((arg, index) => (arg.startsWith("-") && arg !== "--json") || index > 1);
	if (name === undefined || unknown !== undefined) {
		process.stderr.write("clio-coder fleet: graph: usage: clio-coder fleet graph <name> [--json]\n");
		return 2;
	}
	try {
		const { plan } = inspectFleet(name);
		const byId = new Map(plan.steps.map((step) => [step.id, step]));
		const waves = plan.waves.map((ids, index) => ({
			wave: index + 1,
			steps: ids.flatMap((id) => {
				const step = byId.get(id);
				return step === undefined ? [] : [projectedStep(step)];
			}),
		}));
		const loops = plan.loops.map((loop) => ({
			id: loop.id,
			check: loop.checkStepIds.map((id) => projectedStep(byId.get(id) as ExecutionPlanStep)),
			repair: loop.repairStepIds.map((id) => projectedStep(byId.get(id) as ExecutionPlanStep)),
		}));
		if (json) {
			process.stdout.write(`${JSON.stringify({ fleet: name, planHash: plan.hash, waves, loops }, null, 2)}\n`);
			return 0;
		}
		for (const wave of waves) {
			process.stdout.write(`wave ${wave.wave}\n`);
			for (const step of wave.steps) {
				const subject = step.kind === "code" ? `command=${step.command}` : `agent=${step.agent}`;
				const gate = step.gate as { path: string; command: string } | undefined;
				const plan = step.plan as { roster: string[]; maxTasks: number; proposals: boolean } | undefined;
				const detail =
					gate !== undefined
						? ` gate=${gate.path} run=${gate.command}`
						: plan !== undefined
							? ` roster=${JSON.stringify(plan.roster)} maxTasks=${plan.maxTasks}${plan.proposals ? " proposals" : ""}`
							: "";
				const route =
					step.target !== undefined
						? ` target=${step.target}`
						: step.profile !== undefined
							? ` profile=${step.profile}`
							: "";
				process.stdout.write(
					`  ${step.id} kind=${step.kind} ${subject}${route} scope=${step.scope} writes=${JSON.stringify(step.writes)}${detail}\n`,
				);
			}
		}
		for (const loop of loops) {
			process.stdout.write(`loop ${loop.id}\n`);
			for (const step of loop.check)
				process.stdout.write(
					`  check ${step.id} kind=${step.kind} scope=${step.scope} writes=${JSON.stringify(step.writes)}\n`,
				);
			for (const step of loop.repair)
				process.stdout.write(
					`  repair ${step.id} kind=${step.kind} scope=${step.scope} writes=${JSON.stringify(step.writes)}\n`,
				);
		}
		return 0;
	} catch (error) {
		process.stderr.write(`clio-coder fleet: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
