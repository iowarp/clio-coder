import { resolve } from "node:path";
import {
	disableExtension,
	discoverExtensionPackages,
	type ExtensionDiagnostic,
	type ExtensionScope,
	enableExtension,
	type InstalledExtension,
	installExtension,
	listInstalledExtensions,
	removeExtension,
} from "../domains/extensions/index.js";
import { formatColumns, printError, printOk } from "./shared.js";

const HELP = `clio extensions <command>

Manage Clio extension packages.

Commands:
  clio extensions list [--all] [--json] [--user|--project]
  clio extensions discover <path> [--json]
  clio extensions install <path> [--user|--project] [--force] [--json]
  clio extensions enable <id> [--user|--project] [--json]
  clio extensions disable <id> [--user|--project] [--json]
  clio extensions remove <id> [--user|--project] [--json]
`;

interface Parsed {
	command?: string;
	positional: string[];
	scope?: ExtensionScope;
	json: boolean;
	all: boolean;
	force: boolean;
	help: boolean;
}

function parse(argv: ReadonlyArray<string>): Parsed | null {
	const out: Parsed = { positional: [], json: false, all: false, force: false, help: false };
	for (const arg of argv) {
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
			case "-f":
				out.force = true;
				break;
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

function hasErrors(diagnostics: ReadonlyArray<ExtensionDiagnostic>): boolean {
	return diagnostics.some((diag) => diag.type === "error");
}

function printDiagnostics(diagnostics: ReadonlyArray<ExtensionDiagnostic>): void {
	for (const diag of diagnostics) {
		const detail = diag.path ? `${diag.message}: ${diag.path}` : diag.message;
		if (diag.type === "error") printError(detail);
		else process.stderr.write(`warning: ${detail}\n`);
	}
}

function resourceSummary(extension: InstalledExtension): string {
	const resources = Object.entries(extension.resources).map(([key, value]) => `${key}:${value}`);
	return resources.length > 0 ? resources.join(",") : "-";
}

function stateLabel(extension: InstalledExtension): string {
	if (!extension.enabled) return "disabled";
	if (!extension.effective) return `shadowed:${extension.overriddenBy ?? "higher"}`;
	return "active";
}

function printList(items: ReadonlyArray<InstalledExtension>): void {
	if (items.length === 0) {
		process.stdout.write("extensions: none\n");
		return;
	}
	process.stdout.write(
		`${formatColumns([
			["id", "scope", "state", "version", "resources", "description"],
			...items.map((extension) => [
				extension.id,
				extension.scope,
				stateLabel(extension),
				extension.version,
				resourceSummary(extension),
				extension.description,
			]),
		])}\n`,
	);
}

export function runExtensionsCommand(argv: ReadonlyArray<string>): number {
	const parsed = parse(argv);
	if (!parsed || parsed.help || !parsed.command) {
		process.stdout.write(HELP);
		return parsed ? 0 : 2;
	}
	const scopeOptions = { ...(parsed.scope ? { scope: parsed.scope } : {}) };
	switch (parsed.command) {
		case "list": {
			const items = listInstalledExtensions(process.cwd(), { ...scopeOptions, all: parsed.all });
			if (parsed.json) process.stdout.write(`${JSON.stringify({ extensions: items }, null, 2)}\n`);
			else printList(items);
			return 0;
		}
		case "discover": {
			const root = parsed.positional[0];
			if (!root || parsed.positional.length !== 1) {
				process.stderr.write("usage: clio extensions discover <path>\n");
				return 2;
			}
			const candidates = discoverExtensionPackages(resolve(root));
			if (parsed.json) process.stdout.write(`${JSON.stringify({ candidates }, null, 2)}\n`);
			else {
				for (const candidate of candidates) {
					const label = candidate.manifest ? `${candidate.manifest.id}@${candidate.manifest.version}` : candidate.path;
					process.stdout.write(`${candidate.valid ? "ok" : "invalid"}  ${label}  ${candidate.path}\n`);
					printDiagnostics(candidate.diagnostics);
				}
			}
			return candidates.some((candidate) => !candidate.valid) ? 1 : 0;
		}
		case "install": {
			const root = parsed.positional[0];
			if (!root || parsed.positional.length !== 1) {
				process.stderr.write("usage: clio extensions install <path> [--user|--project] [--force]\n");
				return 2;
			}
			const result = installExtension(resolve(root), { ...scopeOptions, force: parsed.force });
			if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			else {
				printDiagnostics(result.diagnostics);
				if (result.extension) printOk(`installed ${result.extension.id} (${result.extension.scope})`);
			}
			return hasErrors(result.diagnostics) ? 1 : 0;
		}
		case "enable":
		case "disable": {
			const id = parsed.positional[0];
			if (!id || parsed.positional.length !== 1) {
				process.stderr.write(`usage: clio extensions ${parsed.command} <id> [--user|--project]\n`);
				return 2;
			}
			const result = parsed.command === "enable" ? enableExtension(id, scopeOptions) : disableExtension(id, scopeOptions);
			if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			else {
				printDiagnostics(result.diagnostics);
				if (result.extension) printOk(`${parsed.command}d ${result.extension.id} (${result.extension.scope})`);
			}
			return hasErrors(result.diagnostics) ? 1 : 0;
		}
		case "remove": {
			const id = parsed.positional[0];
			if (!id || parsed.positional.length !== 1) {
				process.stderr.write("usage: clio extensions remove <id> [--user|--project]\n");
				return 2;
			}
			const result = removeExtension(id, scopeOptions);
			if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			else {
				printDiagnostics(result.diagnostics);
				if (result.removed) printOk(`removed ${result.removed.id} (${result.removed.scope})`);
			}
			return hasErrors(result.diagnostics) ? 1 : 0;
		}
		default:
			printError(`unknown extensions command: ${parsed.command}`);
			process.stdout.write(HELP);
			return 2;
	}
}
