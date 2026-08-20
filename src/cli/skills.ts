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
import { formatColumns, printError, printOk } from "./shared.js";

const HELP = `clio-coder skills <command>

Manage local Clio and Agent Skills-compatible skills.

Commands:
  clio-coder skills list [--json] [--all]
  clio-coder skills search <query> [--json]
  clio-coder skills inspect <name> [--json]
  clio-coder skills validate [path] [--json]
  clio-coder skills install <name|path|github-url>... [--user|--project] [--name <name>] [--force]
  clio-coder skills install --category <category> [--user|--project] [--force]
  clio-coder skills update <name> | --all [--force]
  clio-coder skills sync [--force]
  clio-coder skills eval <name|path> [--scenario <id>] [--target <id>] [--workspace <path>] [--timeout <seconds>] [--trust-fixtures] [--allow-network] [--json]

search covers installed skills plus the local marketplace: CLIO_CODER_SKILL_CATALOG_DIR,
a repo skills/ catalog, or the catalog and skill-marketplace.json index the
installed clio-coder package carries. Installing from the shipped catalog copies
local files and needs no network.

install resolves a bare name through that marketplace; a path or GitHub URL
installs directly, and an existing local path always wins over a same-named
marketplace entry. Several sources install in one command, and --category
installs every marketplace skill in one catalog group (git, research, ...).

eval (experimental) executes the skill's evals.md RED-GREEN scenarios: per
scenario a baseline headless run without the skill, a treatment run with it,
and a judge run scoring each Expected bullet from the transcripts. Exit is 1
when a treatment bullet fails and 3 when a scenario was never measured (a
truncated or unparseable judge response scores no bullet, which is not a skill
failure). Every arm runs hermetic: the network tool plane is stripped from the
child runs unless you pass --allow-network. The baseline and treatment arms run
at autonomy full-auto in per-run disposable workspaces, because a headless run
has no operator to approve anything and a gated arm measures the harness rather
than the skill. --scenario takes a full id as written
in evals.md, whose prefix is per-skill (S1, but also D2 in clio-dev, T3 in
clio-test, F1 in find-skills, H2 in context-handoff), or a bare number that
selects that scenario whatever its prefix. --json emits one JSONL row per
(scenario, bullet) with schema: "experimental". --workspace copies an existing
checkout into a throwaway seed; the source checkout is not mutated. Fixture
commands declared in evals.md are real shell run in that seed; they only execute
with --trust-fixtures, after you have reviewed the evals.md.
`;

type SkillInstallScope = "user" | "project";

interface Parsed {
	command?: string;
	positional: string[];
	json: boolean;
	all: boolean;
	help: boolean;
	force: boolean;
	name?: string;
	category?: string;
	scope?: SkillInstallScope;
	scenario?: string;
	target?: string;
	workspace?: string;
	timeoutSeconds?: number;
	trustFixtures: boolean;
	allowNetwork: boolean;
}

function parse(argv: ReadonlyArray<string>): Parsed {
	const out: Parsed = {
		positional: [],
		json: false,
		all: false,
		help: false,
		force: false,
		trustFixtures: false,
		allowNetwork: false,
	};
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
			case "--allow-network":
				out.allowNetwork = true;
				break;
			case "--name": {
				const value = argv[i + 1];
				if (!value || value.startsWith("-")) throw new Error("--name requires a value");
				out.name = value;
				i++;
				break;
			}
			case "--category": {
				const value = argv[i + 1];
				if (!value || value.startsWith("-")) throw new Error("--category requires a value");
				out.category = value;
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
		// Blank for the ordinary operator-installed case; a worker install is
		// the anomaly worth a column, so it is the only value that ever prints.
		skill.provenance?.installedBy ?? "",
		skill.description,
	]);
}

function printList(skills: ReadonlyArray<Skill>): void {
	if (skills.length === 0) {
		process.stdout.write("skills: none\n");
		return;
	}
	process.stdout.write(
		formatColumns([["name", "scope", "source", "trust", "invoke", "hash", "by", "description"], ...skillRows(skills)]),
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
	if (skill.provenance?.installedBy) {
		process.stdout.write(`installed-by: ${skill.provenance.installedBy}\n`);
	}
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

export async function runSkillsCommand(argv: ReadonlyArray<string>): Promise<number> {
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	// A bare `clio-coder skills` is a missing required argument, which the
	// exit-code contract puts at 2 with the usage on stderr. See the same note in
	// extensions.ts.
	if (!parsed.command) {
		process.stderr.write(HELP);
		return 2;
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
				process.stderr.write("usage: clio-coder skills search <query> [--json]\n");
				return 2;
			}
			const list = loadSkills({ cwd: process.cwd() });
			const discovery = discoverMarketplaceSkills({ cwd: process.cwd() });
			const installedNames = new Set(list.items.map((skill) => skill.name));
			const matchesQuery = (name: string, description: string): boolean =>
				name.toLowerCase().includes(query) || description.toLowerCase().includes(query);
			const installed = list.items.filter((skill) => matchesQuery(skill.name, skill.description));
			// A catalog group name is the other thing an operator types here, and
			// `install --category git` treats it as a real field: without this,
			// `search git` answered with the skills whose prose mentions git and
			// omitted every member of skills/git/.
			const marketplace = discovery.skills.filter(
				(skill) =>
					!installedNames.has(skill.name) &&
					(matchesQuery(skill.name, skill.description) || skill.category?.toLowerCase() === query),
			);
			// Search must report anything that made the result incomplete: loader
			// diagnostics (like list) plus marketplace discovery diagnostics, so a
			// broken index looks different from a skill that does not exist.
			const exitCode = list.diagnostics.some((diag) => diag.type === "error") ? 1 : 0;
			if (parsed.json) {
				process.stdout.write(
					`${JSON.stringify(
						{ query, installed, marketplace, diagnostics: list.diagnostics, marketplaceDiagnostics: discovery.diagnostics },
						null,
						2,
					)}\n`,
				);
				return exitCode;
			}
			if (installed.length > 0) {
				process.stdout.write("installed:\n");
				for (const skill of installed) {
					process.stdout.write(`  ${skill.name.padEnd(24)} ${skill.description}  (${skill.scope}/${skill.source})\n`);
				}
			}
			if (marketplace.length > 0) {
				process.stdout.write("marketplace (clio-coder skills install <name>):\n");
				for (const skill of marketplace) {
					process.stdout.write(`  ${skill.name.padEnd(24)} ${skill.description}  (${formatMarketplaceOrigin(skill)})\n`);
				}
			}
			if (installed.length === 0 && marketplace.length === 0) {
				process.stdout.write(`skills: no matches for "${query}"\n`);
			}
			printDiagnostics(list.diagnostics);
			for (const message of discovery.diagnostics) process.stderr.write(`warning: ${message}\n`);
			return exitCode;
		}
		case "inspect": {
			const name = parsed.positional[0];
			if (!name || parsed.positional.length !== 1) {
				process.stderr.write("usage: clio-coder skills inspect <name> [--json]\n");
				return 2;
			}
			const list = loadSkills({ cwd: process.cwd() });
			const skill = list.items.find((entry) => entry.name === name);
			if (!skill) {
				// inspect reads an installed skill's loaded record, which a marketplace
				// entry does not have yet. Saying "unknown skill" about a name `search`
				// just listed denies the skill exists; name the state and the one
				// command that changes it.
				const available = discoverMarketplaceSkills({ cwd: process.cwd() }).skills.some((entry) => entry.name === name);
				printError(
					available
						? `skill not installed: ${name} (available in the marketplace; install it with: clio-coder skills install ${name})`
						: `unknown skill: ${name}`,
				);
				return 1;
			}
			if (parsed.json) process.stdout.write(`${JSON.stringify({ skill }, null, 2)}\n`);
			else printInspect(skill);
			return 0;
		}
		case "validate": {
			const pathArg = parsed.positional[0];
			if (parsed.positional.length > 1) {
				process.stderr.write("usage: clio-coder skills validate [path] [--json]\n");
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
		case "install": {
			let sources = parsed.positional;
			if (parsed.category !== undefined) {
				if (sources.length > 0) {
					process.stderr.write("--category installs a whole catalog group; do not also name skills\n");
					return 2;
				}
				const grouped = discoverMarketplaceSkills().skills.filter((skill) => skill.category === parsed.category);
				if (grouped.length === 0) {
					printError(`no marketplace skills in category "${parsed.category}"`);
					return 1;
				}
				sources = grouped.map((skill) => skill.name);
			}
			if (sources.length === 0) {
				process.stderr.write(
					"usage: clio-coder skills install <name|path|github-url>... [--user|--project] [--name <name>] [--force]\n" +
						"       clio-coder skills install --category <category> [--user|--project] [--force]\n",
				);
				return 2;
			}
			// --name renames the destination directory, which can only mean one
			// thing for one source; silently applying it to a list would install
			// every skill over the same directory.
			if (parsed.name !== undefined && sources.length !== 1) {
				process.stderr.write("--name applies to a single skill; install them one at a time to rename\n");
				return 2;
			}
			let failed = 0;
			for (const source of sources) {
				try {
					const result = installSkill({
						source,
						scope: parsed.scope ?? "project",
						force: parsed.force,
						...(parsed.name ? { name: parsed.name } : {}),
					});
					printOk(`installed ${result.scope} skill ${result.name} at ${result.path}`);
					for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
				} catch (err) {
					failed += 1;
					printError(err instanceof Error ? err.message : String(err));
				}
			}
			if (failed === sources.length) return 1;
			process.stdout.write("audit is set to unknown; review the skill and set audit: pass yourself\n");
			return failed > 0 ? 1 : 0;
		}
		case "update": {
			const name = parsed.positional[0];
			if ((!name && !parsed.all) || parsed.positional.length > 1) {
				process.stderr.write("usage: clio-coder skills update <name> | --all [--force]\n");
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
					"usage: clio-coder skills eval <name|path> [--scenario <id>] [--target <id>] [--workspace <path>] [--timeout <seconds>] [--trust-fixtures] [--allow-network] [--json]\n",
				);
				return 2;
			}
			// Dynamic import keeps the eval lane (evidence + eval domains) out of
			// the chunk that clio-coder skills list/search load.
			const { runSkillsEvalCommand } = await import("./skills-eval.js");
			return runSkillsEvalCommand(name, {
				json: parsed.json,
				trustFixtures: parsed.trustFixtures,
				allowNetwork: parsed.allowNetwork,
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
