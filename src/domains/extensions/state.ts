import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioConfigDir } from "../../core/xdg.js";
import { evaluateClioCompatibility } from "./compatibility.js";
import { isRecord, loadManifestFromRoot, trimString } from "./discovery.js";
import { extensionContentDigest } from "./integrity.js";
import type {
	ExtensionDiagnostic,
	ExtensionInstallOptions,
	ExtensionInstallResult,
	ExtensionListOptions,
	ExtensionMutationResult,
	ExtensionScope,
	ExtensionState,
	ExtensionStateUpgradeReport,
	InstalledExtension,
} from "./types.js";

const DEFAULT_STATE: ExtensionState = { version: 1, disabled: [], installed: {} };

type StateReadResult =
	| { status: "absent"; state: ExtensionState }
	| { status: "valid"; state: ExtensionState }
	| { status: "corrupt"; state: ExtensionState; message: string };

export function extensionBaseDir(scope: ExtensionScope, cwd = process.cwd()): string {
	return scope === "user"
		? path.join(clioConfigDir(), "extensions")
		: path.join(path.resolve(cwd), ".clio-coder", "extensions");
}

function statePath(scope: ExtensionScope, cwd = process.cwd()): string {
	return path.join(extensionBaseDir(scope, cwd), "state.json");
}

function recoveryPath(filePath: string, label: string): string {
	return `${filePath}.${label}-${process.pid}-${Date.now()}.bak`;
}

function packageRecoveryPath(root: string, label: string): string {
	return path.join(path.dirname(root), `.${path.basename(root)}.${label}-${process.pid}-${Date.now()}.bak`);
}

function preserveFile(filePath: string, label: string): string | undefined {
	if (!existsSync(filePath)) return undefined;
	const backupPath = recoveryPath(filePath, label);
	safeResourceWrite(backupPath, readFileSync(filePath));
	return backupPath;
}

export function scopeRank(scope: ExtensionScope): number {
	return scope === "project" ? 2 : 1;
}

function readState(scope: ExtensionScope, cwd = process.cwd()): StateReadResult {
	const filePath = statePath(scope, cwd);
	if (!existsSync(filePath)) return { status: "absent", state: structuredClone(DEFAULT_STATE) };
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		if (!isRecord(parsed) || parsed.version !== 1) throw new Error("state must be a version 1 object");
		if (!Array.isArray(parsed.disabled) || !parsed.disabled.every((entry) => typeof entry === "string")) {
			throw new Error("state.disabled must be an array of strings");
		}
		if (!isRecord(parsed.installed)) throw new Error("state.installed must be an object");
		const installed: ExtensionState["installed"] = {};
		for (const [id, raw] of Object.entries(parsed.installed)) {
			if (!isRecord(raw)) throw new Error(`state.installed.${id} must be an object`);
			const installedAt = trimString(raw.installedAt);
			if (!installedAt) throw new Error(`state.installed.${id}.installedAt must be a non-empty string`);
			const source = raw.source === undefined ? undefined : trimString(raw.source);
			if (raw.source !== undefined && !source) {
				throw new Error(`state.installed.${id}.source must be a non-empty string`);
			}
			const contentDigest = raw.contentDigest === undefined ? undefined : trimString(raw.contentDigest);
			if (raw.contentDigest !== undefined && (!contentDigest || !/^[a-f0-9]{64}$/u.test(contentDigest))) {
				throw new Error(`state.installed.${id}.contentDigest must be a SHA-256 digest`);
			}
			installed[id] = {
				installedAt,
				...(source ? { source } : {}),
				...(contentDigest ? { contentDigest } : {}),
			};
		}
		return { status: "valid", state: { version: 1, disabled: [...parsed.disabled], installed } };
	} catch (error) {
		return {
			status: "corrupt",
			state: structuredClone(DEFAULT_STATE),
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

function writeState(scope: ExtensionScope, state: ExtensionState, cwd = process.cwd()): void {
	const filePath = statePath(scope, cwd);
	safeResourceWrite(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8" });
}

function installedFromRoot(
	root: string,
	scope: ExtensionScope,
	stateResult: StateReadResult,
	cwd: string,
	fallbackId: string,
): InstalledExtension | null {
	const candidate = loadManifestFromRoot(root);
	const manifest = candidate.manifest;
	const diagnostics = [...candidate.diagnostics];
	const id = manifest?.id ?? fallbackId;
	const provenance = stateResult.state.installed[id];
	const expectedDigest = provenance?.contentDigest;
	let observedDigest: string | undefined;
	let contentVerified = false;
	if (stateResult.status === "corrupt") {
		diagnostics.push({
			type: "error",
			message: `extension install state is corrupt: ${stateResult.message}; reinstall with --force or remove the package to preserve the corrupt bytes and recover`,
			path: statePath(scope, cwd),
		});
	} else if (stateResult.status === "absent") {
		diagnostics.push({
			type: "error",
			message: "extension install state is absent; installed content cannot be verified; reinstall with --force",
			path: statePath(scope, cwd),
		});
	} else if (!provenance) {
		diagnostics.push({
			type: "error",
			message: `extension ${id} is not recorded in install state; reinstall with --force`,
			path: statePath(scope, cwd),
		});
	} else if (!expectedDigest) {
		diagnostics.push({
			type: "error",
			message: `extension ${id} install provenance has no content digest; run clio-coder upgrade, then reinstall with --force if it remains unverifiable`,
			path: statePath(scope, cwd),
		});
	} else {
		try {
			observedDigest = extensionContentDigest(root);
			contentVerified = observedDigest === expectedDigest;
			if (!contentVerified) {
				diagnostics.push({
					type: "error",
					message: `installed extension content drift detected (expected ${expectedDigest}, observed ${observedDigest})`,
					path: root,
				});
			}
		} catch (error) {
			diagnostics.push({
				type: "error",
				message: `installed extension content could not be verified: ${error instanceof Error ? error.message : String(error)}`,
				path: root,
			});
		}
	}
	const clioRange = manifest?.compatibility?.clio;
	const compatible = clioRange === undefined || evaluateClioCompatibility(clioRange).satisfied;
	return {
		id,
		name: manifest?.name ?? id,
		version: manifest?.version ?? "unknown",
		description: manifest?.description ?? "Installed extension has an invalid manifest.",
		scope,
		rootPath: root,
		manifestPath: candidate.manifestPath ?? root,
		enabled: !stateResult.state.disabled.includes(id),
		valid: manifest !== undefined && candidate.valid && contentVerified,
		compatible,
		effective: false,
		loadable: false,
		...(expectedDigest ? { installedContentDigest: expectedDigest } : {}),
		...(observedDigest ? { observedContentDigest: observedDigest } : {}),
		resources: manifest?.resources ?? {},
		diagnostics,
	};
}

function listScope(scope: ExtensionScope, cwd = process.cwd()): InstalledExtension[] {
	const base = extensionBaseDir(scope, cwd);
	if (!existsSync(base)) return [];
	const state = readState(scope, cwd);
	const out: InstalledExtension[] = [];
	for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const root = path.join(base, entry.name);
		const installed = installedFromRoot(root, scope, state, cwd, entry.name);
		if (installed) out.push(installed);
	}
	return out;
}

/**
 * Add integrity digests to released v1 install records only after the installed
 * tree validates and remains byte-identical through the atomic state rewrite.
 * Refused records remain unchanged and therefore fail closed at load time.
 */
export function upgradeLegacyExtensionInstallState(
	cwd = process.cwd(),
	scopes: ReadonlyArray<ExtensionScope> = ["user", "project"],
): ExtensionStateUpgradeReport[] {
	const reports: ExtensionStateUpgradeReport[] = [];
	for (const scope of scopes) {
		const filePath = statePath(scope, cwd);
		const report: ExtensionStateUpgradeReport = { scope, statePath: filePath, upgraded: [], refused: [] };
		const stateResult = readState(scope, cwd);
		if (stateResult.status === "absent") {
			reports.push(report);
			continue;
		}
		if (stateResult.status === "corrupt") {
			report.refused.push({ id: "<state>", reason: `install state is corrupt: ${stateResult.message}` });
			reports.push(report);
			continue;
		}
		const next = structuredClone(stateResult.state);
		const verified = new Map<string, { root: string; digest: string }>();
		for (const [id, record] of Object.entries(next.installed)) {
			if (record.contentDigest) continue;
			const root = path.join(extensionBaseDir(scope, cwd), id);
			try {
				if (!lstatSync(root).isDirectory()) throw new Error("installed path is not a directory");
				const candidate = loadManifestFromRoot(root);
				if (!candidate.valid || !candidate.manifest) {
					throw new Error(candidate.diagnostics.map((diagnostic) => diagnostic.message).join("; ") || "manifest is invalid");
				}
				if (candidate.manifest.id !== id) {
					throw new Error(`manifest id ${candidate.manifest.id} does not match install record ${id}`);
				}
				const digest = extensionContentDigest(root);
				record.contentDigest = digest;
				verified.set(id, { root, digest });
				report.upgraded.push(id);
			} catch (error) {
				report.refused.push({ id, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		if (report.upgraded.length > 0) {
			const backupPath = `${filePath}.pre-digest.bak`;
			safeResourceWrite(filePath, `${JSON.stringify(next, null, 2)}\n`, {
				encoding: "utf8",
				backup: { path: backupPath },
				beforeRename: () => {
					for (const [id, expected] of verified) {
						const observed = extensionContentDigest(expected.root);
						if (observed !== expected.digest) throw new Error(`extension ${id} changed during digest migration`);
					}
				},
			});
			report.backupPath = backupPath;
		}
		reports.push(report);
	}
	return reports;
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
		const winner = group
			.filter((entry) => entry.valid && entry.compatible)
			.sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope))
			.at(-1);
		for (const entry of group) {
			entry.effective = entry === winner;
			entry.loadable = entry.valid && entry.compatible && entry.enabled && entry.effective;
			if (entry.valid && entry.compatible && !entry.effective && winner) entry.overriddenBy = winner.scope;
		}
	}
	// Invalid and incompatible packages remain visible by default so the load
	// refusal and its diagnostic cannot disappear with the resources it suppresses.
	const all =
		options.all === true ? entries : entries.filter((entry) => entry.effective || !entry.valid || !entry.compatible);
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
	if (!candidate.manifest || !candidate.valid) return { diagnostics: candidate.diagnostics };
	const targetRoot = path.join(extensionBaseDir(scope, cwd), candidate.manifest.id);
	if (existsSync(targetRoot)) {
		if (!options.force) {
			return {
				diagnostics: [
					{
						type: "error",
						message: `extension ${candidate.manifest.id} is already installed; retry with --force to replace it`,
						path: targetRoot,
					},
				],
			};
		}
	}
	const parent = path.dirname(targetRoot);
	const stagingRoot = path.join(parent, `.${candidate.manifest.id}.install-${process.pid}-${Date.now()}`);
	const backupRoot = path.join(parent, `.${candidate.manifest.id}.backup-${process.pid}-${Date.now()}`);
	let installedReplacement = false;
	let movedExisting = false;
	const stateResult = readState(scope, cwd);
	if (stateResult.status === "corrupt" && !options.force) {
		return {
			diagnostics: [
				{
					type: "error",
					message: `extension install state is corrupt: ${stateResult.message}; retry with --force to back it up and reinstall safely`,
					path: statePath(scope, cwd),
				},
			],
		};
	}
	const state = stateResult.status === "corrupt" ? structuredClone(DEFAULT_STATE) : stateResult.state;
	let stateBackup: string | undefined;
	let packageBackup: string | undefined;
	try {
		mkdirSync(parent, { recursive: true });
		if (stateResult.status === "corrupt") stateBackup = preserveFile(statePath(scope, cwd), "corrupt");
		rmSync(stagingRoot, { recursive: true, force: true });
		rmSync(backupRoot, { recursive: true, force: true });
		cpSync(source, stagingRoot, {
			recursive: true,
			// `state.json` beside the installed extension directories belongs to
			// Clio's extension manager. An extension may legitimately ship nested
			// resources with the same basename (for example a project-state JSON
			// template), so exclude only a bookkeeping file at the package root.
			filter: (src) => path.relative(source, src) !== "state.json",
		});
		const stagedCandidate = loadManifestFromRoot(stagingRoot);
		if (!stagedCandidate.valid || !stagedCandidate.manifest) {
			const reasons = stagedCandidate.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
			throw new Error(`staged extension content is invalid${reasons ? `: ${reasons}` : ""}`);
		}
		if (stagedCandidate.manifest.id !== candidate.manifest.id) {
			throw new Error(`staged extension id changed from ${candidate.manifest.id} to ${stagedCandidate.manifest.id}`);
		}
		const contentDigest = extensionContentDigest(stagingRoot);
		if (existsSync(targetRoot)) {
			renameSync(targetRoot, backupRoot);
			movedExisting = true;
			packageBackup = backupRoot;
		}
		renameSync(stagingRoot, targetRoot);
		installedReplacement = true;
		state.installed[candidate.manifest.id] = {
			installedAt: new Date().toISOString(),
			source,
			contentDigest,
		};
		state.disabled = state.disabled.filter((entry) => entry !== candidate.manifest?.id);
		writeState(scope, state, cwd);
	} catch (error) {
		rmSync(stagingRoot, { recursive: true, force: true });
		if (installedReplacement) rmSync(targetRoot, { recursive: true, force: true });
		if (movedExisting && existsSync(backupRoot) && !existsSync(targetRoot)) {
			renameSync(backupRoot, targetRoot);
			packageBackup = undefined;
		}
		return {
			...(stateBackup || packageBackup
				? { recovery: { ...(stateBackup ? { stateBackup } : {}), ...(packageBackup ? { packageBackup } : {}) } }
				: {}),
			diagnostics: [
				{
					type: "error",
					message: `extension ${candidate.manifest.id} install failed: ${error instanceof Error ? error.message : String(error)}`,
					path: targetRoot,
				},
			],
		};
	}
	const diagnostics = [...candidate.diagnostics];
	if (movedExisting && stateResult.status !== "valid") {
		diagnostics.push({
			type: "warning",
			message: "previous unverifiable extension bytes were preserved during forced reinstall",
			path: backupRoot,
		});
	} else {
		try {
			rmSync(backupRoot, { recursive: true, force: true });
			packageBackup = undefined;
		} catch (error) {
			diagnostics.push({
				type: "warning",
				message: `extension installed, but its backup could not be removed: ${error instanceof Error ? error.message : String(error)}`,
				path: backupRoot,
			});
		}
	}
	if (stateBackup) {
		diagnostics.push({ type: "warning", message: "corrupt extension install state was preserved", path: stateBackup });
	}
	const installed = findInstalled(candidate.manifest.id, cwd, scope);
	return {
		...(installed ? { extension: installed } : {}),
		...(stateBackup || packageBackup
			? { recovery: { ...(stateBackup ? { stateBackup } : {}), ...(packageBackup ? { packageBackup } : {}) } }
			: {}),
		diagnostics,
	};
}

function mutateEnabled(id: string, enabled: boolean, options: ExtensionListOptions = {}): ExtensionMutationResult {
	const cwd = options.cwd ?? process.cwd();
	const target = findInstalled(id, cwd, options.scope);
	if (!target) {
		return { diagnostics: [{ type: "error", message: `extension ${id} is not installed` }] };
	}
	const stateResult = readState(target.scope, cwd);
	if (stateResult.status !== "valid") {
		return {
			diagnostics: [
				{
					type: "error",
					message:
						stateResult.status === "corrupt"
							? `extension install state is corrupt: ${stateResult.message}`
							: "extension install state is absent",
					path: statePath(target.scope, cwd),
				},
			],
		};
	}
	const state = stateResult.state;
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
	const stateResult = readState(target.scope, cwd);
	if (stateResult.status !== "valid") {
		const filePath = statePath(target.scope, cwd);
		const packageBackup = packageRecoveryPath(target.rootPath, "removed-unverifiable");
		let stateBackup: string | undefined;
		try {
			if (stateResult.status === "corrupt") stateBackup = preserveFile(filePath, "corrupt");
			renameSync(target.rootPath, packageBackup);
			try {
				writeState(target.scope, structuredClone(DEFAULT_STATE), cwd);
			} catch (error) {
				renameSync(packageBackup, target.rootPath);
				throw error;
			}
			const diagnostics: ExtensionDiagnostic[] = [
				{
					type: "warning",
					message: "unverifiable extension bytes were preserved while removing the package from the load path",
					path: packageBackup,
				},
			];
			if (stateBackup) {
				diagnostics.push({ type: "warning", message: "corrupt extension install state was preserved", path: stateBackup });
			}
			return {
				removed: { id, scope: target.scope, path: target.rootPath },
				recovery: { ...(stateBackup ? { stateBackup } : {}), packageBackup },
				diagnostics,
			};
		} catch (error) {
			return {
				diagnostics: [
					{
						type: "error",
						message: `extension ${id} could not be removed safely: ${error instanceof Error ? error.message : String(error)}`,
						path: target.rootPath,
					},
				],
			};
		}
	}
	const state = stateResult.state;
	rmSync(target.rootPath, { recursive: true, force: true });
	Reflect.deleteProperty(state.installed, id);
	state.disabled = state.disabled.filter((entry) => entry !== id);
	writeState(target.scope, state, cwd);
	return { removed: { id, scope: target.scope, path: target.rootPath }, diagnostics: [] };
}
