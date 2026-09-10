/** Explicit foreign or portable package import with the same review shape as interop adopt. */

import { createInterface } from "node:readline/promises";
import { readSettings } from "../core/config.js";
import {
	applyLibraryImport,
	type LibraryImportPlan,
	libraryImportPlanSummary,
	planLibraryImport,
	releaseLibraryImport,
	renderLibraryImportPlan,
} from "../domains/interop/index.js";
import { printError } from "./shared.js";

const HELP = `clio-coder library import <path|github-tree-url> [--user|--project] [--format claude|codex] [--dry-run] [--json] [--yes]

Review and import a plugin package from a local directory or a GitHub tree URL
(https://github.com/owner/repo/tree/ref/path). A portable root plugin.json is
imported as-is (data only). A .claude-plugin/plugin.json or .codex-plugin/plugin.json
package is normalized into a portable Clio package: skills keep their text and
frontmatter names, command markdown becomes prompt recipes, Claude agents become
read-only Clio agents. Hooks, MCP, LSP, scripts and host settings are reported and
never activated. Imported packages keep foreign trust; --format disambiguates when
both hidden manifests exist. Source files are never changed.
`;

interface Parsed {
	source?: string;
	scope?: "user" | "project";
	format?: "claude-code" | "codex";
	dryRun: boolean;
	json: boolean;
	yes: boolean;
	help: boolean;
}

function parse(args: ReadonlyArray<string>): Parsed {
	const out: Parsed = { dryRun: false, json: false, yes: false, help: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--help" || arg === "-h") out.help = true;
		else if (arg === "--json") out.json = true;
		else if (arg === "--yes") out.yes = true;
		else if (arg === "--dry-run") out.dryRun = true;
		else if (arg === "--user" || arg === "--project") {
			const scope = arg === "--user" ? "user" : "project";
			if (out.scope && out.scope !== scope) throw new Error("--user and --project are mutually exclusive");
			out.scope = scope;
		} else if (arg === "--format") {
			const value = args[++i];
			const format =
				value === "claude" || value === "claude-code" ? "claude-code" : value === "codex" ? "codex" : undefined;
			if (!format) throw new Error("--format requires claude or codex");
			out.format = format;
		} else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		else if (out.source) throw new Error("library import takes exactly one path or GitHub tree URL");
		else out.source = arg;
	}
	return out;
}

export async function runLibraryImport(args: ReadonlyArray<string>): Promise<number> {
	let parsed: Parsed;
	try {
		parsed = parse(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (parsed.help || !parsed.source) {
		process.stdout.write(HELP);
		return parsed.help ? 0 : 2;
	}
	const emit = (value: unknown): void => {
		process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
	};
	let plan: LibraryImportPlan;
	try {
		plan = planLibraryImport(parsed.source, {
			cwd: process.cwd(),
			...(parsed.scope ? { scope: parsed.scope } : {}),
			...(parsed.format ? { format: parsed.format } : {}),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (parsed.json) emit({ ok: false, error: message });
		else printError(message);
		return 1;
	}
	try {
		if (!parsed.json) process.stdout.write(`${renderLibraryImportPlan(plan)}\n`);
		if (parsed.dryRun || plan.action !== "install") {
			if (parsed.json) emit({ ok: plan.action === "install", confirmed: false, plan: libraryImportPlanSummary(plan) });
			return plan.action === "install" ? 0 : 1;
		}
		let yes = parsed.yes;
		if (!yes && !parsed.json && process.stdin.isTTY && process.stdout.isTTY) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			try {
				yes = (await rl.question("Import this plan? [y/N] ")).trim().toLowerCase() === "y";
			} finally {
				rl.close();
			}
		}
		let trustProjectImports: boolean | undefined;
		try {
			trustProjectImports = readSettings().integrations.projectResources.trustProjectImports === true;
		} catch {
			trustProjectImports = undefined;
		}
		const summary = libraryImportPlanSummary(plan);
		const result = applyLibraryImport(plan, yes, trustProjectImports === undefined ? {} : { trustProjectImports });
		plan = { ...plan, cleanup: () => {} };
		if (parsed.json) emit({ ok: result.published, confirmed: yes, plan: summary, result });
		else {
			if (result.installed) process.stdout.write(`Installed ${result.installed} at ${result.destination}\n`);
			if (result.validation) {
				const count = result.validation.validation.resources.length;
				process.stdout.write(
					`${result.validation.valid ? "Validated" : "Validation failed for"} ${count} installed resource${count === 1 ? "" : "s"}\n`,
				);
				for (const diagnostic of result.validation.validation.diagnostics)
					process.stderr.write(
						`  [${diagnostic.code}] ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}\n`,
					);
			}
			process.stdout.write(
				`Trust: foreign; trust gate ${result.admission.gate} is ${
					result.admission.gateEnabled === "unknown" ? "unread" : result.admission.gateEnabled ? "enabled" : "disabled"
				}; runtime availability is reported by the library inventory\n`,
			);
			for (const diagnostic of result.diagnostics) process.stderr.write(`${diagnostic}\n`);
		}
		return result.published && (result.validation?.valid ?? true) && result.diagnostics.length === 0 ? 0 : 1;
	} finally {
		releaseLibraryImport(plan);
	}
}
