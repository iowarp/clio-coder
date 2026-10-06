/**
 * `clio-coder playbook` operator surface.
 *
 *   clio-coder playbook list                       enumerate playbooks with validity
 *   clio-coder playbook new <name> --from <name>   copy a shipped playbook into the project
 *   clio-coder playbook validate|graph <name>      inspect a playbook without executing it
 *   clio-coder playbook commands init              draft a repository command registry
 *
 * A playbook is repo-owned policy (.clio-coder/playbooks/<name>.md). The fleet
 * runs it with `clio-coder fleet run <playbook>`; nothing here executes one.
 */

import {
	listPlaybooks,
	PLAYBOOK_COMMANDS_REMEDY,
	PLAYBOOK_COMMANDS_REPO_PATH,
	type PlaybookListing,
	type PlaybookStep,
} from "../domains/agents/index.js";
import { convertWorkspaceForCommand } from "./workspace-conversion.js";

const HELP = `clio-coder playbook <subcommand>

Author and check repo-owned playbooks. The fleet runs them: clio-coder fleet run <playbook>.

Subcommands:
  list                          list builtin, plugin, user and project playbooks with validation status
  new <name> --from <builtin>   copy the build-review, build-test, or sdlc playbook into .clio-coder/playbooks/
  validate <name> [--json]      run a playbook's execution preflight without side effects
  graph <name> [--json]         print a playbook's compiled waves, loops, scopes, and write boundaries
  commands init                 draft a commented playbook command registry from declared project entries
`;

function fail(message: string): number {
	process.stderr.write(`clio-coder playbook: ${message}\n`);
	return 2;
}

function renderStep(step: PlaybookStep): string {
	if (step.kind === "code") return `code:${step.command}[${step.scope}]`;
	if (step.kind === "agent") return `${step.agent}[${step.scope}]`;
	if (step.kind === "gate") return `gate:${step.path}[${step.run}]`;
	if (step.kind === "plan") {
		return `plan:${step.agent}[${step.roster.join(",")}; max ${step.maxTasks}]`;
	}
	const check =
		step.check.kind === "code"
			? `code:${step.check.command}`
			: step.check.kind === "gate"
				? `gate:${step.check.gate}`
				: step.check.agent;
	return `loop:${step.id}(${check} -> ${step.repair.agent} x${step.maxAttempts})`;
}

function listingLine(entry: PlaybookListing, state: string, detail: string): string {
	return `${entry.name}  ${entry.source}  ${state.padEnd(7)}  ${detail}\n`;
}

function runList(args: ReadonlyArray<string>): number {
	// `list` took no arguments and silently ignored whatever followed it, so
	// `playbook list --bogus` exited 0 with the normal table and `playbook list --json`
	// printed the human one. Its siblings status, drain, and resume all reject an
	// unrecognised flag, and so do `agents` and `models`.
	const unknown = args[0];
	if (unknown !== undefined) return fail(`list: unknown flag: ${unknown}`);
	const listings = listPlaybooks(process.cwd());
	if (listings.length === 0) {
		process.stdout.write("no playbooks found (.clio-coder/playbooks/*.md)\n");
		return 0;
	}
	for (const entry of listings) {
		if (entry.playbook !== null) {
			const steps = entry.playbook.steps.map(renderStep).join(" -> ");
			process.stdout.write(listingLine(entry, "valid", steps));
			if (entry.playbook.description.length > 0) {
				process.stdout.write(`  ${entry.playbook.description}\n`);
			}
			continue;
		}
		// A shipped playbook whose only gap is a registry this repo has never written
		// is unfinished setup, not a broken playbook. Both stay unrunnable; only
		// one of them is fixed by writing a file, so only one is told to.
		if (entry.needsCommands !== null) {
			process.stdout.write(
				listingLine(entry, "setup", `needs ${PLAYBOOK_COMMANDS_REPO_PATH} declaring ${entry.needsCommands.join(", ")}`),
			);
			process.stdout.write(`  ${PLAYBOOK_COMMANDS_REMEDY}\n`);
			continue;
		}
		process.stdout.write(listingLine(entry, "invalid", entry.error ?? "unknown error"));
	}
	return 0;
}

export async function runPlaybookCommand(args: ReadonlyArray<string>): Promise<number> {
	const sub = args[0];
	// Asking for help is not a usage error, and it is not an argument either.
	if (sub === "help" || args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (sub === undefined) {
		process.stderr.write(HELP);
		return 2;
	}
	await convertWorkspaceForCommand();
	switch (sub) {
		case "list":
			return runList(args.slice(1));
		case "new":
			return (await import("./playbook-new.js")).runPlaybookNew(args.slice(1));
		case "validate":
			return (await import("./playbook-validate.js")).runPlaybookValidate(args.slice(1));
		case "graph":
			return (await import("./playbook-graph.js")).runPlaybookGraph(args.slice(1));
		case "commands":
			return (await import("./playbook-commands.js")).runPlaybookCommands(args.slice(1));
		default:
			process.stderr.write(`clio-coder playbook: unknown subcommand '${sub}'\n`);
			process.stderr.write(HELP);
			return 2;
	}
}
