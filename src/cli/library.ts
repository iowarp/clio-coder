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
	confirmLibraryRemote,
	discoverLibrary,
	installLibraryPlan,
	libraryEntryDrift,
	libraryEntryRef,
	libraryWorkspace,
	pinLibraryEntry,
	planLibraryInstall,
	planLibraryUpdate,
	registerLibraryPackage,
	releaseLibraryPlan,
	removeLibraryEntry,
	resolveInstalledLibraryEntry,
	resolveLibraryPackage,
	syncLibrary,
} from "../domains/resources/library.js";
import { isLibraryKind, type LibraryEntryKind } from "../domains/resources/library-types.js";
import { printError, printOk } from "./shared.js";

const HELP = `clio-coder library <command>

One library of packages: plugin, skill, agent, prompt, fleet.

Commands:
  clio-coder library list [--kind <kind>] [--user|--project] [--json]
  clio-coder library search [query] [--kind <kind>] [--json]
  clio-coder library register <path> [--user|--project] [--force] [--json]
  clio-coder library inspect <path|kind:name|name> [--user|--project] [--json]
  clio-coder library install <path|kind:name|name> [--user|--project] [--force] [--with-requirements] [--dry-run] [--json]
  clio-coder library update <kind:name|name> [--user|--project] [--force] [--json]
  clio-coder library enable <kind:name|name> [--user|--project] [--json]
  clio-coder library disable <kind:name|name> [--user|--project] [--json]
  clio-coder library remove <kind:name|name> [--user|--project] [--json]
  clio-coder library pin <kind:name|name> [--user|--project] [--json]
  clio-coder library drift [kind:name|name] [--user|--project] [--json]
  clio-coder library reload [--json]
  clio-coder library skills [--all] [--json]
  clio-coder library inventory --json
  clio-coder library validate <package-path|SKILL.md> [--json]
  clio-coder library sync
  clio-coder library push
  clio-coder library remote confirm <url>

Install and register default to user scope. Other mutations select the project
copy when present; an explicit scope selects exactly that copy. List includes
both scopes and all installed states. --from <index.yaml> selects an index.
Skills lists discovered runtime skills, including unmanaged local files.
Inventory is the fixed, body-free skill read for GUI hosts.
Package evals run with clio-coder eval run --package <kind:name> --eval <name>.
`;
interface Parsed {
	command?: string;
	positional: string[];
	scope?: PluginScope;
	kind?: LibraryEntryKind;
	from?: string;
	all: boolean;
	force: boolean;
	json: boolean;
	help: boolean;
	dryRun: boolean;
	withRequirements: boolean;
}
function parse(args: ReadonlyArray<string>): Parsed {
	const out: Parsed = {
		positional: [],
		all: false,
		force: false,
		json: false,
		help: false,
		dryRun: false,
		withRequirements: false,
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;
		if (!out.command && !arg.startsWith("-")) out.command = arg;
		else if (arg === "--help" || arg === "-h") out.help = true;
		else if (arg === "--json") out.json = true;
		else if (arg === "--all") out.all = true;
		else if (arg === "--force" || arg === "-f") out.force = true;
		else if (arg === "--dry-run") out.dryRun = true;
		else if (arg === "--with-requirements") out.withRequirements = true;
		else if (arg === "--kind") {
			const value = args[++i];
			if (!isLibraryKind(value)) throw new Error("--kind requires plugin, skill, agent, prompt, or fleet");
			out.kind = value;
		} else if (arg === "--from") {
			const value = args[++i];
			if (!value || value.startsWith("-")) throw new Error("--from requires an index path");
			out.from = value;
		} else if (arg === "--user" || arg === "--project") {
			const scope = arg === "--user" ? "user" : "project";
			if (out.scope && out.scope !== scope) throw new Error("--user and --project are mutually exclusive");
			out.scope = scope;
		} else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		else out.positional.push(arg);
	}
	return out;
}
export async function runLibraryCommand(
	args: ReadonlyArray<string>,
	discoveryOptions: { catalog?: string } = {},
): Promise<number> {
	if (args[0] === "inventory") return (await import("./skills-inventory.js")).runSkillsInventory(args.slice(1));
	let parsed: Parsed;
	try {
		parsed = parse(args);
	} catch (error) {
		printError(String(error));
		return 2;
	}
	if (parsed.help || !parsed.command) {
		process.stdout.write(HELP);
		return parsed.help ? 0 : 2;
	}
	const options = {
		cwd: process.cwd(),
		...(parsed.scope ? { scope: parsed.scope } : {}),
		...discoveryOptions,
		...(parsed.from ? { catalog: parsed.from } : {}),
	};
	const emit = (value: unknown): void => {
		process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
	};
	try {
		if (parsed.dryRun && parsed.command !== "install" && parsed.command !== "update")
			throw new Error("--dry-run is supported only for library install and update");
		if (parsed.command === "skills") {
			if (parsed.positional.length) throw new Error("library skills takes no arguments");
			return (await import("./skills.js")).runSkillsRead([
				"list",
				...(parsed.all ? ["--all"] : []),
				...(parsed.json ? ["--json"] : []),
			]);
		}
		if (parsed.command === "list" || parsed.command === "search") {
			if (parsed.command === "list" && parsed.positional.length) throw new Error("library list takes no arguments");
			const discovery = libraryWorkspace(options);
			const query = parsed.positional.join(" ").toLowerCase();
			const entries = discovery.entries.filter(
				(entry) =>
					(!parsed.kind || entry.kind === parsed.kind) &&
					(!query || `${entry.name} ${entry.description}`.toLowerCase().includes(query)),
			);
			if (parsed.json) emit({ entries, diagnostics: discovery.diagnostics });
			else {
				for (const entry of entries) {
					const states =
						entry.installed
							.map(
								(item) =>
									`${item.scope}:${item.loadable ? "active" : !item.enabled ? "disabled" : !item.effective ? "shadowed" : "unloadable"}`,
							)
							.join(", ") || "available";
					process.stdout.write(`${libraryEntryRef(entry)}\t${entry.version ?? ""}\t${states}\t${entry.description}\n`);
				}
				for (const diagnostic of discovery.diagnostics) process.stderr.write(`${diagnostic}\n`);
			}
			return 0;
		}
		if (parsed.command === "reload") {
			if (parsed.positional.length) throw new Error("library reload takes no arguments");
			const snapshot = reloadPluginResources(options.cwd);
			if (parsed.json) emit(snapshot);
			else printOk("library refreshed for this process; use /library reload in an active session");
			return 0;
		}
		if (parsed.command === "sync" || parsed.command === "push") {
			if (parsed.positional.length) throw new Error(`library ${parsed.command} takes no arguments`);
			await syncLibrary(parsed.command);
			printOk(`library ${parsed.command} complete`);
			return 0;
		}
		if (parsed.command === "remote") {
			if (parsed.positional.length !== 2 || parsed.positional[0] !== "confirm")
				throw new Error("library remote confirm requires a URL");
			confirmLibraryRemote(parsed.positional[1] as string);
			printOk("confirmed library remote");
			return 0;
		}
		const ref = parsed.positional[0];
		if (parsed.command === "drift" && !ref) {
			const results = listInstalledPlugins(options.cwd, { ...options, all: true }).map((item) => ({
				id: item.id,
				kind: item.kind ?? "plugin",
				scope: item.scope,
				...libraryEntryDrift({ kind: item.kind ?? "plugin", name: item.id }, { ...options, scope: item.scope }),
			}));
			emit({ results });
			return results.some((item) => item.status !== "clean") ? 1 : 0;
		}
		if (!ref || parsed.positional.length !== 1)
			throw new Error(`library ${parsed.command} requires one path or package reference`);
		if (parsed.command === "register") {
			const entry = registerLibraryPackage(ref, { ...options, force: parsed.force });
			emit({ ok: true, entry });
			return 0;
		}
		if (parsed.command === "validate" || parsed.command === "inspect") {
			const local = pluginLocalPath(ref);
			if (existsSync(local)) {
				if (parsed.command === "validate" && local.endsWith("SKILL.md"))
					return (await import("./skills.js")).runSkillsRead(["validate", local, ...(parsed.json ? ["--json"] : [])]);
				const candidate = readPluginManifest(local);
				emit(candidate);
				return candidate.valid ? 0 : 1;
			}
			const copies = listInstalledPlugins(options.cwd, { ...options, all: true })
				.filter((item) => (ref.includes(":") ? `${item.kind ?? "plugin"}:${item.id}` === ref : item.id === ref))
				.sort((a, b) => Number(b.scope === "project") - Number(a.scope === "project"));
			const installed = copies[0];
			if (installed) {
				emit(installed);
				return installed.valid ? 0 : 1;
			}
			const plan = planLibraryInstall(resolveLibraryPackage(ref, options), options);
			try {
				const candidate = readPluginManifest(plan.sourceRoot as string);
				emit(candidate);
				return candidate.valid ? 0 : 1;
			} finally {
				releaseLibraryPlan(plan);
			}
		}
		if (parsed.command === "install" || parsed.command === "update") {
			const entry =
				parsed.command === "update" ? resolveInstalledLibraryEntry(ref, options) : resolveLibraryPackage(ref, options);
			const requirements = classifyLibraryRequirements(entry, discoverLibrary(options).entries, options);
			if (requirements.inactive?.length)
				throw new Error(
					`library_requirement_inactive: ${requirements.inactive.map(libraryEntryRef).join(", ")}; enable or repair those packages first`,
				);
			if (requirements.unsatisfied.length && !parsed.withRequirements)
				throw new Error(
					`library_requirement_missing: ${requirements.unsatisfied.map(libraryEntryRef).join(", ")}; use --with-requirements`,
				);
			const plans = [];
			try {
				for (const dependency of requirements.unsatisfied) plans.push(planLibraryInstall(dependency, options));
				plans.push(
					parsed.command === "update"
						? planLibraryUpdate(ref, { ...options, force: parsed.force })
						: planLibraryInstall(entry, { ...options, force: parsed.force }),
				);
				const writes = plans.map((plan) => ({
					ref: libraryEntryRef(plan.entry),
					path: plan.path,
					sha256: plan.sha256,
					sourceUrl: plan.entry.sourceUrl,
				}));
				const results = parsed.dryRun ? [] : plans.map(installLibraryPlan);
				if (parsed.json)
					emit({
						ok: true,
						confirmed: !parsed.dryRun,
						writes,
						results,
						...(results.at(-1)?.recovery ? { recovery: results.at(-1)?.recovery } : {}),
						id: entry.name,
						path: plans.at(-1)?.path,
						sha256: plans.at(-1)?.sha256,
					});
				else
					for (const write of writes)
						printOk(
							`${parsed.dryRun ? "planned" : parsed.command === "update" ? "updated" : "installed"} ${write.ref} at ${write.path} (sha256 ${write.sha256})`,
						);
			} finally {
				for (const plan of plans) releaseLibraryPlan(plan);
			}
			return 0;
		}
		const entry = resolveInstalledLibraryEntry(ref, options);
		const scoped = { ...options, scope: entry.scope };
		if (parsed.command === "remove") {
			const result = removeLibraryEntry(entry, scoped);
			emit({ ok: true, removed: libraryEntryRef(entry), ...result });
			return 0;
		}
		if (parsed.command === "pin") {
			emit({ id: entry.name, ...pinLibraryEntry(entry, scoped) });
			return 0;
		}
		if (parsed.command === "drift") {
			const result = libraryEntryDrift(entry, scoped);
			emit(result);
			return result.status === "clean" ? 0 : 1;
		}
		if (parsed.command === "enable" || parsed.command === "disable") {
			const result = (parsed.command === "enable" ? enablePlugin : disablePlugin)(entry.name, scoped);
			const ok = !result.diagnostics.some((item) => item.type === "error");
			emit({ ok, ...result });
			return ok ? 0 : 1;
		}
		throw new Error(`unknown library command: ${parsed.command}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (parsed.json) emit({ ok: false, error: message });
		else printError(message);
		return 1;
	}
}
