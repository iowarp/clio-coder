import { FLEET_COMMANDS_REMEDY, FleetCommandRegistryMissingError } from "../domains/agents/index.js";
import { preflightWriteBoundaries } from "../domains/dispatch/write-boundary-enforcer.js";
import { inspectFleet } from "./fleet-preflight.js";

export function runFleetValidate(args: ReadonlyArray<string>): number {
	const json = args.includes("--json");
	const unknown = args.find((arg, index) => (arg.startsWith("-") && arg !== "--json") || index > 1);
	const name = args.find((arg) => !arg.startsWith("-"));
	if (name === undefined || unknown !== undefined) {
		process.stderr.write("clio-coder fleet: validate: usage: clio-coder fleet validate <name> [--json]\n");
		return 2;
	}
	try {
		const result = inspectFleet(name);
		preflightWriteBoundaries(result.plan, process.cwd());
		if (json)
			process.stdout.write(
				`${JSON.stringify({ valid: true, fleet: name, checks: result.checks, planHash: result.plan.hash }, null, 2)}\n`,
			);
		else for (const check of result.checks) process.stdout.write(`${check.check}: ${check.summary}\n`);
		return 0;
	} catch (error) {
		const raw = error instanceof Error ? error.message : String(error);
		const message = raw.startsWith("unknown agent '") ? `preflight failed: ${raw}` : raw;
		const diagnostics = [message, ...(error instanceof FleetCommandRegistryMissingError ? [FLEET_COMMANDS_REMEDY] : [])];
		if (json) process.stdout.write(`${JSON.stringify({ valid: false, fleet: name, diagnostics }, null, 2)}\n`);
		else process.stderr.write(`clio-coder fleet: ${diagnostics.join("\n  ")}\n`);
		return 1;
	}
}
