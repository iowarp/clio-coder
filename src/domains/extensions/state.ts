import { createHash, randomBytes } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { recordLifecycleReceipt } from "../../core/library-receipts.js";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { projectPackagesTrusted } from "../../core/workspace-trust.js";
import { clioConfigDir } from "../../core/xdg.js";
import { type InstalledPlugin, listInstalledPlugins, pluginPromptNames } from "../plugins/index.js";
import { evaluateClioCompatibility } from "./compatibility.js";
import { isRecord, loadManifestFromRoot, trimString } from "./discovery.js";
import { extensionContentDigest, extensionContentDigestWithCapture } from "./integrity.js";
import { capabilityEnvelope, envelopeDigest as envelopeDigestOf } from "./runtime-schema-v2.js";
import type {
	ExtensionDiagnostic,
	ExtensionInstallOptions,
	ExtensionInstallResult,
	ExtensionListOptions,
	ExtensionLoadScope,
	ExtensionMutationResult,
	ExtensionOrigin,
	ExtensionScope,
	ExtensionState,
	InstalledExtension,
} from "./types.js";

const DEFAULT_STATE: ExtensionState = { version: 1, disabled: [], installed: {} };

type StateReadResult =
	| { status: "absent"; state: ExtensionState }
	| { status: "valid"; state: ExtensionState }
	| { status: "corrupt"; state: ExtensionState; message: string };

export interface InstalledExtensionRecord {
	entry: InstalledExtension;
	/** Exact file bytes captured by the stable tree-digest read. */
	captured?: ReadonlyMap<string, Buffer>;
}

export function extensionBaseDir(scope: ExtensionScope, cwd = process.cwd()): string {
	return scope === "user"
		? path.join(clioConfigDir(), "extensions")
		: path.join(path.resolve(cwd), ".clio-coder", "extensions");
}

function statePath(scope: ExtensionScope, cwd = process.cwd()): string {
	return path.join(extensionBaseDir(scope, cwd), "state.json");
}

/**
 * Reject redirects beneath the operator-selected config or project root, the
 * plugin writer's rule: a project link into user scope, or any link below the
 * boundary, would carry package bytes and install state to another trust domain.
 */
function assertManagedBase(scope: ExtensionScope, cwd: string): void {
	const boundary = scope === "user" ? path.resolve(clioConfigDir()) : path.resolve(cwd);
	const base = extensionBaseDir(scope, cwd);
	let cursor = boundary;
	for (const part of path.relative(boundary, base).split(path.sep)) {
		cursor = path.join(cursor, part);
		try {
			const stat = lstatSync(cursor);
			if (stat.isSymbolicLink() || !stat.isDirectory())
				throw new Error(`extension managed path must be a directory without symbolic links: ${cursor}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function managedBaseError(scope: ExtensionScope, cwd: string): string | undefined {
	try {
		assertManagedBase(scope, cwd);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function lexists(candidate: string): boolean {
	try {
		lstatSync(candidate);
		return true;
	} catch {
		// Absent or unreadable: nothing installed can be assumed at this path.
		return false;
	}
}

function contained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function uniqueSibling(target: string, purpose: string): string {
	return path.join(
		path.dirname(target),
		`.${path.basename(target)}.${purpose}-${process.pid}-${randomBytes(8).toString("hex")}`,
	);
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

/** A dev package outranks both installed scopes for the session it is loaded in. */
export function scopeRank(scope: ExtensionLoadScope): number {
	return scope === "dev" ? 3 : scope === "project" ? 2 : 1;
}

function readOrigin(value: unknown): ExtensionOrigin | undefined {
	if (!isRecord(value) || (value.kind !== "local" && value.kind !== "catalog" && value.kind !== "github"))
		return undefined;
	const source = trimString(value.source);
	return source ? { kind: value.kind, source } : undefined;
}

function readState(scope: ExtensionScope, cwd = process.cwd()): StateReadResult {
	const filePath = statePath(scope, cwd);
	const redirected = managedBaseError(scope, cwd);
	if (redirected) return { status: "corrupt", state: structuredClone(DEFAULT_STATE), message: redirected };
	if (!lexists(filePath)) return { status: "absent", state: structuredClone(DEFAULT_STATE) };
	try {
		const stat = lstatSync(filePath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
			throw new Error(`extension state must be a regular unlinked file: ${filePath}`);
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
			const envelopeDigest = raw.envelopeDigest === undefined ? undefined : trimString(raw.envelopeDigest);
			if (raw.envelopeDigest !== undefined && (!envelopeDigest || !/^[a-f0-9]{64}$/u.test(envelopeDigest))) {
				throw new Error(`state.installed.${id}.envelopeDigest must be a SHA-256 digest`);
			}
			const origin = raw.origin === undefined ? undefined : readOrigin(raw.origin);
			if (raw.origin !== undefined && !origin) throw new Error(`state.installed.${id}.origin is not a valid origin`);
			installed[id] = {
				installedAt,
				...(source ? { source } : {}),
				...(origin ? { origin } : {}),
				...(contentDigest ? { contentDigest } : {}),
				...(envelopeDigest ? { envelopeDigest } : {}),
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

export function readExtensionInstallRecord(
	id: string,
	options: ExtensionListOptions = {},
): ExtensionState["installed"][string] | undefined {
	const cwd = options.cwd ?? process.cwd();
	const read = (scope: ExtensionScope) => {
		const result = readState(scope, cwd);
		if (result.status === "corrupt") throw new Error(`extension install state is corrupt: ${result.message}`);
		return result.state.installed[id];
	};
	return options.scope ? read(options.scope) : (read("project") ?? read("user"));
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
): InstalledExtensionRecord | null {
	const candidate = loadManifestFromRoot(root);
	const manifest = candidate.manifest;
	const diagnostics = [...candidate.diagnostics];
	const id = manifest?.id ?? fallbackId;
	const provenance = stateResult.state.installed[id];
	const expectedDigest = provenance?.contentDigest;
	let observedDigest: string | undefined;
	let captured: ReadonlyMap<string, Buffer> | undefined;
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
			message: `extension ${id} install provenance has no content digest; reinstall with --force`,
			path: statePath(scope, cwd),
		});
	} else {
		try {
			const manifestName = candidate.manifestPath ? path.basename(candidate.manifestPath) : undefined;
			const digestResult = extensionContentDigestWithCapture(root, {
				capture: [...(manifestName ? [manifestName] : []), "hooks.yaml"],
			});
			observedDigest = digestResult.digest;
			contentVerified = observedDigest === expectedDigest;
			// Consent is to the envelope. Identical bytes always yield one envelope, so a
			// mismatch means the record was edited or the reviewed envelope no longer
			// describes this package; either way the operator has not approved what would load.
			if (contentVerified && manifest?.runtimeV2) {
				const current = envelopeDigestOf(capabilityEnvelope(manifest.runtimeV2, manifest.plugin));
				if (provenance.envelopeDigest !== current) {
					contentVerified = false;
					diagnostics.push({
						type: "error",
						message: provenance.envelopeDigest
							? `installed extension capability envelope differs from the one recorded at install (recorded ${provenance.envelopeDigest}, current ${current}); reinstall to review it`
							: `extension ${id} has no recorded capability envelope; reinstall to review what it may do`,
						path: root,
					});
				}
			}
			if (contentVerified) captured = digestResult.captured;
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
	const manifestName = candidate.manifestPath ? path.basename(candidate.manifestPath) : undefined;
	const manifestBytes = manifestName ? captured?.get(manifestName) : undefined;
	const extensionProvenance =
		contentVerified && expectedDigest && manifestBytes
			? {
					id,
					scope,
					...(provenance?.source ? { sourcePath: provenance.source } : {}),
					canonicalRoot: realpathSync(root),
					manifestDigest: createHash("sha256").update(manifestBytes).digest("hex"),
					contentDigest: expectedDigest,
				}
			: undefined;
	const entry: InstalledExtension = {
		id,
		name: manifest?.name ?? id,
		version: manifest?.version ?? "unknown",
		description: manifest?.description ?? "Installed extension has an invalid manifest.",
		...(manifest?.capabilities ? { capabilities: manifest.capabilities } : {}),
		...(manifest?.runtime ? { runtime: manifest.runtime } : {}),
		...(manifest?.runtimeV2 ? { runtimeV2: manifest.runtimeV2 } : {}),
		...(manifest?.plugin ? { plugin: manifest.plugin } : {}),
		scope,
		rootPath: root,
		manifestPath: candidate.manifestPath ?? root,
		enabled: !stateResult.state.disabled.includes(id),
		valid: manifest !== undefined && candidate.valid && contentVerified,
		compatible,
		effective: false,
		loadable: false,
		...(extensionProvenance ? { provenance: extensionProvenance } : {}),
		...(observedDigest ? { observedContentDigest: observedDigest } : {}),
		diagnostics,
	};
	return { entry, ...(extensionProvenance && captured ? { captured } : {}) };
}

/** A scope whose managed directory is redirected lists as one invalid entry and never as its contents. */
function invalidRootRecord(scope: ExtensionScope, cwd: string, message: string): InstalledExtensionRecord {
	const base = extensionBaseDir(scope, cwd);
	return {
		entry: {
			id: `invalid-${scope}-extension-root`,
			name: "Extension installation directory",
			version: "0.0.0",
			description: "",
			scope,
			rootPath: base,
			manifestPath: statePath(scope, cwd),
			enabled: false,
			valid: false,
			compatible: true,
			effective: false,
			loadable: false,
			diagnostics: [{ type: "error", message: `extension directory cannot be read: ${message}`, path: base }],
		},
	};
}

function listScope(scope: ExtensionScope, cwd = process.cwd()): InstalledExtensionRecord[] {
	const base = extensionBaseDir(scope, cwd);
	if (!lexists(base)) return [];
	const redirected = managedBaseError(scope, cwd);
	if (redirected) return [invalidRootRecord(scope, cwd, redirected)];
	const state = readState(scope, cwd);
	const out: InstalledExtensionRecord[] = [];
	for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const root = path.join(base, entry.name);
		const installed = installedFromRoot(root, scope, state, cwd, entry.name);
		if (installed) out.push(installed);
	}
	return out;
}

export function listInstalledExtensions(
	cwd = process.cwd(),
	options: ExtensionListOptions = {},
	overlay?: ExtensionSessionOverlay,
): InstalledExtension[] {
	return listInstalledExtensionRecords(cwd, options, overlay).map((record) => record.entry);
}

/**
 * A project copy installs from the repository's own state, so its digest check
 * proves integrity and not consent. Workspace trust supplies the consent: until
 * the operator approves the project's extension state, its copies neither load
 * nor shadow a user copy, and user-scoped extensions are unaffected.
 */
function blockUntrustedProjectExtensions(records: ReadonlyArray<InstalledExtensionRecord>, cwd: string): void {
	const project = records.filter((record) => record.entry.scope === "project");
	if (project.length === 0 || projectPackagesTrusted(cwd, "extensions")) return;
	for (const { entry } of project) {
		entry.trustBlocked = true;
		if (entry.valid && entry.compatible && entry.enabled) {
			entry.diagnostics.push({
				type: "warning",
				message:
					"project extensions are not trusted for this workspace and are not loaded; review with clio-coder config trust extensions",
				path: statePath("project", cwd),
			});
		}
	}
}

/**
 * Session-only additions the terminal applies on top of install state: dev
 * packages and muted ids. Nothing here is ever persisted.
 */
export interface ExtensionSessionOverlay {
	devRecords(): InstalledExtensionRecord[];
	muted(): ReadonlySet<string>;
}

export function listInstalledExtensionRecords(
	cwd = process.cwd(),
	options: ExtensionListOptions = {},
	overlay?: ExtensionSessionOverlay,
): InstalledExtensionRecord[] {
	const scopes: ExtensionScope[] = options.scope ? [options.scope] : ["user", "project"];
	const records = scopes.flatMap((scope) => listScope(scope, cwd));
	blockUntrustedProjectExtensions(records, cwd);
	if (overlay && options.scope === undefined) records.push(...overlay.devRecords());
	const byId = new Map<string, InstalledExtensionRecord[]>();
	for (const record of records) {
		const entry = record.entry;
		const list = byId.get(entry.id) ?? [];
		list.push(record);
		byId.set(entry.id, list);
	}
	for (const group of byId.values()) {
		const winner = group
			.filter(
				(record) =>
					record.entry.valid && record.entry.compatible && !record.entry.trustBlocked && !record.entry.consentPending,
			)
			.sort((a, b) => scopeRank(a.entry.scope) - scopeRank(b.entry.scope))
			.at(-1);
		const muted = overlay?.muted().has(group[0]?.entry.id ?? "") === true;
		for (const record of group) {
			const entry = record.entry;
			entry.effective = record === winner;
			entry.loadable = entry.valid && entry.compatible && entry.enabled && entry.effective && !muted;
			if (muted && entry.effective) entry.muted = true;
			if (entry.valid && entry.compatible && !entry.trustBlocked && !entry.consentPending && !entry.effective && winner) {
				entry.overriddenBy = winner.entry.scope;
			}
		}
	}
	// Invalid and incompatible packages remain visible by default so the load
	// refusal and its diagnostic cannot disappear with the capabilities it suppresses.
	const all =
		options.all === true
			? records
			: records.filter(
					({ entry }) => entry.effective || entry.trustBlocked || entry.consentPending || !entry.valid || !entry.compatible,
				);
	annotateServedPlugins(
		all.map((record) => record.entry),
		cwd,
	);
	return all.sort((a, b) => {
		const id = a.entry.id.localeCompare(b.entry.id);
		if (id !== 0) return id;
		return scopeRank(a.entry.scope) - scopeRank(b.entry.scope);
	});
}

/**
 * Resolve each `plugin:` link against the plugins in effect in this workspace.
 * Plugins are read once per listing, and only when some extension declares a link.
 */
function annotateServedPlugins(entries: InstalledExtension[], cwd: string): void {
	if (!entries.some((entry) => entry.plugin)) return;
	let plugins: InstalledPlugin[] = [];
	try {
		plugins = listInstalledPlugins(cwd);
	} catch {
		// Unreadable plugin state serves no prompts: every takeover stays off and the plain prompts keep working.
	}
	for (const entry of entries) {
		if (!entry.plugin) continue;
		const served = plugins.find((plugin) => plugin.id === entry.plugin && plugin.loadable);
		entry.pluginPrompts = served?.manifest ? pluginPromptNames(served.rootPath, served.manifest) : [];
		if (served?.manifest) entry.pluginSource = `plugin:${served.scope}:${served.id}`;
		else delete entry.pluginSource;
	}
}

type InstalledInScope = InstalledExtension & { scope: ExtensionScope };

/** Install state never holds a dev package; this module's listing has no session overlay. */
function findInstalled(id: string, cwd: string, scope?: ExtensionScope): InstalledInScope | null {
	const entries = listInstalledExtensions(cwd, { ...(scope ? { scope } : {}), all: true }).filter(
		(entry): entry is InstalledInScope => entry.id === id && entry.scope !== "dev",
	);
	if (entries.length === 0) return null;
	return [...entries].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope)).at(-1) ?? null;
}

/** Whether held bytes still differ from the record. A retained backup is removed only when it matches what was recorded. */
function retainRecovery(backup: string, recordedDigest: string | undefined): boolean {
	try {
		if (!recordedDigest || extensionContentDigest(backup) !== recordedDigest) return true;
		rmSync(backup, { recursive: true, force: true });
		return false;
	} catch {
		// Cleanup failure does not undo a committed lifecycle operation, and unreadable bytes are kept.
		return true;
	}
}

function refusal(message: string, at?: string): ExtensionInstallResult {
	return { diagnostics: [{ type: "error", message, ...(at ? { path: at } : {}) }] };
}

export function installExtension(sourcePath: string, options: ExtensionInstallOptions = {}): ExtensionInstallResult {
	const scope = options.scope ?? "user";
	const cwd = options.cwd ?? process.cwd();
	const source = path.resolve(sourcePath);
	const candidate = loadManifestFromRoot(source);
	if (!candidate.manifest || !candidate.valid) return { diagnostics: candidate.diagnostics };
	const manifest = candidate.manifest;
	if (
		(options.expectedId !== undefined && options.expectedId !== manifest.id) ||
		(options.expectedVersion !== undefined && options.expectedVersion !== manifest.version)
	)
		return refusal("extension source does not match the pinned identity or version");
	const redirected = managedBaseError(scope, cwd);
	if (redirected) return refusal(redirected);
	// The source is hashed before anything is staged, so a hard link, a special file or an
	// escaping link stops here and the managed directory never sees it.
	let sourceDigest: string;
	try {
		sourceDigest = extensionContentDigest(source);
	} catch (error) {
		return refusal(
			`extension source cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
			source,
		);
	}
	if (options.expectedDigest !== undefined && sourceDigest !== options.expectedDigest)
		return refusal("extension source does not match the pinned full-tree digest");
	if (lexists(path.join(source, "state.json")))
		return refusal("extension package must not contain a root state.json, which belongs to install state", source);
	const envelope = manifest.runtimeV2
		? envelopeDigestOf(capabilityEnvelope(manifest.runtimeV2, manifest.plugin))
		: undefined;
	if (options.expectedEnvelopeDigest !== undefined && (options.expectedEnvelopeDigest ?? undefined) !== envelope)
		return refusal("extension capability envelope differs from the one reviewed; review a fresh plan");
	const base = extensionBaseDir(scope, cwd);
	const targetRoot = path.join(base, manifest.id);
	// Copying a source into its own descendant grows recursively; replacing an
	// ancestor would erase the source. Neither is a meaningful install.
	if (
		contained(canonicalizeExistingPath(source), canonicalizeExistingPath(base)) ||
		contained(canonicalizeExistingPath(targetRoot), canonicalizeExistingPath(source))
	)
		return refusal("extension source overlaps its managed installation destination");
	if (lexists(targetRoot)) {
		if (lstatSync(targetRoot).isSymbolicLink())
			return refusal("installed extension root must not be a symbolic link", targetRoot);
		if (!options.force) {
			return refusal(`extension ${manifest.id} is already installed; retry with --force to replace it`, targetRoot);
		}
	}
	const stateResult = readState(scope, cwd);
	if (stateResult.status === "corrupt" && !options.force) {
		return refusal(
			`extension install state is corrupt: ${stateResult.message}; retry with --force to back it up and reinstall safely`,
			statePath(scope, cwd),
		);
	}
	const state = stateResult.status === "corrupt" ? structuredClone(DEFAULT_STATE) : stateResult.state;
	const previousDigest = state.installed[manifest.id]?.contentDigest;
	const parent = path.dirname(targetRoot);
	const stagingRoot = uniqueSibling(targetRoot, "install");
	const backupRoot = uniqueSibling(targetRoot, "backup");
	let installedReplacement = false;
	let movedExisting = false;
	// Files that differ from the record are the operator's evidence, not ours to discard.
	let preserveBackup = false;
	if (lexists(targetRoot)) {
		try {
			preserveBackup = extensionContentDigest(targetRoot) !== previousDigest;
		} catch {
			// An unreadable tree cannot be proven to match its record.
			preserveBackup = true;
		}
	}
	let stateBackup: string | undefined;
	let packageBackup: string | undefined;
	try {
		mkdirSync(parent, { recursive: true });
		if (stateResult.status === "corrupt") stateBackup = preserveFile(statePath(scope, cwd), "corrupt");
		cpSync(source, stagingRoot, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
		const stagedCandidate = loadManifestFromRoot(stagingRoot);
		if (!stagedCandidate.valid || !stagedCandidate.manifest) {
			const reasons = stagedCandidate.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
			throw new Error(`staged extension content is invalid${reasons ? `: ${reasons}` : ""}`);
		}
		const stagedManifest = stagedCandidate.manifest;
		if (stagedManifest.id !== manifest.id) {
			throw new Error(`staged extension id changed from ${manifest.id} to ${stagedManifest.id}`);
		}
		const stagedEnvelope = stagedManifest.runtimeV2
			? envelopeDigestOf(capabilityEnvelope(stagedManifest.runtimeV2, stagedManifest.plugin))
			: undefined;
		if (
			extensionContentDigest(stagingRoot) !== sourceDigest ||
			stagedManifest.version !== manifest.version ||
			stagedEnvelope !== envelope
		)
			throw new Error("staged extension differs from the verified source tree");
		if (extensionContentDigest(source) !== sourceDigest) throw new Error("extension source changed while staging");
		if (lexists(targetRoot)) {
			renameSync(targetRoot, backupRoot);
			movedExisting = true;
			packageBackup = backupRoot;
		}
		renameSync(stagingRoot, targetRoot);
		installedReplacement = true;
		if (extensionContentDigest(targetRoot) !== sourceDigest) throw new Error("extension changed during publication");
		// The staged manifest is the one whose bytes were just digested, so the envelope recorded is the one installed.
		state.installed[manifest.id] = {
			installedAt: new Date().toISOString(),
			source: options.source ?? source,
			origin: options.origin ?? { kind: "local", source },
			contentDigest: sourceDigest,
			...(envelope ? { envelopeDigest: envelope } : {}),
		};
		state.disabled = state.disabled.filter((entry) => entry !== manifest.id);
		writeState(scope, state, cwd);
	} catch (error) {
		rmSync(stagingRoot, { recursive: true, force: true });
		// Preserve concurrent changes instead of deleting someone else's work.
		let changed = false;
		if (installedReplacement && lexists(targetRoot)) {
			try {
				changed = extensionContentDigest(targetRoot) !== sourceDigest;
			} catch {
				// Unreadable replacement bytes are preserved.
				changed = true;
			}
			if (!changed) rmSync(targetRoot, { recursive: true, force: true });
		}
		if (movedExisting && !changed && existsSync(backupRoot) && !lexists(targetRoot)) {
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
					message: `extension ${manifest.id} install failed: ${error instanceof Error ? error.message : String(error)}`,
					path: targetRoot,
				},
			],
		};
	}
	const diagnostics = [...candidate.diagnostics];
	if (movedExisting && !preserveBackup) preserveBackup = retainRecovery(backupRoot, previousDigest);
	if (movedExisting && preserveBackup) {
		diagnostics.push({
			type: "warning",
			message:
				stateResult.status === "valid"
					? "previous extension files that differed from the install record were preserved"
					: "previous unverifiable extension bytes were preserved during forced reinstall",
			path: backupRoot,
		});
	} else packageBackup = undefined;
	if (stateBackup) {
		diagnostics.push({ type: "warning", message: "corrupt extension install state was preserved", path: stateBackup });
	}
	const installed = findInstalled(manifest.id, cwd, scope);
	recordLifecycleReceipt(
		{
			operation: movedExisting ? "update" : "install",
			kind: "extension",
			id: manifest.id,
			version: manifest.version,
			contentDigest: sourceDigest,
			envelopeDigest: envelope ?? null,
			scope,
			source: options.source ?? source,
		},
		options.lifecycle,
	);
	return {
		...(installed ? { extension: installed } : {}),
		...(stateBackup || packageBackup
			? { recovery: { ...(stateBackup ? { stateBackup } : {}), ...(packageBackup ? { packageBackup } : {}) } }
			: {}),
		diagnostics,
	};
}

/** The diagnostic for an id that is not installed, naming a redirected scope when that is why. */
function notInstalled(id: string, options: ExtensionListOptions, cwd: string): ExtensionMutationResult {
	for (const scope of options.scope ? [options.scope] : (["user", "project"] as const)) {
		const redirected = managedBaseError(scope, cwd);
		if (redirected && (options.scope || !lexists(extensionBaseDir(scope, cwd))))
			return { diagnostics: [{ type: "error", message: redirected }] };
	}
	return { diagnostics: [{ type: "error", message: `extension ${id} is not installed` }] };
}

function mutateEnabled(id: string, enabled: boolean, options: ExtensionListOptions = {}): ExtensionMutationResult {
	const cwd = options.cwd ?? process.cwd();
	const target = findInstalled(id, cwd, options.scope);
	if (!target) return notInstalled(id, options, cwd);
	const redirected = managedBaseError(target.scope, cwd);
	if (redirected) return { diagnostics: [{ type: "error", message: redirected }] };
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
	recordLifecycleReceipt(
		{
			operation: enabled ? "enable" : "disable",
			kind: "extension",
			id,
			version: target.version,
			contentDigest: state.installed[id]?.contentDigest ?? null,
			envelopeDigest: state.installed[id]?.envelopeDigest ?? null,
			scope: target.scope,
			source: state.installed[id]?.source ?? target.rootPath,
		},
		options.lifecycle,
	);
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
	if (!target) return notInstalled(id, options, cwd);
	const redirected = managedBaseError(target.scope, cwd);
	if (redirected) return { diagnostics: [{ type: "error", message: redirected }] };
	if (lstatSync(target.rootPath).isSymbolicLink()) {
		return {
			diagnostics: [
				{ type: "error", message: "installed extension root must not be a symbolic link", path: target.rootPath },
			],
		};
	}
	const stateResult = readState(target.scope, cwd);
	const receiptIdentity = {
		operation: "remove" as const,
		kind: "extension",
		id,
		version: target.version,
		contentDigest: stateResult.state.installed[id]?.contentDigest ?? target.provenance?.contentDigest ?? null,
		envelopeDigest: stateResult.state.installed[id]?.envelopeDigest ?? null,
		scope: target.scope,
		source: stateResult.state.installed[id]?.source ?? target.rootPath,
	};
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
			recordLifecycleReceipt(receiptIdentity, options.lifecycle);
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
	const recordedDigest = state.installed[id]?.contentDigest;
	// Files that differ from the record leave the load path but stay on disk beside it.
	let preserve = false;
	try {
		preserve = extensionContentDigest(target.rootPath) !== recordedDigest;
	} catch {
		preserve = true;
	}
	const packageBackup = preserve ? uniqueSibling(target.rootPath, "removed") : undefined;
	try {
		if (packageBackup) renameSync(target.rootPath, packageBackup);
		else rmSync(target.rootPath, { recursive: true, force: true });
		Reflect.deleteProperty(state.installed, id);
		state.disabled = state.disabled.filter((entry) => entry !== id);
		writeState(target.scope, state, cwd);
	} catch (error) {
		if (packageBackup && existsSync(packageBackup) && !lexists(target.rootPath))
			renameSync(packageBackup, target.rootPath);
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
	recordLifecycleReceipt(receiptIdentity, options.lifecycle);
	return {
		removed: { id, scope: target.scope, path: target.rootPath },
		...(packageBackup ? { recovery: { packageBackup } } : {}),
		diagnostics: packageBackup
			? [
					{
						type: "warning",
						message: "removed extension contained changed or unverified files; preserved recovery copy",
						path: packageBackup,
					},
				]
			: [],
	};
}
