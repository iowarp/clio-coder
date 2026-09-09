import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
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
import {
	bundledPluginCatalog,
	fetchPluginSource,
	type PluginCatalogEntry,
	parsePluginGithubSource,
	pluginLocalPath,
} from "../plugins/catalog.js";
import {
	installPlugin,
	isPluginId,
	listInstalledPlugins,
	type PluginScope,
	pluginBaseDir,
	pluginContentDigest,
	readPluginInstallRecord,
	readPluginManifest,
	removePlugin,
} from "../plugins/index.js";
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

export type LibraryEntry = MarketplaceSkill | PluginCatalogEntry;

export interface LibraryDiscoveryResult {
	entries: LibraryEntry[];
	diagnostics: string[];
	refusals: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogPath(): string {
	const configured = readSettings().integrations.library.catalog;
	return path.resolve(configured ?? path.join(clioConfigDir(), "library.yaml"));
}

function parseCatalog(filePath: string, diagnostics: string[]): LibraryEntry[] {
	if (!existsSync(filePath)) return [];
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = filePath.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
		const rows = Array.isArray(parsed)
			? parsed
			: isRecord(parsed) && Array.isArray(parsed.entries)
				? parsed.entries
				: isRecord(parsed) && Array.isArray(parsed.skills)
					? parsed.skills
					: [];
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
					: value.kind === "agent" || value.kind === "prompt" || value.kind === "fleet" || value.kind === "plugin"
						? value.kind
						: "skill";
			if (value.kind !== undefined && !["skill", "agent", "prompt", "fleet", "plugin"].includes(String(value.kind))) {
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
			if (kind === "plugin") {
				if (!isPluginId(value.name.trim()) || !value.sourceUrl.trim()) {
					diagnostics.push(`plugin catalog entry malformed: ${value.name}`);
					return [];
				}
				if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.version !== "string") {
					diagnostics.push(`plugin catalog entry requires version and full-tree sha256: ${value.name}`);
					return [];
				}
				if (/^(?:https?:\/\/|git@)/.test(sourceUrl) && !parsePluginGithubSource(sourceUrl)) {
					diagnostics.push(`unsupported plugin catalog source: ${sourceUrl}`);
					return [];
				}
			}
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
					...(kind === "plugin" && typeof value.sha256 === "string" ? { sha256: value.sha256 } : {}),
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
	const bundledPlugins = bundledPluginCatalog(diagnostics);
	const privatePath = catalogPath();
	const primary = options.catalog ? parseCatalog(path.resolve(options.catalog), diagnostics) : [];
	const privateEntries = parseCatalog(privatePath, diagnostics);
	const byRef = new Map<string, LibraryEntry>();
	for (const entry of [...marketplace.skills, ...bundledPlugins, ...primary, ...privateEntries])
		byRef.set(libraryEntryRef(entry), entry);
	for (const plugin of listInstalledPlugins(options.cwd ?? process.cwd())) {
		const ref = `plugin:${plugin.id}`;
		if (byRef.has(ref)) continue;
		const record = readPluginInstallRecord(plugin.id, {
			...(options.cwd ? { cwd: options.cwd } : {}),
			scope: plugin.scope,
		});
		byRef.set(ref, {
			kind: "plugin",
			name: plugin.id,
			version: plugin.version,
			description: plugin.description,
			sourceUrl: record?.source ?? plugin.rootPath,
			origin: "installed",
		});
	}
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

const REQUIREMENT_PATTERN = /^(skill|agent|prompt|fleet|plugin):([A-Za-z0-9][A-Za-z0-9._-]*)$/;

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
	/** Plugin source retained until acceptance; release a cancelled plan. */
	sourceRoot?: string;
	cleanup?: () => void;
	cwd?: string;
	scope?: PluginScope;
	force?: boolean;
	expectedInstalledDigest?: string;
}

export interface LibraryScopeOptions {
	cwd?: string;
	scope?: PluginScope;
}

function installedPlugin(entry: Pick<LibraryEntry, "kind" | "name">, options: LibraryScopeOptions = {}) {
	return listInstalledPlugins(options.cwd ?? process.cwd(), {
		all: true,
		...(options.scope ? { scope: options.scope } : {}),
	})
		.filter((plugin) => plugin.id === entry.name)
		.sort((left, right) => Number(right.scope === "project") - Number(left.scope === "project"))[0];
}

export function libraryInstallPath(
	entry: Pick<LibraryEntry, "kind" | "name">,
	options: LibraryScopeOptions = {},
): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) throw new Error(`invalid library entry name: ${entry.name}`);
	if (entry.kind === "plugin")
		return (
			installedPlugin(entry, options)?.rootPath ??
			path.join(pluginBaseDir(options.scope ?? "user", options.cwd ?? process.cwd()), entry.name)
		);
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
	/** Installed dependencies requiring explicit enable or repair before use. */
	inactive?: LibraryEntry[];
}

/**
 * Whether this entry is already on disk for this operator. A kind-qualified pin
 * and a kind-specific destination are each sufficient, which is the same rule
 * the requirement classifier applies, so a surface that draws an installed or
 * available column never disagrees with the gate that refuses an install.
 */
export function libraryEntryInstalled(
	entry: Pick<LibraryEntry, "kind" | "name">,
	options: LibraryScopeOptions = {},
): boolean {
	if (entry.kind === "plugin") return installedPlugin(entry, options) !== undefined;
	return existsSync(libraryInstallPath(entry));
}

/**
 * The pin recorded for this entry, or undefined when nothing pinned it. A
 * destination can exist without a pin, which is why this is a separate question
 * from `libraryEntryInstalled`.
 */
export function libraryEntryPin(
	entry: Pick<LibraryEntry, "kind" | "name">,
	options: LibraryScopeOptions = {},
): { sha256: string; sourceUrl: string } | undefined {
	if (entry.kind === "plugin") {
		const plugin = installedPlugin(entry, options);
		if (!plugin) return undefined;
		const record = readPluginInstallRecord(entry.name, { ...options, scope: plugin.scope });
		return record ? { sha256: record.contentDigest, sourceUrl: record.source } : undefined;
	}
	return readLibraryPins()[libraryEntryRef(entry)];
}

export function classifyLibraryRequirements(
	entry: LibraryEntry,
	catalog: ReadonlyArray<LibraryEntry>,
	options: LibraryScopeOptions = {},
): LibraryRequirementStatus {
	const ordered = resolveLibraryRequirements(entry, catalog).slice(0, -1);
	const inactive = ordered.filter(
		(requirement) =>
			requirement.kind === "plugin" &&
			libraryEntryInstalled(requirement, options) &&
			!listInstalledPlugins(options.cwd ?? process.cwd()).some(
				(plugin) => plugin.id === requirement.name && plugin.loadable,
			),
	);
	const inactiveRefs = new Set(inactive.map(libraryEntryRef));
	const satisfied = ordered.filter(
		(requirement) => libraryEntryInstalled(requirement, options) && !inactiveRefs.has(libraryEntryRef(requirement)),
	);
	const satisfiedRefs = new Set(satisfied.map(libraryEntryRef));
	return {
		ordered,
		satisfied,
		...(inactive.length ? { inactive } : {}),
		unsatisfied: ordered.filter((requirement) => !satisfiedRefs.has(libraryEntryRef(requirement))),
	};
}

export function planLibraryInstall(
	entry: LibraryEntry,
	options: { cwd?: string; scope?: PluginScope; force?: boolean } = {},
): LibraryInstallPlan {
	if (entry.kind === "plugin") {
		const fetched = fetchPluginSource(entry.sourceUrl, options.cwd);
		try {
			const candidate = readPluginManifest(fetched.root);
			if (!candidate.valid || !candidate.manifest)
				throw new Error(`invalid plugin: ${candidate.diagnostics.map((item) => item.message).join("; ")}`);
			if (candidate.manifest.name !== entry.name)
				throw new Error(`plugin identity mismatch: expected ${entry.name}, found ${candidate.manifest.name}`);
			if (entry.version && candidate.manifest.version !== entry.version)
				throw new Error(`plugin version mismatch: expected ${entry.version}, found ${candidate.manifest.version}`);
			const sha256 = pluginContentDigest(fetched.root);
			if (entry.sha256 && sha256 !== entry.sha256) throw new Error(`plugin_pin_mismatch: ${entry.name}`);
			return {
				entry: { ...entry, ...(candidate.manifest.version ? { version: candidate.manifest.version } : {}) },
				path: path.join(pluginBaseDir(options.scope ?? "user", options.cwd ?? process.cwd()), entry.name),
				sha256,
				sourceRoot: fetched.root,
				cleanup: fetched.cleanup,
				...options,
			};
		} catch (error) {
			fetched.cleanup();
			throw error;
		}
	}
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
	if (plan.entry.kind === "plugin") return; // The atomic plugin state is its authoritative pin, per scope.
	const pinPath = path.join(clioConfigDir(), "library-pins.yaml");
	const pins = readLibraryPins();
	pins[libraryEntryRef(plan.entry)] = { sha256: plan.sha256, sourceUrl: plan.entry.sourceUrl };
	safeResourceWrite(pinPath, stringifyYaml(Object.fromEntries(Object.entries(pins).sort())), { encoding: "utf8" });
}

export function releaseLibraryPlan(plan: LibraryInstallPlan): void {
	plan.cleanup?.();
}

/** All surfaces commit the reviewed digest, including every bundle asset. */
export interface LibraryInstallResult {
	recovery?: { stateBackup?: string; packageBackup?: string };
}

export function installLibraryPlan(plan: LibraryInstallPlan): LibraryInstallResult {
	let recovery: LibraryInstallResult["recovery"];
	try {
		if (existsSync(plan.path) && !plan.force) throw new Error(`library destination already exists: ${plan.path}`);
		if (plan.entry.kind === "plugin") {
			if (!plan.sourceRoot) throw new Error("plugin install plan has no staged source");
			if (plan.expectedInstalledDigest && pluginContentDigest(plan.path) !== plan.expectedInstalledDigest)
				throw new Error(`plugin_destination_changed: ${plan.entry.name}`);
			const result = installPlugin(plan.sourceRoot, {
				...(plan.cwd ? { cwd: plan.cwd } : {}),
				scope: plan.scope ?? "user",
				force: plan.force ?? false,
				expectedDigest: plan.sha256,
				expectedId: plan.entry.name,
				...(plan.entry.version ? { expectedVersion: plan.entry.version } : {}),
				origin: {
					kind:
						plan.entry.origin === "catalog" || plan.entry.origin === "index"
							? "catalog"
							: parsePluginGithubSource(plan.entry.sourceUrl)
								? "github"
								: "local",
					source: plan.entry.sourceUrl,
				},
			});
			if (!result.plugin || result.diagnostics.some((item) => item.type === "error"))
				throw new Error(
					`${result.diagnostics.map((item) => item.message).join("; ") || "plugin install failed"}${result.recovery ? `; recovery: ${JSON.stringify(result.recovery)}` : ""}`,
				);
			recovery = result.recovery;
		} else {
			const current = planLibraryInstall(plan.entry);
			if (current.sha256 !== plan.sha256) throw new Error(`library_source_changed: ${libraryEntryRef(plan.entry)}`);
			if (plan.entry.kind === "skill")
				installSkill({ source: plan.entry.sourceUrl, scope: "user", name: plan.entry.name, force: plan.force ?? false });
			else safeResourceWrite(plan.path, readFileSync(sourceFile(plan.entry)));
		}
		recordPin(plan);
		return recovery ? { recovery } : {};
	} finally {
		releaseLibraryPlan(plan);
	}
}

/** Existing paths beat catalog IDs, including a directory named like a curated plugin. */
export function resolveLibraryPlugin(
	source: string,
	options: { cwd?: string; catalog?: string } = {},
): PluginCatalogEntry {
	const local = pluginLocalPath(source, options.cwd);
	if (existsSync(local)) {
		const candidate = readPluginManifest(local);
		if (!candidate.valid || !candidate.manifest)
			throw new Error(`invalid plugin: ${candidate.diagnostics.map((item) => item.message).join("; ")}`);
		return {
			kind: "plugin",
			name: candidate.manifest.name,
			description: candidate.manifest.description ?? "",
			...(candidate.manifest.version ? { version: candidate.manifest.version } : {}),
			sourceUrl: local,
			origin: "installed",
		};
	}
	const entry = discoverLibrary(options).entries.find(
		(item) => item.kind === "plugin" && item.name === source.replace(/^plugin:/, ""),
	);
	if (entry?.kind === "plugin") return entry;
	if (parsePluginGithubSource(source))
		throw new Error("remote plugin installation requires a catalog entry with version and full-tree sha256 pin");
	throw new Error(`plugin source is neither an existing local directory nor a catalog entry: ${source}`);
}

export function planPluginUpdate(
	id: string,
	options: { cwd?: string; scope?: PluginScope; force?: boolean; catalog?: string } = {},
): LibraryInstallPlan {
	const plugin = installedPlugin({ kind: "plugin", name: id }, options);
	if (!plugin) throw new Error(`plugin not installed: ${id}`);
	const pin = libraryEntryPin({ kind: "plugin", name: id }, { ...options, scope: plugin.scope });
	if (!options.force && pin && pluginContentDigest(plugin.rootPath) !== pin.sha256)
		throw new Error(`plugin_local_changes: ${id}; use --force to replace local changes`);
	const record = readPluginInstallRecord(id, { ...options, scope: plugin.scope });
	const catalogOrigin = record?.origin && typeof record.origin === "object" && record.origin.kind === "catalog";
	const discovery = discoverLibrary(options);
	const catalog = catalogOrigin
		? discovery.entries.find((entry) => entry.kind === "plugin" && entry.name === id && entry.origin !== "installed")
		: undefined;
	if (catalogOrigin && !catalog)
		throw new Error(
			`plugin catalog source unavailable: ${id}; restore its pinned catalog entry or explicitly install a new source`,
		);
	const entry = catalog?.kind === "plugin" ? catalog : pin ? resolveLibraryPlugin(pin.sourceUrl, options) : undefined;
	if (!entry) throw new Error(`plugin has no update source: ${id}`);
	if (entry.name !== id) throw new Error(`plugin identity mismatch: expected ${id}, found ${entry.name}`);
	const requirements = classifyLibraryRequirements(entry, discovery.entries, options);
	if (requirements.inactive?.length)
		throw new Error(
			`library_requirement_inactive: ${requirements.inactive.map(libraryEntryRef).join(", ")}; enable or repair these plugins explicitly`,
		);
	if (requirements.unsatisfied.length)
		throw new Error(
			`library_requirement_missing: ${requirements.unsatisfied.map(libraryEntryRef).join(", ")}; install required resources before updating`,
		);
	const plan = planLibraryInstall(entry, { ...options, scope: plugin.scope, force: true });
	if (!options.force) plan.expectedInstalledDigest = pluginContentDigest(plugin.rootPath);
	return plan;
}

export function removeLibraryEntry(
	entry: Pick<LibraryEntry, "kind" | "name">,
	options: { cwd?: string; scope?: PluginScope } = {},
): LibraryInstallResult {
	libraryInstallPath(entry, options); // Validate identity before any deletion.
	if (entry.kind === "plugin") {
		const result = removePlugin(entry.name, options);
		if (result.diagnostics.some((item) => item.type === "error"))
			throw new Error(
				`${result.diagnostics.map((item) => item.message).join("; ")}${result.recovery ? `; recovery: ${JSON.stringify(result.recovery)}` : ""}`,
			);
		return result.recovery ? { recovery: result.recovery } : {};
	} else
		rmSync(entry.kind === "skill" ? path.dirname(libraryInstallPath(entry)) : libraryInstallPath(entry), {
			recursive: true,
			force: true,
		});
	const pins = readLibraryPins();
	delete pins[libraryEntryRef(entry)];
	safeResourceWrite(path.join(clioConfigDir(), "library-pins.yaml"), stringifyYaml(pins), { encoding: "utf8" });
	return {};
}

export function pinLibraryEntry(
	entry: LibraryEntry,
	options: LibraryScopeOptions = {},
): { sha256: string; sourceUrl: string } {
	const installed = libraryInstallPath(entry, options);
	if (entry.kind === "plugin") {
		const pin = libraryEntryPin(entry, options);
		if (!pin) throw new Error(`plugin is not installed with a verified pin: ${entry.name}`);
		if (pluginContentDigest(installed) !== pin.sha256)
			throw new Error(`plugin_local_changes: ${entry.name}; reinstall explicitly to accept changed content`);
		return pin;
	}
	if (!existsSync(installed)) throw new Error(`library entry is not installed: ${libraryEntryRef(entry)}`);
	const sha256 =
		entry.kind === "skill"
			? normalizedSkillHash(readFileSync(installed, "utf8"))
			: createHash("sha256").update(readFileSync(installed)).digest("hex");
	recordPin({ entry, path: installed, sha256 });
	return { sha256, sourceUrl: entry.sourceUrl };
}

export function libraryEntryDrift(
	entry: Pick<LibraryEntry, "kind" | "name">,
	options: LibraryScopeOptions = {},
): { status: "clean" | "changed" | "missing" | "unpinned"; expected?: string; observed?: string } {
	const installed = libraryInstallPath(entry, options);
	if (!existsSync(installed)) return { status: "missing" };
	const pin = libraryEntryPin(entry, options);
	if (!pin) return { status: "unpinned" };
	const observed =
		entry.kind === "plugin"
			? pluginContentDigest(installed)
			: entry.kind === "skill"
				? normalizedSkillHash(readFileSync(installed, "utf8"))
				: createHash("sha256").update(readFileSync(installed)).digest("hex");
	return { status: observed === pin.sha256 ? "clean" : "changed", expected: pin.sha256, observed };
}

function confirmedRemote(): string {
	const settings = readSettings().integrations.library;
	if (!settings.remote || settings.remote !== settings.confirmedRemote) throw new Error("library_remote_unconfirmed");
	return settings.remote;
}

export function confirmLibraryRemote(url: string): void {
	const current = readSettings().integrations.library.remote;
	if (current !== null && current !== url) throw new Error("library_remote_mismatch");
	updateSettings((settings) => {
		if (settings.integrations.library.remote === null) settings.integrations.library.remote = url;
		settings.integrations.library.confirmedRemote = url;
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
	const settings = readSettings().integrations.library;
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
