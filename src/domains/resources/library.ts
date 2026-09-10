import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { readSettings, updateSettings } from "../../core/config.js";
import { runCommandVector, type SafeCommandResult } from "../../core/safe-exec.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioConfigDir } from "../../core/xdg.js";
import {
	bundledPluginCatalog,
	fetchPluginSource,
	type PluginCatalogEntry,
	parsePluginGithubSource,
	pluginLocalPath,
	readPluginCatalog,
} from "../plugins/catalog.js";
import {
	installPlugin,
	listInstalledPlugins,
	type PluginExpectedState,
	type PluginMutationResult,
	type PluginScope,
	pluginBaseDir,
	pluginContentDigest,
	pluginResourcePath,
	readPluginInstallRecord,
	readPluginManifest,
	removePlugin,
} from "../plugins/index.js";
import { splitYamlFrontmatter } from "./common-loader.js";
import type { LibraryPackageEntry, LibraryRequirementRef } from "./library-types.js";

export type LibraryEntry = LibraryPackageEntry;

export interface LibraryDiscoveryResult {
	entries: LibraryEntry[];
	diagnostics: string[];
	refusals: Readonly<Record<string, string>>;
}

function catalogPath(): string {
	const configured = readSettings().integrations.library.catalog;
	return path.resolve(configured ?? path.join(clioConfigDir(), "library.yaml"));
}

function parseCatalog(filePath: string, diagnostics: string[]): LibraryEntry[] {
	return readPluginCatalog(filePath, diagnostics).map((entry) => ({ ...entry, origin: "index" }));
}

/** Discovery retains damaged copies even when their provenance record cannot be read. */
function displayInstallRecord(id: string, options: LibraryScopeOptions, diagnostics: string[]) {
	try {
		return readPluginInstallRecord(id, options);
	} catch (error) {
		const message = `package state unavailable (${options.scope}:${id}): ${error instanceof Error ? error.message : String(error)}`;
		if (!diagnostics.includes(message)) diagnostics.push(message);
		return undefined;
	}
}

export function libraryEntryRef(entry: Pick<LibraryEntry, "kind" | "name">): LibraryRequirementRef {
	return `${entry.kind}:${entry.name}`;
}

export function discoverLibrary(options: { catalog?: string; cwd?: string } = {}): LibraryDiscoveryResult {
	const diagnostics: string[] = [];
	const bundledPlugins = bundledPluginCatalog(diagnostics);
	const privatePath = catalogPath();
	const primary = options.catalog ? parseCatalog(path.resolve(options.catalog), diagnostics) : [];
	const privateEntries = parseCatalog(privatePath, diagnostics);
	const byRef = new Map<string, LibraryEntry>();
	for (const entry of [
		...bundledPlugins,
		...privateEntries,
		...parseCatalog(path.join(options.cwd ?? process.cwd(), ".clio-coder", "library.yaml"), diagnostics),
		...primary,
	])
		byRef.set(libraryEntryRef(entry), entry);
	for (const plugin of listInstalledPlugins(options.cwd ?? process.cwd(), { all: true })) {
		const ref = `${plugin.kind ?? "plugin"}:${plugin.id}`;
		if (byRef.has(ref)) continue;
		const record = displayInstallRecord(
			plugin.id,
			{ ...(options.cwd ? { cwd: options.cwd } : {}), scope: plugin.scope },
			diagnostics,
		);
		byRef.set(ref, {
			kind: plugin.kind ?? "plugin",
			name: plugin.id,
			version: plugin.version,
			description: plugin.description,
			sourceUrl: record?.source ?? plugin.rootPath,
			origin: "installed",
		});
	}
	const refusals: Record<string, string> = {};
	const entries = [...byRef.values()];
	for (const entry of entries) {
		try {
			resolveLibraryRequirements(entry, [...byRef.values()]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			refusals[libraryEntryRef(entry)] = message;
			if (!diagnostics.includes(message)) diagnostics.push(message);
		}
	}
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
	/** Reviewed facts rechecked inside the writer's lock. */
	expect?: PluginExpectedState;
}

export interface LibraryScopeOptions {
	cwd?: string;
	scope?: PluginScope;
}

/** Installed state remains addressable after its index entry is removed. */
export function resolveInstalledLibraryEntry(
	ref: string,
	options: LibraryScopeOptions = {},
): LibraryEntry & { scope: PluginScope } {
	const copies = listInstalledPlugins(options.cwd ?? process.cwd(), { ...options, all: true })
		.filter((item) => (ref.includes(":") ? `${item.kind ?? "plugin"}:${item.id}` === ref : item.id === ref))
		.sort((a, b) => Number(b.scope === "project") - Number(a.scope === "project"));
	const item = copies[0];
	if (!item) throw new Error(`package not installed: ${ref}`);
	const saved = readPluginInstallRecord(item.id, { ...options, scope: item.scope });
	return {
		scope: item.scope,
		kind: item.kind ?? "plugin",
		name: item.id,
		description: item.description,
		version: item.version,
		sourceUrl: saved?.source ?? item.rootPath,
		origin: "installed",
		...(item.manifest?.clio.requires ? { requires: item.manifest.clio.requires } : {}),
	};
}

/** Register verified bytes in one scoped index without installing or enabling them. */
export function registerLibraryPackage(
	source: string,
	options: LibraryScopeOptions & { force?: boolean } = {},
): LibraryEntry {
	const local = pluginLocalPath(source, options.cwd);
	const candidate = readPluginManifest(local);
	if (!candidate.valid || !candidate.manifest || !candidate.contentDigest)
		throw new Error(candidate.diagnostics.map((item) => item.message).join("; "));
	const manifest = candidate.manifest;
	const entry: LibraryEntry = {
		kind: manifest.clio.kind ?? "plugin",
		name: manifest.name,
		description: manifest.description ?? "",
		...(manifest.version ? { version: manifest.version } : {}),
		sha256: candidate.contentDigest,
		sourceUrl: local,
		origin: "index",
		...(manifest.clio.requires ? { requires: manifest.clio.requires } : {}),
	};
	const file =
		options.scope === "project" ? path.join(options.cwd ?? process.cwd(), ".clio-coder", "library.yaml") : catalogPath();
	withStateFileLockSync(file, () => {
		const diagnostics: string[] = [];
		const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
		const entries = readPluginCatalog(file, diagnostics);
		if (diagnostics.length) throw new Error(diagnostics.join("; "));
		const previous = entries.find((item) => item.name === entry.name);
		if (previous && !options.force)
			throw new Error(`package already registered: ${entry.name}; use --force to replace its pin`);
		const next = [...entries.filter((item) => item.name !== entry.name), entry].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		if ((existsSync(file) ? readFileSync(file, "utf8") : undefined) !== before)
			throw new Error("library index changed during registration");
		safeResourceWrite(file, stringifyYaml({ entries: next.map(({ origin: _origin, index: _index, ...item }) => item) }), {
			encoding: "utf8",
		});
	});
	return entry;
}

/** One workspace view includes available packages and every installed scope. */
export function libraryWorkspace(options: LibraryScopeOptions & { catalog?: string } = {}) {
	const discovery = discoverLibrary(options);
	const installed = listInstalledPlugins(options.cwd ?? process.cwd(), { ...options, all: true });
	return {
		...discovery,
		entries: discovery.entries.map((entry) => ({
			...entry,
			installed: installed
				.filter((item) => item.id === entry.name && (item.kind ?? "plugin") === entry.kind)
				.map((item) => ({
					...item,
					origin: displayInstallRecord(item.id, { ...options, scope: item.scope }, discovery.diagnostics)?.origin,
				})),
		})),
	};
}

/** Resolve the authored invocation identity; package names do not rewrite resource IDs. */
export function libraryRuntimeName(
	entry: Pick<LibraryEntry, "kind" | "name">,
	options: LibraryScopeOptions = {},
): string | undefined {
	const installed = installedPlugin(entry, options);
	if (!installed?.loadable || entry.kind === "plugin") return undefined;
	const manifest = installed.manifest;
	const component = manifest?.clio.components.find((item) => item.kind === entry.kind);
	if (!manifest || !component) return undefined;
	const file = pluginResourcePath(installed.rootPath, component.path);
	if (entry.kind === "agent") return path.basename(file, ".md");
	if (entry.kind === "prompt")
		return path
			.relative(pluginResourcePath(installed.rootPath, manifest.clio.resources.prompts as string), file)
			.replace(/\.md$/, "")
			.split(path.sep)
			.join(":");
	const parsed = splitYamlFrontmatter(readFileSync(file, "utf8"));
	if (!parsed.ok) return undefined;
	const metadata = parsed.frontmatter;
	return typeof metadata.name === "string" ? metadata.name : undefined;
}

function installedPlugin(entry: Pick<LibraryEntry, "kind" | "name">, options: LibraryScopeOptions = {}) {
	return listInstalledPlugins(options.cwd ?? process.cwd(), {
		all: true,
		...(options.scope ? { scope: options.scope } : {}),
	})
		.filter((plugin) => plugin.id === entry.name && (plugin.kind ?? "plugin") === entry.kind)
		.sort((left, right) => Number(right.scope === "project") - Number(left.scope === "project"))[0];
}

export function libraryInstallPath(
	entry: Pick<LibraryEntry, "kind" | "name">,
	options: LibraryScopeOptions = {},
): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) throw new Error(`invalid library entry name: ${entry.name}`);
	return (
		installedPlugin(entry, options)?.rootPath ??
		path.join(pluginBaseDir(options.scope ?? "user", options.cwd ?? process.cwd()), entry.name)
	);
}

export interface LibraryRequirementStatus {
	ordered: LibraryEntry[];
	satisfied: LibraryEntry[];
	unsatisfied: LibraryEntry[];
	/** Installed dependencies requiring explicit enable or repair before use. */
	inactive?: LibraryEntry[];
}

/**
 * Whether this entry has an installed copy, including disabled or damaged copies.
 * Requirement checks separately require a verified, loadable copy.
 */
export function libraryEntryInstalled(
	entry: Pick<LibraryEntry, "kind" | "name">,
	options: LibraryScopeOptions = {},
): boolean {
	return installedPlugin(entry, options) !== undefined;
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
	const plugin = installedPlugin(entry, options);
	if (!plugin) return undefined;
	const record = displayInstallRecord(entry.name, { ...options, scope: plugin.scope }, []);
	return record ? { sha256: record.contentDigest, sourceUrl: record.source } : undefined;
}

export function classifyLibraryRequirements(
	entry: LibraryEntry,
	catalog: ReadonlyArray<LibraryEntry>,
	options: LibraryScopeOptions = {},
): LibraryRequirementStatus {
	const ordered = resolveLibraryRequirements(entry, catalog).slice(0, -1);
	const inactive = ordered.filter(
		(requirement) =>
			libraryEntryInstalled(requirement, options) &&
			!listInstalledPlugins(options.cwd ?? process.cwd(), options).some(
				(plugin) => plugin.id === requirement.name && (plugin.kind ?? "plugin") === requirement.kind && plugin.loadable,
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
	const fetched = fetchPluginSource(entry.sourceUrl, options.cwd);
	try {
		const candidate = readPluginManifest(fetched.root);
		if (!candidate.valid || !candidate.manifest)
			throw new Error(`invalid plugin: ${candidate.diagnostics.map((item) => item.message).join("; ")}`);
		if ((candidate.manifest.clio.kind ?? "plugin") !== entry.kind)
			throw new Error(`package kind mismatch: expected ${entry.kind}`);
		if (candidate.manifest.name !== entry.name)
			throw new Error(`plugin identity mismatch: expected ${entry.name}, found ${candidate.manifest.name}`);
		if (entry.version && candidate.manifest.version !== entry.version)
			throw new Error(`plugin version mismatch: expected ${entry.version}, found ${candidate.manifest.version}`);
		const declaredRequirements = candidate.manifest.clio.requires ?? [];
		if (JSON.stringify([...declaredRequirements].sort()) !== JSON.stringify([...(entry.requires ?? [])].sort()))
			throw new Error(
				`library_requirement_mismatch: ${entry.name}; index and manifest must declare the same requirements`,
			);
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

export function releaseLibraryPlan(plan: LibraryInstallPlan): void {
	plan.cleanup?.();
}

/** All surfaces commit the reviewed digest, including every bundle asset. */
export interface LibraryInstallResult {
	recovery?: { stateBackup?: string; packageBackup?: string };
}

/**
 * Commit a staged plan through the package writer without releasing it. The
 * destination digest reviewed before the lock is also rechecked inside it when
 * the plan carries `expect`. Returns the writer's structured result.
 */
export function commitLibraryInstallPlan(plan: LibraryInstallPlan): PluginMutationResult {
	if (existsSync(plan.path) && !plan.force) throw new Error(`library destination already exists: ${plan.path}`);
	if (!plan.sourceRoot) throw new Error("plugin install plan has no staged source");
	if (plan.expectedInstalledDigest && pluginContentDigest(plan.path) !== plan.expectedInstalledDigest)
		throw new Error(`plugin_destination_changed: ${plan.entry.name}`);
	const expect: PluginExpectedState | undefined =
		plan.expect ??
		(plan.expectedInstalledDigest
			? {
					copies: [
						{
							scope: plan.scope ?? "user",
							id: plan.entry.name,
							partial: true,
							recorded: true,
							tree: plan.expectedInstalledDigest,
						},
					],
				}
			: undefined);
	return installPlugin(plan.sourceRoot, {
		...(plan.cwd ? { cwd: plan.cwd } : {}),
		scope: plan.scope ?? "user",
		force: plan.force ?? false,
		expectedDigest: plan.sha256,
		expectedId: plan.entry.name,
		expectedKind: plan.entry.kind,
		...(plan.entry.version ? { expectedVersion: plan.entry.version } : {}),
		...(expect ? { expect } : {}),
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
}

export function installLibraryPlan(plan: LibraryInstallPlan): LibraryInstallResult {
	let recovery: LibraryInstallResult["recovery"];
	try {
		const result = commitLibraryInstallPlan(plan);
		if (!result.plugin || result.diagnostics.some((item) => item.type === "error"))
			throw new Error(
				`${result.diagnostics.map((item) => item.message).join("; ") || "plugin install failed"}${result.recovery ? `; recovery: ${JSON.stringify(result.recovery)}` : ""}`,
			);
		recovery = result.recovery;
		return recovery ? { recovery } : {};
	} finally {
		releaseLibraryPlan(plan);
	}
}

/** Existing paths beat catalog IDs, including a directory named like a curated plugin. */
export function resolveLibraryPackage(
	source: string,
	options: { cwd?: string; catalog?: string } = {},
): PluginCatalogEntry {
	const local = pluginLocalPath(source, options.cwd);
	if (existsSync(local)) {
		const candidate = readPluginManifest(local);
		if (!candidate.valid || !candidate.manifest)
			throw new Error(`invalid plugin: ${candidate.diagnostics.map((item) => item.message).join("; ")}`);
		return {
			kind: candidate.manifest.clio.kind ?? "plugin",
			name: candidate.manifest.name,
			...(candidate.manifest.clio.requires ? { requires: candidate.manifest.clio.requires } : {}),
			description: candidate.manifest.description ?? "",
			...(candidate.manifest.version ? { version: candidate.manifest.version } : {}),
			sourceUrl: local,
			origin: "installed",
		};
	}
	const matches = discoverLibrary(options).entries.filter((item) =>
		source.includes(":") ? libraryEntryRef(item) === source : item.name === source,
	);
	if (matches.length > 1) throw new Error(`ambiguous package: ${source}; use kind:name`);
	const entry = matches[0];
	if (entry) return entry;
	if (parsePluginGithubSource(source))
		throw new Error("remote plugin installation requires a catalog entry with version and full-tree sha256 pin");
	throw new Error(`plugin source is neither an existing local directory nor a catalog entry: ${source}`);
}

export function planLibraryUpdate(
	id: string,
	options: { cwd?: string; scope?: PluginScope; force?: boolean; catalog?: string } = {},
): LibraryInstallPlan {
	const identity = resolveInstalledLibraryEntry(id, options);
	const plugin = installedPlugin(identity, options);
	if (!plugin) throw new Error(`plugin not installed: ${id}`);
	const pin = libraryEntryPin(identity, { ...options, scope: plugin.scope });
	if (!options.force && pin && pluginContentDigest(plugin.rootPath) !== pin.sha256)
		throw new Error(`plugin_local_changes: ${id}; use --force to replace local changes`);
	const record = readPluginInstallRecord(identity.name, { ...options, scope: plugin.scope });
	if (typeof record?.origin === "object" && record.origin.kind === "interop")
		throw new Error("interop packages require a new reviewed adoption; remove the installed copy and adopt it again");
	const catalogOrigin = record?.origin && typeof record.origin === "object" && record.origin.kind === "catalog";
	const discovery = discoverLibrary(options);
	const catalog = catalogOrigin
		? discovery.entries.find(
				(entry) => entry.kind === identity.kind && entry.name === identity.name && entry.origin !== "installed",
			)
		: undefined;
	if (catalogOrigin && !catalog)
		throw new Error(
			`plugin catalog source unavailable: ${id}; restore its pinned catalog entry or explicitly install a new source`,
		);
	const entry = catalog ?? (pin ? resolveLibraryPackage(pin.sourceUrl, options) : undefined);
	if (!entry) throw new Error(`plugin has no update source: ${id}`);
	if (entry.name !== identity.name || entry.kind !== identity.kind)
		throw new Error(`package identity mismatch: expected ${id}, found ${libraryEntryRef(entry)}`);
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
	options: { cwd?: string; scope?: PluginScope; expect?: PluginExpectedState } = {},
): LibraryInstallResult {
	const installed = installedPlugin(entry, options);
	if (!installed) throw new Error(`package not installed: ${libraryEntryRef(entry)}`);
	const result = removePlugin(entry.name, { ...options, scope: installed.scope });
	if (result.diagnostics.some((item) => item.type === "error"))
		throw new Error(
			`${result.diagnostics.map((item) => item.message).join("; ")}${result.recovery ? `; recovery: ${JSON.stringify(result.recovery)}` : ""}`,
		);
	return result.recovery ? { recovery: result.recovery } : {};
}

export function pinLibraryEntry(
	entry: LibraryEntry,
	options: LibraryScopeOptions = {},
): { sha256: string; sourceUrl: string } {
	const installed = libraryInstallPath(entry, options);
	const pin = libraryEntryPin(entry, options);
	if (!pin) throw new Error(`plugin is not installed with a verified pin: ${entry.name}`);
	if (pluginContentDigest(installed) !== pin.sha256)
		throw new Error(`plugin_local_changes: ${entry.name}; reinstall explicitly to accept changed content`);
	return pin;
}

export function libraryEntryDrift(
	entry: Pick<LibraryEntry, "kind" | "name">,
	options: LibraryScopeOptions = {},
): { status: "clean" | "changed" | "missing" | "unpinned"; expected?: string; observed?: string } {
	const installed = libraryInstallPath(entry, options);
	if (!existsSync(installed)) return { status: "missing" };
	const pin = libraryEntryPin(entry, options);
	if (!pin) return { status: "unpinned" };
	const observed = pluginContentDigest(installed);
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
