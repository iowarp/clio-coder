import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clioConfigDir } from "../../core/xdg.js";
import { isRecord, loadManifestFromRoot, trimString } from "./discovery.js";
import type {
	ExtensionInstallOptions,
	ExtensionInstallResult,
	ExtensionListOptions,
	ExtensionMutationResult,
	ExtensionScope,
	ExtensionState,
	InstalledExtension,
} from "./types.js";

const DEFAULT_STATE: ExtensionState = { version: 1, disabled: [], installed: {} };

export function extensionBaseDir(scope: ExtensionScope, cwd = process.cwd()): string {
	return scope === "user"
		? path.join(clioConfigDir(), "extensions")
		: path.join(path.resolve(cwd), ".clio", "extensions");
}

function statePath(scope: ExtensionScope, cwd = process.cwd()): string {
	return path.join(extensionBaseDir(scope, cwd), "state.json");
}

export function scopeRank(scope: ExtensionScope): number {
	return scope === "project" ? 2 : 1;
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
	}
	const parent = path.dirname(targetRoot);
	const stagingRoot = path.join(parent, `.${candidate.manifest.id}.install-${process.pid}-${Date.now()}`);
	const backupRoot = path.join(parent, `.${candidate.manifest.id}.backup-${process.pid}-${Date.now()}`);
	let installedReplacement = false;
	let movedExisting = false;
	const state = readState(scope, cwd);
	try {
		mkdirSync(parent, { recursive: true });
		rmSync(stagingRoot, { recursive: true, force: true });
		rmSync(backupRoot, { recursive: true, force: true });
		cpSync(source, stagingRoot, {
			recursive: true,
			filter: (src) => path.basename(src) !== "state.json",
		});
		if (existsSync(targetRoot)) {
			renameSync(targetRoot, backupRoot);
			movedExisting = true;
		}
		renameSync(stagingRoot, targetRoot);
		installedReplacement = true;
		state.installed[candidate.manifest.id] = { installedAt: new Date().toISOString(), source };
		state.disabled = state.disabled.filter((entry) => entry !== candidate.manifest?.id);
		writeState(scope, state, cwd);
		rmSync(backupRoot, { recursive: true, force: true });
	} catch (error) {
		rmSync(stagingRoot, { recursive: true, force: true });
		if (installedReplacement) rmSync(targetRoot, { recursive: true, force: true });
		if (movedExisting && existsSync(backupRoot) && !existsSync(targetRoot)) {
			renameSync(backupRoot, targetRoot);
		}
		return {
			diagnostics: [
				{
					type: "error",
					message: `extension ${candidate.manifest.id} install failed: ${error instanceof Error ? error.message : String(error)}`,
					path: targetRoot,
				},
			],
		};
	}
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
