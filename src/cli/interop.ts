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
import { writeCliFailure } from "./kit/json-out.js";
import type { ErrorSlug } from "./kit/slugs.js";

const ADOPT_PATH = ["interop", "adopt"] as const;

function failure(path: ReadonlyArray<string>, slug: ErrorSlug, message: string, json: boolean, code = 2): number {
	writeCliFailure({ path, slug, message, json });
	return code;
}

const HELP = `clio-coder interop <subcommand>

Detected external coding agents and how far each one is wired.

Subcommands:
  inspect [--json]              show host inventory and connection state
  adopt <host> [--kind skill|agent|prompt|plugin] [--project|--user]
               [--yes] [--dry-run] [--json]
                                review and adopt safe resources; --json prints
                                the plan and its result as one document and
                                asks on stderr

Notes:
  inspect changes no host or project files and starts no agent session. Wiring a detected agent
  as a delegation peer is an explicit review: run \`clio-coder configure --interop\`.
`;

export async function runInteropCommand(args: ReadonlyArray<string>): Promise<number> {
	const sub = args[0];
	if (sub === undefined) {
		process.stderr.write(HELP);
		return 2;
	}
	if (sub === "--help" || sub === "-h") {
		process.stdout.write(HELP);
		return 0;
	}
	if ((sub === "adopt" || sub === "inspect") && (args.includes("--help") || args.includes("-h"))) {
		process.stdout.write(HELP);
		return 0;
	}
	if (sub === "adopt") return await runAdopt(args.slice(1));
	if (sub === "inspect") return await runInteropInspect(args.slice(1));
	const unknownFlag = sub.startsWith("-");
	return failure(
		["interop"],
		unknownFlag ? "unknown_flag" : "unknown_command",
		unknownFlag ? `unknown flag: ${sub}` : `unknown command: ${sub}`,
		args.includes("--json"),
	);
}

async function runAdopt(args: ReadonlyArray<string>): Promise<number> {
	const json = args.includes("--json");
	const host = args[0] === "claude" ? "claude-code" : args[0] === "agy" ? "antigravity" : args[0];
	const kind = host && !host.startsWith("-") ? interopAgentKind(host as InteropAgentId) : undefined;
	if (!kind?.inventory) {
		return failure(ADOPT_PATH, "usage", "name a host: claude-code, codex, antigravity, copilot, opencode", json);
	}
	let filter: AdoptionKind | undefined;
	let scope: "user" | "project" | undefined;
	let yes = false;
	let dryRun = false;
	for (let i = 1; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--kind" || arg.startsWith("--kind=")) {
			const next = arg === "--kind" ? args[++i] : arg.slice("--kind=".length);
			if (!next || !["skill", "agent", "prompt", "plugin"].includes(next)) {
				return failure(ADOPT_PATH, "usage", "--kind must be one of skill, agent, prompt, plugin", json);
			}
			filter = next as AdoptionKind;
		} else if (arg === "--project" || arg === "--user") {
			if (scope) return failure(ADOPT_PATH, "flag_conflict", "choose one destination scope", json);
			scope = arg === "--project" ? "project" : "user";
		} else if (arg === "--yes" || arg === "-y") yes = true;
		else if (arg === "--dry-run") dryRun = true;
		else if (arg === "--json") continue;
		else {
			const unknownFlag = arg.startsWith("-");
			return failure(
				ADOPT_PATH,
				unknownFlag ? "unknown_flag" : "usage",
				unknownFlag ? `unknown flag: ${arg}` : `unexpected argument: ${arg}`,
				json,
			);
		}
	}
	const report = await detectInteropAgents({ inventory: true });
	const inventory = report.agents.find((agent) => agent.kind === kind.id)?.inventory;
	if (!inventory) return failure(ADOPT_PATH, "not_found", "inventory is unknown", json, 1);
	const plan = planInteropAdoption({
		host: kind.id,
		inventory,
		...(scope ? { scope } : {}),
		...(filter ? { kind: filter } : {}),
	});
	const installable = plan.entries.some((entry) => entry.action === "install");
	if (!json) {
		process.stdout.write(`${renderInteropAdoptionPlan(plan)}\n`);
		for (const diagnostic of inventory.diagnostics) process.stdout.write(`Unknown: ${diagnostic}\n`);
	}
	const document = (installed: string[], diagnostics: string[]) => ({
		version: 1,
		host: plan.host,
		scope: plan.scope,
		dryRun,
		entries: plan.entries.map(({ files: _files, ...entry }) => entry),
		unknown: inventory.diagnostics,
		installed,
		diagnostics,
	});
	if (dryRun || !installable) {
		if (json) process.stdout.write(`${JSON.stringify(document([], []))}\n`);
		return 0;
	}
	if (!yes && process.stdin.isTTY && (json || process.stdout.isTTY)) {
		// Under --json stdout is the document, so the question goes to stderr.
		if (json) process.stderr.write(`${renderInteropAdoptionPlan(plan)}\n`);
		const rl = createInterface({ input: process.stdin, output: json ? process.stderr : process.stdout });
		try {
			yes = (await rl.question("Install this plan? [y/N] ")).trim().toLowerCase() === "y";
		} finally {
			rl.close();
		}
	}
	const result = applyInteropAdoption(plan, yes);
	if (json) process.stdout.write(`${JSON.stringify(document(result.installed, result.diagnostics))}\n`);
	else for (const id of result.installed) process.stdout.write(`Installed ${id}\n`);
	for (const diagnostic of result.diagnostics) process.stderr.write(`${diagnostic}\n`);
	return result.diagnostics.length > 0 ? 1 : 0;
}
