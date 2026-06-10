import { resolve } from "node:path";
import {
	installSkill,
	loadSkills,
	modelVisibleSkills,
	type ResourceDiagnostic,
	type Skill,
	type SkillUpdateReport,
	updateSkills,
} from "../domains/resources/index.js";
import { createSkillTool } from "../tools/skills.js";
import { formatColumns, printError, printOk } from "./shared.js";

const HELP = `clio skills <command>

Manage local Clio and Agent Skills-compatible skills.

Commands:
  clio skills list [--json] [--all]
  clio skills inspect <name> [--json]
  clio skills validate [path] [--json]
  clio skills create <name> [--user|--project]
  clio skills install <path|github-url> [--user|--project] [--name <name>] [--force]
  clio skills update <name> | --all [--force]
  clio skills sync [--force]
`;

type SkillCreateScope = "user" | "project";

interface Parsed {
	command?: string;
	positional: string[];
	json: boolean;
	all: boolean;
	help: boolean;
	force: boolean;
	name?: string;
	scope?: SkillCreateScope;
}

function parse(argv: ReadonlyArray<string>): Parsed | null {
	const out: Parsed = { positional: [], json: false, all: false, help: false, force: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (!out.command && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		switch (arg) {
			case "--json":
				out.json = true;
				break;
			case "--all":
				out.all = true;
				break;
			case "--force":
				out.force = true;
				break;
			case "--name": {
				const value = argv[i + 1];
				if (!value || value.startsWith("-")) return null;
				out.name = value;
				i++;
				break;
			}
			case "--user":
				if (out.scope && out.scope !== "user") return null;
				out.scope = "user";
				break;
			case "--project":
				if (out.scope && out.scope !== "project") return null;
				out.scope = "project";
				break;
			case "--help":
			case "-h":
				out.help = true;
				break;
			default:
				if (arg.startsWith("-")) return null;
				out.positional.push(arg);
		}
	}
	return out;
}

function printUpdateReports(reports: ReadonlyArray<SkillUpdateReport>): number {
	if (reports.length === 0) {
		process.stdout.write("skills: nothing to update (no installed skills with source-url provenance)\n");
		return 0;
	}
	for (const report of reports) {
		const detail = report.detail ? ` (${report.detail})` : "";
		process.stdout.write(`${report.name}: ${report.status}${detail}\n`);
	}
	return reports.some((report) => report.status === "error") ? 1 : 0;
}

function printDiagnostics(diagnostics: ReadonlyArray<ResourceDiagnostic>): void {
	for (const diag of diagnostics) {
		const detail = diag.path ? `${diag.message}: ${diag.path}` : diag.message;
		if (diag.type === "error") printError(detail);
		else process.stderr.write(`warning: ${detail}\n`);
	}
}

function skillRows(skills: ReadonlyArray<Skill>): string[][] {
	return skills.map((skill) => [
		skill.name,
		skill.scope,
		skill.source,
		skill.trusted ? "trusted" : "untrusted",
		skill.disableModelInvocation ? "manual" : "model",
		skill.hash.slice(0, 12),
		skill.description,
	]);
}

function printList(skills: ReadonlyArray<Skill>): void {
	if (skills.length === 0) {
		process.stdout.write("skills: none\n");
		return;
	}
	process.stdout.write(
		formatColumns([["name", "scope", "source", "trust", "invoke", "hash", "description"], ...skillRows(skills)]),
	);
}

function printInspect(skill: Skill): void {
	process.stdout.write(`name: ${skill.name}\n`);
	process.stdout.write(`description: ${skill.description}\n`);
	process.stdout.write(`path: ${skill.filePath}\n`);
	process.stdout.write(`baseDir: ${skill.baseDir}\n`);
	process.stdout.write(`scope: ${skill.scope}\n`);
	process.stdout.write(`source: ${skill.source}\n`);
	process.stdout.write(`trusted: ${skill.trusted}\n`);
	process.stdout.write(`disableModelInvocation: ${skill.disableModelInvocation}\n`);
	process.stdout.write(`hash: ${skill.hash}\n`);
	if (skill.diagnostics.length > 0) {
		process.stdout.write("diagnostics:\n");
		for (const diag of skill.diagnostics) process.stdout.write(`  ${diag.type}: ${diag.message}\n`);
	}
}

function validationLoad(pathArg: string | undefined): ReturnType<typeof loadSkills> {
	if (!pathArg) return loadSkills({ cwd: process.cwd() });
	return loadSkills({ disableDiscovery: true, explicitSkillPaths: [resolve(pathArg)] });
}

function defaultDescription(name: string): string {
	return `Use when ${name.replace(/-/g, " ")} guidance is needed.`;
}

function defaultBody(name: string): string {
	return [`# ${name}`, "", "Describe the workflow, constraints, and files this skill should use.", ""].join("\n");
}

export async function runSkillsCommand(argv: ReadonlyArray<string>): Promise<number> {
	const parsed = parse(argv);
	if (!parsed || parsed.help || !parsed.command) {
		process.stdout.write(HELP);
		return parsed ? 0 : 2;
	}
	switch (parsed.command) {
		case "list": {
			const list = loadSkills({ cwd: process.cwd() });
			const skills = parsed.all ? list.items : modelVisibleSkills(list.items);
			if (parsed.json) process.stdout.write(`${JSON.stringify({ skills, diagnostics: list.diagnostics }, null, 2)}\n`);
			else {
				printList(skills);
				printDiagnostics(list.diagnostics);
			}
			return list.diagnostics.some((diag) => diag.type === "error") ? 1 : 0;
		}
		case "inspect": {
			const name = parsed.positional[0];
			if (!name || parsed.positional.length !== 1) {
				process.stderr.write("usage: clio skills inspect <name> [--json]\n");
				return 2;
			}
			const list = loadSkills({ cwd: process.cwd() });
			const skill = list.items.find((entry) => entry.name === name);
			if (!skill) {
				printError(`unknown skill: ${name}`);
				return 1;
			}
			if (parsed.json) process.stdout.write(`${JSON.stringify({ skill }, null, 2)}\n`);
			else printInspect(skill);
			return 0;
		}
		case "validate": {
			const pathArg = parsed.positional[0];
			if (parsed.positional.length > 1) {
				process.stderr.write("usage: clio skills validate [path] [--json]\n");
				return 2;
			}
			const list = validationLoad(pathArg);
			const ok = list.items.length > 0 && !list.diagnostics.some((diag) => diag.type === "error");
			if (parsed.json) {
				process.stdout.write(`${JSON.stringify({ ok, skills: list.items, diagnostics: list.diagnostics }, null, 2)}\n`);
			} else {
				printDiagnostics(list.diagnostics);
				process.stdout.write(`${ok ? "valid" : "invalid"}: ${list.items.length} skill(s)\n`);
			}
			return ok ? 0 : 1;
		}
		case "create": {
			const name = parsed.positional[0];
			if (!name || parsed.positional.length !== 1) {
				process.stderr.write("usage: clio skills create <name> [--user|--project]\n");
				return 2;
			}
			const tool = createSkillTool({ getCwd: () => process.cwd() });
			const result = await tool.run({
				name,
				description: defaultDescription(name),
				body: defaultBody(name),
				scope: parsed.scope ?? "project",
				with_scaffold: true,
			});
			if (result.kind === "error") {
				printError(result.message);
				return 1;
			}
			printOk(result.output.split("\n")[0] ?? `created skill ${name}`);
			return 0;
		}
		case "install": {
			const source = parsed.positional[0];
			if (!source || parsed.positional.length !== 1) {
				process.stderr.write("usage: clio skills install <path|github-url> [--user|--project] [--name <name>] [--force]\n");
				return 2;
			}
			try {
				const result = installSkill({
					source,
					scope: parsed.scope ?? "project",
					force: parsed.force,
					...(parsed.name ? { name: parsed.name } : {}),
				});
				printOk(`installed ${result.scope} skill ${result.name} at ${result.path}`);
				for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
				process.stdout.write("audit is set to unknown; review the skill and set audit: pass yourself\n");
				return 0;
			} catch (err) {
				printError(err instanceof Error ? err.message : String(err));
				return 1;
			}
		}
		case "update": {
			const name = parsed.positional[0];
			if ((!name && !parsed.all) || parsed.positional.length > 1) {
				process.stderr.write("usage: clio skills update <name> | --all [--force]\n");
				return 2;
			}
			try {
				const reports = updateSkills(name ? { name, force: parsed.force } : { all: true, force: parsed.force });
				return printUpdateReports(reports);
			} catch (err) {
				printError(err instanceof Error ? err.message : String(err));
				return 1;
			}
		}
		case "sync": {
			try {
				return printUpdateReports(updateSkills({ all: true, force: parsed.force }));
			} catch (err) {
				printError(err instanceof Error ? err.message : String(err));
				return 1;
			}
		}
		default:
			printError(`unknown skills command: ${parsed.command}`);
			process.stdout.write(HELP);
			return 2;
	}
}
