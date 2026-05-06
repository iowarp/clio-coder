import { resolve } from "node:path";
import {
	importShareArchive,
	planShareImport,
	type ShareDiagnostic,
	type ShareExportOptions,
	type ShareImportPlan,
	type ShareScope,
	writeShareArchive,
} from "../domains/share/index.js";
import { printError, printOk } from "./shared.js";

const HELP = `clio share <command>

Export and import portable Clio project/resource archives.

Commands:
  clio share export --out <path> [--project|--user|--both] [--context] [--prompts] [--skills] [--settings] [--extensions]
  clio share import <path> [--dry-run] [--force] [--project|--user] [--json]
  clio share inspect <path> [--json]

Aliases:
  clio export --out <path> ...
  clio import <path> ...
`;

interface Parsed {
	command?: string;
	positional: string[];
	out?: string;
	scope?: ShareScope | "both";
	json: boolean;
	dryRun: boolean;
	force: boolean;
	help: boolean;
	includeContext?: boolean;
	includePrompts?: boolean;
	includeSkills?: boolean;
	includeSettings?: boolean;
	includeExtensions?: boolean;
}

function parse(argv: ReadonlyArray<string>): Parsed | null {
	const out: Parsed = { positional: [], json: false, dryRun: false, force: false, help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg) continue;
		if (!out.command && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		const need = (): string | null => {
			const value = argv[i + 1];
			if (!value) return null;
			i += 1;
			return value;
		};
		switch (arg) {
			case "--out": {
				const value = need();
				if (!value) return null;
				out.out = value;
				break;
			}
			case "--project":
				if (out.scope && out.scope !== "project") return null;
				out.scope = "project";
				break;
			case "--user":
				if (out.scope && out.scope !== "user") return null;
				out.scope = "user";
				break;
			case "--both":
				if (out.scope && out.scope !== "both") return null;
				out.scope = "both";
				break;
			case "--json":
				out.json = true;
				break;
			case "--dry-run":
				out.dryRun = true;
				break;
			case "--force":
			case "-f":
				out.force = true;
				break;
			case "--context":
				out.includeContext = true;
				break;
			case "--prompts":
				out.includePrompts = true;
				break;
			case "--skills":
				out.includeSkills = true;
				break;
			case "--settings":
				out.includeSettings = true;
				break;
			case "--extensions":
				out.includeExtensions = true;
				break;
			case "--all":
				out.includeContext = true;
				out.includePrompts = true;
				out.includeSkills = true;
				out.includeSettings = true;
				out.includeExtensions = true;
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

function hasBlockingDiagnostics(diagnostics: ReadonlyArray<ShareDiagnostic>): boolean {
	return diagnostics.some((diag) => diag.type === "error" || diag.type === "conflict");
}

function printDiagnostics(diagnostics: ReadonlyArray<ShareDiagnostic>): void {
	for (const diag of diagnostics) {
		const detail = diag.path ? `${diag.message}: ${diag.path}` : diag.message;
		if (diag.type === "error" || diag.type === "conflict") printError(detail);
		else process.stderr.write(`warning: ${detail}\n`);
	}
}

function exportOptions(parsed: Parsed): ShareExportOptions {
	return {
		...(parsed.scope ? { scope: parsed.scope } : {}),
		...(parsed.includeContext !== undefined ? { includeContext: parsed.includeContext } : {}),
		...(parsed.includePrompts !== undefined ? { includePrompts: parsed.includePrompts } : {}),
		...(parsed.includeSkills !== undefined ? { includeSkills: parsed.includeSkills } : {}),
		...(parsed.includeSettings !== undefined ? { includeSettings: parsed.includeSettings } : {}),
		...(parsed.includeExtensions !== undefined ? { includeExtensions: parsed.includeExtensions } : {}),
	};
}

function printPlan(plan: ShareImportPlan, dryRun: boolean): void {
	printDiagnostics(plan.diagnostics);
	const verb = dryRun ? "would" : "will";
	const counts = new Map<string, number>();
	for (const action of plan.actions) counts.set(action.action, (counts.get(action.action) ?? 0) + 1);
	process.stdout.write(
		`import ${dryRun ? "dry-run" : "plan"}: ${verb} write ${counts.get("write") ?? 0}, overwrite ${counts.get("overwrite") ?? 0}, skip ${counts.get("skip") ?? 0}, settings ${counts.get("settings") ?? 0}\n`,
	);
	for (const action of plan.actions.slice(0, 12)) {
		process.stdout.write(`  ${action.action.padEnd(9)} ${action.type.padEnd(15)} ${action.path}\n`);
	}
	if (plan.actions.length > 12) process.stdout.write(`  ... ${plan.actions.length - 12} more action(s)\n`);
}

export function runShareCommand(argv: ReadonlyArray<string>): number {
	const parsed = parse(argv);
	if (!parsed || parsed.help || !parsed.command) {
		process.stdout.write(HELP);
		return parsed ? 0 : 2;
	}
	switch (parsed.command) {
		case "export": {
			if (!parsed.out) {
				process.stderr.write("usage: clio share export --out <path>\n");
				return 2;
			}
			const archive = writeShareArchive(resolve(parsed.out), exportOptions(parsed));
			if (parsed.json) process.stdout.write(`${JSON.stringify({ archive }, null, 2)}\n`);
			else printOk(`exported ${archive.files.length} item(s) to ${resolve(parsed.out)}`);
			return 0;
		}
		case "import": {
			const archivePath = parsed.positional[0];
			if (!archivePath || parsed.positional.length !== 1) {
				process.stderr.write("usage: clio share import <path> [--dry-run] [--force]\n");
				return 2;
			}
			const options = {
				dryRun: parsed.dryRun,
				force: parsed.force,
				...(parsed.scope === "user" || parsed.scope === "project" ? { scope: parsed.scope } : {}),
			};
			const plan = parsed.dryRun
				? planShareImport(resolve(archivePath), options)
				: importShareArchive(resolve(archivePath), options);
			if (parsed.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
			else printPlan(plan, parsed.dryRun);
			return hasBlockingDiagnostics(plan.diagnostics) ? 1 : 0;
		}
		case "inspect": {
			const archivePath = parsed.positional[0];
			if (!archivePath || parsed.positional.length !== 1) {
				process.stderr.write("usage: clio share inspect <path>\n");
				return 2;
			}
			const plan = planShareImport(resolve(archivePath), { dryRun: true, force: true });
			if (parsed.json) process.stdout.write(`${JSON.stringify(plan.archive, null, 2)}\n`);
			else {
				printDiagnostics(plan.diagnostics);
				const archive = plan.archive;
				if (archive) {
					process.stdout.write(
						`archive: ${archive.manifest.format} clio=${archive.manifest.clioVersion} files=${archive.files.length} created=${archive.manifest.createdAt}\n`,
					);
				}
			}
			return plan.diagnostics.some((diag) => diag.type === "error") ? 1 : 0;
		}
		default:
			printError(`unknown share command: ${parsed.command}`);
			process.stdout.write(HELP);
			return 2;
	}
}

export function runExportCommand(argv: ReadonlyArray<string>): number {
	return runShareCommand(["export", ...argv]);
}

export function runImportCommand(argv: ReadonlyArray<string>): number {
	return runShareCommand(["import", ...argv]);
}
