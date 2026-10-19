import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	type Dirent,
	lstatSync,
	openSync,
	readdirSync,
	readlinkSync,
	readSync,
	type Stats,
	statSync,
} from "node:fs";
import path from "node:path";
import { gitConfigScopeFiles, mainSandboxGitLayout } from "./main-session.js";

/**
 * What git would run outside Clio's sandbox. A hook runs with the full
 * privileges of whoever runs git next, so instead of closing each route a
 * hook can be planted through (a separate git dir, a nested repository, a
 * hooks path created by a contained command, a config edit made outside
 * Clio), the hook drift guard (src/domains/safety/hook-drift.ts) compares
 * what these directories hold before a git command runs outside the sandbox.
 *
 * The scope is the repository holding the workspace and every repository
 * nested in it that a bounded walk finds, each resolved by the main-session
 * sandbox's git layout: linked worktrees, submodules, a `.git` file naming a
 * separate git dir, and every core.hooksPath value. Once the caches are warm
 * a fingerprint costs a stat per workspace directory and per hook file: a
 * directory is read again only when its mtime moved, and a hook file is
 * hashed again only when its stat identity changed.
 *
 * Git configuration can name programs too (core.fsmonitor, core.sshCommand,
 * diff.external, filter drivers, credential helpers, `!` aliases and the
 * rest of {@link gitConfigValueRuns}), so each repository's executable config
 * values join the fingerprint as entries of kind `config`, one per config
 * file and key, global and system scopes included. One `git config --list
 * --show-origin -z` per repository reads them, and it runs again only after
 * one of the files it read, or a scope file it could read next, moved.
 */

/**
 * One file git would run from a hooks directory, or one executable git config
 * value (`kind: "config"`).
 */
export interface GitHookFile {
	/** Absolute path as listed in its hooks directory; for config, the file that sets it, or git's origin label. */
	path: string;
	kind: "file" | "symlink" | "config";
	/** The config key as git lists it (`core.fsmonitor`, `filter.lfs.clean`); absent for a hook file. */
	key?: string;
	/** Any execute bit on what git would open, the link's target for a link. */
	executable: boolean;
	/** Bytes git would read; -1 for a dangling link or an unreadable file. */
	size: number;
	/** SHA-256 over the link text, for a link, and the first {@link HASH_MAX_BYTES} of content. */
	hash: string;
	/** The first line, control characters removed, at most {@link FIRST_LINE_CHARS}. */
	firstLine: string;
}

export interface GitHooksFingerprint {
	/** Hooks directories scanned, present or not. */
	directories: ReadonlyArray<string>;
	/** Hook files and executable config values, by {@link gitHookEntryId}. */
	files: ReadonlyMap<string, GitHookFile>;
	/** True when the nested-repository walk stopped at its bound, so a deeper repository is not covered. */
	capped: boolean;
}

export type GitHookChangeKind = "added" | "changed" | "removed";

export interface GitHookChange {
	path: string;
	kind: GitHookChangeKind;
	/** The config key, for an executable config value. */
	key?: string;
	/** The file now, or as last seen for a removed one. */
	size: number;
	firstLine: string;
	executable: boolean;
	/** Empty for a removed file. */
	hash: string;
}

/** Directory levels below the workspace the nested-repository walk descends. */
const DISCOVERY_MAX_DEPTH = 12;
/** Directories one walk visits before it stops and reports itself capped. */
const DISCOVERY_MAX_DIRECTORIES = 4_000;
/** Never walked: git's own metadata, and dependency trees nobody runs git inside. */
const DISCOVERY_SKIPPED: ReadonlySet<string> = new Set([".git", "node_modules"]);
const HASH_MAX_BYTES = 4 * 1024 * 1024;
const FIRST_LINE_BYTES = 512;
const FIRST_LINE_CHARS = 120;
const CONFIG_LIST_TIMEOUT_MS = 5_000;
const CONFIG_LIST_MAX_BYTES = 4 * 1024 * 1024;

/** A hook file's path, or a config value's file and key: what a fingerprint, a baseline and a change are keyed by. */
export function gitHookEntryId(entry: { path: string; key?: string }): string {
	return entry.key === undefined ? entry.path : `${entry.path}\0${entry.key}`;
}

/** core.* keys whose value is a program, a shell command, or (core.hooksPath) where hooks run from. */
const CORE_PROGRAM_KEYS: ReadonlySet<string> = new Set([
	"alternaterefscommand",
	"askpass",
	"editor",
	"fsmonitor",
	"gitproxy",
	"hookspath",
	"pager",
	"sshcommand",
]);
const BOOLEAN_WORDS: ReadonlySet<string> = new Set(["true", "false", "yes", "no", "on", "off", "1", "0"]);

/**
 * Pure: whether git runs `value` of `key` as a program. `key` is as `git
 * config --list` prints it: section and name lowercased, a subsection as
 * written. An empty value, which resets a list or turns a feature off, runs
 * nothing; a boolean core.fsmonitor selects git's own daemon or none.
 */
function gitConfigValueRuns(key: string, value: string): boolean {
	const first = key.indexOf(".");
	const last = key.lastIndexOf(".");
	if (first <= 0 || last === key.length - 1) return false;
	const section = key.slice(0, first);
	const name = key.slice(last + 1);
	const sub = first === last ? null : key.slice(first + 1, last);
	const trimmed = value.trim();
	if (trimmed === "") return false;
	switch (section) {
		case "core":
			return (
				sub === null && CORE_PROGRAM_KEYS.has(name) && !(name === "fsmonitor" && BOOLEAN_WORDS.has(trimmed.toLowerCase()))
			);
		case "sequence":
			return sub === null && name === "editor";
		case "diff":
			return sub === null ? name === "external" : name === "textconv" || name === "command";
		case "filter":
			return sub !== null && (name === "clean" || name === "smudge" || name === "process");
		case "merge":
			return sub !== null && name === "driver";
		case "credential":
			return name === "helper";
		case "gpg":
			return name === "program" || (sub === "ssh" && name === "defaultkeycommand");
		case "alias":
			return trimmed.startsWith("!");
		case "uploadpack":
			return sub === null && name === "packobjectshook";
		case "remote":
			return sub !== null && (name === "uploadpack" || name === "receivepack" || name === "vcs");
		case "pager":
			return sub === null && !BOOLEAN_WORDS.has(trimmed.toLowerCase());
		case "trailer":
			return sub !== null && (name === "command" || name === "cmd");
		case "submodule":
			return sub !== null && name === "update" && trimmed.startsWith("!");
		case "difftool":
		case "mergetool":
			return sub !== null && name === "cmd";
		case "interactive":
			return sub === null && name === "difffilter";
		default:
			return false;
	}
}

interface ListedDirectory {
	key: string;
	subdirs: ReadonlyArray<string>;
	repository: boolean;
}

interface ListedHooks {
	key: string;
	names: ReadonlyArray<string>;
}

interface HashedFile {
	identity: string;
	file: GitHookFile;
}

function statKey(stat: Stats): string {
	return `${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
}

function fileIdentity(stat: Stats): string {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
}

/** C0 and C1 controls never reach an approval card. */
function printable(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code >= 0x20 && code !== 0x7f && (code < 0x80 || code >= 0xa0);
}

/** The first line of a script, or a marker for a binary. */
function firstLineOf(head: Buffer): string {
	if (head.includes(0)) return "(binary)";
	const first = head.toString("utf8").split(/\r?\n/u)[0] ?? "";
	const line = [...first].filter(printable).join("").trim();
	return line.length > FIRST_LINE_CHARS ? `${line.slice(0, FIRST_LINE_CHARS)}…` : line;
}

/** Hashes what git would open at `file`, following a link, and returns its first line. */
function readContent(file: string, hash: ReturnType<typeof createHash>): { ok: boolean; firstLine: string } {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return { ok: false, firstLine: "" };
	}
	try {
		const chunk = Buffer.alloc(64 * 1024);
		let total = 0;
		let head: Buffer | null = null;
		while (total < HASH_MAX_BYTES) {
			const read = readSync(fd, chunk, 0, Math.min(chunk.length, HASH_MAX_BYTES - total), null);
			if (read <= 0) break;
			head ??= Buffer.from(chunk.subarray(0, Math.min(read, FIRST_LINE_BYTES)));
			hash.update(chunk.subarray(0, read));
			total += read;
		}
		return { ok: true, firstLine: head === null ? "" : firstLineOf(head) };
	} catch {
		return { ok: false, firstLine: "" };
	} finally {
		closeSync(fd);
	}
}

/**
 * Impure: repository tops under `root`, breadth first so the bound spends
 * itself on shallow levels. A directory is read again only when its stat key
 * moved since the walk that cached it.
 */
function createRepositoryWalker(root: string): () => { tops: string[]; capped: boolean } {
	let walked = new Map<string, ListedDirectory>();
	return () => {
		const next = new Map<string, ListedDirectory>();
		const tops: string[] = [];
		let capped = false;
		const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
		for (let at = 0; at < queue.length; at += 1) {
			if (next.size >= DISCOVERY_MAX_DIRECTORIES) {
				capped = true;
				break;
			}
			const { dir, depth } = queue[at] as { dir: string; depth: number };
			let stat: Stats;
			try {
				stat = statSync(dir);
			} catch {
				continue;
			}
			const key = statKey(stat);
			let listed = walked.get(dir);
			if (listed === undefined || listed.key !== key) {
				let entries: Dirent[];
				try {
					entries = readdirSync(dir, { withFileTypes: true });
				} catch {
					continue;
				}
				listed = {
					key,
					repository: entries.some((entry) => entry.name === ".git"),
					// A link to a directory is not followed: it could lead the walk anywhere.
					subdirs: entries
						.filter((entry) => entry.isDirectory() && !DISCOVERY_SKIPPED.has(entry.name))
						.map((entry) => path.join(dir, entry.name)),
				};
			}
			next.set(dir, listed);
			if (listed.repository) tops.push(dir);
			if (depth >= DISCOVERY_MAX_DEPTH) {
				if (listed.subdirs.length > 0) capped = true;
				continue;
			}
			for (const sub of listed.subdirs) queue.push({ dir: sub, depth: depth + 1 });
		}
		walked = next;
		return { tops, capped };
	};
}

/** Where one repository keeps what git runs: its hooks directories, and the files its configuration comes from. */
interface RepositoryScope {
	/**
	 * The work tree top holding the workspace root or a nested repository top,
	 * where its config is listed: git prints a relative origin from there.
	 */
	dir: string;
	hooksDirs: ReadonlyArray<string>;
	configFiles: ReadonlyArray<string>;
}

/** The nearest directory at or above `dir` holding a `.git`, or `dir` itself outside a repository. */
function workTreeTop(dir: string): string {
	for (let at = dir; ; at = path.dirname(at)) {
		try {
			lstatSync(path.join(at, ".git"));
			return at;
		} catch {
			if (path.dirname(at) === at) return dir;
		}
	}
}

/** The scope of the repository holding `root` and of each nested top. */
function repositoryScopes(root: string, tops: ReadonlyArray<string>): RepositoryScope[] {
	return [...new Set([workTreeTop(root), ...tops])].map((dir) => {
		try {
			const layout = mainSandboxGitLayout(dir);
			return {
				dir,
				hooksDirs: layout?.hooksDirs ?? [],
				configFiles: layout?.configFiles ?? gitConfigScopeFiles(null, null),
			};
		} catch {
			// An unreadable layout still leaves the default hooks directory a hook would most likely land in.
			return {
				dir,
				hooksDirs: [path.join(dir, ".git", "hooks")],
				configFiles: [...gitConfigScopeFiles(null, null), path.join(dir, ".git", "config")],
			};
		}
	});
}

/** Every hooks directory of the repository holding `root` and of each nested top. */
function hooksDirectoriesOf(scopes: ReadonlyArray<RepositoryScope>): string[] {
	return [...new Set(scopes.flatMap((scope) => scope.hooksDirs))];
}

/** One repository's executable config as last listed. */
interface ConfigListing {
	/** {@link statStamp} of the watched files when the listing ran; a listing that failed has none. */
	stamp: string | null;
	/** Config files the listing named as origins: includes, besides the scope files. */
	origins: ReadonlyArray<string>;
	entries: ReadonlyMap<string, GitHookFile>;
}

function statStamp(files: ReadonlyArray<string>): string {
	return files
		.map((file) => {
			try {
				return `${file}\0${fileIdentity(statSync(file))}`;
			} catch {
				return `${file}\0-`;
			}
		})
		.join("\n");
}

/** Variables that would point a listing at another repository than the one in its directory. */
const REPOSITORY_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"];

/**
 * Impure: the executable config values git reads in `dir`, every scope
 * included, as fingerprint entries, and the files they came from. Null when
 * git cannot list them. Listing config runs no hook and no configured
 * program.
 */
function listExecutableConfig(dir: string): { entries: Map<string, GitHookFile>; origins: string[] } | null {
	const env = { ...process.env };
	for (const name of REPOSITORY_ENV) Reflect.deleteProperty(env, name);
	let output: string;
	try {
		output = execFileSync("git", ["config", "--list", "--show-origin", "-z"], {
			cwd: dir,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: CONFIG_LIST_TIMEOUT_MS,
			maxBuffer: CONFIG_LIST_MAX_BYTES,
		});
	} catch {
		return null;
	}
	// `-z` prints `<origin>\0<key>\n<value>\0` per value, and only `<key>` for a key with no `=`.
	const fields = output.split("\0");
	const groups = new Map<string, { path: string; key: string; values: string[] }>();
	const origins = new Set<string>();
	for (let at = 0; at + 1 < fields.length; at += 2) {
		const origin = fields[at] as string;
		const pair = fields[at + 1] as string;
		const newline = pair.indexOf("\n");
		const key = newline < 0 ? pair : pair.slice(0, newline);
		const value = newline < 0 ? "" : pair.slice(newline + 1);
		// Git prints a file below the work tree top relative to it, having moved there to read config.
		const file = origin.startsWith("file:") ? path.resolve(dir, origin.slice("file:".length)) : null;
		if (file !== null) origins.add(file);
		const where = file ?? origin.replace(/:$/u, "");
		const id = gitHookEntryId({ path: where, key });
		const group = groups.get(id) ?? { path: where, key, values: [] };
		group.values.push(value);
		groups.set(id, group);
	}
	const entries = new Map<string, GitHookFile>();
	for (const [id, group] of groups) {
		if (!group.values.some((value) => gitConfigValueRuns(group.key, value))) continue;
		const joined = group.values.join("\0");
		entries.set(id, {
			path: group.path,
			kind: "config",
			key: group.key,
			executable: true,
			size: Buffer.byteLength(joined),
			hash: createHash("sha256").update(joined).digest("hex"),
			firstLine: firstLineOf(Buffer.from(group.values.at(-1) ?? "")),
		});
	}
	return { entries, origins: [...origins] };
}

/**
 * Impure: `scope`'s executable config, listed again only when a watched file
 * moved since `cached`: a scope file, or an origin the last listing named.
 */
function executableConfigOf(scope: RepositoryScope, cached: ConfigListing | undefined): ConfigListing {
	const watched = (origins: ReadonlyArray<string>): string[] => [...new Set([...scope.configFiles, ...origins])];
	const stamp = statStamp(watched(cached?.origins ?? []));
	if (cached !== undefined && cached.stamp === stamp) return cached;
	const listed = listExecutableConfig(scope.dir);
	// A failed listing keeps what was last seen and lists again next time.
	if (listed === null) return { stamp: null, origins: cached?.origins ?? [], entries: cached?.entries ?? new Map() };
	const sameOrigins =
		cached !== undefined &&
		listed.origins.length === cached.origins.length &&
		listed.origins.every((origin) => cached.origins.includes(origin));
	// A file the listing names for the first time is stamped after it was read.
	return {
		stamp: sameOrigins ? stamp : statStamp(watched(listed.origins)),
		origins: listed.origins,
		entries: listed.entries,
	};
}

/** Walkers kept for {@link gitHookDirectories}, so a dispatch's repeat calls re-stat instead of re-reading. */
const DIRECTORY_WALKERS_KEPT = 16;
const directoryWalkers = new Map<string, () => { tops: string[]; capped: boolean }>();

/**
 * Impure: every hooks directory of the repository holding `root` and of the
 * repositories nested under it, present or not. The worker sandbox keeps the
 * ones inside its writable roots read-only.
 */
export function gitHookDirectories(root: string): { directories: string[]; capped: boolean } {
	const base = path.resolve(root);
	let walk = directoryWalkers.get(base);
	if (walk === undefined) {
		walk = createRepositoryWalker(base);
		if (directoryWalkers.size >= DIRECTORY_WALKERS_KEPT) {
			const oldest = directoryWalkers.keys().next().value;
			if (oldest !== undefined) directoryWalkers.delete(oldest);
		}
		directoryWalkers.set(base, walk);
	}
	const { tops, capped } = walk();
	return { directories: hooksDirectoriesOf(repositoryScopes(base, tops)), capped };
}

export interface GitHooksFingerprinter {
	/** The hooks git could run now. Reuses listings and hashes whose stat identity held. */
	fingerprint(): GitHooksFingerprint;
	/**
	 * The executable config values git reads in the repository holding `dir`,
	 * by {@link gitHookEntryId}, without walking for hooks. Cheap enough for a
	 * status probe: a stat per config file, and a `git config` listing only
	 * after one of them moved.
	 */
	config(dir: string): ReadonlyMap<string, GitHookFile>;
}

/** Repository scopes {@link GitHooksFingerprinter.config} keeps beyond those the last walk found. */
const CONFIG_SCOPES_KEPT = 64;

/**
 * Impure: a fingerprinter for the workspace at `workspace`, with its own
 * caches. One per session keeps a repeat check to a stat walk.
 */
export function createGitHooksFingerprinter(workspace: string): GitHooksFingerprinter {
	const root = path.resolve(workspace);
	const walk = createRepositoryWalker(root);
	let listings = new Map<string, ListedHooks>();
	let hashed = new Map<string, HashedFile>();
	let configs = new Map<string, ConfigListing>();
	let scopesByTop = new Map<string, RepositoryScope>();

	const hookFile = (file: string, nextHashed: Map<string, HashedFile>): GitHookFile | null => {
		let link: Stats;
		try {
			link = lstatSync(file);
		} catch {
			return null;
		}
		if (!link.isFile() && !link.isSymbolicLink()) return null;
		let target: Stats | null = link;
		let linkText = "";
		if (link.isSymbolicLink()) {
			try {
				linkText = readlinkSync(file);
			} catch {
				// The link still fingerprints by what it reaches.
				linkText = "";
			}
			try {
				target = statSync(file);
			} catch {
				target = null;
			}
			if (target !== null && !target.isFile()) target = null;
		}
		const identity = `${fileIdentity(link)}|${linkText}|${target === null ? "-" : fileIdentity(target)}`;
		const cached = hashed.get(file);
		if (cached !== undefined && cached.identity === identity) {
			nextHashed.set(file, cached);
			return cached.file;
		}
		const hash = createHash("sha256");
		if (link.isSymbolicLink()) hash.update(`link:${linkText}\0`);
		const content = target === null ? { ok: false, firstLine: "" } : readContent(file, hash);
		const entry: GitHookFile = {
			path: file,
			kind: link.isSymbolicLink() ? "symlink" : "file",
			executable: target !== null && (target.mode & 0o111) !== 0,
			size: target !== null && content.ok ? target.size : -1,
			hash: hash.digest("hex"),
			firstLine: content.firstLine,
		};
		nextHashed.set(file, { identity, file: entry });
		return entry;
	};

	return {
		fingerprint() {
			const { tops, capped } = walk();
			const scopes = repositoryScopes(root, tops);
			const directories = hooksDirectoriesOf(scopes);
			const nextListings = new Map<string, ListedHooks>();
			const nextHashed = new Map<string, HashedFile>();
			const files = new Map<string, GitHookFile>();
			for (const dir of directories) {
				let stat: Stats;
				try {
					stat = statSync(dir);
				} catch {
					continue;
				}
				if (!stat.isDirectory()) continue;
				const key = statKey(stat);
				let listed = listings.get(dir);
				if (listed === undefined || listed.key !== key) {
					let names: string[];
					try {
						names = readdirSync(dir).filter((name) => !name.endsWith(".sample"));
					} catch {
						continue;
					}
					listed = { key, names };
				}
				nextListings.set(dir, listed);
				for (const name of listed.names) {
					const file = path.join(dir, name);
					const entry = hookFile(file, nextHashed);
					if (entry !== null) files.set(file, entry);
				}
			}
			const nextConfigs = new Map<string, ConfigListing>();
			for (const scope of scopes) {
				const listing = executableConfigOf(scope, configs.get(scope.dir));
				nextConfigs.set(scope.dir, listing);
				// The global and system entries every repository lists share one id.
				for (const [id, entry] of listing.entries) files.set(id, entry);
			}
			listings = nextListings;
			hashed = nextHashed;
			configs = nextConfigs;
			scopesByTop = new Map(scopes.map((scope) => [scope.dir, scope]));
			return { directories, files, capped };
		},
		config(dir) {
			const top = workTreeTop(path.resolve(dir));
			let scope = scopesByTop.get(top);
			if (scope === undefined) {
				scope = repositoryScopes(top, [])[0] as RepositoryScope;
				if (scopesByTop.size >= CONFIG_SCOPES_KEPT) {
					const oldest = scopesByTop.keys().next().value;
					if (oldest !== undefined) scopesByTop.delete(oldest);
				}
				scopesByTop.set(top, scope);
			}
			const listing = executableConfigOf(scope, configs.get(top));
			configs.set(top, listing);
			return listing.entries;
		},
	};
}

/**
 * Pure: added and changed entries of `after` against `before`, then removed
 * ones, sorted by path and key. Both maps are keyed by {@link gitHookEntryId}.
 */
export function diffGitHookFiles(
	before: ReadonlyMap<string, GitHookFile>,
	after: ReadonlyMap<string, GitHookFile>,
): GitHookChange[] {
	const changes: GitHookChange[] = [];
	const change = (file: GitHookFile, kind: GitHookChangeKind): GitHookChange => ({
		path: file.path,
		kind,
		...(file.key !== undefined ? { key: file.key } : {}),
		size: file.size,
		firstLine: file.firstLine,
		executable: file.executable,
		hash: kind === "removed" ? "" : file.hash,
	});
	for (const [id, file] of after) {
		const prior = before.get(id);
		if (prior === undefined) changes.push(change(file, "added"));
		else if (prior.hash !== file.hash || prior.executable !== file.executable || prior.kind !== file.kind) {
			changes.push(change(file, "changed"));
		}
	}
	for (const [id, file] of before) if (!after.has(id)) changes.push(change(file, "removed"));
	return changes.sort((a, b) => a.path.localeCompare(b.path) || (a.key ?? "").localeCompare(b.key ?? ""));
}
