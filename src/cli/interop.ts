/** Discover coding agents and review safe resource adoption without model calls. */

import { createInterface } from "node:readline/promises";
import {
	type AdoptionKind,
	applyInteropAdoption,
	detectInteropAgents,
	type InteropAgentId,
	interopAgentKind,
	planInteropAdoption,
	renderInteropAdoptionPlan,
} from "../domains/interop/index.js";
import { runInteropInspect } from "./interop-inspect.js";
import { printError } from "./shared.js";

const HELP = `clio-coder interop <subcommand>

Detected external coding agents and how far each one is wired.

Subcommands:
  inspect [--json]              show host inventory and connection state
  adopt <host> [--kind skill|agent|prompt|plugin] [--project|--user]
               [--yes] [--dry-run]
                                review and adopt safe resources

Notes:
  inspect writes nothing and starts no agent session. Wiring a detected agent
  as a delegation peer is an explicit review: run \`clio-coder configure --interop\`.
`;

export async function runInteropCommand(args: ReadonlyArray<string>): Promise<number> {
	const sub = args[0];
	if (sub === undefined || sub === "--help" || sub === "-h") {
		process.stdout.write(HELP);
		return sub === undefined ? 2 : 0;
	}
	if (sub === "adopt") return await runAdopt(args.slice(1));
	if (sub === "inspect") return await runInteropInspect(args.slice(1));
	printError(`unknown interop command: ${sub}`);
	process.stdout.write(HELP);
	return 2;
}

async function runAdopt(args: ReadonlyArray<string>): Promise<number> {
	const host = args[0] === "claude" ? "claude-code" : args[0] === "agy" ? "antigravity" : args[0];
	const kind = host ? interopAgentKind(host as InteropAgentId) : undefined;
	if (!kind?.inventory) {
		printError("adopt requires a host: claude-code, codex, antigravity, copilot, opencode");
		return 2;
	}
	let filter: AdoptionKind | undefined;
	let scope: "user" | "project" | undefined;
	let yes = false;
	let dryRun = false;
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--kind") {
			const next = args[++i];
			if (!next || !["skill", "agent", "prompt", "plugin"].includes(next)) {
				printError("invalid adoption kind");
				return 2;
			}
			filter = next as AdoptionKind;
		} else if (arg === "--project" || arg === "--user") {
			if (scope) {
				printError("choose one destination scope");
				return 2;
			}
			scope = arg === "--project" ? "project" : "user";
		} else if (arg === "--yes") yes = true;
		else if (arg === "--dry-run") dryRun = true;
		else {
			printError(`unknown adopt option: ${arg}`);
			return 2;
		}
	}
	const report = await detectInteropAgents({ inventory: true });
	const inventory = report.agents.find((agent) => agent.kind === kind.id)?.inventory;
	if (!inventory) {
		printError("inventory is unknown");
		return 1;
	}
	const plan = planInteropAdoption({
		host: kind.id,
		inventory,
		...(scope ? { scope } : {}),
		...(filter ? { kind: filter } : {}),
	});
	process.stdout.write(`${renderInteropAdoptionPlan(plan)}\n`);
	for (const diagnostic of inventory.diagnostics) process.stdout.write(`Unknown: ${diagnostic}\n`);
	if (dryRun || !plan.entries.some((entry) => entry.action === "install")) return 0;
	if (!yes && process.stdin.isTTY && process.stdout.isTTY) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			yes = (await rl.question("Install this plan? [y/N] ")).trim().toLowerCase() === "y";
		} finally {
			rl.close();
		}
	}
	const result = applyInteropAdoption(plan, yes);
	for (const id of result.installed) process.stdout.write(`Installed ${id}\n`);
	for (const diagnostic of result.diagnostics) process.stderr.write(`${diagnostic}\n`);
	return result.diagnostics.length > 0 ? 1 : 0;
}
