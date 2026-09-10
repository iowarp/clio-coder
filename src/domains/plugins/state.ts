import { randomBytes } from "node:crypto";
import {
	closeSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioConfigDir } from "../../core/xdg.js";
import { evaluateClioCompatibility } from "../extensions/compatibility.js";
import { isLibraryKind, type LibraryRequirementRef } from "../resources/library-types.js";
import { isPluginId, pluginPathContained, readPluginManifest } from "./discovery.js";
import { pluginContentDigest } from "./integrity.js";
import type {
	InstalledPlugin,
	LibraryPackageInstallInput,
	PluginDiagnosticCode,
	PluginExpectedCopy,
	PluginExpectedState,
	PluginInstallOptions,
	PluginInstallRecord,
	PluginListOptions,
	PluginMutationOptions,
	PluginMutationResult,
	PluginScope,
	PluginState,
} from "./types.js";
import { isForeignPluginOrigin } from "./types.js";

/** sourcePath is a prepared package root containing plugin.json for the declared kind. */
export function installLibraryPackage(input: LibraryPackageInstallInput): PluginMutationResult {
	const { kind, sourcePath, ...options } = input;
	return installPlugin(sourcePath, { ...options, expectedKind: kind });
}

export function pluginBaseDir(scope: PluginScope, cwd = process.cwd()): string {
	return scope === "user"
		? path.join(clioConfigDir(), "plugins")
		: path.join(path.resolve(cwd), ".clio-coder", "plugins");
}

export function pluginStatePath(scope: PluginScope, cwd = process.cwd()): string {
	return path.join(pluginBaseDir(scope, cwd), "state.json");
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plainFile(file: string): void {
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
		throw new Error(`plugin state must be a regular unlinked file: ${file}`);
}

function stateBytes(file: string): string | undefined {
	if (!existsSync(file)) return undefined;
	plainFile(file);
	return readFileSync(file, "utf8");
}

function readState(scope: PluginScope, cwd: string): { state: PluginState; bytes?: string } {
	const bytes = stateBytes(pluginStatePath(scope, cwd));
	if (bytes === undefined) return { state: { version: 1, disabled: [], installed: {} } };
	const raw: unknown = JSON.parse(bytes);
	if (
		!record(raw) ||
		raw.version !== 1 ||
		!Array.isArray(raw.disabled) ||
		!raw.disabled.every((id) => typeof id === "string" && isPluginId(id)) ||
		!record(raw.installed)
	)
		throw new Error("plugin install state is malformed");
	for (const [id, entry] of Object.entries(raw.installed)) {
		if (
			!isPluginId(id) ||
			!record(entry) ||
			typeof entry.installedAt !== "string" ||
			typeof entry.source !== "string" ||
			typeof entry.contentDigest !== "string" ||
			!/^[a-f0-9]{64}$/u.test(entry.contentDigest)
		)
			throw new Error(`invalid plugin install record: ${id}`);
		if (entry.origin !== undefined && typeof entry.origin !== "string" && !validOrigin(entry.origin))
			throw new Error(`invalid plugin origin: ${id}`);
		if (entry.kind !== undefined && !isLibraryKind(entry.kind)) throw new Error(`invalid package kind: ${id}`);
		if (entry.trust !== undefined && entry.trust !== "trusted" && entry.trust !== "foreign")
			throw new Error(`invalid package trust: ${id}`);
	}
	return { state: raw as unknown as PluginState, bytes };
}

const FOREIGN_FORMATS = new Set(["portable", "claude-code", "codex"]);
/** Persisted provenance is validated on every read so a hand-edited record cannot invent an origin. */
function validOrigin(origin: unknown): boolean {
	if (!record(origin) || typeof origin.source !== "string") return false;
	const optional =
		(origin.marketplace === undefined || typeof origin.marketplace === "string") &&
		(origin.host === undefined || typeof origin.host === "string");
	switch (origin.kind) {
		case "local":
		case "catalog":
		case "github":
			return true;
		case "interop":
			return (
				typeof origin.host === "string" &&
				path.isAbsolute(origin.source) &&
				optional &&
				(origin.format === undefined || FOREIGN_FORMATS.has(String(origin.format)))
			);
		case "import":
			return (
				FOREIGN_FORMATS.has(String(origin.format)) &&
				optional &&
				((origin.transport === "local" && path.isAbsolute(origin.source)) ||
					(origin.transport === "github" && /^https:\/\/github\.com\//u.test(origin.source)))
			);
		default:
			return false;
	}
}

function assertUnchangedState(file: string, expected: string | undefined): void {
	if (stateBytes(file) !== expected)
		throw new Error("plugin install state changed during the operation; retry after reviewing concurrent edits");
}

function writeState(scope: PluginScope, cwd: string, state: PluginState, expected: string | undefined): void {
	const file = pluginStatePath(scope, cwd);
	assertUnchangedState(file, expected);
	safeResourceWrite(file, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
		beforeRename: () => assertUnchangedState(file, expected),
	});
}

/** Reject redirects beneath the operator-selected config or project root. */
function assertManagedBase(scope: PluginScope, cwd: string): void {
	const boundary = scope === "user" ? path.resolve(clioConfigDir()) : path.resolve(cwd);
	const base = pluginBaseDir(scope, cwd);
	let cursor = boundary;
	for (const part of path.relative(boundary, base).split(path.sep)) {
		cursor = path.join(cursor, part);
		try {
			const stat = lstatSync(cursor);
			if (stat.isSymbolicLink() || !stat.isDirectory())
				throw new Error(`plugin managed path must be a directory without symbolic links: ${cursor}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

/** A writer refusal with a machine-readable reason; the message is what operators see. */
export class PluginWriterRefusal extends Error {
	constructor(
		readonly code: PluginDiagnosticCode,
		message: string,
		readonly changed?: {
			scope: PluginScope;
			id: string;
			fact: keyof PluginExpectedCopy;
			expected: unknown;
			observed: unknown;
		},
	) {
		super(message);
		this.name = "PluginWriterRefusal";
	}
}

function acquireScopeLock(scope: PluginScope, cwd: string): () => void {
	assertManagedBase(scope, cwd);
	mkdirSync(pluginBaseDir(scope, cwd), { recursive: true });
	const lock = path.join(pluginBaseDir(scope, cwd), ".mutation.lock");
	let fd: number;
	try {
		fd = openSync(lock, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new PluginWriterRefusal("locked", "another plugin operation holds the installation lock");
		throw error;
	}
	return () => {
		closeSync(fd);
		rmSync(lock, { force: true });
	};
}

/**
 * Hold one scope's cooperative `.mutation.lock` around `fn`. Non-blocking: a
 * held lock throws a `locked` refusal immediately, so two holders can never
 * deadlock. A composer that reviewed peer-scope facts holds the peer lock here
 * and lets the writer take its own; the same scope must never be nested.
 */
export function withPluginScopeLock<T>(scope: PluginScope, cwd: string, fn: () => T): T {
	const release = acquireScopeLock(scope, cwd);
	try {
		return fn();
	} finally {
		release();
	}
}

function withMutation(scope: PluginScope, cwd: string, work: () => PluginMutationResult): PluginMutationResult {
	try {
		return withPluginScopeLock(scope, cwd, work);
	} catch (error) {
		return {
			diagnostics: [
				{
					type: "error",
					message: error instanceof Error ? error.message : String(error),
					...(error instanceof PluginWriterRefusal ? { code: error.code } : {}),
					...(error instanceof PluginWriterRefusal && error.changed ? { changed: error.changed } : {}),
				},
			],
		};
	}
}

/** Observe the facts a plan reviews for one copy. Throws when that scope's state cannot be read. */
export function observePluginCopy(scope: PluginScope, id: string, cwd: string): PluginExpectedCopy {
	const saved = readState(scope, cwd).state.installed[id];
	const target = path.join(pluginBaseDir(scope, cwd), id);
	let tree: string = "absent";
	if (existsSync(target)) {
		try {
			tree = pluginContentDigest(target);
		} catch {
			tree = "unreadable";
		}
	}
	return {
		scope,
		id,
		recorded: saved !== undefined,
		tree,
		enabled: !readState(scope, cwd).state.disabled.includes(id),
		...(saved ? { recordedDigest: saved.contentDigest } : {}),
		...(saved?.kind ? { kind: saved.kind } : {}),
		...(saved?.trust ? { trust: saved.trust } : {}),
		...(saved?.origin !== undefined ? { origin: saved.origin } : {}),
	};
}

/**
 * Recheck reviewed facts. Called inside the mutated scope's lock; peer-scope
 * facts are only as protected as the lock the composer holds for that scope.
 */
function assertExpectedState(expect: PluginExpectedState | undefined, cwd: string): void {
	for (const expected of expect?.copies ?? []) {
		let observed: PluginExpectedCopy;
		try {
			observed = observePluginCopy(expected.scope, expected.id, cwd);
		} catch (error) {
			throw new PluginWriterRefusal(
				"stale_plan",
				`reviewed state for ${expected.scope}:${expected.id} is no longer readable: ${error instanceof Error ? error.message : String(error)}; review a fresh plan`,
			);
		}
		// A reviewed snapshot is complete: a fact that appears or disappears
		// (absent origin becoming foreign, trust or kind recorded later) is a
		// change, so compare the union of both key sets.
		const facts = new Set(
			expected.partial ? Object.keys(expected) : [...Object.keys(expected), ...Object.keys(observed)],
		) as Set<keyof PluginExpectedCopy>;
		for (const fact of facts) {
			if (fact === "scope" || fact === "id" || fact === "partial") continue;
			const want = JSON.stringify(expected[fact] ?? null);
			const have = JSON.stringify(observed[fact] ?? null);
			if (want !== have)
				throw new PluginWriterRefusal(
					"stale_plan",
					`reviewed ${fact} changed for ${expected.scope}:${expected.id} (expected ${want}, observed ${have}); review a fresh plan`,
					{ scope: expected.scope, id: expected.id, fact, expected: expected[fact], observed: observed[fact] },
				);
		}
	}
}

/** The one precedence rule: valid, compatible copies compete and project wins. */
export function resolvePluginPrecedence(entries: InstalledPlugin[]): void {
	for (const entry of entries) {
		const winner = entries
			.filter((peer) => peer.id === entry.id && peer.valid && peer.compatible)
			.sort((a, b) => Number(a.scope === "project") - Number(b.scope === "project"))
			.at(-1);
		entry.effective = entry === winner;
		entry.loadable = entry.valid && entry.compatible && entry.enabled && entry.effective;
		delete entry.overriddenBy;
		if (winner && winner !== entry) entry.overriddenBy = winner.scope;
	}
}

export interface PluginDependentBreak {
	ref: LibraryRequirementRef;
	scope: PluginScope;
	missing: LibraryRequirementRef[];
}

function unmetRequirementsOf(entry: InstalledPlugin, entries: ReadonlyArray<InstalledPlugin>): LibraryRequirementRef[] {
	return (entry.manifest?.clio.requires ?? []).filter(
		(requirement) => !entries.some((peer) => peer.loadable && `${peer.kind ?? "plugin"}:${peer.id}` === requirement),
	);
}

/**
 * Project the effective set after exactly one disable or removal and report
 * enabled effective dependents that are satisfied now and would not be.
 * Pre-existing breakage is listed separately and never refuses.
 */
export function newlyBrokenDependents(
	entries: ReadonlyArray<InstalledPlugin>,
	mutation: { scope: PluginScope; id: string; operation: "disable" | "remove" },
): { newlyBroken: PluginDependentBreak[]; preexisting: PluginDependentBreak[]; effectiveAfter?: InstalledPlugin } {
	const before = entries.map((entry) => ({ ...entry }));
	resolvePluginPrecedence(before);
	const after = before
		.filter((entry) => !(mutation.operation === "remove" && entry.id === mutation.id && entry.scope === mutation.scope))
		.map((entry) => ({
			...entry,
			enabled:
				mutation.operation === "disable" && entry.id === mutation.id && entry.scope === mutation.scope
					? false
					: entry.enabled,
		}));
	resolvePluginPrecedence(after);
	const newlyBroken: PluginDependentBreak[] = [];
	const preexisting: PluginDependentBreak[] = [];
	for (const entry of before) {
		if (entry.id === mutation.id && entry.scope === mutation.scope) continue;
		const later = after.find((peer) => peer.id === entry.id && peer.scope === entry.scope);
		if (!later?.loadable) continue;
		const missingBefore = entry.loadable ? unmetRequirementsOf(entry, before) : [];
		const missingAfter = unmetRequirementsOf(later, after);
		const ref: LibraryRequirementRef = `${entry.kind ?? "plugin"}:${entry.id}`;
		const fresh = missingAfter.filter((requirement) => !missingBefore.includes(requirement));
		if (fresh.length) newlyBroken.push({ ref, scope: entry.scope, missing: fresh });
		else if (missingAfter.length) preexisting.push({ ref, scope: entry.scope, missing: missingAfter });
	}
	const effectiveAfter = after.find((entry) => entry.id === mutation.id && entry.effective);
	return { newlyBroken, preexisting, ...(effectiveAfter ? { effectiveAfter } : {}) };
}

function refuseBrokenDependents(
	cwd: string,
	mutation: { scope: PluginScope; id: string; operation: "disable" | "remove" },
): void {
	const { newlyBroken } = newlyBrokenDependents(listInstalledPlugins(cwd, { all: true }), mutation);
	if (newlyBroken.length)
		throw new PluginWriterRefusal(
			"dependents",
			`${mutation.operation} of ${mutation.scope}:${mutation.id} would break ${newlyBroken
				.map((item) => `${item.scope}:${item.ref} (missing ${item.missing.join(", ")})`)
				.join("; ")}; disable or remove those dependents first`,
		);
}

function scopeEntries(scope: PluginScope, cwd: string): InstalledPlugin[] {
	const base = pluginBaseDir(scope, cwd);
	if (!existsSync(base)) return [];
	let names: string[];
	try {
		assertManagedBase(scope, cwd);
		names = readdirSync(base).sort().filter(isPluginId);
	} catch (error) {
		return [
			{
				id: `invalid-${scope}-plugin-root`,
				name: "Plugin installation directory",
				version: "0.0.0",
				description: "",
				scope,
				rootPath: base,
				manifestPath: pluginStatePath(scope, cwd),
				enabled: false,
				valid: false,
				compatible: true,
				effective: false,
				loadable: false,
				resources: {},
				diagnostics: [
					{
						type: "error",
						message: `plugin directory cannot be read: ${error instanceof Error ? error.message : String(error)}`,
						path: base,
					},
				],
			},
		];
	}
	let state: PluginState = { version: 1, disabled: [], installed: {} };
	let stateError: string | undefined;
	try {
		assertManagedBase(scope, cwd);
		state = readState(scope, cwd).state;
	} catch (error) {
		stateError = error instanceof Error ? error.message : String(error);
	}
	const entries: InstalledPlugin[] = [];
	for (const id of names) {
		const rootPath = path.join(base, id);
		const candidate = readPluginManifest(rootPath);
		const manifest = candidate.manifest;
		const diagnostics = [...candidate.diagnostics];
		const saved = state.installed[id];
		if (manifest && manifest.name !== id)
			diagnostics.push({
				type: "error",
				message: `installed directory ${id} does not match plugin identity ${manifest.name}`,
				path: rootPath,
			});
		if (stateError)
			diagnostics.push({
				type: "error",
				message: `plugin install state cannot be read: ${stateError}`,
				path: pluginStatePath(scope, cwd),
			});
		else if (!saved)
			diagnostics.push({
				type: "error",
				message: "plugin is not recorded in install state; install it through plugins install",
				path: rootPath,
			});
		else if (candidate.contentDigest !== saved.contentDigest)
			diagnostics.push({
				type: "error",
				message: `installed plugin content drift detected (expected ${saved.contentDigest}, observed ${candidate.contentDigest ?? "unreadable"})`,
				path: rootPath,
			});
		const range = manifest?.clio.compatibility?.clio;
		const compatible = range === undefined || evaluateClioCompatibility(range).satisfied;
		if (!compatible)
			diagnostics.push({
				type: "error",
				message: `plugin requires Clio ${range}`,
				path: candidate.manifestPath ?? rootPath,
			});
		const valid =
			candidate.valid &&
			!stateError &&
			!!saved &&
			candidate.contentDigest === saved.contentDigest &&
			manifest?.name === id;
		entries.push({
			id,
			kind: saved?.kind ?? manifest?.clio.kind ?? "plugin",
			trust: saved?.trust ?? (isForeignPluginOrigin(saved?.origin) ? "foreign" : "trusted"),
			name: manifest?.name ?? id,
			version: manifest?.version ?? "0.0.0",
			description: manifest?.description ?? "",
			scope,
			rootPath,
			manifestPath: candidate.manifestPath ?? path.join(rootPath, "plugin.json"),
			enabled: !state.disabled.includes(id),
			valid,
			compatible,
			effective: false,
			loadable: false,
			resources: manifest?.clio.resources ?? {},
			...(manifest ? { manifest } : {}),
			diagnostics,
			...(candidate.contentDigest ? { observedContentDigest: candidate.contentDigest } : {}),
			...(valid && candidate.manifestDigest && saved
				? {
						provenance: {
							id,
							scope,
							sourcePath: saved.source,
							canonicalRoot: realpathSync(rootPath),
							manifestDigest: candidate.manifestDigest,
							contentDigest: saved.contentDigest,
						},
					}
				: {}),
		});
	}
	return entries;
}

export function listInstalledPlugins(cwd = process.cwd(), options: PluginListOptions = {}): InstalledPlugin[] {
	const scopes: PluginScope[] = options.scope ? [options.scope] : ["user", "project"];
	const entries = scopes.flatMap((scope) => scopeEntries(scope, cwd));
	resolvePluginPrecedence(entries);
	return entries
		.filter((entry) => options.all || entry.effective || !entry.valid || !entry.compatible)
		.sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope));
}

export function readPluginInstallRecord(id: string, options: PluginListOptions = {}): PluginInstallRecord | undefined {
	if (!isPluginId(id)) return undefined;
	const cwd = options.cwd ?? process.cwd();
	if (options.scope) return readState(options.scope, cwd).state.installed[id];
	return readState("project", cwd).state.installed[id] ?? readState("user", cwd).state.installed[id];
}

function selectedScope(id: string, options: PluginListOptions): PluginScope {
	if (options.scope) return options.scope;
	return existsSync(path.join(pluginBaseDir("project", options.cwd), id)) ? "project" : "user";
}

function uniqueSibling(target: string, purpose: string): string {
	return path.join(
		path.dirname(target),
		`.${path.basename(target)}.${purpose}-${process.pid}-${randomBytes(8).toString("hex")}`,
	);
}

/** Recheck held bytes after publication so edits made during staging survive. */
function retainRecovery(backup: string, expectedDigest: string | undefined): boolean {
	try {
		if (!expectedDigest || pluginContentDigest(backup) !== expectedDigest) return true;
		rmSync(backup, { recursive: true, force: true });
		return false;
	} catch {
		// Cleanup failure does not undo a committed lifecycle operation.
		return true;
	}
}

export function installPlugin(sourcePath: string, options: PluginInstallOptions = {}): PluginMutationResult {
	const cwd = options.cwd ?? process.cwd();
	const scope = options.scope ?? "user";
	const source = path.resolve(cwd, sourcePath);
	const candidate = readPluginManifest(source);
	if (!candidate.valid || !candidate.manifest || !candidate.contentDigest) return { diagnostics: candidate.diagnostics };
	const manifest = candidate.manifest;
	const digest = candidate.contentDigest;
	const range = manifest.clio.compatibility?.clio;
	if (range && !evaluateClioCompatibility(range).satisfied)
		return { diagnostics: [{ type: "error", message: `plugin requires Clio ${range}` }] };
	if (
		(options.expectedKind !== undefined && options.expectedKind !== (manifest.clio.kind ?? "plugin")) ||
		(options.expectedDigest !== undefined && options.expectedDigest !== digest) ||
		(options.expectedId !== undefined && options.expectedId !== manifest.name) ||
		(options.expectedVersion !== undefined && options.expectedVersion !== manifest.version)
	)
		return {
			diagnostics: [{ type: "error", message: "plugin source does not match the pinned digest, identity, or version" }],
		};
	const target = path.join(pluginBaseDir(scope, cwd), manifest.name);
	const resolvedBase = pluginBaseDir(scope, cwd);
	// Copying a source into its own descendant grows recursively; replacing an
	// ancestor would erase the source. Neither is a meaningful install.
	if (
		pluginPathContained(canonicalizeExistingPath(source), canonicalizeExistingPath(resolvedBase)) ||
		pluginPathContained(canonicalizeExistingPath(target), canonicalizeExistingPath(source))
	)
		return { diagnostics: [{ type: "error", message: "plugin source overlaps its managed installation destination" }] };
	return withMutation(scope, cwd, () => {
		const { state, bytes } = readState(scope, cwd);
		assertExpectedState(options.expect, cwd);
		const previouslyInstalled = Object.hasOwn(state.installed, manifest.name);
		const previousDigest = state.installed[manifest.name]?.contentDigest;
		const previousOrigin = state.installed[manifest.name]?.origin;
		if (isForeignPluginOrigin(previousOrigin))
			throw new Error("interop packages require a new reviewed adoption; remove the installed copy and adopt it again");
		const previousKind = state.installed[manifest.name]?.kind ?? readPluginManifest(target).manifest?.clio.kind;
		if (previousKind && previousKind !== (manifest.clio.kind ?? "plugin"))
			throw new Error("package kind cannot change during replacement; remove it explicitly first");
		if (existsSync(target) && !options.force)
			throw new Error(`plugin ${manifest.name} is already installed; use --force to replace it`);
		if (existsSync(target) && lstatSync(target).isSymbolicLink())
			throw new Error("installed plugin root must not be a symbolic link");
		const staging = uniqueSibling(target, "install");
		const backup = uniqueSibling(target, "backup");
		let moved = false;
		let published = false;
		let preserveBackup = false;
		if (existsSync(target)) {
			try {
				preserveBackup = pluginContentDigest(target) !== state.installed[manifest.name]?.contentDigest;
			} catch {
				preserveBackup = true;
			}
		}
		try {
			cpSync(source, staging, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
			const staged = readPluginManifest(staging);
			if (!staged.valid || staged.manifest?.name !== manifest.name || staged.contentDigest !== digest)
				throw new Error("staged plugin differs from the verified source tree");
			if (pluginContentDigest(source) !== digest) throw new Error("plugin source changed while staging");
			assertUnchangedState(pluginStatePath(scope, cwd), bytes);
			if (existsSync(target)) {
				renameSync(target, backup);
				moved = true;
			}
			renameSync(staging, target);
			published = true;
			if (pluginContentDigest(target) !== digest) throw new Error("plugin changed during publication");
			const origin = options.origin ?? { kind: "local" as const, source };
			const trust = isForeignPluginOrigin(origin)
				? "foreign"
				: (options.trust ?? state.installed[manifest.name]?.trust ?? "trusted");
			state.installed[manifest.name] = {
				kind: manifest.clio.kind ?? "plugin",
				installedAt: new Date().toISOString(),
				source: typeof origin === "string" ? origin : origin.source,
				origin,
				contentDigest: digest,
				trust,
			};
			if (!previouslyInstalled) state.disabled = state.disabled.filter((id) => id !== manifest.name);
			writeState(scope, cwd, state, bytes);
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			if (published && existsSync(target)) {
				// Preserve concurrent changes instead of deleting someone else's work.
				let unchanged = false;
				try {
					unchanged = pluginContentDigest(target) === digest;
				} catch {
					/* Preserve unreadable replacement. */
				}
				if (!unchanged)
					return {
						recovery: { ...(moved ? { packageBackup: backup } : {}) },
						diagnostics: [
							{
								type: "error",
								message: `plugin installation failed and changed content was preserved: ${String(error)}`,
								path: target,
							},
						],
					};
				rmSync(target, { recursive: true, force: true });
			}
			if (moved) renameSync(backup, target);
			throw error;
		}
		if (moved && !preserveBackup) preserveBackup = retainRecovery(backup, previousDigest);
		const plugin = listInstalledPlugins(cwd, { scope, all: true }).find((entry) => entry.id === manifest.name);
		return {
			...(plugin ? { plugin } : {}),
			...(moved && preserveBackup ? { recovery: { packageBackup: backup } } : {}),
			diagnostics: plugin?.diagnostics ?? [],
		};
	});
}

export function updatePlugin(id: string, options: PluginInstallOptions = {}): PluginMutationResult {
	if (!isPluginId(id)) return { diagnostics: [{ type: "error", message: "invalid plugin id" }] };
	try {
		const scope = selectedScope(id, options);
		const installed = readPluginInstallRecord(id, { ...options, scope });
		if (!installed) throw new Error(`plugin ${id} is not installed`);
		if (isForeignPluginOrigin(installed.origin))
			throw new Error("interop packages require a new reviewed adoption; remove the installed copy and adopt it again");
		const current = listInstalledPlugins(options.cwd ?? process.cwd(), { scope, all: true }).find(
			(entry) => entry.id === id,
		);
		if (!options.force && !current?.valid)
			throw new Error(
				`plugin ${id} has changed or unverifiable content; use --force to preserve a recovery copy and replace it`,
			);
		if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(installed.source))
			throw new Error("remote plugin updates must resolve a verified library catalog source");
		return installPlugin(installed.source, {
			...options,
			scope,
			force: true,
			expectedId: id,
			origin: installed.origin ?? installed.source,
		});
	} catch (error) {
		return { diagnostics: [{ type: "error", message: error instanceof Error ? error.message : String(error) }] };
	}
}

function setEnabled(id: string, enabled: boolean, options: PluginMutationOptions): PluginMutationResult {
	if (!isPluginId(id)) return { diagnostics: [{ type: "error", message: "invalid plugin id" }] };
	const cwd = options.cwd ?? process.cwd();
	const scope = selectedScope(id, options);
	return withMutation(scope, cwd, () => {
		const { state, bytes } = readState(scope, cwd);
		assertExpectedState(options.expect, cwd);
		const plugin = listInstalledPlugins(cwd, { scope, all: true }).find((entry) => entry.id === id);
		if (!plugin) throw new Error(`plugin ${id} is not installed`);
		if (enabled && (!plugin.valid || !plugin.compatible))
			throw new Error(`plugin ${id} cannot be enabled: ${plugin.diagnostics.map((entry) => entry.message).join("; ")}`);
		if (!enabled && plugin.enabled) refuseBrokenDependents(cwd, { scope, id, operation: "disable" });
		state.disabled = state.disabled.filter((value) => value !== id);
		if (!enabled) state.disabled.push(id);
		writeState(scope, cwd, state, bytes);
		const updated = listInstalledPlugins(cwd, { scope, all: true }).find((entry) => entry.id === id);
		return { ...(updated ? { plugin: updated } : {}), diagnostics: [] };
	});
}

export function enablePlugin(id: string, options: PluginMutationOptions = {}): PluginMutationResult {
	return setEnabled(id, true, options);
}
export function disablePlugin(id: string, options: PluginMutationOptions = {}): PluginMutationResult {
	return setEnabled(id, false, options);
}

export function removePlugin(id: string, options: PluginMutationOptions = {}): PluginMutationResult {
	if (!isPluginId(id)) return { diagnostics: [{ type: "error", message: "invalid plugin id" }] };
	const cwd = options.cwd ?? process.cwd();
	const scope = selectedScope(id, options);
	return withMutation(scope, cwd, () => {
		const { state, bytes } = readState(scope, cwd);
		assertExpectedState(options.expect, cwd);
		const target = path.join(pluginBaseDir(scope, cwd), id);
		const previousDigest = state.installed[id]?.contentDigest;
		if (!existsSync(target) && !state.installed[id]) throw new Error(`plugin ${id} is not installed`);
		refuseBrokenDependents(cwd, { scope, id, operation: "remove" });
		const backup = uniqueSibling(target, "removed");
		const moved = existsSync(target);
		let preserve = false;
		if (moved) {
			try {
				preserve = pluginContentDigest(target) !== state.installed[id]?.contentDigest;
			} catch {
				preserve = true;
			}
			renameSync(target, backup);
		}
		try {
			delete state.installed[id];
			state.disabled = state.disabled.filter((value) => value !== id);
			writeState(scope, cwd, state, bytes);
		} catch (error) {
			if (moved) renameSync(backup, target);
			throw error;
		}
		if (moved && !preserve) preserve = retainRecovery(backup, previousDigest);
		return {
			removed: { id, scope, path: target },
			...(preserve ? { recovery: { packageBackup: backup } } : {}),
			diagnostics: preserve
				? [
						{
							type: "warning",
							message: "removed plugin contained changed or unverified files; preserved recovery copy",
							path: backup,
						},
					]
				: [],
		};
	});
}
