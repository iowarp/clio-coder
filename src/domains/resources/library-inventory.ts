import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { readSettings } from "../../core/config.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { clioConfigDir } from "../../core/xdg.js";
import { listFleetContracts } from "../agents/fleet-contract.js";
import type { AgentRecipe } from "../agents/recipe.js";
import { type AgentRecipeDiagnostic, discoverAgentRecipes } from "../agents/registry.js";
import type { AgentAudience } from "../agents/spec.js";
import { INTEROP_AGENT_KINDS } from "../interop/registry.js";
import { bundledLibraryIndexPath, parsePluginGithubSource } from "../plugins/catalog.js";
import { listInstalledPlugins, readPluginInstallRecord } from "../plugins/state.js";
import type { InstalledPlugin, PluginInstallRecord, PluginScope } from "../plugins/types.js";
import type { ResourceDiagnostic } from "./collision.js";
import { discoverLibrary } from "./library.js";
import type {
	LibraryEntryKind,
	LibraryPackageEntry,
	LibraryProvidedResource,
	LibraryRequirementRef,
	LibraryResourceKind,
} from "./library-types.js";
import { isLibraryKind, isLibraryResourceKind } from "./library-types.js";
import { type LibraryValidationPrerequisite, validateLibraryPackage } from "./library-validation.js";
import { loadPromptTemplates, type PromptTemplate } from "./prompts/loader.js";
import { loadSkills, type Skill } from "./skills/loader.js";

/**
 * One body-free projection of three separate facts: catalog packages (install
 * targets), installed scoped copies (state), and actual recipe resources (what
 * the loaders really see). It composes the existing readers and never fetches,
 * executes, reloads or writes. Package and recipe readers never call back into
 * this module.
 */

export type LibraryPackageFormat = "portable" | "claude-code" | "codex";

/** Where the bytes came from, derived from discovery, install and adoption evidence only. */
export type LibraryOrigin =
	| { kind: "bundled"; catalog: string }
	| { kind: "remote"; url: string; catalog?: string; host?: string }
	| { kind: "local"; path: string; catalog?: string; host?: string }
	| { kind: "imported"; agent: string; path: string; marketplace?: string }
	| { kind: "core" }
	| { kind: "unknown"; detail?: string };

/**
 * `loadable` means the package engine admits the copy's resource roots. It says
 * nothing about whether every recipe inside parsed or is trusted; that is the
 * resource row's availability.
 */
export type LibraryCopyState = "loadable" | "disabled" | "shadowed" | "invalid" | "incompatible" | "damaged";

export interface LibraryCopy {
	ref: LibraryRequirementRef;
	kind: LibraryEntryKind;
	name: string;
	scope: PluginScope;
	root: string;
	version: string;
	state: LibraryCopyState;
	enabled: boolean;
	valid: boolean;
	compatible: boolean;
	effective: boolean;
	loadable: boolean;
	trust: "trusted" | "foreign";
	overriddenBy?: PluginScope;
	origin: LibraryOrigin;
	format?: LibraryPackageFormat;
	recordedDigest?: string;
	observedDigest?: string;
	installedAt?: string;
	diagnostics: string[];
}

export interface LibraryPackageRecord {
	ref: LibraryRequirementRef;
	kind: LibraryEntryKind;
	name: string;
	description: string;
	version?: string;
	sha256?: string;
	sourceUrl: string;
	requires?: LibraryRequirementRef[];
	origin: LibraryOrigin;
	format?: LibraryPackageFormat;
	/** Hints only; absent means contents are unknown until inspection. */
	provides?: LibraryProvidedResource[];
	/** Which reader produced the row: a catalog, a scoped index, or install state alone. */
	catalogOrigin: LibraryPackageEntry["origin"];
	copies: Array<{ scope: PluginScope; state: LibraryCopyState }>;
	refusal?: string;
}

export type LibraryResourceSourceClass = "core" | "package" | "user" | "project" | "compat";
export type LibraryResourceAvailability = "available" | "untrusted" | "invalid" | "shadowed" | "unavailable";

export interface LibraryResource {
	/** `${kind}:${name}@${sourceId}#${relativePath}`; two same-name files under one root stay distinct. */
	key: string;
	kind: LibraryResourceKind;
	/** Actual runtime name: skill frontmatter name, agent file id, prompt path with colons, fleet contract name. */
	name: string;
	description: string;
	invocation?: string;
	path: string;
	source: { class: LibraryResourceSourceClass; id: string; scope: "package" | "user" | "project" };
	owner?: { ref: LibraryRequirementRef; scope: PluginScope; componentId?: string };
	origin: LibraryOrigin;
	format?: LibraryPackageFormat;
	availability: LibraryResourceAvailability;
	reason?: string;
	trusted: boolean;
	modelInvocable?: boolean;
	audience?: AgentAudience;
	diagnostics: string[];
}

export interface LibraryInventory {
	version: 1;
	generatedAt: string;
	cwd: string;
	audience: "operator" | "model";
	packages: LibraryPackageRecord[];
	copies: LibraryCopy[];
	resources: LibraryResource[];
	diagnostics: string[];
	truncated: { packages: boolean; copies: boolean; resources: boolean };
}

export const LIBRARY_INVENTORY_LIMITS = {
	packages: 512,
	copies: 256,
	resources: 1024,
	diagnostics: 64,
	copyDiagnostics: 16,
	resourceDiagnostics: 8,
	description: 512,
	message: 512,
} as const;

function clip(value: string, limit: number = LIBRARY_INVENTORY_LIMITS.description): string {
	return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** Append-only list that refuses rows past its cap so traversal, not a final slice, enforces the bound. */
class Bounded<T> {
	readonly items: T[] = [];
	truncated = false;
	constructor(private readonly limit: number) {}
	push(item: T): boolean {
		if (this.items.length >= this.limit) {
			this.truncated = true;
			return false;
		}
		this.items.push(item);
		return true;
	}
}

export interface LibraryInventoryOptions {
	cwd?: string;
	catalog?: string;
	/** `model` hides internal/shadow agents and every resource the model may not invoke. Default operator. */
	audience?: "operator" | "model";
	/** Operator only: include shadow/internal agents. */
	all?: boolean;
	/** Packages match their own kind or a provided hint kind; resources match exactly. */
	kinds?: ReadonlyArray<LibraryEntryKind>;
	query?: string;
	/** `kind:name` package ref, a resource key, or a bare runtime name. */
	ref?: string;
	sources?: ReadonlyArray<LibraryResourceSourceClass>;
	/** Skip a whole reader when a caller does not need it. */
	include?: { packages?: boolean; copies?: boolean; resources?: boolean };
	trustProjectCompatRoots?: boolean;
	/** Testing seam: the config dir used for user roots. */
	configDir?: string;
	/** Testing seam: the home directory used for compatibility roots. */
	home?: string;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export function libraryResourceKey(
	kind: LibraryResourceKind,
	name: string,
	sourceId: string,
	relativePath: string,
): string {
	return `${kind}:${name}@${sourceId}#${relativePath}`;
}

export interface LibraryResourceKeyParts {
	kind: LibraryResourceKind;
	name: string;
	sourceId: string;
	/** Absent when a caller addresses every file with that name under that source. */
	relativePath?: string;
}

export function parseLibraryResourceKey(key: string): LibraryResourceKeyParts | undefined {
	const hash = key.indexOf("#");
	const head = hash >= 0 ? key.slice(0, hash) : key;
	const at = head.lastIndexOf("@");
	const colon = head.indexOf(":");
	if (at <= 0 || colon <= 0 || colon > at) return undefined;
	const kind = head.slice(0, colon);
	const name = head.slice(colon + 1, at);
	const sourceId = head.slice(at + 1);
	if (!isLibraryResourceKind(kind) || !name || !sourceId) return undefined;
	const relativePath = hash >= 0 ? key.slice(hash + 1) : undefined;
	return { kind, name, sourceId, ...(relativePath ? { relativePath } : {}) };
}

function keyMatches(key: string, parts: LibraryResourceKeyParts): boolean {
	const own = parseLibraryResourceKey(key);
	if (!own) return false;
	return (
		own.kind === parts.kind &&
		own.name === parts.name &&
		own.sourceId === parts.sourceId &&
		(parts.relativePath === undefined || own.relativePath === parts.relativePath)
	);
}

/** Anchors that turn an absolute file path into the contained relative path a key carries. */
interface KeyAnchors {
	cwd: string;
	home: string;
	configDir?: string;
	packageRoot?: string;
}

function relativeTo(anchor: string | undefined, filePath: string): string | undefined {
	if (!anchor) return undefined;
	const relative = path.relative(canonical(anchor), canonical(filePath));
	return contained(canonical(anchor), canonical(filePath)) ? relative.split(path.sep).join("/") : undefined;
}

function keyPath(anchors: KeyAnchors, sourceId: string, filePath: string, owner: LibraryCopy | undefined): string {
	const candidate =
		(owner ? relativeTo(owner.root, filePath) : undefined) ??
		(sourceId === "core" ? relativeTo(anchors.packageRoot, filePath) : undefined) ??
		(sourceId === "config" ? relativeTo(anchors.configDir, filePath) : undefined) ??
		(sourceId === "project" || sourceId.endsWith("-project") ? relativeTo(anchors.cwd, filePath) : undefined) ??
		relativeTo(anchors.home, filePath);
	return candidate ?? path.basename(filePath);
}

// ---------------------------------------------------------------------------
// Origin classification
// ---------------------------------------------------------------------------

function bundledLibraryDir(): string | undefined {
	try {
		return path.join(resolvePackageRoot(), "library");
	} catch {
		return undefined;
	}
}

function contained(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function canonical(value: string): string {
	try {
		return realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}

function underBundledLibrary(candidate: string): boolean {
	const dir = bundledLibraryDir();
	if (!dir || !path.isAbsolute(candidate)) return false;
	return contained(canonical(dir), canonical(candidate));
}

function bundledIndex(): string | undefined {
	try {
		return bundledLibraryIndexPath();
	} catch {
		return undefined;
	}
}

/** Loose-file source ids look like `claude-user`, `codex-project`; the prefix is the local agent. */
function compatHost(sourceId: string): string | undefined {
	const match = /^(.+)-(user|project)$/.exec(sourceId);
	const host = match?.[1];
	return host && host !== "unknown" ? host : undefined;
}

function formatForHost(host: string | undefined): LibraryPackageFormat | undefined {
	if (host === "claude" || host === "claude-code") return "claude-code";
	if (host === "codex") return "codex";
	return undefined;
}

export type LibraryOriginEvidence =
	| { kind: "catalog-row"; entry: LibraryPackageEntry }
	| { kind: "install-record"; record: PluginInstallRecord | undefined; rootPath: string }
	| { kind: "resource-root"; sourceId: string; path: string };

/** One rule shared by CLI, context and UI. Author metadata never reaches it. */
export function classifyLibraryOrigin(evidence: LibraryOriginEvidence): {
	origin: LibraryOrigin;
	format?: LibraryPackageFormat;
} {
	if (evidence.kind === "catalog-row") {
		const { entry } = evidence;
		if (entry.origin === "installed") return { origin: { kind: "unknown", detail: "no catalog row" } };
		const catalog = entry.index;
		const bundled = bundledIndex();
		if (catalog && bundled && canonical(catalog) === canonical(bundled))
			return { origin: { kind: "bundled", catalog }, format: "portable" };
		if (parsePluginGithubSource(entry.sourceUrl))
			return { origin: { kind: "remote", url: entry.sourceUrl, ...(catalog ? { catalog } : {}) }, format: "portable" };
		return { origin: { kind: "local", path: entry.sourceUrl, ...(catalog ? { catalog } : {}) }, format: "portable" };
	}
	if (evidence.kind === "install-record") {
		const { record } = evidence;
		if (!record) return { origin: { kind: "unknown", detail: "install record unavailable" } };
		const origin = record.origin;
		if (origin === undefined || typeof origin === "string") {
			const source = origin ?? record.source;
			if (parsePluginGithubSource(source)) return { origin: { kind: "remote", url: source }, format: "portable" };
			if (path.isAbsolute(source))
				return underBundledLibrary(source)
					? { origin: { kind: "bundled", catalog: bundledIndex() ?? source }, format: "portable" }
					: { origin: { kind: "local", path: source }, format: "portable" };
			return { origin: { kind: "unknown", detail: `unclassified source: ${source}` } };
		}
		switch (origin.kind) {
			case "catalog": {
				if (parsePluginGithubSource(origin.source))
					return { origin: { kind: "remote", url: origin.source }, format: "portable" };
				if (underBundledLibrary(origin.source))
					return { origin: { kind: "bundled", catalog: bundledIndex() ?? origin.source }, format: "portable" };
				return { origin: { kind: "local", path: origin.source }, format: "portable" };
			}
			case "github":
				return { origin: { kind: "remote", url: origin.source }, format: "portable" };
			case "local":
				return { origin: { kind: "local", path: origin.source }, format: "portable" };
			case "interop":
				return {
					origin: {
						kind: "imported",
						agent: origin.host,
						path: origin.source,
						...(origin.marketplace ? { marketplace: origin.marketplace } : {}),
					},
					format: origin.format ?? "portable",
				};
			case "import":
				return {
					origin:
						origin.transport === "github"
							? { kind: "remote", url: origin.source, ...(origin.host ? { host: origin.host } : {}) }
							: { kind: "local", path: origin.source, ...(origin.host ? { host: origin.host } : {}) },
					format: origin.format,
				};
			default:
				return { origin: { kind: "unknown", detail: "unrecognized origin record" } };
		}
	}
	const { sourceId } = evidence;
	if (sourceId === "core") return { origin: { kind: "core" } };
	if (sourceId.startsWith("plugin:"))
		return { origin: { kind: "unknown", detail: "package origin requires its installed copy record" } };
	if (sourceId === "config" || sourceId === "project")
		return { origin: { kind: "local", path: evidence.path }, format: "portable" };
	const host = compatHost(sourceId);
	const format = formatForHost(host);
	return {
		origin: { kind: "local", path: evidence.path, ...(host ? { host } : {}) },
		...(format ? { format } : {}),
	};
}

// ---------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------

/** The one copy-state projection, shared with lifecycle verification. */
export function libraryCopyState(plugin: InstalledPlugin): LibraryCopyState {
	if (plugin.loadable) return "loadable";
	if (!plugin.compatible) return "incompatible";
	// No parsed manifest means the copy is not a package any more; drift only
	// describes a package whose recorded bytes changed.
	if (!plugin.manifest) return "invalid";
	if (plugin.diagnostics.some((item) => item.message.includes("content drift"))) return "damaged";
	if (!plugin.valid) return "invalid";
	if (!plugin.enabled) return "disabled";
	if (!plugin.effective) return "shadowed";
	return "invalid";
}

function safeInstallRecord(plugin: InstalledPlugin, cwd: string): PluginInstallRecord | undefined {
	try {
		return readPluginInstallRecord(plugin.id, { cwd, scope: plugin.scope });
	} catch {
		return undefined;
	}
}

function projectCopy(plugin: InstalledPlugin, cwd: string): LibraryCopy {
	const kind = plugin.kind ?? "plugin";
	const record = safeInstallRecord(plugin, cwd);
	const classified = classifyLibraryOrigin({ kind: "install-record", record, rootPath: plugin.rootPath });
	return {
		ref: `${kind}:${plugin.id}`,
		kind,
		name: plugin.id,
		scope: plugin.scope,
		root: plugin.rootPath,
		version: plugin.version,
		state: libraryCopyState(plugin),
		enabled: plugin.enabled,
		valid: plugin.valid,
		compatible: plugin.compatible,
		effective: plugin.effective,
		loadable: plugin.loadable,
		trust: plugin.trust ?? "trusted",
		...(plugin.overriddenBy ? { overriddenBy: plugin.overriddenBy } : {}),
		origin: classified.origin,
		...(classified.format ? { format: classified.format } : {}),
		...(record?.contentDigest ? { recordedDigest: record.contentDigest } : {}),
		...(plugin.observedContentDigest ? { observedDigest: plugin.observedContentDigest } : {}),
		...(record?.installedAt ? { installedAt: record.installedAt } : {}),
		diagnostics: plugin.diagnostics
			.slice(0, LIBRARY_INVENTORY_LIMITS.copyDiagnostics)
			.map((item) => clip(item.message, LIBRARY_INVENTORY_LIMITS.message)),
	};
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

interface OwnerIndex {
	/** `plugin:<scope>:<id>` → copy */
	bySourceId: Map<string, LibraryCopy>;
	/** canonical root → copy, for readers that only expose a file path */
	roots: Array<{ root: string; copy: LibraryCopy }>;
	anchors: KeyAnchors;
}

function ownerIndex(copies: ReadonlyArray<LibraryCopy>, anchors: KeyAnchors): OwnerIndex {
	const bySourceId = new Map<string, LibraryCopy>();
	const roots: OwnerIndex["roots"] = [];
	for (const copy of copies) {
		bySourceId.set(`plugin:${copy.scope}:${copy.name}`, copy);
		roots.push({ root: canonical(copy.root), copy });
	}
	// Longest root first so a nested package root wins containment.
	roots.sort((a, b) => b.root.length - a.root.length);
	return { bySourceId, roots, anchors };
}

function ownerByPath(index: OwnerIndex, filePath: string): LibraryCopy | undefined {
	const target = canonical(filePath);
	return index.roots.find((item) => contained(item.root, target))?.copy;
}

function ownerOf(copy: LibraryCopy): NonNullable<LibraryResource["owner"]> {
	return { ref: copy.ref, scope: copy.scope };
}

function sourceClassFor(sourceId: string): LibraryResourceSourceClass {
	if (sourceId === "core") return "core";
	if (sourceId.startsWith("plugin:")) return "package";
	if (sourceId === "config") return "user";
	if (sourceId === "project") return "project";
	return "compat";
}

function resourceOrigin(
	sourceId: string,
	filePath: string,
	owner: LibraryCopy | undefined,
): { origin: LibraryOrigin; format?: LibraryPackageFormat } {
	if (owner) return { origin: owner.origin, ...(owner.format ? { format: owner.format } : {}) };
	return classifyLibraryOrigin({ kind: "resource-root", sourceId, path: filePath });
}

function bounded(diagnostics: ReadonlyArray<string>): string[] {
	return diagnostics
		.slice(0, LIBRARY_INVENTORY_LIMITS.resourceDiagnostics)
		.map((message) => clip(message, LIBRARY_INVENTORY_LIMITS.message));
}

function fromSkill(skill: Skill, index: OwnerIndex): LibraryResource {
	const sourceId = skill.sourceInfo.source ?? `${skill.source}-${skill.scope}`;
	const owner =
		index.bySourceId.get(sourceId) ?? (skill.scope === "package" ? ownerByPath(index, skill.filePath) : undefined);
	const hard = skill.diagnostics.some((item) => item.type === "error" || item.type === "collision");
	const availability: LibraryResourceAvailability = hard ? "invalid" : skill.trusted ? "available" : "untrusted";
	const reason = hard
		? skill.diagnostics.find((item) => item.type === "error" || item.type === "collision")?.message
		: !skill.trusted
			? "root is not trusted; enable integrations.projectResources.trustProjectImports or install the package"
			: undefined;
	const scope = skill.scope === "cli" ? "user" : skill.scope;
	return {
		key: libraryResourceKey("skill", skill.name, sourceId, keyPath(index.anchors, sourceId, skill.filePath, owner)),
		kind: "skill",
		name: skill.name,
		description: clip(skill.description),
		...(availability === "available" ? { invocation: `/skill ${skill.name}` } : {}),
		path: skill.filePath,
		source: { class: sourceClassFor(sourceId), id: sourceId, scope },
		...(owner ? { owner: ownerOf(owner) } : {}),
		...resourceOrigin(sourceId, skill.filePath, owner),
		availability,
		...(reason ? { reason: clip(reason, LIBRARY_INVENTORY_LIMITS.message) } : {}),
		trusted: skill.trusted,
		modelInvocable: skill.trusted && !skill.disableModelInvocation && !hard,
		diagnostics: bounded(skill.diagnostics.map((item) => item.message)),
	};
}

function fromPrompt(template: PromptTemplate, index: OwnerIndex): LibraryResource {
	const scope = template.sourceInfo.scope === "cli" ? "user" : template.sourceInfo.scope;
	const sourceId = template.sourceInfo.source ?? scope;
	const owner =
		index.bySourceId.get(sourceId) ?? (scope === "package" ? ownerByPath(index, template.filePath) : undefined);
	const availability: LibraryResourceAvailability = template.unavailable
		? "unavailable"
		: template.trusted
			? "available"
			: "untrusted";
	const reason = template.unavailable
		? template.unavailable
		: !template.trusted
			? "root is not trusted; enable integrations.projectResources.trustProjectImports or install the package"
			: undefined;
	return {
		key: libraryResourceKey(
			"prompt",
			template.name,
			sourceId,
			keyPath(index.anchors, sourceId, template.filePath, owner),
		),
		kind: "prompt",
		name: template.name,
		description: clip(template.description),
		...(availability === "available" ? { invocation: `/${template.name}` } : {}),
		path: template.filePath,
		source: { class: sourceClassFor(sourceId), id: sourceId, scope },
		...(owner ? { owner: ownerOf(owner) } : {}),
		...resourceOrigin(sourceId, template.filePath, owner),
		availability,
		...(reason ? { reason: clip(reason, LIBRARY_INVENTORY_LIMITS.message) } : {}),
		trusted: template.trusted,
		diagnostics: [],
	};
}

function agentSourceId(
	recipe: Pick<AgentRecipe, "source" | "filepath">,
	index: OwnerIndex,
): { sourceId: string; owner?: LibraryCopy } {
	if (recipe.source === "builtin") return { sourceId: "core" };
	if (recipe.source === "user") return { sourceId: "config" };
	if (recipe.source === "project") return { sourceId: "project" };
	const owner = ownerByPath(index, recipe.filepath);
	return owner ? { sourceId: `plugin:${owner.scope}:${owner.name}`, owner } : { sourceId: "plugin:unknown" };
}

function agentScope(source: AgentRecipe["source"]): "package" | "user" | "project" {
	return source === "user" ? "user" : source === "project" ? "project" : "package";
}

function fromAgent(recipe: AgentRecipe, index: OwnerIndex): LibraryResource {
	const { sourceId, owner } = agentSourceId(recipe, index);
	const scope = agentScope(recipe.source);
	return {
		key: libraryResourceKey("agent", recipe.id, sourceId, keyPath(index.anchors, sourceId, recipe.filepath, owner)),
		kind: "agent",
		name: recipe.id,
		description: clip(recipe.description),
		invocation: `dispatch(agent="${recipe.id}")`,
		path: recipe.filepath,
		source: { class: sourceClassFor(sourceId), id: sourceId, scope },
		...(owner ? { owner: ownerOf(owner) } : {}),
		...resourceOrigin(sourceId, recipe.filepath, owner),
		availability: "available",
		trusted: true,
		audience: recipe.audience,
		diagnostics: [],
	};
}

function fromAgentDiagnostic(diagnostic: AgentRecipeDiagnostic, index: OwnerIndex): LibraryResource {
	const { sourceId, owner } = agentSourceId({ source: diagnostic.source, filepath: diagnostic.filepath }, index);
	const scope = agentScope(diagnostic.source);
	const name = diagnostic.id ?? path.basename(diagnostic.filepath, ".md");
	const availability: LibraryResourceAvailability =
		diagnostic.kind === "overridden" ? "shadowed" : diagnostic.kind === "ignored" ? "unavailable" : "invalid";
	return {
		key: libraryResourceKey("agent", name, sourceId, keyPath(index.anchors, sourceId, diagnostic.filepath, owner)),
		kind: "agent",
		name,
		description: "",
		path: diagnostic.filepath,
		source: { class: sourceClassFor(sourceId), id: sourceId, scope },
		...(owner ? { owner: ownerOf(owner) } : {}),
		...resourceOrigin(sourceId, diagnostic.filepath, owner),
		availability,
		reason: clip(diagnostic.message, LIBRARY_INVENTORY_LIMITS.message),
		trusted: true,
		...(diagnostic.audience ? { audience: diagnostic.audience } : {}),
		diagnostics: bounded([diagnostic.message]),
	};
}

function fromFleet(listing: ReturnType<typeof listFleetContracts>[number], index: OwnerIndex): LibraryResource {
	const { sourceId, owner } = agentSourceId({ source: listing.source, filepath: listing.path }, index);
	const scope = agentScope(listing.source);
	const name = listing.contract?.name ?? listing.name;
	const availability: LibraryResourceAvailability = listing.contract
		? "available"
		: listing.needsCommands
			? "unavailable"
			: "invalid";
	const reason = listing.error ?? undefined;
	return {
		key: libraryResourceKey("fleet", name, sourceId, keyPath(index.anchors, sourceId, listing.path, owner)),
		kind: "fleet",
		name,
		description: clip(listing.contract?.description ?? ""),
		...(availability === "available" ? { invocation: `/fleet run ${name}` } : {}),
		path: listing.path,
		source: { class: sourceClassFor(sourceId), id: sourceId, scope },
		...(owner ? { owner: ownerOf(owner) } : {}),
		...resourceOrigin(sourceId, listing.path, owner),
		availability,
		...(reason ? { reason: clip(reason, LIBRARY_INVENTORY_LIMITS.message) } : {}),
		trusted: true,
		diagnostics: reason ? bounded([reason]) : [],
	};
}

/** A collision loser is a real file the loader read and discarded; it stays inspectable. */
function fromCollisionLoser(
	kind: LibraryResourceKind,
	diagnostic: ResourceDiagnostic,
	winners: ReadonlyArray<LibraryResource>,
	index: OwnerIndex,
	sourceIdFor: (filePath: string, scope: "package" | "user" | "project") => string,
): LibraryResource | undefined {
	const collision = diagnostic.collision;
	if (!collision) return undefined;
	if (winners.some((item) => item.path === collision.loserPath)) return undefined;
	const scope = collision.loserScope === "cli" ? "user" : collision.loserScope;
	const owner = scope === "package" ? ownerByPath(index, collision.loserPath) : undefined;
	const sourceId = owner ? `plugin:${owner.scope}:${owner.name}` : sourceIdFor(collision.loserPath, scope);
	return {
		key: libraryResourceKey(kind, collision.name, sourceId, keyPath(index.anchors, sourceId, collision.loserPath, owner)),
		kind,
		name: collision.name,
		description: "",
		path: collision.loserPath,
		source: { class: sourceClassFor(sourceId), id: sourceId, scope },
		...(owner ? { owner: ownerOf(owner) } : {}),
		...resourceOrigin(sourceId, collision.loserPath, owner),
		availability: "shadowed",
		reason: clip(diagnostic.message, LIBRARY_INVENTORY_LIMITS.message),
		trusted: false,
		diagnostics: bounded([diagnostic.message]),
	};
}

/**
 * Source id for a file the loaders only named in a collision diagnostic. Clio's
 * own roots map to `config`/`project`; a compatibility root maps to the id the
 * loader itself assigns (`claude-user` for skills, `claude-code-user` for
 * prompts) by containment in the interop registry's declared roots. A file
 * under no known root gets `unknown-<scope>`, never an invented vendor.
 */
function looseSourceId(anchors: KeyAnchors, kind: "skill" | "prompt") {
	return (filePath: string, scope: "package" | "user" | "project"): string => {
		if (scope === "package") return "plugin:unknown";
		const target = canonical(filePath);
		if (scope === "project" && contained(canonical(path.join(anchors.cwd, ".clio-coder")), target)) return "project";
		if (scope === "user" && anchors.configDir && contained(canonical(anchors.configDir), target)) return "config";
		const base = scope === "user" ? anchors.home : anchors.cwd;
		for (const agent of INTEROP_AGENT_KINDS) {
			const root =
				kind === "skill"
					? scope === "user"
						? agent.userSkillRoot
						: agent.projectSkillRoot
					: scope === "user"
						? agent.userPromptRoot
						: agent.projectPromptRoot;
			const id = kind === "skill" ? agent.skillSource : agent.id;
			if (root && id && contained(canonical(path.join(base, root)), target)) return `${id}-${scope}`;
		}
		return `unknown-${scope}`;
	};
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

interface Selection {
	packageRef?: LibraryRequirementRef;
	resourceKey?: ReturnType<typeof parseLibraryResourceKey>;
	name?: string;
}

function parseSelection(ref: string | undefined): Selection {
	if (!ref) return {};
	const key = parseLibraryResourceKey(ref);
	if (key) return { resourceKey: key };
	const colon = ref.indexOf(":");
	if (colon > 0 && isLibraryKind(ref.slice(0, colon))) return { packageRef: ref as LibraryRequirementRef };
	return { name: ref };
}

function matchesQuery(query: string | undefined, ...fields: ReadonlyArray<string | undefined>): boolean {
	if (!query) return true;
	const needle = query.toLowerCase();
	return fields.some((field) => field?.toLowerCase().includes(needle));
}

function packageMatches(record: LibraryPackageRecord, options: LibraryInventoryOptions, selection: Selection): boolean {
	if (selection.packageRef && record.ref !== selection.packageRef) return false;
	if (selection.name && record.name !== selection.name && !record.provides?.some((hint) => hint.name === selection.name))
		return false;
	if (selection.resourceKey) {
		// An exact key names one file under one source. Only its owner answers;
		// hints in other packages never match a key that already has an owner.
		const key = selection.resourceKey;
		if (!key.sourceId.startsWith("plugin:") || key.sourceId.split(":")[2] !== record.name) return false;
	}
	if (options.kinds?.length) {
		const kinds = options.kinds;
		if (!kinds.includes(record.kind) && !record.provides?.some((hint) => kinds.includes(hint.kind))) return false;
	}
	return matchesQuery(
		options.query,
		record.name,
		record.description,
		...(record.provides ?? []).map((hint) => hint.name),
	);
}

function copyMatches(copy: LibraryCopy, options: LibraryInventoryOptions, selection: Selection): boolean {
	if (selection.packageRef && copy.ref !== selection.packageRef) return false;
	if (selection.name && copy.name !== selection.name) return false;
	if (selection.resourceKey && selection.resourceKey.sourceId !== `plugin:${copy.scope}:${copy.name}`) return false;
	if (options.kinds?.length && !options.kinds.includes(copy.kind)) return false;
	return true;
}

function resourceMatches(resource: LibraryResource, options: LibraryInventoryOptions, selection: Selection): boolean {
	if (selection.packageRef && resource.owner?.ref !== selection.packageRef) {
		const [kind, name] = selection.packageRef.split(":", 2);
		if (!(kind === resource.kind && name === resource.name)) return false;
	}
	if (selection.name && resource.name !== selection.name) return false;
	if (selection.resourceKey && !keyMatches(resource.key, selection.resourceKey)) return false;
	if (options.kinds?.length && !options.kinds.includes(resource.kind)) return false;
	if (options.sources?.length && !options.sources.includes(resource.source.class)) return false;
	return matchesQuery(options.query, resource.name, resource.description);
}

function audienceAdmits(resource: LibraryResource, options: LibraryInventoryOptions): boolean {
	const model = options.audience === "model";
	if (resource.kind === "agent" && (resource.audience === "shadow" || resource.audience === "internal"))
		return !model && options.all === true;
	if (model) return resource.availability === "available" && resource.modelInvocable !== false;
	return true;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function trustSetting(explicit: boolean | undefined): boolean {
	if (explicit !== undefined) return explicit;
	try {
		return readSettings().integrations.projectResources.trustProjectImports;
	} catch {
		return false;
	}
}

function sortResources(items: LibraryResource[]): LibraryResource[] {
	const order: Record<LibraryResourceKind, number> = { skill: 0, agent: 1, prompt: 2, fleet: 3 };
	return items.sort(
		(a, b) =>
			order[a.kind] - order[b.kind] ||
			a.name.localeCompare(b.name) ||
			a.source.id.localeCompare(b.source.id) ||
			a.key.localeCompare(b.key),
	);
}

export function readLibraryInventory(options: LibraryInventoryOptions = {}): LibraryInventory {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const include = { packages: true, copies: true, resources: true, ...(options.include ?? {}) };
	const selection = parseSelection(options.ref);
	const diagnostics = new Bounded<string>(LIBRARY_INVENTORY_LIMITS.diagnostics);
	const note = (message: string): void => {
		const text = clip(message, LIBRARY_INVENTORY_LIMITS.message);
		if (!diagnostics.items.includes(text)) diagnostics.push(text);
	};
	const wants = (kind: LibraryResourceKind): boolean => !options.kinds?.length || options.kinds.includes(kind);

	// Copies underpin package state and resource ownership, so they are read
	// whenever either of those is requested. The package engine enumerates every
	// scoped copy for precedence; only the projection is capped here.
	const installed =
		include.copies || include.packages || include.resources ? listInstalledPlugins(cwd, { all: true }) : [];
	const copyRows = new Bounded<LibraryCopy>(LIBRARY_INVENTORY_LIMITS.copies);
	for (const plugin of installed) if (!copyRows.push(projectCopy(plugin, cwd))) break;
	if (copyRows.truncated) note("installed copies truncated; later copies have no owner rows");
	const copies = copyRows.items;
	const copiesByRef = new Map<string, LibraryCopy[]>();
	for (const copy of copies) copiesByRef.set(copy.ref, [...(copiesByRef.get(copy.ref) ?? []), copy]);

	const packages = new Bounded<LibraryPackageRecord>(LIBRARY_INVENTORY_LIMITS.packages);
	if (include.packages) {
		const discovery = discoverLibrary({ cwd, ...(options.catalog ? { catalog: options.catalog } : {}) });
		for (const message of discovery.diagnostics) note(message);
		for (const entry of discovery.entries) {
			const ref: LibraryRequirementRef = `${entry.kind}:${entry.name}`;
			const own = copiesByRef.get(ref) ?? [];
			const classified =
				entry.origin === "installed" && own[0]
					? { origin: own[0].origin, ...(own[0].format ? { format: own[0].format } : {}) }
					: classifyLibraryOrigin({ kind: "catalog-row", entry });
			const refusal = discovery.refusals[ref];
			const record: LibraryPackageRecord = {
				ref,
				kind: entry.kind,
				name: entry.name,
				description: clip(entry.description),
				...(entry.version ? { version: entry.version } : {}),
				...(entry.sha256 ? { sha256: entry.sha256 } : {}),
				sourceUrl: entry.sourceUrl,
				...(entry.requires ? { requires: entry.requires } : {}),
				origin: classified.origin,
				...(classified.format ? { format: classified.format } : {}),
				...(entry.provides ? { provides: entry.provides } : {}),
				catalogOrigin: entry.origin,
				copies: own.map((copy) => ({ scope: copy.scope, state: copy.state })),
				...(refusal ? { refusal } : {}),
			};
			// discoverLibrary already sorts by ref; selection is applied before the cap.
			if (packageMatches(record, options, selection) && !packages.push(record)) break;
		}
	}

	const resources = new Bounded<LibraryResource>(LIBRARY_INVENTORY_LIMITS.resources);
	if (include.resources) {
		let configDir = options.configDir;
		if (!configDir) {
			try {
				configDir = clioConfigDir();
			} catch {
				configDir = undefined;
			}
		}
		let packageRoot: string | undefined;
		try {
			packageRoot = resolvePackageRoot();
		} catch {
			packageRoot = undefined;
		}
		const index = ownerIndex(copies, {
			cwd,
			home: options.home ?? homedir(),
			...(configDir ? { configDir } : {}),
			...(packageRoot ? { packageRoot } : {}),
		});
		const trustProjectCompatRoots = trustSetting(options.trustProjectCompatRoots);
		// Each loader enumerates its whole root set because precedence needs every
		// candidate. What is bounded here is which loaders run and what is projected.
		const skillRows: LibraryResource[] = [];
		if (wants("skill")) {
			const skills = loadSkills({
				cwd,
				trustProjectCompatRoots,
				...(options.configDir ? { configDir: options.configDir } : {}),
				...(options.home ? { home: options.home } : {}),
			});
			const loose = looseSourceId(index.anchors, "skill");
			for (const skill of skills.items) skillRows.push(fromSkill(skill, index));
			for (const diagnostic of skills.diagnostics) {
				const loser =
					diagnostic.type === "collision" ? fromCollisionLoser("skill", diagnostic, skillRows, index, loose) : undefined;
				if (loser) skillRows.push(loser);
				else if (diagnostic.type !== "collision")
					note(`skill: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`);
			}
		}
		const promptRows: LibraryResource[] = [];
		if (wants("prompt")) {
			const prompts = loadPromptTemplates({
				cwd,
				trustProjectCompatRoots,
				...(options.home ? { home: options.home } : {}),
			});
			const loose = looseSourceId(index.anchors, "prompt");
			for (const template of prompts.items) promptRows.push(fromPrompt(template, index));
			for (const diagnostic of prompts.diagnostics) {
				const loser =
					diagnostic.type === "collision" ? fromCollisionLoser("prompt", diagnostic, promptRows, index, loose) : undefined;
				if (loser) promptRows.push(loser);
				else if (diagnostic.type !== "collision")
					note(`prompt: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`);
			}
		}
		const agentRows: LibraryResource[] = [];
		if (wants("agent")) {
			const agentDiagnostics: AgentRecipeDiagnostic[] = [];
			try {
				for (const recipe of discoverAgentRecipes(cwd, agentDiagnostics)) agentRows.push(fromAgent(recipe, index));
			} catch (error) {
				note(`agent: discovery failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			for (const diagnostic of agentDiagnostics) agentRows.push(fromAgentDiagnostic(diagnostic, index));
		}
		const fleetRows: LibraryResource[] = [];
		if (wants("fleet")) {
			try {
				for (const listing of listFleetContracts(cwd)) fleetRows.push(fromFleet(listing, index));
			} catch (error) {
				note(`fleet: discovery failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		// Audience and selection are applied per row while collecting, so the cap
		// bounds admitted rows rather than a superset that is sliced afterwards.
		for (const row of sortResources([...skillRows, ...promptRows, ...agentRows, ...fleetRows])) {
			if (!audienceAdmits(row, options) || !resourceMatches(row, options, selection)) continue;
			if (!resources.push(row)) break;
		}
	}

	const selectedCopies = include.copies
		? copies
				.filter((copy) => copyMatches(copy, options, selection))
				.sort((a, b) => a.ref.localeCompare(b.ref) || a.scope.localeCompare(b.scope))
		: [];
	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		cwd,
		audience: options.audience ?? "operator",
		packages: packages.items,
		copies: selectedCopies,
		resources: resources.items,
		diagnostics: diagnostics.items,
		truncated: {
			packages: packages.truncated,
			// Copies also supply package status and resource ownership when omitted
			// from the public copy list. Consumers must know when that evidence is partial.
			copies: copyRows.truncated,
			resources: resources.truncated,
		},
	};
}

// ---------------------------------------------------------------------------
// Explicit deeper read for one copy
// ---------------------------------------------------------------------------

export interface LibraryCopyInspection {
	copy: LibraryCopy;
	resources: Array<{
		kind: LibraryResourceKind;
		name: string;
		path: string;
		componentId?: string;
		description?: string;
		valid: boolean;
		diagnostics: string[];
	}>;
	ancillary: Array<{ kind: string; id: string; path: string; valid: boolean }>;
	prerequisites: LibraryValidationPrerequisite[];
	diagnostics: string[];
}

/**
 * Enumerate one installed copy's members through the shared validator. This
 * reads a disabled, shadowed or damaged copy too, which the runtime loaders
 * never do; it is the explicit inspection the listing deliberately avoids.
 */
export function inspectLibraryCopy(
	ref: string,
	options: { cwd?: string; scope?: PluginScope } = {},
): LibraryCopyInspection {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	// Resolve precedence across both scopes before selecting the copy to inspect.
	const candidates = listInstalledPlugins(cwd, { all: true })
		.filter((item) => !options.scope || item.scope === options.scope)
		.filter((item) => (ref.includes(":") ? `${item.kind ?? "plugin"}:${item.id}` === ref : item.id === ref))
		.sort((a, b) => Number(b.scope === "project") - Number(a.scope === "project"));
	const plugin = candidates[0];
	if (!plugin) throw new Error(`package not installed: ${ref}`);
	const copy = projectCopy(plugin, cwd);
	if (!existsSync(plugin.rootPath))
		return { copy, resources: [], ancillary: [], prerequisites: [], diagnostics: ["package root is missing"] };
	const result = validateLibraryPackage(plugin.rootPath, { cwd });
	const components = new Map(
		(result.manifest?.clio.components ?? []).map((component) => [`${component.kind}:${component.id}`, component.id]),
	);
	const resources: LibraryCopyInspection["resources"] = [];
	const ancillary: LibraryCopyInspection["ancillary"] = [];
	for (const record of result.validation.resources) {
		if (isLibraryResourceKind(record.kind)) {
			const componentId = record.componentRef ? components.get(record.componentRef) : undefined;
			resources.push({
				kind: record.kind,
				name: record.name,
				path: record.path,
				...(componentId && componentId !== record.name ? { componentId } : {}),
				...(record.description !== undefined ? { description: record.description } : {}),
				valid: record.valid,
				diagnostics: bounded(record.diagnostics.map((item) => item.message)),
			});
		} else ancillary.push({ kind: record.kind, id: record.name, path: record.path, valid: record.valid });
	}
	return {
		copy,
		resources,
		ancillary,
		prerequisites: result.validation.prerequisites,
		diagnostics: [
			...result.diagnostics.map((item) => item.message),
			...result.validation.diagnostics.map((item) => `[${item.code}] ${item.message}`),
		].slice(0, LIBRARY_INVENTORY_LIMITS.copyDiagnostics),
	};
}
