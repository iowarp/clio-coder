import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pluginLocalPath } from "../domains/plugins/catalog.js";
import {
	listInstalledPlugins,
	type PluginScope,
	readPluginManifest,
	reloadPluginResources,
} from "../domains/plugins/index.js";
import {
	confirmLibraryRemote,
	libraryEntryDrift,
	libraryEntryRef,
	libraryWorkspace,
	pinLibraryEntry,
	planLibraryInstall,
	registerLibraryPackage,
	releaseLibraryPlan,
	resolveInstalledLibraryEntry,
	resolveLibraryPackage,
	syncLibrary,
} from "../domains/resources/library.js";
import {
	applyLibraryLifecycle,
	type LibraryApplyResult,
	type LibraryLifecyclePlan,
	type LibraryOperation,
	planLibraryLifecycle,
} from "../domains/resources/library-actions.js";
import {
	inspectLibraryCopy,
	type LibraryOrigin,
	type LibraryResourceSourceClass,
	readLibraryInventory,
} from "../domains/resources/library-inventory.js";
import { isLibraryKind, isLibraryResourceKind, type LibraryEntryKind } from "../domains/resources/library-types.js";
import { printError, printOk } from "./shared.js";

const HELP = `clio-coder library <command>

One library of packages: plugin, skill, agent, prompt, fleet.

Commands:
  clio-coder library list [--kind <kind>] [--user|--project] [--json]
  clio-coder library search [query] [--kind <kind>] [--json]
  clio-coder library recipes [query] [--kind skill|agent|prompt|fleet] [--source core|package|user|project|compat] [--all] [--json]
  clio-coder library register <path> [--user|--project] [--force] [--json]
  clio-coder library inspect <path|kind:name|name> [--user|--project] [--json]
  clio-coder library install <path|kind:name|name> [--user|--project] [--force] [--with-requirements] [--dry-run] [--json]
  clio-coder library import <path|github-tree-url> [--user|--project] [--format claude|codex] [--dry-run] [--json] [--yes]
  clio-coder library update <kind:name|name> [--user|--project] [--force] [--dry-run] [--json]
  clio-coder library enable <kind:name|name> [--user|--project] [--dry-run] [--json]
  clio-coder library disable <kind:name|name> [--user|--project] [--dry-run] [--json]
  clio-coder library remove <kind:name|name> [--user|--project] [--dry-run] [--json]
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
Every mutation builds one reviewed plan, rechecks it inside the package lock,
refuses to break enabled dependents, and reports per-package outcomes with disk,
recipe-admission and host-refresh facts separately; --dry-run prints the plan
and writes nothing. A CLI never refreshes a running session.
Import reviews a portable, Claude Code or Codex plugin from a path or GitHub
tree URL, normalizes supported recipes into a foreign-trust package, and never
activates hooks, MCP, LSP or scripts.
List and search are package-oriented; --kind and a query also match the
recipes a bundle provides, returning the owning package as the install target.
Recipes is the versioned, body-free read of actual discovered recipes across
core, installed packages and loose user/project files, with owner, origin,
availability and invocation; --all adds internal diagnostic agents. Nothing in
these reads fetches a remote source or activates a recipe.
Skills lists discovered runtime skills, including unmanaged local files.
Inventory is the fixed, body-free skill read for GUI hosts.
Package evals run with clio-coder eval run --package <kind:name> --eval <name>.
`;
/** One short operator label per origin; details stay in the JSON record. */
function originLabel(origin: LibraryOrigin): string {
	switch (origin.kind) {
		case "bundled":
			return "bundled";
		case "remote":
			return `remote ${origin.url}`;
		case "local":
			return origin.host ? `local (${origin.host}) ${origin.path}` : `local ${origin.path}`;
		case "imported":
			return `imported from ${origin.agent}${origin.marketplace ? ` (${origin.marketplace})` : ""} ${origin.path}`;
		case "core":
			return "core";
		default:
			return origin.detail ? `unknown: ${origin.detail}` : "unknown";
	}
}

interface Parsed {
	command?: string;
	positional: string[];
	scope?: PluginScope;
	kind?: LibraryEntryKind;
	source?: LibraryResourceSourceClass;
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
		} else if (arg === "--source") {
			const value = args[++i];
			if (!value || !["core", "package", "user", "project", "compat"].includes(value))
				throw new Error("--source requires core, package, user, project, or compat");
			out.source = value as LibraryResourceSourceClass;
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
const LIFECYCLE: ReadonlyArray<LibraryOperation> = ["install", "update", "enable", "disable", "remove"];

function verb(operation: LibraryOperation): string {
	return operation === "install" ? "installed" : operation === "update" ? "updated" : `${operation}d`;
}

/** Existing JSON fields stay where old callers expect them; plan and apply are additive. */
function lifecycleJson(
	operation: LibraryOperation,
	plan: LibraryLifecyclePlan,
	apply: LibraryApplyResult,
	ok: boolean,
) {
	const target = plan.steps.at(-1);
	const last = apply.outcomes.at(-1);
	const failure = apply.outcomes.find((item) => item.status === "failed" && item.error);
	const base = { ok, ...(failure ? { error: failure.error?.message } : {}), plan, apply };
	if (operation === "install" || operation === "update")
		return {
			...base,
			confirmed: !apply.dryRun && ok,
			writes: plan.steps.map((step) => ({
				ref: step.identity.ref,
				path: step.destination,
				...(step.source ? { sha256: step.source.sha256, sourceUrl: step.source.sourceUrl } : {}),
			})),
			results: apply.outcomes
				.filter((item) => item.status === "committed")
				.map((item) => (item.recovery ? { recovery: item.recovery } : {})),
			...(last?.recovery ? { recovery: last.recovery } : {}),
			id: target?.identity.name,
			path: target?.destination,
			...(target?.source ? { sha256: target.source.sha256 } : {}),
		};
	if (operation === "remove")
		return {
			...base,
			...(last?.status === "committed" ? { removed: last.identity.ref } : {}),
			...(last?.recovery ? { recovery: last.recovery } : {}),
		};
	const plugin =
		last?.status === "committed"
			? listInstalledPlugins(plan.cwd, { scope: last.identity.scope, all: true }).find(
					(item) => item.id === last.identity.name,
				)
			: undefined;
	return { ...base, ...(plugin ? { plugin } : {}), diagnostics: last?.diagnostics ?? [] };
}

export async function runLibraryCommand(
	args: ReadonlyArray<string>,
	discoveryOptions: { catalog?: string } = {},
): Promise<number> {
	if (args[0] === "inventory") return (await import("./skills-inventory.js")).runSkillsInventory(args.slice(1));
	if (args[0] === "import") return (await import("./library-import.js")).runLibraryImport(args.slice(1));
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
		if (parsed.dryRun && !LIFECYCLE.includes(parsed.command as LibraryOperation))
			throw new Error("--dry-run is supported only for library install, update, enable, disable and remove");
		if (parsed.command === "skills") {
			if (parsed.positional.length) throw new Error("library skills takes no arguments");
			return (await import("./skills.js")).runSkillsRead([
				"list",
				...(parsed.all ? ["--all"] : []),
				...(parsed.json ? ["--json"] : []),
			]);
		}
		if (parsed.command === "recipes") {
			if (parsed.kind && !isLibraryResourceKind(parsed.kind))
				throw new Error("library recipes --kind requires skill, agent, prompt, or fleet");
			const inventory = readLibraryInventory({
				cwd: options.cwd,
				include: { packages: false, copies: false },
				...(parsed.kind ? { kinds: [parsed.kind] } : {}),
				...(parsed.source ? { sources: [parsed.source] } : {}),
				...(parsed.positional.length ? { query: parsed.positional.join(" ") } : {}),
				all: parsed.all,
			});
			if (parsed.json) {
				const { packages: _packages, copies: _copies, ...rest } = inventory;
				emit(rest);
			} else {
				for (const resource of inventory.resources) {
					const owner = resource.owner ? `${resource.owner.ref}@${resource.owner.scope}` : resource.source.class;
					process.stdout.write(
						`${resource.kind}\t${resource.name}\t${owner}\t${originLabel(resource.origin)}\t${resource.availability}\t${resource.invocation ?? ""}\n`,
					);
				}
				if (inventory.truncated.resources) process.stderr.write("recipe list truncated; narrow with --kind or a query\n");
				for (const diagnostic of inventory.diagnostics) process.stderr.write(`${diagnostic}\n`);
			}
			return 0;
		}
		if (parsed.command === "list" || parsed.command === "search") {
			if (parsed.command === "list" && parsed.positional.length) throw new Error("library list takes no arguments");
			if (parsed.source) throw new Error("--source applies to library recipes");
			const discovery = libraryWorkspace(options);
			const query = parsed.positional.join(" ");
			const inventory = readLibraryInventory({
				cwd: options.cwd,
				...(options.catalog ? { catalog: options.catalog } : {}),
				include: { resources: false },
				...(parsed.kind ? { kinds: [parsed.kind] } : {}),
				...(query ? { query } : {}),
			});
			const selected = new Map(inventory.packages.map((record) => [record.ref, record]));
			const entries = discovery.entries.flatMap((entry) => {
				const record = selected.get(libraryEntryRef(entry));
				return record
					? [
							{
								...entry,
								provenance: record.origin,
								...(record.format ? { format: record.format } : {}),
								...(record.provides ? { provides: record.provides } : {}),
							},
						]
					: [];
			});
			if (parsed.json) emit({ entries, diagnostics: discovery.diagnostics });
			else {
				for (const entry of entries) {
					const states =
						entry.installed
							.map(
								(item) =>
									`${item.scope}:${item.loadable ? "loadable" : !item.enabled ? "disabled" : !item.effective ? "shadowed" : "unloadable"}`,
							)
							.join(", ") || "available";
					process.stdout.write(
						`${libraryEntryRef(entry)}\t${entry.version ?? ""}\t${states}\t${originLabel(entry.provenance)}\t${entry.description}\n`,
					);
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
		if (parsed.command === "validate") {
			const local = pluginLocalPath(ref);
			if (local.endsWith("SKILL.md"))
				return (await import("./skills.js")).runSkillsRead(["validate", local, ...(parsed.json ? ["--json"] : [])]);
			const packageRoot = existsSync(local) && statSync(local).isFile() ? path.dirname(local) : local;
			const { validateLibraryPackage } = await import("../domains/resources/library-validation.js");
			const result = validateLibraryPackage(packageRoot, options);
			if (parsed.json) emit(result);
			else {
				const name = result.manifest?.name ?? path.basename(packageRoot);
				if (result.valid) {
					const count = result.validation.resources.length;
					printOk(`package ${name} is valid (${count} resource${count === 1 ? "" : "s"} checked)`);
				} else {
					if (!result.manifestValid) {
						printError(`package ${name} manifest is invalid`);
						for (const diag of result.diagnostics) {
							process.stderr.write(`  [manifest] ${diag.message}${diag.path ? ` (${diag.path})` : ""}\n`);
						}
					}
					if (!result.validation.contentValid) {
						printError(`package ${name} authored content is invalid`);
						for (const diag of result.validation.diagnostics) {
							process.stderr.write(`  [${diag.code}] ${diag.message}${diag.path ? ` (${diag.path})` : ""}\n`);
						}
					}
				}
			}
			return result.valid ? 0 : 1;
		}
		if (parsed.command === "inspect") {
			const local = pluginLocalPath(ref);
			if (existsSync(local)) {
				const candidate = readPluginManifest(local);
				emit(candidate);
				return candidate.valid ? 0 : 1;
			}
			// Precedence is a cross-scope fact: list both scopes first, then narrow
			// to the requested scope, so a user copy shadowed by a project copy never
			// reads as effective.
			const copies = listInstalledPlugins(options.cwd, { all: true })
				.filter((item) => !parsed.scope || item.scope === parsed.scope)
				.filter((item) => (ref.includes(":") ? `${item.kind ?? "plugin"}:${item.id}` === ref : item.id === ref))
				.sort((a, b) => Number(b.scope === "project") - Number(a.scope === "project"));
			const installed = copies[0];
			if (installed) {
				// Existing fields stay as they are; `library` is the additive deeper read.
				emit({ ...installed, library: inspectLibraryCopy(ref, { ...options, scope: installed.scope }) });
				return installed.valid ? 0 : 1;
			}
			const entry = resolveLibraryPackage(ref, options);
			const record = readLibraryInventory({
				cwd: options.cwd,
				...(options.catalog ? { catalog: options.catalog } : {}),
				include: { resources: false, copies: false },
				ref: libraryEntryRef(entry),
			}).packages[0];
			const plan = planLibraryInstall(entry, options);
			try {
				const candidate = readPluginManifest(plan.sourceRoot as string);
				emit({
					...candidate,
					...(record
						? {
								library: {
									origin: record.origin,
									...(record.format ? { format: record.format } : {}),
									...(record.provides ? { provides: record.provides } : {}),
								},
							}
						: {}),
				});
				return candidate.valid ? 0 : 1;
			} finally {
				releaseLibraryPlan(plan);
			}
		}
		if (LIFECYCLE.includes(parsed.command as LibraryOperation)) {
			const operation = parsed.command as LibraryOperation;
			const plan = planLibraryLifecycle({
				operation,
				ref,
				cwd: options.cwd,
				...(parsed.scope ? { scope: parsed.scope } : {}),
				...(options.catalog ? { catalog: options.catalog } : {}),
				force: parsed.force,
				withRequirements: parsed.withRequirements,
			});
			const apply = applyLibraryLifecycle(plan, { dryRun: parsed.dryRun });
			const ok = apply.failed === 0 && (apply.dryRun || plan.applicable);
			if (parsed.json) emit(lifecycleJson(operation, plan, apply, ok));
			else {
				for (const outcome of apply.outcomes) {
					const step = plan.steps.find(
						(item) => item.identity.ref === outcome.identity.ref && item.identity.scope === outcome.identity.scope,
					);
					const where = `${outcome.identity.ref} (${outcome.identity.scope})`;
					if (outcome.status === "committed")
						printOk(
							`${verb(operation)} ${where}${step?.source ? ` at ${step.destination} (sha256 ${step.source.sha256})` : ""}${
								outcome.recovery?.packageBackup ? `; recovery ${outcome.recovery.packageBackup}` : ""
							}${outcome.error ? `; verification: ${outcome.error.message}` : ""}`,
						);
					else if (outcome.status === "unattempted")
						process.stdout.write(
							`${parsed.dryRun ? "planned" : "unattempted"} ${operation} ${where}${step?.refusal ? `: ${step.refusal}` : ""}\n`,
						);
					else
						printError(`${operation} ${where} failed: ${outcome.error?.message ?? "unknown"}; ${outcome.error?.next ?? ""}`);
				}
				if (apply.committed)
					process.stderr.write(
						`refresh: ${apply.refresh.status}${"reason" in apply.refresh ? ` (${apply.refresh.reason})` : ""}\n`,
					);
			}
			return ok ? 0 : 1;
		}
		const entry = resolveInstalledLibraryEntry(ref, options);
		const scoped = { ...options, scope: entry.scope };
		if (parsed.command === "pin") {
			emit({ id: entry.name, ...pinLibraryEntry(entry, scoped) });
			return 0;
		}
		if (parsed.command === "drift") {
			const result = libraryEntryDrift(entry, scoped);
			emit(result);
			return result.status === "clean" ? 0 : 1;
		}
		throw new Error(`unknown library command: ${parsed.command}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (parsed.json) emit({ ok: false, error: message });
		else printError(message);
		return 1;
	}
}
