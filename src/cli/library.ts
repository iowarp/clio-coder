import {
	classifyLibraryRequirements,
	confirmLibraryRemote,
	discoverLibrary,
	installLibraryPlan,
	type LibraryEntry,
	type LibraryEntryKind,
	libraryEntryDrift,
	libraryEntryInstalled,
	libraryEntryRef,
	libraryInstallPath,
	pinLibraryEntry,
	planLibraryInstall,
	releaseLibraryPlan,
	removeLibraryEntry,
	syncLibrary,
} from "../domains/resources/index.js";
import { runPluginsCommand } from "./plugins.js";
import { printError, printOk } from "./shared.js";

const KINDS = new Set<LibraryEntryKind>(["skill", "agent", "prompt", "fleet", "plugin"]);
const HELP = `clio-coder library <command>

Commands:
  clio-coder library list [--kind <kind>] [--json]
  clio-coder library search <query> [--kind <kind>] [--json]
  clio-coder library add <ref> [--from <catalog|path>] [--with-requirements] [--yes] [--json]
  clio-coder library update <ref> [--force] [--json]
  clio-coder library remove <ref> [--json]
  clio-coder library pin <ref> [--json]
  clio-coder library drift <ref> [--json]
  clio-coder library use <kind> <name>
  clio-coder library sync
  clio-coder library push
  clio-coder library remote confirm <url>
`;

interface Parsed {
	command?: string;
	positional: string[];
	kind?: LibraryEntryKind;
	from?: string;
	json: boolean;
	yes: boolean;
	withRequirements: boolean;
	help: boolean;
	force: boolean;
}

function parse(argv: ReadonlyArray<string>): Parsed {
	const out: Parsed = { positional: [], json: false, yes: false, withRequirements: false, help: false, force: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg) continue;
		if (!out.command && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		if (arg === "--json") out.json = true;
		else if (arg === "--force") out.force = true;
		else if (arg === "--yes") out.yes = true;
		else if (arg === "--with-requirements") out.withRequirements = true;
		else if (arg === "--help" || arg === "-h") out.help = true;
		else if (arg === "--kind") {
			const value = argv[++i];
			if (!value || !KINDS.has(value as LibraryEntryKind))
				throw new Error("--kind requires skill, agent, prompt, fleet, or plugin");
			out.kind = value as LibraryEntryKind;
		} else if (arg === "--from") {
			const value = argv[++i];
			if (!value) throw new Error("--from requires a value");
			out.from = value;
		} else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		else out.positional.push(arg);
	}
	return out;
}

function selectEntry(entries: ReadonlyArray<LibraryEntry>, ref: string): LibraryEntry {
	const matches = ref.includes(":")
		? entries.filter((entry) => libraryEntryRef(entry) === ref)
		: entries.filter((entry) => entry.name === ref);
	if (matches.length === 0) throw new Error(`library entry not found: ${ref}`);
	if (matches.length > 1)
		throw new Error(`library entry is ambiguous; use a typed reference: ${matches.map(libraryEntryRef).join(", ")}`);
	return matches[0] as LibraryEntry;
}

function filtered(entries: ReadonlyArray<LibraryEntry>, kind?: LibraryEntryKind): LibraryEntry[] {
	return entries.filter((entry) => kind === undefined || entry.kind === kind);
}

export async function runLibraryCommand(argv: ReadonlyArray<string>): Promise<number> {
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (!parsed.command || parsed.help) {
		process.stdout.write(HELP);
		return parsed.help ? 0 : 2;
	}
	try {
		if (parsed.command === "list" || parsed.command === "search") {
			const discovery = discoverLibrary();
			const query = parsed.command === "search" ? parsed.positional.join(" ").trim().toLowerCase() : "";
			if (parsed.command === "search" && !query) throw new Error("library search requires a query");
			const entries = filtered(discovery.entries, parsed.kind).filter(
				(entry) => !query || entry.name.toLowerCase().includes(query) || entry.description.toLowerCase().includes(query),
			);
			if (parsed.json)
				process.stdout.write(
					`${JSON.stringify({ entries: entries.map((entry) => ({ ...entry, installed: libraryEntryInstalled(entry) })), diagnostics: discovery.diagnostics }, null, 2)}\n`,
				);
			else
				for (const entry of entries) process.stdout.write(`${libraryEntryRef(entry).padEnd(28)} ${entry.description}\n`);
			return 0;
		}
		if (parsed.command === "add") {
			const ref = parsed.positional[0];
			if (!ref || parsed.positional.length !== 1) throw new Error("library add requires one reference");
			const catalog = parsed.from && parsed.from !== "catalog" ? parsed.from : undefined;
			const discovery = discoverLibrary(catalog ? { catalog } : {});
			let entry: LibraryEntry;
			try {
				entry = selectEntry(discovery.entries, ref);
			} catch (error) {
				const refusal = ref.includes(":")
					? discovery.refusals[ref]
					: Object.entries(discovery.refusals).find(([key]) => key.endsWith(`:${ref}`))?.[1];
				if (refusal) throw new Error(refusal);
				throw error;
			}
			const requirements = classifyLibraryRequirements(entry, discovery.entries);
			if (requirements.inactive?.length)
				throw new Error(
					`library_requirement_inactive: ${requirements.inactive.map(libraryEntryRef).join(", ")}; enable or repair these plugins explicitly`,
				);
			if (requirements.unsatisfied.length > 0 && !parsed.withRequirements) {
				const refs = requirements.unsatisfied.map(libraryEntryRef);
				if (parsed.json)
					process.stdout.write(
						`${JSON.stringify({ ok: false, entry: libraryEntryRef(entry), satisfiedRequirements: requirements.satisfied.map(libraryEntryRef), unresolvedRequirements: refs }, null, 2)}\n`,
					);
				else
					process.stderr.write(
						`satisfied requirements: ${requirements.satisfied.length > 0 ? requirements.satisfied.map(libraryEntryRef).join(", ") : "none"}\nunresolved requirements: ${refs.join(", ")}\npass --with-requirements to install them in dependency order\n`,
					);
				return 1;
			}
			const plans = [];
			try {
				for (const item of [...(parsed.withRequirements ? requirements.unsatisfied : []), entry])
					plans.push(planLibraryInstall(item));
				if (!parsed.json) {
					process.stdout.write("library add plan:\n");
					process.stdout.write(
						`  satisfied requirements: ${requirements.satisfied.length > 0 ? requirements.satisfied.map(libraryEntryRef).join(", ") : "none"}\n`,
					);
					for (const plan of plans)
						process.stdout.write(`  ${libraryEntryRef(plan.entry)} -> ${plan.path} sha256 ${plan.sha256}\n`);
				}
				if (parsed.yes) for (const plan of plans) installLibraryPlan(plan);
				if (parsed.json)
					process.stdout.write(
						`${JSON.stringify({ ok: true, confirmed: parsed.yes, satisfiedRequirements: requirements.satisfied.map(libraryEntryRef), writes: plans.map((plan) => ({ ref: libraryEntryRef(plan.entry), path: plan.path, sha256: plan.sha256 })) }, null, 2)}\n`,
					);
				else if (parsed.yes) printOk(`installed ${plans.length} library entry or entries`);
				return 0;
			} finally {
				for (const plan of plans) releaseLibraryPlan(plan);
			}
		}
		if (["update", "remove", "pin", "drift"].includes(parsed.command)) {
			const ref = parsed.positional[0];
			if (!ref || parsed.positional.length !== 1) throw new Error(`library ${parsed.command} requires one reference`);
			const discovery = discoverLibrary(parsed.from && parsed.from !== "catalog" ? { catalog: parsed.from } : {});
			const entry = selectEntry(discovery.entries, ref);
			if (entry.kind === "plugin")
				return runPluginsCommand(
					[parsed.command, entry.name, ...(parsed.force ? ["--force"] : []), ...(parsed.json ? ["--json"] : [])],
					parsed.from && parsed.from !== "catalog" ? { catalog: parsed.from } : {},
				);
			let result: unknown;
			if (parsed.command === "remove") {
				removeLibraryEntry(entry);
				result = { ok: true, removed: libraryEntryRef(entry) };
			} else if (parsed.command === "pin") result = pinLibraryEntry(entry);
			else if (parsed.command === "drift") {
				const drift = libraryEntryDrift(entry);
				process.stdout.write(
					`${parsed.json ? JSON.stringify(drift, null, 2) : `${libraryEntryRef(entry)}: ${drift.status}`}\n`,
				);
				return drift.status === "clean" ? 0 : 1;
			} else {
				const drift = libraryEntryDrift(entry);
				if (drift.status === "missing") throw new Error(`library entry is not installed: ${libraryEntryRef(entry)}`);
				if (drift.status !== "clean" && !parsed.force)
					throw new Error("library local changes or unpinned content; use --force to replace");
				const plan = planLibraryInstall(entry);
				plan.force = true;
				installLibraryPlan(plan);
				result = { ok: true, updated: libraryEntryRef(entry), sha256: plan.sha256 };
			}
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			return 0;
		}
		if (parsed.command === "use") {
			const kind = parsed.positional[0] as LibraryEntryKind | undefined;
			const name = parsed.positional[1];
			if (!kind || !KINDS.has(kind) || !name || parsed.positional.length !== 2)
				throw new Error("library use requires a kind and name");
			// A skill is loaded by the operator from the Skills Hub, never by a CLI
			// verb, so the honest answer names where it lives and how to load it.
			const output =
				kind === "plugin"
					? `/resources library plugin\nInspect installed contributions with clio-coder plugins inspect ${name}`
					: kind === "fleet"
						? `clio-coder fleet run ${name}`
						: kind === "agent"
							? `/run ${name}`
							: kind === "skill"
								? `${libraryInstallPath({ kind, name })}\nload it from /skill in the TUI, or ask the model to call context(scope="skills")`
								: name;
			process.stdout.write(`${output}\n`);
			return 0;
		}
		if (parsed.command === "remote") {
			if (parsed.positional[0] !== "confirm" || !parsed.positional[1] || parsed.positional.length !== 2)
				throw new Error("library remote confirm requires a URL");
			confirmLibraryRemote(parsed.positional[1]);
			printOk("confirmed library remote");
			return 0;
		}
		if (parsed.command === "sync" || parsed.command === "push") {
			await syncLibrary(parsed.command);
			printOk(`library ${parsed.command} complete`);
			return 0;
		}
		throw new Error(`unknown library command: ${parsed.command}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		printError(message);
		if (parsed.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
		return 1;
	}
}
