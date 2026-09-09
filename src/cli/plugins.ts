import { existsSync } from "node:fs";
import { pluginLocalPath } from "../domains/plugins/catalog.js";
import {
	disablePlugin,
	enablePlugin,
	listInstalledPlugins,
	type PluginScope,
	readPluginManifest,
	reloadPluginResources,
} from "../domains/plugins/index.js";
import {
	classifyLibraryRequirements,
	discoverLibrary,
	installLibraryPlan,
	libraryEntryDrift,
	libraryEntryPin,
	libraryEntryRef,
	pinLibraryEntry,
	planLibraryInstall,
	planPluginUpdate,
	releaseLibraryPlan,
	removeLibraryEntry,
	resolveLibraryPlugin,
} from "../domains/resources/library.js";
import { printError, printOk } from "./shared.js";

const HELP = `clio-coder plugins <command>

Manage portable plugin bundles. Catalog installs verify the complete bundle pin.

Commands:
  clio-coder plugins list [--all] [--json] [--user|--project]
  clio-coder plugins search [query] [--json]
  clio-coder plugins inspect <path|id> [--json]
  clio-coder plugins install <path|id> [--user|--project] [--force] [--json]
  clio-coder plugins update <id> [--user|--project] [--force] [--json]
  clio-coder plugins enable <id> [--user|--project] [--json]
  clio-coder plugins disable <id> [--user|--project] [--json]
  clio-coder plugins remove <id> [--user|--project] [--json]
  clio-coder plugins pin <id> [--user|--project] [--json]
  clio-coder plugins drift [id] [--user|--project] [--json]
  clio-coder plugins reload [--json]

Install/update are explicit mutations. Use library add plugin:<id> for a preview.
`;

interface Parsed {
	command?: string;
	positional: string[];
	scope?: PluginScope;
	all: boolean;
	force: boolean;
	json: boolean;
	help: boolean;
}
function parse(argv: ReadonlyArray<string>): Parsed {
	const result: Parsed = { positional: [], all: false, force: false, json: false, help: false };
	for (const arg of argv) {
		if (!result.command && !arg.startsWith("-")) result.command = arg;
		else if (arg === "--help" || arg === "-h") result.help = true;
		else if (arg === "--all") result.all = true;
		else if (arg === "--json") result.json = true;
		else if (arg === "--force" || arg === "-f") result.force = true;
		else if (arg === "--user" || arg === "--project") {
			const scope = arg === "--user" ? "user" : "project";
			if (result.scope && result.scope !== scope) throw new Error("--user and --project are mutually exclusive");
			result.scope = scope;
		} else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		else result.positional.push(arg);
	}
	return result;
}

export async function runPluginsCommand(
	argv: ReadonlyArray<string>,
	discoveryOptions: { catalog?: string } = {},
): Promise<number> {
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		printError(String(error));
		return 2;
	}
	if (parsed.help || !parsed.command) {
		process.stdout.write(HELP);
		return parsed.help ? 0 : 2;
	}
	const options = { ...(parsed.scope ? { scope: parsed.scope } : {}), cwd: process.cwd() };
	const emit = (value: unknown): void => {
		process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
	};
	try {
		if (parsed.command === "list") {
			if (parsed.positional.length) throw new Error("plugins list takes no arguments");
			const plugins = listInstalledPlugins(process.cwd(), { ...options, all: parsed.all });
			if (parsed.json) emit({ plugins });
			else if (!plugins.length) process.stdout.write("No plugins installed. Browse with `clio-coder plugins search`.\n");
			else
				for (const plugin of plugins)
					process.stdout.write(
						`${plugin.id}\t${plugin.version}\t${plugin.scope}\t${plugin.loadable ? "active" : !plugin.enabled ? "disabled" : !plugin.effective ? "shadowed" : "unloadable"}\t${plugin.diagnostics.map((item) => item.message).join("; ")}\n`,
					);
			return 0;
		}
		if (parsed.command === "search") {
			const discovery = discoverLibrary(discoveryOptions);
			const query = parsed.positional.join(" ").toLowerCase();
			const entries = discovery.entries.filter(
				(entry) => entry.kind === "plugin" && `${entry.name} ${entry.description}`.toLowerCase().includes(query),
			);
			if (parsed.json) emit({ entries, diagnostics: discovery.diagnostics });
			else {
				for (const entry of entries) process.stdout.write(`${entry.name}\t${entry.version ?? ""}\t${entry.description}\n`);
				for (const diagnostic of discovery.diagnostics) process.stderr.write(`${diagnostic}\n`);
			}
			return 0;
		}
		if (parsed.command === "reload") {
			if (parsed.positional.length) throw new Error("plugins reload takes no arguments");
			const snapshot = reloadPluginResources(process.cwd());
			if (parsed.json) emit(snapshot);
			else printOk("plugin resources reloaded for this process; use /resources plugins reload in an active session");
			return 0;
		}
		const id = parsed.positional[0];
		if (parsed.command === "drift") {
			if (parsed.positional.length > 1) throw new Error("plugins drift accepts one ID");
			const installed = listInstalledPlugins(process.cwd(), { ...options, all: parsed.all });
			if (id && !installed.some((plugin) => plugin.id === id)) throw new Error(`plugin not installed: ${id}`);
			const results = installed
				.filter((plugin) => !id || plugin.id === id)
				.map((plugin) => ({
					id: plugin.id,
					scope: plugin.scope,
					...libraryEntryDrift({ kind: "plugin", name: plugin.id }, { ...options, scope: plugin.scope }),
				}));
			if (parsed.json) emit({ results });
			else for (const result of results) process.stdout.write(`${result.id}\t${result.scope}\t${result.status}\n`);
			return results.some((result) => result.status !== "clean") ? 1 : 0;
		}
		if (!id || parsed.positional.length !== 1) throw new Error(`plugins ${parsed.command} requires one path or ID`);
		if (parsed.command === "install" || parsed.command === "update") {
			if (parsed.command === "install") {
				const entry = resolveLibraryPlugin(id, discoveryOptions);
				const requirements = classifyLibraryRequirements(entry, discoverLibrary(discoveryOptions).entries);
				if (requirements.inactive?.length)
					throw new Error(
						`library_requirement_inactive: ${requirements.inactive.map(libraryEntryRef).join(", ")}; enable or repair these plugins explicitly`,
					);
				if (requirements.unsatisfied.length)
					throw new Error(
						`library_requirement_missing: ${requirements.unsatisfied.map(libraryEntryRef).join(", ")}; use library add plugin:${entry.name} --with-requirements --yes`,
					);
			}
			const plan =
				parsed.command === "update"
					? planPluginUpdate(id, { ...options, ...discoveryOptions, force: parsed.force })
					: planLibraryInstall(resolveLibraryPlugin(id, discoveryOptions), { ...options, force: parsed.force });
			try {
				const result = installLibraryPlan(plan);
				if (parsed.json) emit({ ok: true, id: plan.entry.name, path: plan.path, sha256: plan.sha256, ...result });
				else
					printOk(
						`${parsed.command === "update" ? "updated" : "installed"} ${plan.entry.name} at ${plan.path} (sha256 ${plan.sha256})`,
					);
				if (!parsed.json && result.recovery) process.stdout.write(`Recovery copies: ${JSON.stringify(result.recovery)}\n`);
			} finally {
				releaseLibraryPlan(plan);
			}
			return 0;
		}
		if (parsed.command === "inspect") {
			const local = pluginLocalPath(id);
			if (existsSync(local)) {
				const result = readPluginManifest(local);
				emit(result);
				return result.valid ? 0 : 1;
			}
			const installed = listInstalledPlugins(process.cwd(), { ...options, all: true })
				.filter((plugin) => plugin.id === id)
				.sort((left, right) => Number(right.scope === "project") - Number(left.scope === "project"))[0];
			if (installed) {
				emit(installed);
				return installed.valid ? 0 : 1;
			}
			const plan = planLibraryInstall(resolveLibraryPlugin(id, discoveryOptions));
			try {
				const result = readPluginManifest(plan.sourceRoot ?? plan.entry.sourceUrl);
				emit({ ...result, sha256: plan.sha256 });
				return result.valid ? 0 : 1;
			} finally {
				releaseLibraryPlan(plan);
			}
		}
		if (parsed.command === "enable" || parsed.command === "disable") {
			const result = (parsed.command === "enable" ? enablePlugin : disablePlugin)(id, options);
			const ok = !result.diagnostics.some((item) => item.type === "error");
			if (parsed.json) emit({ ok, ...result });
			else if (ok) printOk(`${parsed.command}d plugin ${id}`);
			else for (const diagnostic of result.diagnostics) printError(diagnostic.message);
			return ok ? 0 : 1;
		}
		if (parsed.command === "remove") {
			const result = removeLibraryEntry({ kind: "plugin", name: id }, options);
			if (parsed.json) emit({ ok: true, id, ...result });
			else {
				printOk(`removed plugin ${id}`);
				if (result.recovery) process.stdout.write(`Recovery copies: ${JSON.stringify(result.recovery)}\n`);
			}
			return 0;
		}
		if (parsed.command === "pin") {
			const pin = libraryEntryPin({ kind: "plugin", name: id }, options);
			if (!pin) throw new Error(`plugin not installed: ${id}`);
			const result = pinLibraryEntry(
				{ kind: "plugin", name: id, description: "", sourceUrl: pin.sourceUrl, origin: "installed" },
				options,
			);
			if (parsed.json) emit({ id, ...result });
			else process.stdout.write(`${id}\t${result.sha256}\t${result.sourceUrl}\n`);
			return 0;
		}
		throw new Error(`unknown plugins command: ${parsed.command}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (parsed.json) emit({ ok: false, error: message });
		else printError(message);
		return 1;
	}
}
