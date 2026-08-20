/**
 * Workbench UI state: the recent-project list, the refuse-to-open guards, and
 * the host-side directory browser.
 *
 * This is Workbench state, not Clio configuration. The only file it owns is
 * `projects.json` under the Workbench state directory. Deno's read/write grants
 * are broad at launch, so the boundary that keeps the operator away from `/`,
 * `$HOME`, dot-config directories, and system trees is enforced here, in
 * Workbench code, against canonical paths. The product says so.
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectBrowseListingPayload, WireBrowseEntry } from "./src/protocol.ts";

export const MAX_RECENT_PROJECTS = 32;
export const MAX_BROWSE_ENTRIES = 512;
const RECENT_FILE = "projects.json";
const RECENT_FILE_VERSION = 1;
const MAX_PATH_BYTES = 4 * 1024;
const encoder = new TextEncoder();

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

function envValue(name: string): string | undefined {
	try {
		const value = Deno.env.get(name);
		return value === undefined || value.length === 0 ? undefined : value;
	} catch {
		return undefined;
	}
}

/** `$CLIO_WORKBENCH_STATE_DIR`, else `$XDG_STATE_HOME/clio-workbench`, else `~/.local/state/clio-workbench`. */
export function resolveStateDir(homePath: string): string {
	const explicit = envValue("CLIO_WORKBENCH_STATE_DIR");
	if (explicit !== undefined && isAbsolute(explicit)) return resolve(explicit);
	const xdg = envValue("XDG_STATE_HOME");
	if (xdg !== undefined && isAbsolute(xdg)) return join(resolve(xdg), "clio-workbench");
	return join(homePath, ".local", "state", "clio-workbench");
}

export function resolveHomePath(): string {
	const home = envValue("HOME");
	if (home === undefined || !isAbsolute(home)) {
		throw new WorkbenchStateError("internal", "Workbench needs an absolute HOME to place its state.");
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
		if (!isRecord(entry)) return null;
		const { id, canonicalPath, displayName, lastOpenedAt } = entry;
		if (!validId(id) || !validPath(canonicalPath) || !validDisplayName(displayName) || !validTimestamp(lastOpenedAt)) {
			return null;
		}
		if (ids.has(id) || paths.has(canonicalPath)) return null;
		ids.add(id);
		paths.add(canonicalPath);
		projects.push({ id, canonicalPath, displayName, lastOpenedAt });
	}
	return projects;
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
		if (!isAbsolute(homePath)) throw new WorkbenchStateError("internal", "The Workbench home path must be absolute.");
		const stateDir = resolve(options.stateDir ?? resolveStateDir(homePath));
		const state = new WorkbenchState(stateDir, homePath, options);
		await state.#load();
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
		if (isWithin(this.stateDir, path)) return "The Workbench state directory cannot be opened as a project.";
		if (isStrictAncestor(path, this.stateDir)) {
			return "A directory that contains the Workbench state cannot be opened as a project.";
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
			this.#log(`Workbench could not read its recent-project list; starting empty (${errorName(error)}).`);
			return;
		}
		const parsed = parseRecentFile(text);
		if (parsed === null) {
			this.#log("Workbench found a corrupt recent-project list and is starting with an empty one.");
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
				`Workbench could not save its recent-project list (${errorName(error)}).`,
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
