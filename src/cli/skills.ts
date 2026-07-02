import { resolve } from "node:path";
import {
	discoverMarketplaceSkills,
	installSkill,
	loadSkills,
	type MarketplaceSkill,
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
  clio skills search <query> [--json]
  clio skills inspect <name> [--json]
  clio skills validate [path] [--json]
  clio skills create <name> [--user|--project]
  clio skills install <path|github-url> [--user|--project] [--name <name>] [--force]
  clio skills update <name> | --all [--force]
  clio skills sync [--force]
  clio skills eval <name|path> [--scenario <id>] [--target <id>] [--workspace <path>] [--timeout <seconds>] [--trust-fixtures] [--json]

search covers installed skills plus the local marketplace (a repo skills/
catalog, CLIO_SKILL_CATALOG_DIR, or the skill-marketplace.json index).

eval (experimental) executes the skill's evals.md RED-GREEN scenarios: per
scenario a baseline headless run without the skill, a treatment run with it,
and a judge run scoring each Expected bullet from the transcripts. Exit is
nonzero when any treatment bullet fails. --json emits one JSONL row per
(scenario, bullet) with schema: "experimental". --workspace runs scenarios in
an existing checkout instead of a throwaway temp directory. Fixture commands
declared in evals.md are real shell run in the scenario workspace; they only
execute with --trust-fixtures, after you have reviewed the evals.md.
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
	scenario?: string;
	target?: string;
	workspace?: string;
	timeoutSeconds?: number;
	trustFixtures: boolean;
}

function parse(argv: ReadonlyArray<string>): Parsed {
	const out: Parsed = { positional: [], json: false, all: false, help: false, force: false, trustFixtures: false };
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
			case "--trust-fixtures":
				out.trustFixtures = true;
				break;
			case "--name": {
				const value = argv[i + 1];
				if (!value || value.startsWith("-")) throw new Error("--name requires a value");
				out.name = value;
				i++;
				break;
			}
			case "--scenario": {
				const value = argv[i + 1];
				if (!value || value.startsWith("-")) throw new Error("--scenario requires a value");
				out.scenario = value;
				i++;
				break;
			}
			case "--target": {
				const value = argv[i + 1];
				if (!value || value.startsWith("-")) throw new Error("--target requires a value");
				out.target = value;
				i++;
				break;
			}
			case "--workspace": {
				const value = argv[i + 1];
				if (!value || value.startsWith("-")) throw new Error("--workspace requires a value");
				out.workspace = value;
				i++;
				break;
			}
			case "--timeout": {
				const value = argv[i + 1];
				const seconds = value === undefined ? Number.NaN : Number.parseInt(value, 10);
				if (!Number.isInteger(seconds) || seconds <= 0) throw new Error("--timeout requires a positive integer");
				out.timeoutSeconds = seconds;
				i++;
				break;
			}
			case "--user":
				if (out.scope && out.scope !== "user") throw new Error("--user and --project are mutually exclusive");
				out.scope = "user";
				break;
			case "--project":
				if (out.scope && out.scope !== "project") throw new Error("--user and --project are mutually exclusive");
				out.scope = "project";
				break;
			case "--help":
			case "-h":
				out.help = true;
				break;
			default:
				if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
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

function formatMarketplaceOrigin(skill: MarketplaceSkill): string {
	const parts = [skill.origin === "catalog" ? "catalog" : "index"];
	if (skill.version) parts.push(`v${skill.version}`);
	if (skill.audit) parts.push(`audit: ${skill.audit}`);
	return parts.join(", ");
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
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help || !parsed.command) {
		process.stdout.write(HELP);
		return 0;
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
		case "search": {
			const query = parsed.positional.join(" ").trim().toLowerCase();
			if (query.length === 0) {
				process.stderr.write("usage: clio skills search <query> [--json]\n");
				return 2;
			}
			const list = loadSkills({ cwd: process.cwd() });
			const installedNames = new Set(list.items.map((skill) => skill.name));
			const matchesQuery = (name: string, description: string): boolean =>
				name.toLowerCase().includes(query) || description.toLowerCase().includes(query);
			const installed = list.items.filter((skill) => matchesQuery(skill.name, skill.description));
			const marketplace = discoverMarketplaceSkills({ cwd: process.cwd() }).skills.filter(
				(skill) => !installedNames.has(skill.name) && matchesQuery(skill.name, skill.description),
			);
			if (parsed.json) {
				process.stdout.write(`${JSON.stringify({ query, installed, marketplace }, null, 2)}\n`);
				return 0;
			}
			if (installed.length === 0 && marketplace.length === 0) {
				process.stdout.write(`skills: no matches for "${query}"\n`);
				return 0;
			}
			if (installed.length > 0) {
				process.stdout.write("installed:\n");
				for (const skill of installed) {
					process.stdout.write(`  ${skill.name.padEnd(24)} ${skill.description}  (${skill.scope}/${skill.source})\n`);
				}
			}
			if (marketplace.length > 0) {
				process.stdout.write("marketplace (clio skills install <name|source>):\n");
				for (const skill of marketplace) {
					process.stdout.write(`  ${skill.name.padEnd(24)} ${skill.description}  (${formatMarketplaceOrigin(skill)})\n`);
				}
			}
			return 0;
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
			// A scanned file that produced no loaded skill is malformed, and a
			// collision drops a skill: both make the catalog invalid, as does any
			// hard error. Benign warnings (name/path mismatch, name format,
			// description length) attach to a file that still loaded, so their path
			// is among the loaded skills and they do not fail validation.
			const loadedPaths = new Set(list.items.map((skill) => skill.filePath));
			const hasInvalidDiagnostic = list.diagnostics.some(
				(diag) =>
					diag.type === "error" ||
					diag.type === "collision" ||
					(diag.type === "warning" && diag.path !== undefined && !loadedPaths.has(diag.path)),
			);
			const ok = list.items.length > 0 && !hasInvalidDiagnostic;
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
		case "eval": {
			const name = parsed.positional[0];
			if (!name || parsed.positional.length !== 1) {
				process.stderr.write(
					"usage: clio skills eval <name|path> [--scenario <id>] [--target <id>] [--workspace <path>] [--timeout <seconds>] [--trust-fixtures] [--json]\n",
				);
				return 2;
			}
			// Dynamic import keeps the eval lane (evidence + eval domains) out of
			// the chunk that clio skills list/search load.
			const { runSkillsEvalCommand } = await import("./skills-eval.js");
			return runSkillsEvalCommand(name, {
				json: parsed.json,
				trustFixtures: parsed.trustFixtures,
				...(parsed.scenario !== undefined ? { scenario: parsed.scenario } : {}),
				...(parsed.target !== undefined ? { target: parsed.target } : {}),
				...(parsed.workspace !== undefined ? { workspace: parsed.workspace } : {}),
				...(parsed.timeoutSeconds !== undefined ? { timeoutSeconds: parsed.timeoutSeconds } : {}),
			});
		}
		default:
			printError(`unknown skills command: ${parsed.command}`);
			process.stderr.write(HELP);
			return 2;
	}
}
