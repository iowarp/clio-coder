/**
 * Workbench UI state: the recent-project list, the refuse-to-open guards, and
 * the host-side directory browser.
 *
 * This is Workbench state, not Clio Coder configuration. The only file it owns is
 * `projects.json` under the Workbench state directory. Deno's read/write grants
 * are broad at launch, so the boundary that keeps the operator away from `/`,
 * `$HOME`, dot-config directories, and system trees is enforced here, in
 * Workbench code, against canonical paths. The product says so.
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectBrowseListingPayload, WireBrowseEntry } from "./src/protocol.ts";

export const MAX_RECENT_PROJECTS = 32;
export const MAX_BROWSE_ENTRIES = 512;
export const CANONICAL_STATE_DIRECTORY_NAME = "clio-coder-gui";
export const LEGACY_STATE_DIRECTORY_NAME = "clio-workbench";
export const CANONICAL_STATE_ENV = "CLIO_CODER_GUI_STATE_DIR";
export const LEGACY_STATE_ENV = "CLIO_WORKBENCH_STATE_DIR";
export const LEGACY_MIGRATION_MARKER = "clio-coder-gui-migration-pending.json";
const RECENT_FILE = "projects.json";
const RECENT_FILE_VERSION = 1;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_MIGRATION_INPUT_BYTES = 1024 * 1024;
const MIGRATION_BACKUP_SUFFIX = "before-clio-coder-gui-merge.bak";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RecentProject {
	readonly id: string;
	readonly canonicalPath: string;
	readonly displayName: string;
	readonly lastOpenedAt: string;
}

export interface OpenableRoot {
	readonly canonicalPath: string;
	readonly displayName: string;
}

export interface WorkbenchStateOptions {
	/** Overrides the state directory resolution (tests). */
	readonly stateDir?: string;
	/** Overrides `$HOME` (tests). */
	readonly homePath?: string;
	/** Overrides environment reads (tests). */
	readonly env?: EnvReader;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export type WorkbenchStateErrorCode = "refused" | "not-found" | "invalid" | "internal";

/** A renderer-safe error: its message names only the path the operator typed. */
export class WorkbenchStateError extends Error {
	override readonly name = "WorkbenchStateError";

	constructor(readonly code: WorkbenchStateErrorCode, message: string) {
		super(message);
	}
}

const SYSTEM_ROOTS = [
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/boot",
	"/dev",
	"/proc",
	"/sys",
	"/run",
	"/var",
	"/root",
	"/opt",
	"/snap",
] as const;
const HOME_GUARDED = [".ssh", ".gnupg", ".aws", ".config", ".local", ".cache"] as const;

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function isWithin(root: string, candidate: string): boolean {
	const local = relative(root, candidate);
	return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
}

function isStrictAncestor(candidate: string, descendant: string): boolean {
	return candidate !== descendant && isWithin(candidate, descendant);
}

/** Reads one environment variable; an empty, missing, or unreadable value is `undefined`. */
export type EnvReader = (name: string) => string | undefined;

function envValue(name: string): string | undefined {
	try {
		const value = Deno.env.get(name);
		return value === undefined || value.length === 0 ? undefined : value;
	} catch {
		return undefined;
	}
}

let warnedForLegacyStateEnv = false;

function warnForLegacyStateEnv(log?: (message: string) => void): void {
	if (log === undefined || warnedForLegacyStateEnv) return;
	warnedForLegacyStateEnv = true;
	log(
		`${LEGACY_STATE_ENV} is deprecated; use ${CANONICAL_STATE_ENV}. The legacy override remains supported for two minor releases.`,
	);
}

/**
 * `$CLIO_CODER_GUI_STATE_DIR`, else the deprecated `$CLIO_WORKBENCH_STATE_DIR`,
 * else `$XDG_STATE_HOME/clio-coder-gui`, else `~/.local/state/clio-coder-gui`.
 * The installer passes its own reader so it records exactly the directory the app will use.
 */
export function resolveStateDir(
	homePath: string,
	env: EnvReader = envValue,
	log?: (message: string) => void,
): string {
	const canonical = env(CANONICAL_STATE_ENV);
	if (canonical !== undefined && isAbsolute(canonical)) return resolve(canonical);
	const legacy = env(LEGACY_STATE_ENV);
	if (legacy !== undefined && isAbsolute(legacy)) {
		warnForLegacyStateEnv(log);
		return resolve(legacy);
	}
	const xdg = env("XDG_STATE_HOME");
	if (xdg !== undefined && isAbsolute(xdg)) return join(resolve(xdg), CANONICAL_STATE_DIRECTORY_NAME);
	return join(homePath, ".local", "state", CANONICAL_STATE_DIRECTORY_NAME);
}

export function resolveHomePath(): string {
	const home = envValue("HOME");
	if (home === undefined || !isAbsolute(home)) {
		throw new WorkbenchStateError("internal", "The GUI needs an absolute HOME to place its state.");
	}
	return resolve(home);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 64) return false;
	const parsed = new Date(value);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value);
}

function validPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && isAbsolute(value) && !value.includes("\0") &&
		!hasControlCharacter(value) && encoder.encode(value).byteLength <= MAX_PATH_BYTES;
}

function validDisplayName(value: unknown): value is string {
	return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 120 &&
		!hasControlCharacter(value);
}

function parseRecentEntry(value: unknown): RecentProject | null {
	if (!isRecord(value)) return null;
	const { id, canonicalPath, displayName, lastOpenedAt } = value;
	if (!validId(id) || !validPath(canonicalPath) || !validDisplayName(displayName) || !validTimestamp(lastOpenedAt)) {
		return null;
	}
	return { id, canonicalPath: resolve(canonicalPath), displayName, lastOpenedAt };
}

function parseRecentFile(text: string): RecentProject[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || parsed.version !== RECENT_FILE_VERSION || !Array.isArray(parsed.projects)) return null;
	if (parsed.projects.length > MAX_RECENT_PROJECTS) return null;
	const projects: RecentProject[] = [];
	const ids = new Set<string>();
	const paths = new Set<string>();
	for (const entry of parsed.projects) {
		const project = parseRecentEntry(entry);
		if (project === null || ids.has(project.id) || paths.has(project.canonicalPath)) return null;
		ids.add(project.id);
		paths.add(project.canonicalPath);
		projects.push(project);
	}
	return projects;
}

/** Migration is deliberately row-tolerant: corrupt rows are backed up, then dropped. */
function parseMigrationRows(bytes: Uint8Array | null): RecentProject[] {
	if (bytes === null || bytes.byteLength > MAX_MIGRATION_INPUT_BYTES) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoder.decode(bytes));
	} catch {
		return [];
	}
	if (!isRecord(parsed) || parsed.version !== RECENT_FILE_VERSION || !Array.isArray(parsed.projects)) return [];
	return parsed.projects.flatMap((entry) => {
		const project = parseRecentEntry(entry);
		return project === null ? [] : [project];
	});
}

function mergeRecentProjects(
	canonicalRows: readonly RecentProject[],
	legacyRows: readonly RecentProject[],
): RecentProject[] {
	type Candidate = Readonly<{ project: RecentProject; canonical: boolean }>;
	const byPath = new Map<string, Candidate>();
	for (
		const candidate of [
			...legacyRows.map((project) => ({ project, canonical: false })),
			...canonicalRows.map((project) => ({ project, canonical: true })),
		]
	) {
		const previous = byPath.get(candidate.project.canonicalPath);
		if (
			previous === undefined || candidate.project.lastOpenedAt > previous.project.lastOpenedAt ||
			(candidate.project.lastOpenedAt === previous.project.lastOpenedAt && candidate.canonical && !previous.canonical)
		) byPath.set(candidate.project.canonicalPath, candidate);
	}
	const ordered = [...byPath.values()].sort((left, right) =>
		right.project.lastOpenedAt.localeCompare(left.project.lastOpenedAt) ||
		Number(right.canonical) - Number(left.canonical) ||
		left.project.canonicalPath.localeCompare(right.project.canonicalPath)
	);
	const ids = new Set<string>();
	const merged: RecentProject[] = [];
	for (const candidate of ordered) {
		if (ids.has(candidate.project.id)) continue;
		ids.add(candidate.project.id);
		merged.push(candidate.project);
		if (merged.length === MAX_RECENT_PROJECTS) break;
	}
	return merged;
}

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
	try {
		return await Deno.lstat(path);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return null;
		throw error;
	}
}

async function readOptionalBytes(path: string): Promise<Uint8Array | null> {
	try {
		return await Deno.readFile(path);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return null;
		throw error;
	}
}

async function writeBytesAtomically(path: string, bytes: Uint8Array): Promise<void> {
	const temporary = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
	try {
		await Deno.writeFile(temporary, bytes);
		await Deno.rename(temporary, path);
	} catch (error) {
		await Deno.remove(temporary).catch(() => undefined);
		throw error;
	}
}

async function nextBackupPath(stateDir: string): Promise<string> {
	const base = join(stateDir, `${RECENT_FILE}.${MIGRATION_BACKUP_SUFFIX}`);
	for (let index = 0; index < 1_000; index += 1) {
		const candidate = index === 0 ? base : `${base}.${index}`;
		if (await lstatOrNull(candidate) === null) return candidate;
	}
	throw new WorkbenchStateError("internal", "The GUI could not allocate a state-migration backup.");
}

async function backUpInput(stateDir: string, bytes: Uint8Array | null): Promise<string | null> {
	if (bytes === null) return null;
	const backup = await nextBackupPath(stateDir);
	await writeBytesAtomically(backup, bytes);
	return backup;
}

interface StateMigrationResult {
	/** Markers from an earlier launch, removed only after this launch reads canonical state successfully. */
	readonly cleanupMarkers: readonly string[];
}

function legacyStateCandidates(homePath: string, env: EnvReader, canonicalStateDir: string): string[] {
	const candidates: string[] = [];
	const xdg = env("XDG_STATE_HOME");
	if (xdg !== undefined && isAbsolute(xdg)) {
		candidates.push(join(resolve(xdg), LEGACY_STATE_DIRECTORY_NAME));
	}
	candidates.push(join(homePath, ".local", "state", LEGACY_STATE_DIRECTORY_NAME));
	return [...new Set(candidates.map((candidate) => resolve(candidate)))].filter(
		(candidate) => candidate !== canonicalStateDir,
	);
}

async function mergeStateRoots(
	canonicalStateDir: string,
	legacyStateDir: string,
	now: () => number,
	log: (message: string) => void,
): Promise<"merged" | "pending-cleanup" | "nothing"> {
	const legacyFile = join(legacyStateDir, RECENT_FILE);
	const marker = join(legacyStateDir, LEGACY_MIGRATION_MARKER);
	const legacyBytes = await readOptionalBytes(legacyFile);
	if (legacyBytes === null) return await lstatOrNull(marker) === null ? "nothing" : "pending-cleanup";

	const canonicalFile = join(canonicalStateDir, RECENT_FILE);
	const canonicalBytes = await readOptionalBytes(canonicalFile);
	await Deno.mkdir(canonicalStateDir, { recursive: true });
	const canonicalBackup = await backUpInput(canonicalStateDir, canonicalBytes);
	const legacyBackup = await backUpInput(legacyStateDir, legacyBytes);
	const projects = mergeRecentProjects(parseMigrationRows(canonicalBytes), parseMigrationRows(legacyBytes));
	const snapshot = encoder.encode(`${JSON.stringify({ version: RECENT_FILE_VERSION, projects }, null, "\t")}\n`);
	await writeBytesAtomically(canonicalFile, snapshot);
	await Deno.remove(legacyFile);
	const receipt = {
		version: 1,
		migratedAt: new Date(now()).toISOString(),
		target: canonicalStateDir,
		canonicalBackup,
		legacyBackup,
		projects: projects.length,
	};
	await writeBytesAtomically(marker, encoder.encode(`${JSON.stringify(receipt, null, "\t")}\n`));
	log(`Merged legacy GUI state into ${canonicalStateDir}; the original inputs were backed up.`);
	return "merged";
}

async function migrateLegacyState(
	canonicalStateDir: string,
	homePath: string,
	env: EnvReader,
	now: () => number,
	log: (message: string) => void,
): Promise<StateMigrationResult> {
	const cleanupMarkers: string[] = [];
	for (const legacyStateDir of legacyStateCandidates(homePath, env, canonicalStateDir)) {
		const legacyInfo = await lstatOrNull(legacyStateDir);
		if (legacyInfo === null) continue;
		if (!legacyInfo.isDirectory || legacyInfo.isSymlink) {
			log(`Legacy GUI state at ${legacyStateDir} is not a real directory and was left untouched.`);
			continue;
		}
		let canonicalInfo = await lstatOrNull(canonicalStateDir);
		if (canonicalInfo === null) {
			await Deno.mkdir(dirname(canonicalStateDir), { recursive: true });
			try {
				await Deno.rename(legacyStateDir, canonicalStateDir);
				log(`Moved legacy GUI state atomically to ${canonicalStateDir}.`);
				continue;
			} catch (error) {
				canonicalInfo = await lstatOrNull(canonicalStateDir);
				if (canonicalInfo === null || await lstatOrNull(legacyStateDir) === null) {
					throw new WorkbenchStateError(
						"internal",
						`The GUI could not move its legacy state safely (${errorName(error)}).`,
					);
				}
			}
		}
		if (!canonicalInfo?.isDirectory || canonicalInfo.isSymlink) {
			throw new WorkbenchStateError("internal", "The canonical GUI state path is not a real directory.");
		}
		const outcome = await mergeStateRoots(canonicalStateDir, legacyStateDir, now, log);
		if (outcome === "pending-cleanup") cleanupMarkers.push(join(legacyStateDir, LEGACY_MIGRATION_MARKER));
	}
	return { cleanupMarkers };
}

function compareEntryNames(left: string, right: string): number {
	const folded = left.toLocaleLowerCase("en-US").localeCompare(right.toLocaleLowerCase("en-US"), "en-US");
	return folded !== 0 ? folded : left < right ? -1 : left > right ? 1 : 0;
}

export class WorkbenchState {
	readonly stateDir: string;
	readonly homePath: string;
	readonly #now: () => number;
	readonly #log: (message: string) => void;
	#recent: RecentProject[] = [];
	#writes: Promise<void> = Promise.resolve();

	private constructor(stateDir: string, homePath: string, options: WorkbenchStateOptions) {
		this.stateDir = stateDir;
		this.homePath = homePath;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? ((message) => console.error(message));
	}

	/** Reads `projects.json`. A corrupt or unreadable file starts the list empty and logs one line to stderr. */
	static async open(options: WorkbenchStateOptions = {}): Promise<WorkbenchState> {
		const homePath = resolve(options.homePath ?? resolveHomePath());
		if (!isAbsolute(homePath)) throw new WorkbenchStateError("internal", "The GUI home path must be absolute.");
		const log = options.log ?? ((message: string) => console.error(message));
		const env = options.env ?? envValue;
		const stateDir = resolve(options.stateDir ?? resolveStateDir(homePath, env, log));
		const canonicalOverride = env(CANONICAL_STATE_ENV);
		const legacyOverride = env(LEGACY_STATE_ENV);
		const usingLegacyOverride = options.stateDir === undefined &&
			(canonicalOverride === undefined || !isAbsolute(canonicalOverride)) &&
			legacyOverride !== undefined && isAbsolute(legacyOverride);
		const migration = options.stateDir === undefined && !usingLegacyOverride
			? await migrateLegacyState(stateDir, homePath, env, options.now ?? Date.now, log)
			: { cleanupMarkers: [] };
		const state = new WorkbenchState(stateDir, homePath, options);
		await state.#load();
		for (const marker of migration.cleanupMarkers) {
			await Deno.remove(marker).catch((error: unknown) => {
				log(`The GUI could not retire its legacy state-migration marker (${errorName(error)}).`);
			});
		}
		return state;
	}

	recent(): readonly RecentProject[] {
		return [...this.#recent];
	}

	recentById(id: string): RecentProject | null {
		return this.#recent.find((project) => project.id === id) ?? null;
	}

	recentByPath(canonicalPath: string): RecentProject | null {
		return this.#recent.find((project) => project.canonicalPath === canonicalPath) ?? null;
	}

	/** Upserts one project at the head of the recent list and persists atomically. */
	async remember(
		project: Readonly<{ id: string; canonicalPath: string; displayName: string }>,
	): Promise<RecentProject> {
		if (!validId(project.id)) throw new WorkbenchStateError("invalid", "The project identifier is invalid.");
		if (!validPath(project.canonicalPath)) throw new WorkbenchStateError("invalid", "The project path is invalid.");
		if (!validDisplayName(project.displayName)) {
			throw new WorkbenchStateError("invalid", "The project name is invalid.");
		}
		const entry: RecentProject = {
			id: project.id,
			canonicalPath: project.canonicalPath,
			displayName: project.displayName,
			lastOpenedAt: new Date(this.#now()).toISOString(),
		};
		this.#recent = [
			entry,
			...this.#recent.filter((candidate) =>
				candidate.id !== entry.id && candidate.canonicalPath !== entry.canonicalPath
			),
		].slice(0, MAX_RECENT_PROJECTS);
		await this.#persist();
		return entry;
	}

	async forget(id: string): Promise<boolean> {
		const before = this.#recent.length;
		this.#recent = this.#recent.filter((project) => project.id !== id);
		if (this.#recent.length === before) return false;
		await this.#persist();
		return true;
	}

	/**
	 * Explains why a canonical path may not be opened, or returns null when it may.
	 * Pure on the path string: existence and directory checks live in `resolveOpenable`.
	 */
	guardReason(canonicalPath: string): string | null {
		const path = resolve(canonicalPath);
		if (path === "/" || path === sep) return "The filesystem root cannot be opened as a project.";
		if (path === this.homePath) return "Your home directory cannot be opened as a project; choose a folder inside it.";
		if (isStrictAncestor(path, this.homePath)) {
			return "A directory above your home directory cannot be opened as a project.";
		}
		for (const name of HOME_GUARDED) {
			const guarded = join(this.homePath, name);
			if (isWithin(guarded, path)) {
				return `Directories under ~/${name} hold configuration or credentials and cannot be opened as a project.`;
			}
		}
		if (isWithin(this.stateDir, path)) return "The GUI state directory cannot be opened as a project.";
		if (isStrictAncestor(path, this.stateDir)) {
			return "A directory that contains the GUI state cannot be opened as a project.";
		}
		for (const root of SYSTEM_ROOTS) {
			if (isWithin(root, path)) return `System directories under ${root} cannot be opened as a project.`;
		}
		if (/^\/lib[^/]*$/u.test(path) || /^\/lib[^/]*\//u.test(path)) {
			return "System library directories cannot be opened as a project.";
		}
		return null;
	}

	/**
	 * Canonicalizes a typed or picked path and applies every guard. Rejects
	 * symlinks at the typed path itself so the operator always sees the real
	 * directory that will become the trusted root.
	 */
	async resolveOpenable(typedPath: string): Promise<OpenableRoot> {
		if (!validPath(typedPath) || typedPath.trim() !== typedPath) {
			throw new WorkbenchStateError("invalid", "Enter an absolute directory path.");
		}
		const requested = resolve(typedPath);
		let info: Deno.FileInfo;
		try {
			info = await Deno.lstat(requested);
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) {
				throw new WorkbenchStateError("refused", "That directory does not exist.");
			}
			throw new WorkbenchStateError("refused", "That directory cannot be read.");
		}
		if (info.isSymlink) {
			throw new WorkbenchStateError("refused", "That path is a symbolic link; open the real directory it points to.");
		}
		if (!info.isDirectory) throw new WorkbenchStateError("refused", "That path is not a directory.");
		let canonicalPath: string;
		try {
			canonicalPath = await Deno.realPath(requested);
		} catch {
			throw new WorkbenchStateError("refused", "That directory cannot be resolved.");
		}
		const reason = this.guardReason(canonicalPath);
		if (reason !== null) throw new WorkbenchStateError("refused", reason);
		const displayName = basename(canonicalPath) || canonicalPath;
		return { canonicalPath, displayName: displayName.slice(0, 120) };
	}

	/** True when a remembered project can still be opened: it exists, is a directory, and passes the guards. */
	async available(canonicalPath: string): Promise<boolean> {
		try {
			await this.resolveOpenable(canonicalPath);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Lists the directories directly under `path` (default `$HOME`). Files are
	 * never listed. Symlinked directories are shown but flagged guarded and
	 * never followed. Hidden entries are flagged, not removed.
	 */
	async browse(typedPath?: string): Promise<ProjectBrowseListingPayload> {
		// Validate before resolving: `resolve` would otherwise silently anchor a
		// relative path to the host process's own working directory.
		if (typedPath !== undefined && !validPath(typedPath)) {
			throw new WorkbenchStateError("invalid", "Enter an absolute directory path.");
		}
		const requested = typedPath === undefined ? this.homePath : resolve(typedPath);
		let canonical: string;
		let info: Deno.FileInfo;
		try {
			canonical = await Deno.realPath(requested);
			info = await Deno.stat(canonical);
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) {
				throw new WorkbenchStateError("not-found", "That directory does not exist.");
			}
			throw new WorkbenchStateError("refused", "That directory cannot be read.");
		}
		if (!info.isDirectory) throw new WorkbenchStateError("not-found", "That path is not a directory.");
		const entries: WireBrowseEntry[] = [];
		let truncated = false;
		try {
			for await (const entry of Deno.readDir(canonical)) {
				if (!entry.isDirectory && !entry.isSymlink) continue;
				if (entry.name.length === 0 || entry.name.length > 255 || hasControlCharacter(entry.name)) continue;
				if (entry.isSymlink) {
					let target: Deno.FileInfo;
					try {
						target = await Deno.stat(join(canonical, entry.name));
					} catch {
						continue;
					}
					if (!target.isDirectory) continue;
				}
				entries.push({
					name: entry.name,
					hidden: entry.name.startsWith("."),
					guarded: entry.isSymlink || this.guardReason(join(canonical, entry.name)) !== null,
				});
			}
		} catch (error) {
			if (error instanceof Deno.errors.PermissionDenied || error instanceof Deno.errors.NotCapable) {
				return {
					path: canonical,
					parent: parentOf(canonical),
					entries: [],
					truncated: false,
					openable: false,
					reason: "That directory cannot be read.",
				};
			}
			throw new WorkbenchStateError("internal", "The directory listing failed.");
		}
		entries.sort((left, right) => compareEntryNames(left.name, right.name));
		if (entries.length > MAX_BROWSE_ENTRIES) {
			entries.length = MAX_BROWSE_ENTRIES;
			truncated = true;
		}
		const reason = this.guardReason(canonical);
		return {
			path: canonical,
			parent: parentOf(canonical),
			entries,
			truncated,
			openable: reason === null,
			reason,
		};
	}

	async #load(): Promise<void> {
		const file = join(this.stateDir, RECENT_FILE);
		let text: string;
		try {
			text = await Deno.readTextFile(file);
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) return;
			this.#log(`The GUI could not read its recent-project list; starting empty (${errorName(error)}).`);
			return;
		}
		const parsed = parseRecentFile(text);
		if (parsed === null) {
			this.#log("The GUI found a corrupt recent-project list and is starting with an empty one.");
			return;
		}
		this.#recent = parsed;
	}

	#persist(): Promise<void> {
		const snapshot = { version: RECENT_FILE_VERSION, projects: this.#recent };
		const write = this.#writes.then(async () => {
			await Deno.mkdir(this.stateDir, { recursive: true });
			const target = join(this.stateDir, RECENT_FILE);
			const temporary = `${target}.${crypto.randomUUID().slice(0, 8)}.tmp`;
			await Deno.writeTextFile(temporary, `${JSON.stringify(snapshot, null, "\t")}\n`);
			await Deno.rename(temporary, target);
		});
		this.#writes = write.catch(() => undefined);
		return write.catch((error: unknown) => {
			throw new WorkbenchStateError(
				"internal",
				`The GUI could not save its recent-project list (${errorName(error)}).`,
			);
		});
	}
}

function parentOf(path: string): string | null {
	const parent = dirname(path);
	return parent === path ? null : parent;
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown error";
}
