import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readSettings, updateSettings } from "../../core/config.js";
import { runCommandVector, type SafeCommandResult } from "../../core/safe-exec.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioConfigDir } from "../../core/xdg.js";
import { parseFrontmatter } from "../agents/frontmatter.js";
import {
	assertAgentSpecPolicy,
	normalizeAgentSpec,
	parseAgentRecipeSchema,
	parseFleetContract,
} from "../agents/index.js";
import { loadPromptTemplates } from "./prompts/loader.js";
import { normalizedSkillHash } from "./skills/install.js";
import {
	type DiscoverMarketplaceOptions,
	discoverMarketplaceSkills,
	installSkill,
	type LibraryEntryKind,
	type LibraryRequirementRef,
	type MarketplaceSkill,
} from "./skills/marketplace.js";

export type LibraryEntry = MarketplaceSkill;

export interface LibraryDiscoveryResult {
	entries: LibraryEntry[];
	diagnostics: string[];
	refusals: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogPath(): string {
	const configured = readSettings().library.catalog;
	return path.resolve(configured ?? path.join(clioConfigDir(), "library.yaml"));
}

function parseCatalog(filePath: string, diagnostics: string[]): LibraryEntry[] {
	if (!existsSync(filePath)) return [];
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = filePath.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
		const rows = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.skills) ? parsed.skills : [];
		return rows.flatMap((value): LibraryEntry[] => {
			if (
				!isRecord(value) ||
				typeof value.name !== "string" ||
				typeof value.description !== "string" ||
				typeof value.sourceUrl !== "string"
			) {
				diagnostics.push(`library catalog entry malformed: ${filePath}`);
				return [];
			}
			const kind: LibraryEntryKind =
				value.kind === undefined || value.kind === "skill"
					? "skill"
					: value.kind === "agent" || value.kind === "prompt" || value.kind === "fleet"
						? value.kind
						: "skill";
			if (value.kind !== undefined && !["skill", "agent", "prompt", "fleet"].includes(String(value.kind))) {
				diagnostics.push(`library catalog entry has unsupported kind: ${value.name}`);
				return [];
			}
			if (
				value.requires !== undefined &&
				(!Array.isArray(value.requires) || value.requires.some((item) => typeof item !== "string"))
			) {
				diagnostics.push(`library_requirement_malformed: ${value.name}`);
				return [];
			}
			const sourceUrl = /^(?:https?:\/\/|git@)/.test(value.sourceUrl)
				? value.sourceUrl
				: path.resolve(path.dirname(filePath), value.sourceUrl);
			const requires = Array.isArray(value.requires)
				? value.requires.filter((item): item is LibraryRequirementRef => typeof item === "string")
				: undefined;
			return [
				{
					kind,
					name: value.name.trim(),
					description: value.description.trim(),
					sourceUrl,
					origin: "index",
					...(typeof value.version === "string" ? { version: value.version } : {}),
					...(requires ? { requires } : {}),
				},
			];
		});
	} catch (error) {
		diagnostics.push(`library catalog unreadable: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

export function libraryEntryRef(entry: Pick<LibraryEntry, "kind" | "name">): LibraryRequirementRef {
	return `${entry.kind}:${entry.name}`;
}

export function discoverLibrary(
	options: { catalog?: string; cwd?: string; marketplace?: DiscoverMarketplaceOptions } = {},
): LibraryDiscoveryResult {
	const marketplace = discoverMarketplaceSkills({
		...(options.marketplace ?? {}),
		...(options.cwd ? { cwd: options.cwd } : {}),
	});
	const diagnostics = [...marketplace.diagnostics.filter((item) => !item.includes("no local skill marketplace"))];
	const privatePath = catalogPath();
	const primary = options.catalog ? parseCatalog(path.resolve(options.catalog), diagnostics) : [];
	const privateEntries = parseCatalog(privatePath, diagnostics);
	const byRef = new Map<string, LibraryEntry>();
	for (const entry of [...marketplace.skills, ...primary, ...privateEntries]) byRef.set(libraryEntryRef(entry), entry);
	const refusals: Record<string, string> = {};
	const entries = [...byRef.values()].filter((entry) => {
		try {
			resolveLibraryRequirements(entry, [...byRef.values()]);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			refusals[libraryEntryRef(entry)] = message;
			if (!diagnostics.includes(message)) diagnostics.push(message);
			return false;
		}
	});
	return {
		entries: entries.sort((a, b) => libraryEntryRef(a).localeCompare(libraryEntryRef(b))),
		diagnostics,
		refusals,
	};
}

const REQUIREMENT_PATTERN = /^(skill|agent|prompt|fleet):([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export function resolveLibraryRequirements(entry: LibraryEntry, catalog: ReadonlyArray<LibraryEntry>): LibraryEntry[] {
	const byRef = new Map(catalog.map((item) => [libraryEntryRef(item), item]));
	const ordered: LibraryEntry[] = [];
	const visiting: string[] = [];
	const visited = new Set<string>();
	const visit = (current: LibraryEntry): void => {
		const currentRef = libraryEntryRef(current);
		if (visited.has(currentRef)) return;
		const cycleAt = visiting.indexOf(currentRef);
		if (cycleAt >= 0)
			throw new Error(`library_requirement_cycle: ${[...visiting.slice(cycleAt), currentRef].join(" -> ")}`);
		visiting.push(currentRef);
		for (const requirement of current.requires ?? []) {
			if (!REQUIREMENT_PATTERN.test(requirement)) throw new Error("library_requirement_malformed");
			const dependency = byRef.get(requirement);
			if (!dependency) throw new Error(`library_requirement_missing: ${requirement}`);
			visit(dependency);
		}
		visiting.pop();
		visited.add(currentRef);
		ordered.push(current);
	};
	visit(entry);
	return ordered;
}

function sourceFile(entry: LibraryEntry): string {
	const source = path.resolve(entry.sourceUrl);
	if (entry.kind === "skill") return source;
	if (!existsSync(source)) throw new Error(`library source path does not exist: ${source}`);
	return source;
}

function validateEntry(entry: LibraryEntry, raw: string, filePath: string): void {
	if (entry.kind === "fleet") {
		parseFleetContract(raw, filePath);
		return;
	}
	if (entry.kind === "agent") {
		const parsed = parseFrontmatter(raw, filePath);
		const recipe = parseAgentRecipeSchema({ id: entry.name, source: "user", filepath: filePath, ...parsed });
		assertAgentSpecPolicy(normalizeAgentSpec(recipe));
		return;
	}
	if (entry.kind === "prompt") {
		const loaded = loadPromptTemplates({ roots: [{ path: path.dirname(filePath), scope: "user", source: "library" }] });
		if (!loaded.items.some((item) => item.filePath === filePath))
			throw new Error(`prompt template is malformed: ${filePath}`);
	}
}

export interface LibraryInstallPlan {
	entry: LibraryEntry;
	path: string;
	sha256: string;
}

export function libraryInstallPath(entry: Pick<LibraryEntry, "kind" | "name">): string {
	if (entry.kind === "skill") return path.join(clioConfigDir(), "skills", entry.name, "SKILL.md");
	const root = entry.kind === "agent" ? "agents" : entry.kind === "fleet" ? "fleets" : "prompts";
	return path.join(clioConfigDir(), root, `${entry.name}.md`);
}

function readLibraryPins(): Record<string, { sha256: string; sourceUrl: string }> {
	const pinPath = path.join(clioConfigDir(), "library-pins.yaml");
	if (!existsSync(pinPath)) return {};
	const parsed = parseYaml(readFileSync(pinPath, "utf8"));
	return isRecord(parsed) ? (parsed as Record<string, { sha256: string; sourceUrl: string }>) : {};
}

export interface LibraryRequirementStatus {
	ordered: LibraryEntry[];
	satisfied: LibraryEntry[];
	unsatisfied: LibraryEntry[];
}

export function classifyLibraryRequirements(
	entry: LibraryEntry,
	catalog: ReadonlyArray<LibraryEntry>,
): LibraryRequirementStatus {
	const ordered = resolveLibraryRequirements(entry, catalog).slice(0, -1);
	const pins = readLibraryPins();
	const satisfied = ordered.filter((requirement) => {
		const ref = libraryEntryRef(requirement);
		return pins[ref] !== undefined || existsSync(libraryInstallPath(requirement));
	});
	const satisfiedRefs = new Set(satisfied.map(libraryEntryRef));
	return {
		ordered,
		satisfied,
		unsatisfied: ordered.filter((requirement) => !satisfiedRefs.has(libraryEntryRef(requirement))),
	};
}

export function planLibraryInstall(entry: LibraryEntry): LibraryInstallPlan {
	if (entry.kind === "skill") {
		const source = sourceFile(entry);
		const file = statSync(source).isDirectory() ? path.join(source, "SKILL.md") : source;
		const raw = readFileSync(file);
		return {
			entry,
			path: libraryInstallPath(entry),
			sha256: normalizedSkillHash(raw.toString("utf8")),
		};
	}
	const source = sourceFile(entry);
	const raw = readFileSync(source, "utf8");
	validateEntry(entry, raw, source);
	return {
		entry,
		path: libraryInstallPath(entry),
		sha256: createHash("sha256").update(raw).digest("hex"),
	};
}

function recordPin(plan: LibraryInstallPlan): void {
	const pinPath = path.join(clioConfigDir(), "library-pins.yaml");
	const pins = readLibraryPins();
	pins[libraryEntryRef(plan.entry)] = { sha256: plan.sha256, sourceUrl: plan.entry.sourceUrl };
	safeResourceWrite(pinPath, stringifyYaml(Object.fromEntries(Object.entries(pins).sort())), { encoding: "utf8" });
}

export function installLibraryPlan(plan: LibraryInstallPlan): void {
	if (existsSync(plan.path)) throw new Error(`library destination already exists: ${plan.path}`);
	if (plan.entry.kind === "skill") installSkill({ source: plan.entry.sourceUrl, scope: "user", name: plan.entry.name });
	else safeResourceWrite(plan.path, readFileSync(sourceFile(plan.entry)));
	recordPin(plan);
}

function confirmedRemote(): string {
	const settings = readSettings().library;
	if (!settings.remote || settings.remote !== settings.confirmedRemote) throw new Error("library_remote_unconfirmed");
	return settings.remote;
}

export function confirmLibraryRemote(url: string): void {
	const current = readSettings().library.remote;
	if (current !== null && current !== url) throw new Error("library_remote_mismatch");
	updateSettings((settings) => {
		if (settings.library.remote === null) settings.library.remote = url;
		settings.library.confirmedRemote = url;
	});
}

export type LibraryCommandRunner = (
	file: string,
	args: ReadonlyArray<string>,
	options: { cwd: string; workspaceRoot: string },
) => Promise<SafeCommandResult>;

export async function syncLibrary(
	direction: "sync" | "push",
	runner: LibraryCommandRunner = runCommandVector,
): Promise<void> {
	const settings = readSettings().library;
	if (!settings.sync) throw new Error("library_sync_disabled");
	const remote = confirmedRemote();
	const cwd = path.dirname(catalogPath());
	const remoteResult = await runner("git", ["remote", "get-url", "library"], { cwd, workspaceRoot: cwd });
	if (remoteResult.exitCode !== 0 || remoteResult.stdout.trim() !== remote)
		throw new Error("library_remote_unconfirmed");
	if (direction === "sync") {
		const fetched = await runner("git", ["fetch", "library"], { cwd, workspaceRoot: cwd });
		if (fetched.exitCode !== 0) throw new Error(fetched.stderr.trim() || "library sync failed");
		const advanced = await runner("git", ["merge", "--ff-only", "FETCH_HEAD"], { cwd, workspaceRoot: cwd });
		if (advanced.exitCode !== 0) throw new Error(advanced.stderr.trim() || "library sync failed");
		return;
	}
	const result = await runner("git", ["push", "library"], { cwd, workspaceRoot: cwd });
	if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `library ${direction} failed`);
}
