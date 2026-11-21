/** Discover coding agents and review safe resource adoption without model calls. */

import { createInterface } from "node:readline/promises";
import {
	ADOPTION_KINDS,
	type AdoptionKind,
	applyInteropAdoption,
	detectInteropAgents,
	INTEROP_AGENT_KINDS,
	type InteropAdoptionPlan,
	type InteropAgentId,
	interopAgentKind,
	planInteropAdoption,
	renderInteropAdoptionPlan,
} from "../domains/interop/index.js";
import { runInteropInspect } from "./interop-inspect.js";
import { writeCliFailure } from "./kit/json-out.js";
import type { ErrorSlug } from "./kit/slugs.js";

const ADOPT_PATH = ["interop", "adopt"] as const;

/** A plan entry as the CLI prints it: no reviewed bytes, and an MCP server's env as keys only. */
function publicEntry({ files: _files, server, ...entry }: InteropAdoptionPlan["entries"][number]) {
	return {
		...entry,
		...(server
			? {
					server: {
						id: server.id,
						command: server.command,
						args: server.args,
						envKeys: Object.keys(server.env).sort(),
						...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
					},
				}
			: {}),
	};
}

/**
 * The configure flow's migration step: one reviewed plan per detected host
 * with an inventory, each applied only on an explicit yes. Without a way to
 * answer it prints the plans and writes nothing.
 */
export async function runInteropAdoptionReview(io: {
	rl: { question(query: string): Promise<string> } | null;
}): Promise<number> {
	const report = await detectInteropAgents({ inventory: true });
	let offered = 0;
	let failed = false;
	for (const kind of INTEROP_AGENT_KINDS) {
		const inventory = report.agents.find((agent) => agent.kind === kind.id && agent.presence !== "absent")?.inventory;
		if (!kind.inventory || !inventory || inventory.items.length === 0) continue;
		const plan = planInteropAdoption({ host: kind.id, inventory });
		if (!plan.entries.some((entry) => entry.action === "install")) continue;
		offered++;
		process.stdout.write(`\n${renderInteropAdoptionPlan(plan)}\n`);
		if (io.rl === null) continue;
		const yes = (await io.rl.question(`Adopt from ${kind.label}? [y/N] `)).trim().toLowerCase() === "y";
		if (!yes) continue;
		const result = applyInteropAdoption(plan, true);
		for (const id of result.installed) process.stdout.write(`Installed ${id}\n`);
		for (const diagnostic of result.diagnostics) process.stderr.write(`${diagnostic}\n`);
		if (result.diagnostics.length > 0) failed = true;
	}
	if (offered === 0) process.stdout.write("Nothing new to adopt from other coding agents.\n");
	else if (io.rl === null)
		process.stdout.write("\nRun `clio-coder interop adopt <host>` on a terminal to adopt any of these.\n");
	return failed ? 1 : 0;
}

function failure(path: ReadonlyArray<string>, slug: ErrorSlug, message: string, json: boolean, code = 2): number {
	writeCliFailure({ path, slug, message, json });
	return code;
}

const HELP = `clio-coder interop <subcommand>

Detected external coding agents and how far each one is wired.

Subcommands:
  inspect [--json]              show host inventory and connection state
  adopt <host> [--kind skill|agent|prompt|plugin|mcp] [--project|--user]
               [--yes] [--dry-run] [--json]
                                review and adopt a host's skills, agents,
                                prompts, plugins and stdio MCP servers in one
                                plan; --json prints the plan and its result as
                                one document and asks on stderr

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
			if (!next || !(ADOPTION_KINDS as ReadonlyArray<string>).includes(next)) {
				return failure(ADOPT_PATH, "usage", `--kind must be one of ${ADOPTION_KINDS.join(", ")}`, json);
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
		entries: plan.entries.map(publicEntry),
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
