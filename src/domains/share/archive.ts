import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type ClioSettings, readSettings, writeSettings } from "../../core/config.js";
import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import { readClioVersion } from "../../core/package-root.js";
import {
	type SafeResourceWriteResult,
	safeResourceBackupPath,
	safeResourceWrite,
} from "../../core/safe-resource-write.js";
import { clioConfigDir, resolveClioDirs } from "../../core/xdg.js";

export type ShareScope = "project" | "user";
export type ShareEntryType = "project-context" | "prompt" | "skill" | "settings" | "extension";

export interface ShareArchiveFile {
	type: ShareEntryType;
	scope: ShareScope;
	archivePath: string;
	relativePath: string;
	sha256: string;
	size: number;
	encoding: "base64";
	data: string;
}

export interface ShareArchiveManifestFile {
	type: ShareEntryType;
	scope: ShareScope;
	archivePath: string;
	relativePath: string;
	sha256: string;
	size: number;
}

export interface ShareArchiveManifest {
	format: "clio.share.v1";
	clioVersion: string;
	createdAt: string;
	files: ShareArchiveManifestFile[];
}

export interface ClioShareArchive {
	kind: "clio-share-archive";
	formatVersion: 1;
	manifest: ShareArchiveManifest;
	files: ShareArchiveFile[];
}

export interface ShareDiagnostic {
	type: "warning" | "error" | "conflict";
	message: string;
	path?: string;
}

export interface ShareExportOptions {
	cwd?: string;
	scope?: ShareScope | "both";
	includeContext?: boolean;
	includePrompts?: boolean;
	includeSkills?: boolean;
	includeSettings?: boolean;
	includeExtensions?: boolean;
}

export interface ShareImportOptions {
	cwd?: string;
	scope?: ShareScope;
	dryRun?: boolean;
	force?: boolean;
}

export interface ShareImportAction {
	action: "write" | "overwrite" | "skip" | "settings";
	type: ShareEntryType;
	scope: ShareScope;
	path: string;
}

export interface ShareImportPlan {
	archive: ClioShareArchive | null;
	actions: ShareImportAction[];
	diagnostics: ShareDiagnostic[];
	recovery?: ShareImportRecovery;
}

export interface ShareImportRecovery {
	written: string[];
	backups: string[];
	failed?: string;
}

const PROJECT_CONTEXT_FILES = ["CLIO.md", "AGENTS.md", "CODEX.md", "GEMINI.md", "CLAUDE.md"] as const;
const SETTINGS_FRAGMENT_PATH = "settings.fragment.yaml";

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorWithCode(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value;
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
	return `{${Object.entries(value)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
		.join(",")}}`;
}

function readDirRecursive(root: string): Array<{ fullPath: string; relativePath: string; stat: Stats }> {
	if (!existsSync(root)) return [];
	const out: Array<{ fullPath: string; relativePath: string; stat: Stats }> = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name === ".DS_Store") continue;
			const fullPath = path.join(dir, entry.name);
			const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
			const stat = statSync(fullPath);
			if (entry.isDirectory()) {
				walk(fullPath);
				continue;
			}
			if (entry.isFile()) out.push({ fullPath, relativePath, stat });
		}
	};
	try {
		if (statSync(root).isDirectory()) walk(root);
	} catch {
		return [];
	}
	return out;
}

function addBufferFile(
	files: ShareArchiveFile[],
	input: {
		type: ShareEntryType;
		scope: ShareScope;
		archivePath: string;
		relativePath: string;
		buffer: Buffer;
	},
): void {
	files.push({
		type: input.type,
		scope: input.scope,
		archivePath: input.archivePath.split(path.sep).join("/"),
		relativePath: input.relativePath.split(path.sep).join("/"),
		sha256: sha256(input.buffer),
		size: input.buffer.byteLength,
		encoding: "base64",
		data: input.buffer.toString("base64"),
	});
}

function addTree(
	files: ShareArchiveFile[],
	type: ShareEntryType,
	scope: ShareScope,
	root: string,
	archivePrefix: string,
	filter?: (relativePath: string) => boolean,
): void {
	for (const entry of readDirRecursive(root)) {
		if (filter && !filter(entry.relativePath)) continue;
		const buffer = readFileSync(entry.fullPath);
		addBufferFile(files, {
			type,
			scope,
			archivePath: `${archivePrefix}/${entry.relativePath}`,
			relativePath: entry.relativePath,
			buffer,
		});
	}
}

function settingsFragment(settings: Readonly<ClioSettings>): Record<string, unknown> {
	return {
		safetyLevel: settings.safetyLevel,
		scope: settings.scope,
		budget: settings.budget,
		theme: settings.theme,
		terminal: settings.terminal,
		keybindings: settings.keybindings,
		compaction: settings.compaction,
		retry: settings.retry,
	};
}

function requestedScopes(scope: ShareExportOptions["scope"]): ShareScope[] {
	if (scope === "both") return ["project", "user"];
	return [scope ?? "project"];
}

function defaultedIncludes(
	options: ShareExportOptions,
): Required<
	Pick<
		ShareExportOptions,
		"includeContext" | "includePrompts" | "includeSkills" | "includeSettings" | "includeExtensions"
	>
> {
	const any =
		options.includeContext !== undefined ||
		options.includePrompts !== undefined ||
		options.includeSkills !== undefined ||
		options.includeSettings !== undefined ||
		options.includeExtensions !== undefined;
	return {
		includeContext: any ? options.includeContext === true : true,
		includePrompts: any ? options.includePrompts === true : true,
		includeSkills: any ? options.includeSkills === true : true,
		includeSettings: any ? options.includeSettings === true : true,
		includeExtensions: any ? options.includeExtensions === true : true,
	};
}

export function createShareArchive(options: ShareExportOptions = {}): ClioShareArchive {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const files: ShareArchiveFile[] = [];
	const includes = defaultedIncludes(options);
	const scopes = requestedScopes(options.scope);

	if (includes.includeContext && scopes.includes("project")) {
		for (const name of PROJECT_CONTEXT_FILES) {
			const full = path.join(cwd, name);
			try {
				if (!statSync(full).isFile()) continue;
				addBufferFile(files, {
					type: "project-context",
					scope: "project",
					archivePath: `project/${name}`,
					relativePath: name,
					buffer: readFileSync(full),
				});
			} catch {
				// absent
			}
		}
	}

	if (includes.includePrompts) {
		for (const scope of scopes) {
			const root = scope === "user" ? path.join(clioConfigDir(), "prompts") : path.join(cwd, ".clio", "prompts");
			addTree(files, "prompt", scope, root, `${scope}/prompts`);
		}
	}
	if (includes.includeSkills) {
		for (const scope of scopes) {
			const root = scope === "user" ? path.join(clioConfigDir(), "skills") : path.join(cwd, ".clio", "skills");
			addTree(files, "skill", scope, root, `${scope}/skills`);
		}
	}
	if (includes.includeExtensions) {
		for (const scope of scopes) {
			const root = scope === "user" ? path.join(clioConfigDir(), "extensions") : path.join(cwd, ".clio", "extensions");
			addTree(files, "extension", scope, root, `${scope}/extensions`, (rel) => path.basename(rel) !== "state.json");
		}
	}
	if (includes.includeSettings) {
		const buffer = Buffer.from(stringifyYaml(settingsFragment(readSettings())), "utf8");
		addBufferFile(files, {
			type: "settings",
			scope: "user",
			archivePath: SETTINGS_FRAGMENT_PATH,
			relativePath: SETTINGS_FRAGMENT_PATH,
			buffer,
		});
	}

	const manifestFiles = files.map(({ data: _data, encoding: _encoding, ...entry }) => entry);
	return {
		kind: "clio-share-archive",
		formatVersion: 1,
		manifest: {
			format: "clio.share.v1",
			clioVersion: readClioVersion(),
			createdAt: new Date().toISOString(),
			files: manifestFiles,
		},
		files: files.sort((a, b) => a.archivePath.localeCompare(b.archivePath)),
	};
}

export function writeShareArchive(outPath: string, options: ShareExportOptions = {}): ClioShareArchive {
	const archive = createShareArchive(options);
	safeResourceWrite(path.resolve(outPath), `${stableJson(archive)}\n`, { encoding: "utf8" });
	return archive;
}

function decodeArchiveFile(entry: ShareArchiveFile): Buffer {
	return Buffer.from(entry.data, entry.encoding);
}

function parseArchive(raw: unknown): ClioShareArchive {
	if (!isRecord(raw) || raw.kind !== "clio-share-archive" || raw.formatVersion !== 1 || !isRecord(raw.manifest)) {
		throw new Error("not a Clio share archive v1");
	}
	if (raw.manifest.format !== "clio.share.v1" || !Array.isArray(raw.files)) {
		throw new Error("share archive manifest is malformed");
	}
	const archive = raw as unknown as ClioShareArchive;
	for (const file of archive.files) {
		if (
			!isRecord(file) ||
			typeof file.archivePath !== "string" ||
			typeof file.relativePath !== "string" ||
			typeof file.sha256 !== "string" ||
			file.encoding !== "base64" ||
			typeof file.data !== "string"
		) {
			throw new Error("share archive file entry is malformed");
		}
		const actual = sha256(decodeArchiveFile(file));
		if (actual !== file.sha256) throw new Error(`share archive checksum mismatch for ${file.archivePath}`);
	}
	return archive;
}

export function readShareArchive(filePath: string): ClioShareArchive {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`share archive could not be read: ${reason}`);
	}
	return parseArchive(parsed);
}

interface ShareImportTargetRoot {
	root: string;
	containmentRoot: string;
	scope: ShareScope;
}

interface ShareImportPreparedTarget {
	entry: ShareArchiveFile;
	target: string;
	scope: ShareScope;
	buffer: Buffer;
}

interface ShareImportPreparedPlan {
	archive: ClioShareArchive | null;
	actions: ShareImportAction[];
	diagnostics: ShareDiagnostic[];
	targets: ShareImportPreparedTarget[];
}

function configDirPath(): string {
	return path.resolve(resolveClioDirs().config);
}

function settingsFilePath(): string {
	return path.join(configDirPath(), "settings.yaml");
}

function relativePathSegments(relativePath: string): string[] | null {
	if (relativePath.length === 0 || relativePath.includes("\0")) return null;
	if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return null;
	const segments = relativePath.replace(/\\/g, "/").split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
	return segments;
}

function targetRootForFile(entry: ShareArchiveFile, options: ShareImportOptions): ShareImportTargetRoot {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const config = configDirPath();
	const scope = options.scope ?? entry.scope;
	switch (entry.type) {
		case "project-context":
			return { root: cwd, containmentRoot: cwd, scope: "project" };
		case "prompt":
			return scope === "user"
				? { root: path.join(config, "prompts"), containmentRoot: config, scope }
				: { root: path.join(cwd, ".clio", "prompts"), containmentRoot: cwd, scope };
		case "skill":
			return scope === "user"
				? { root: path.join(config, "skills"), containmentRoot: config, scope }
				: { root: path.join(cwd, ".clio", "skills"), containmentRoot: cwd, scope };
		case "extension":
			return scope === "user"
				? { root: path.join(config, "extensions"), containmentRoot: config, scope }
				: { root: path.join(cwd, ".clio", "extensions"), containmentRoot: cwd, scope };
		case "settings":
			return { root: config, containmentRoot: config, scope };
	}
}

function isInsideOrEqual(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function lstatExists(candidate: string): boolean {
	try {
		lstatSync(candidate);
		return true;
	} catch (err) {
		if (isErrorWithCode(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) return false;
		throw err;
	}
}

function nearestExistingPath(candidate: string): string | null {
	let current = path.resolve(candidate);
	while (!lstatExists(current)) {
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return current;
}

function pathDiagnostic(entry: ShareArchiveFile): string {
	return `${entry.archivePath} -> ${entry.relativePath}`;
}

function validateRealPathContainment(
	entry: ShareArchiveFile,
	target: string,
	containmentRoot: string,
): ShareDiagnostic | null {
	const rootAnchor = nearestExistingPath(containmentRoot);
	const targetAnchor = nearestExistingPath(lstatExists(target) ? target : path.dirname(target));
	if (!rootAnchor || !targetAnchor) {
		return {
			type: "error",
			message: `share archive target could not be resolved safely: ${pathDiagnostic(entry)}`,
			path: entry.relativePath,
		};
	}
	let realRoot: string;
	let realTarget: string;
	try {
		realRoot = realpathSync(rootAnchor);
		realTarget = realpathSync(targetAnchor);
	} catch {
		return {
			type: "error",
			message: `share archive target could not be resolved safely: ${pathDiagnostic(entry)}`,
			path: entry.relativePath,
		};
	}
	if (!isInsideOrEqual(realTarget, realRoot)) {
		return {
			type: "error",
			message: `share archive target escapes import root: ${pathDiagnostic(entry)}`,
			path: entry.relativePath,
		};
	}
	return null;
}

function resolveImportTarget(
	entry: ShareArchiveFile,
	options: ShareImportOptions,
): ShareImportPreparedTarget | ShareDiagnostic {
	const segments = relativePathSegments(entry.relativePath);
	if (!segments) {
		return {
			type: "error",
			message: `share archive relativePath is not safe: ${pathDiagnostic(entry)}`,
			path: entry.relativePath,
		};
	}
	const targetRoot = targetRootForFile(entry, options);
	const target = entry.type === "settings" ? settingsFilePath() : path.resolve(targetRoot.root, ...segments);
	if (!isInsideOrEqual(target, targetRoot.root)) {
		return {
			type: "error",
			message: `share archive target escapes import root: ${pathDiagnostic(entry)}`,
			path: entry.relativePath,
		};
	}
	const realPathDiagnostic = validateRealPathContainment(entry, target, targetRoot.containmentRoot);
	if (realPathDiagnostic) return realPathDiagnostic;
	return { entry, target, scope: targetRoot.scope, buffer: decodeArchiveFile(entry) };
}

function preflightImportTargets(
	archive: ClioShareArchive,
	options: ShareImportOptions,
): { targets: ShareImportPreparedTarget[]; diagnostics: ShareDiagnostic[] } {
	const targets: ShareImportPreparedTarget[] = [];
	const diagnostics: ShareDiagnostic[] = [];
	for (const entry of archive.files) {
		const resolved = resolveImportTarget(entry, options);
		if ("type" in resolved) {
			diagnostics.push(resolved);
			continue;
		}
		targets.push(resolved);
	}
	if (diagnostics.length > 0) return { targets: [], diagnostics };
	return { targets, diagnostics };
}

function versionDiagnostics(archive: ClioShareArchive): ShareDiagnostic[] {
	const current = readClioVersion();
	const [curMajor, curMinor] = current.split(".");
	const [arcMajor, arcMinor] = archive.manifest.clioVersion.split(".");
	if (curMajor !== arcMajor || curMinor !== arcMinor) {
		return [
			{
				type: "warning",
				message: `archive was created by Clio ${archive.manifest.clioVersion}; current Clio is ${current}`,
			},
		];
	}
	return [];
}

function settingsPlan(buffer: Buffer, options: ShareImportOptions): ShareDiagnostic[] {
	const parsed = parseYaml(buffer.toString("utf8")) as unknown;
	if (!isRecord(parsed)) return [{ type: "error", message: "settings fragment must be a YAML object" }];
	const settingsTarget = settingsFilePath();
	const current = settingsFragment(existsSync(settingsTarget) ? readSettings() : DEFAULT_SETTINGS);
	const diagnostics: ShareDiagnostic[] = [];
	for (const [key, value] of Object.entries(parsed)) {
		if (key in current && JSON.stringify(current[key]) !== JSON.stringify(value)) {
			diagnostics.push({
				type: "conflict",
				message: `settings fragment changes ${key}`,
				path: settingsTarget,
			});
		}
	}
	return options.force ? diagnostics.filter((diag) => diag.type !== "conflict") : diagnostics;
}

function prepareShareImport(filePath: string, options: ShareImportOptions = {}): ShareImportPreparedPlan {
	let archive: ClioShareArchive;
	try {
		archive = readShareArchive(filePath);
	} catch (err) {
		return {
			archive: null,
			actions: [],
			diagnostics: [{ type: "error", message: err instanceof Error ? err.message : String(err), path: filePath }],
			targets: [],
		};
	}
	const diagnostics: ShareDiagnostic[] = [...versionDiagnostics(archive)];
	const actions: ShareImportAction[] = [];
	const preflight = preflightImportTargets(archive, options);
	if (preflight.diagnostics.length > 0) {
		return { archive, actions: [], diagnostics: [...diagnostics, ...preflight.diagnostics], targets: [] };
	}
	for (const targetInfo of preflight.targets) {
		const { entry, target, scope, buffer } = targetInfo;
		if (entry.type === "settings") {
			diagnostics.push(...settingsPlan(buffer, options));
			actions.push({ action: "settings", type: entry.type, scope, path: target });
			continue;
		}
		if (existsSync(target)) {
			const same = sha256(readFileSync(target)) === entry.sha256;
			if (same) {
				actions.push({ action: "skip", type: entry.type, scope, path: target });
			} else if (options.force) {
				actions.push({ action: "overwrite", type: entry.type, scope, path: target });
			} else {
				diagnostics.push({ type: "conflict", message: `destination already exists with different content`, path: target });
				actions.push({ action: "skip", type: entry.type, scope, path: target });
			}
			continue;
		}
		actions.push({ action: "write", type: entry.type, scope, path: target });
	}
	return { archive, actions, diagnostics, targets: preflight.targets };
}

function publicImportPlan(prepared: ShareImportPreparedPlan, recovery?: ShareImportRecovery): ShareImportPlan {
	return {
		archive: prepared.archive,
		actions: prepared.actions,
		diagnostics: prepared.diagnostics,
		...(recovery ? { recovery } : {}),
	};
}

export function planShareImport(filePath: string, options: ShareImportOptions = {}): ShareImportPlan {
	return publicImportPlan(prepareShareImport(filePath, options));
}

function mergeSettingsFragment(buffer: Buffer): SafeResourceWriteResult {
	const parsed = parseYaml(buffer.toString("utf8")) as unknown;
	if (!isRecord(parsed)) throw new Error("settings fragment must be a YAML object");
	const current = readSettings();
	const next = structuredClone(current) as ClioSettings;
	for (const key of [
		"safetyLevel",
		"scope",
		"budget",
		"theme",
		"terminal",
		"keybindings",
		"compaction",
		"retry",
	] as const) {
		if (key in parsed) {
			(next as unknown as Record<string, unknown>)[key] = parsed[key];
		}
	}
	return writeSettings(next, { backup: true });
}

export function importShareArchive(filePath: string, options: ShareImportOptions = {}): ShareImportPlan {
	const prepared = prepareShareImport(filePath, options);
	const plan = publicImportPlan(prepared);
	if (!prepared.archive || options.dryRun) return plan;
	if (prepared.diagnostics.some((diag) => diag.type === "error" || diag.type === "conflict")) return plan;
	const written: string[] = [];
	const backups: string[] = [];
	const rememberWrite = (result: SafeResourceWriteResult): void => {
		if (!written.includes(result.path)) written.push(result.path);
		if (result.backupPath && !backups.includes(result.backupPath)) backups.push(result.backupPath);
	};
	let failed: string | undefined;
	try {
		for (let index = 0; index < prepared.targets.length; index += 1) {
			const targetInfo = prepared.targets[index];
			const action = prepared.actions[index];
			if (!targetInfo || !action || action.action === "skip") continue;
			failed = targetInfo.target;
			if (targetInfo.entry.type === "settings") {
				rememberWrite(mergeSettingsFragment(targetInfo.buffer));
				failed = undefined;
				continue;
			}
			rememberWrite(
				safeResourceWrite(targetInfo.target, targetInfo.buffer, {
					backup: action.action === "overwrite",
				}),
			);
			failed = undefined;
		}
		return plan;
	} catch (err) {
		if (failed) {
			const expectedBackup = safeResourceBackupPath(failed);
			if (existsSync(expectedBackup) && !backups.includes(expectedBackup)) backups.push(expectedBackup);
		}
		const reason = err instanceof Error ? err.message : String(err);
		const recovery: ShareImportRecovery = {
			written,
			backups,
			...(failed ? { failed } : {}),
		};
		return publicImportPlan(
			{
				...prepared,
				diagnostics: [
					...prepared.diagnostics,
					{
						type: "error",
						message: `share import failed while writing${failed ? ` ${failed}` : ""}: ${reason}`,
						...(failed ? { path: failed } : {}),
					},
				],
			},
			recovery,
		);
	}
}
