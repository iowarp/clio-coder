import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { clioConfigDir } from "../../core/xdg.js";

export type ExtensionScope = "user" | "project";
export type ExtensionResourceKind = "skills" | "prompts" | "themes";

export interface ExtensionManifestResources {
	skills?: string;
	prompts?: string;
	themes?: string;
}

export interface ClioExtensionManifest {
	manifestVersion: 1;
	id: string;
	name: string;
	version: string;
	description: string;
	resources: ExtensionManifestResources;
	tools?: string[];
	settings?: string[];
	compatibility?: { clio?: string };
}

export interface ExtensionDiagnostic {
	type: "warning" | "error";
	message: string;
	path?: string;
}

export interface InstalledExtension {
	id: string;
	name: string;
	version: string;
	description: string;
	scope: ExtensionScope;
	rootPath: string;
	manifestPath: string;
	enabled: boolean;
	effective: boolean;
	resources: ExtensionManifestResources;
	overriddenBy?: ExtensionScope;
	diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionCandidate {
	path: string;
	manifestPath?: string;
	manifest?: ClioExtensionManifest;
	valid: boolean;
	diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionResourceRoot {
	id: string;
	scope: ExtensionScope;
	path: string;
	source: string;
}

export interface ExtensionListOptions {
	scope?: ExtensionScope;
	cwd?: string;
	all?: boolean;
}

export interface ExtensionInstallOptions extends ExtensionListOptions {
	force?: boolean;
}

export interface ExtensionInstallResult {
	extension?: InstalledExtension;
	diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionMutationResult {
	extension?: InstalledExtension;
	removed?: { id: string; scope: ExtensionScope; path: string };
	diagnostics: ExtensionDiagnostic[];
}

interface ExtensionState {
	version: 1;
	disabled: string[];
	installed: Record<string, { installedAt: string; source?: string }>;
}

const MANIFEST_NAMES = ["clio-extension.yaml", "clio-extension.yml", "clio-extension.json"] as const;
const DEFAULT_STATE: ExtensionState = { version: 1, disabled: [], installed: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function validateId(id: string): string | null {
	if (id.length > 80) return "id exceeds 80 characters";
	if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(id)) {
		return "id must use lowercase letters, numbers, dots, underscores, or hyphens and start/end alphanumeric";
	}
	return null;
}

function extensionBaseDir(scope: ExtensionScope, cwd = process.cwd()): string {
	return scope === "user"
		? path.join(clioConfigDir(), "extensions")
		: path.join(path.resolve(cwd), ".clio", "extensions");
}

function statePath(scope: ExtensionScope, cwd = process.cwd()): string {
	return path.join(extensionBaseDir(scope, cwd), "state.json");
}

function scopeRank(scope: ExtensionScope): number {
	return scope === "project" ? 2 : 1;
}

function readJsonOrYaml(filePath: string): unknown {
	const raw = readFileSync(filePath, "utf8");
	if (filePath.endsWith(".json")) return JSON.parse(raw);
	return parseYaml(raw);
}

function normalizeResources(value: unknown): ExtensionManifestResources {
	if (!isRecord(value)) return {};
	const out: ExtensionManifestResources = {};
	const skills = trimString(value.skills);
	const prompts = trimString(value.prompts);
	const themes = trimString(value.themes);
	if (skills) out.skills = skills;
	if (prompts) out.prompts = prompts;
	if (themes) out.themes = themes;
	return out;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.map((entry) => trimString(entry)).filter((entry): entry is string => entry !== undefined);
	return out.length > 0 ? out : undefined;
}

export function parseExtensionManifest(
	value: unknown,
	manifestPath: string,
): {
	manifest?: ClioExtensionManifest;
	diagnostics: ExtensionDiagnostic[];
} {
	const diagnostics: ExtensionDiagnostic[] = [];
	if (!isRecord(value)) {
		return { diagnostics: [{ type: "error", message: "extension manifest must be an object", path: manifestPath }] };
	}
	if (value.manifestVersion !== 1) {
		diagnostics.push({ type: "error", message: "manifestVersion must be 1", path: manifestPath });
	}
	const id = trimString(value.id);
	const name = trimString(value.name) ?? id;
	const version = trimString(value.version);
	const description = trimString(value.description);
	if (!id) diagnostics.push({ type: "error", message: "id is required", path: manifestPath });
	else {
		const idError = validateId(id);
		if (idError) diagnostics.push({ type: "error", message: idError, path: manifestPath });
	}
	if (!version) diagnostics.push({ type: "error", message: "version is required", path: manifestPath });
	if (!description) diagnostics.push({ type: "error", message: "description is required", path: manifestPath });
	const resources = normalizeResources(value.resources);
	const tools = stringArray(value.tools);
	const settings = stringArray(value.settings);
	const compatibility = isRecord(value.compatibility)
		? { ...(trimString(value.compatibility.clio) ? { clio: trimString(value.compatibility.clio) as string } : {}) }
		: undefined;
	if (!id || !name || !version || !description || diagnostics.some((diag) => diag.type === "error")) {
		return { diagnostics };
	}
	const manifest: ClioExtensionManifest = {
		manifestVersion: 1,
		id,
		name,
		version,
		description,
		resources,
	};
	if (tools) manifest.tools = tools;
	if (settings) manifest.settings = settings;
	if (compatibility && Object.keys(compatibility).length > 0) manifest.compatibility = compatibility;
	return { manifest, diagnostics };
}

export function findExtensionManifestPath(root: string): string | null {
	for (const name of MANIFEST_NAMES) {
		const candidate = path.join(root, name);
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// absent
		}
	}
	return null;
}

function loadManifestFromRoot(root: string): ExtensionCandidate {
	const manifestPath = findExtensionManifestPath(root);
	if (!manifestPath) {
		return {
			path: root,
			valid: false,
			diagnostics: [{ type: "error", message: "extension manifest not found", path: root }],
		};
	}
	try {
		const parsed = parseExtensionManifest(readJsonOrYaml(manifestPath), manifestPath);
		return {
			path: root,
			manifestPath,
			...(parsed.manifest ? { manifest: parsed.manifest } : {}),
			valid: parsed.manifest !== undefined && !parsed.diagnostics.some((diag) => diag.type === "error"),
			diagnostics: parsed.diagnostics,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			path: root,
			manifestPath,
			valid: false,
			diagnostics: [{ type: "error", message: `extension manifest could not be read: ${reason}`, path: manifestPath }],
		};
	}
}

export function discoverExtensionPackages(root: string): ExtensionCandidate[] {
	const full = path.resolve(root);
	if (!existsSync(full)) {
		return [{ path: full, valid: false, diagnostics: [{ type: "error", message: "path does not exist", path: full }] }];
	}
	const stat = statSync(full);
	if (!stat.isDirectory()) {
		return [
			{
				path: full,
				valid: false,
				diagnostics: [{ type: "error", message: "extension path is not a directory", path: full }],
			},
		];
	}
	const direct = loadManifestFromRoot(full);
	if (direct.valid || direct.manifestPath) return [direct];
	const candidates: ExtensionCandidate[] = [];
	for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const child = path.join(full, entry.name);
		const loaded = loadManifestFromRoot(child);
		if (loaded.valid || loaded.manifestPath) candidates.push(loaded);
	}
	return candidates.length > 0 ? candidates : [direct];
}

function readState(scope: ExtensionScope, cwd = process.cwd()): ExtensionState {
	const filePath = statePath(scope, cwd);
	if (!existsSync(filePath)) return structuredClone(DEFAULT_STATE);
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		if (!isRecord(parsed) || parsed.version !== 1) return structuredClone(DEFAULT_STATE);
		const disabled = Array.isArray(parsed.disabled)
			? parsed.disabled.filter((entry): entry is string => typeof entry === "string")
			: [];
		const installed = isRecord(parsed.installed)
			? Object.fromEntries(
					Object.entries(parsed.installed).flatMap(([id, raw]) => {
						if (!isRecord(raw)) return [];
						const installedAt = trimString(raw.installedAt) ?? new Date(0).toISOString();
						const source = trimString(raw.source);
						return [[id, { installedAt, ...(source ? { source } : {}) }]];
					}),
				)
			: {};
		return { version: 1, disabled, installed };
	} catch {
		return structuredClone(DEFAULT_STATE);
	}
}

function writeState(scope: ExtensionScope, state: ExtensionState, cwd = process.cwd()): void {
	const filePath = statePath(scope, cwd);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function installedFromRoot(root: string, scope: ExtensionScope, state: ExtensionState): InstalledExtension | null {
	const candidate = loadManifestFromRoot(root);
	const manifest = candidate.manifest;
	if (!manifest || !candidate.manifestPath) return null;
	return {
		id: manifest.id,
		name: manifest.name,
		version: manifest.version,
		description: manifest.description,
		scope,
		rootPath: root,
		manifestPath: candidate.manifestPath,
		enabled: !state.disabled.includes(manifest.id),
		effective: false,
		resources: manifest.resources,
		diagnostics: candidate.diagnostics,
	};
}

function listScope(scope: ExtensionScope, cwd = process.cwd()): InstalledExtension[] {
	const base = extensionBaseDir(scope, cwd);
	if (!existsSync(base)) return [];
	const state = readState(scope, cwd);
	const out: InstalledExtension[] = [];
	for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const root = path.join(base, entry.name);
		const installed = installedFromRoot(root, scope, state);
		if (installed) out.push(installed);
	}
	return out;
}

export function listInstalledExtensions(cwd = process.cwd(), options: ExtensionListOptions = {}): InstalledExtension[] {
	const scopes: ExtensionScope[] = options.scope ? [options.scope] : ["user", "project"];
	const entries = scopes.flatMap((scope) => listScope(scope, cwd));
	const byId = new Map<string, InstalledExtension[]>();
	for (const entry of entries) {
		const list = byId.get(entry.id) ?? [];
		list.push(entry);
		byId.set(entry.id, list);
	}
	for (const group of byId.values()) {
		const winner = [...group].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope)).at(-1);
		for (const entry of group) {
			entry.effective = entry === winner;
			if (!entry.effective && winner) entry.overriddenBy = winner.scope;
		}
	}
	const all = options.all === true ? entries : entries.filter((entry) => entry.effective);
	return all.sort((a, b) => {
		const id = a.id.localeCompare(b.id);
		if (id !== 0) return id;
		return scopeRank(a.scope) - scopeRank(b.scope);
	});
}

function findInstalled(id: string, cwd: string, scope?: ExtensionScope): InstalledExtension | null {
	const entries = listInstalledExtensions(cwd, { ...(scope ? { scope } : {}), all: true }).filter(
		(entry) => entry.id === id,
	);
	if (entries.length === 0) return null;
	return [...entries].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope)).at(-1) ?? null;
}

export function installExtension(sourcePath: string, options: ExtensionInstallOptions = {}): ExtensionInstallResult {
	const scope = options.scope ?? "user";
	const cwd = options.cwd ?? process.cwd();
	const source = path.resolve(sourcePath);
	const candidate = loadManifestFromRoot(source);
	if (!candidate.manifest) return { diagnostics: candidate.diagnostics };
	const targetRoot = path.join(extensionBaseDir(scope, cwd), candidate.manifest.id);
	if (existsSync(targetRoot)) {
		if (!options.force) {
			return {
				diagnostics: [
					{ type: "error", message: `extension ${candidate.manifest.id} is already installed`, path: targetRoot },
				],
			};
		}
		rmSync(targetRoot, { recursive: true, force: true });
	}
	mkdirSync(path.dirname(targetRoot), { recursive: true });
	cpSync(source, targetRoot, {
		recursive: true,
		filter: (src) => path.basename(src) !== "state.json",
	});
	const state = readState(scope, cwd);
	state.installed[candidate.manifest.id] = { installedAt: new Date().toISOString(), source };
	state.disabled = state.disabled.filter((entry) => entry !== candidate.manifest?.id);
	writeState(scope, state, cwd);
	const installed = findInstalled(candidate.manifest.id, cwd, scope);
	return {
		...(installed ? { extension: installed } : {}),
		diagnostics: candidate.diagnostics,
	};
}

function mutateEnabled(id: string, enabled: boolean, options: ExtensionListOptions = {}): ExtensionMutationResult {
	const cwd = options.cwd ?? process.cwd();
	const target = findInstalled(id, cwd, options.scope);
	if (!target) {
		return { diagnostics: [{ type: "error", message: `extension ${id} is not installed` }] };
	}
	const state = readState(target.scope, cwd);
	if (enabled) state.disabled = state.disabled.filter((entry) => entry !== id);
	else if (!state.disabled.includes(id)) state.disabled.push(id);
	writeState(target.scope, state, cwd);
	const extension = findInstalled(id, cwd, target.scope) ?? undefined;
	return { ...(extension ? { extension } : {}), diagnostics: [] };
}

export function enableExtension(id: string, options: ExtensionListOptions = {}): ExtensionMutationResult {
	return mutateEnabled(id, true, options);
}

export function disableExtension(id: string, options: ExtensionListOptions = {}): ExtensionMutationResult {
	return mutateEnabled(id, false, options);
}

export function removeExtension(id: string, options: ExtensionListOptions = {}): ExtensionMutationResult {
	const cwd = options.cwd ?? process.cwd();
	const target = findInstalled(id, cwd, options.scope);
	if (!target) {
		return { diagnostics: [{ type: "error", message: `extension ${id} is not installed` }] };
	}
	rmSync(target.rootPath, { recursive: true, force: true });
	const state = readState(target.scope, cwd);
	Reflect.deleteProperty(state.installed, id);
	state.disabled = state.disabled.filter((entry) => entry !== id);
	writeState(target.scope, state, cwd);
	return { removed: { id, scope: target.scope, path: target.rootPath }, diagnostics: [] };
}

export function enabledExtensionResourceRoots(
	kind: ExtensionResourceKind,
	cwd = process.cwd(),
): ExtensionResourceRoot[] {
	const roots: ExtensionResourceRoot[] = [];
	for (const entry of listInstalledExtensions(cwd)) {
		if (!entry.enabled || !entry.effective) continue;
		const rel = entry.resources[kind];
		if (!rel) continue;
		const full = path.resolve(entry.rootPath, rel);
		if (!full.startsWith(path.resolve(entry.rootPath))) continue;
		try {
			if (!statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		roots.push({
			id: entry.id,
			scope: entry.scope,
			path: full,
			source: `extension:${entry.scope}:${entry.id}`,
		});
	}
	return roots;
}

export function extensionManifestYaml(manifest: ClioExtensionManifest): string {
	return stringifyYaml(manifest);
}
