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
import { mainSandboxGitLayout } from "./main-session.js";

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
 */

/** One file git would run from a hooks directory. */
export interface GitHookFile {
	/** Absolute path as listed in its hooks directory. */
	path: string;
	kind: "file" | "symlink";
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
	/** Hook files by absolute path. */
	files: ReadonlyMap<string, GitHookFile>;
	/** True when the nested-repository walk stopped at its bound, so a deeper repository is not covered. */
	capped: boolean;
}

export type GitHookChangeKind = "added" | "changed" | "removed";

export interface GitHookChange {
	path: string;
	kind: GitHookChangeKind;
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

/** Every hooks directory of the repository holding `root` and of each nested top. */
function hooksDirectoriesOf(root: string, tops: ReadonlyArray<string>): string[] {
	const directories = new Set<string>();
	for (const top of [root, ...tops]) {
		let dirs: ReadonlyArray<string>;
		try {
			dirs = mainSandboxGitLayout(top)?.hooksDirs ?? [];
		} catch {
			// An unreadable layout still leaves the default hooks directory a hook would most likely land in.
			dirs = [path.join(top, ".git", "hooks")];
		}
		for (const dir of dirs) directories.add(dir);
	}
	return [...directories];
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
	return { directories: hooksDirectoriesOf(base, tops), capped };
}

export interface GitHooksFingerprinter {
	/** The hooks git could run now. Reuses listings and hashes whose stat identity held. */
	fingerprint(): GitHooksFingerprint;
}

/**
 * Impure: a fingerprinter for the workspace at `workspace`, with its own
 * caches. One per session keeps a repeat check to a stat walk.
 */
export function createGitHooksFingerprinter(workspace: string): GitHooksFingerprinter {
	const root = path.resolve(workspace);
	const walk = createRepositoryWalker(root);
	let listings = new Map<string, ListedHooks>();
	let hashed = new Map<string, HashedFile>();

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
			const directories = hooksDirectoriesOf(root, tops);
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
			listings = nextListings;
			hashed = nextHashed;
			return { directories, files, capped };
		},
	};
}

/** Pure: added and changed files of `after` against `before`, then removed ones, sorted by path. */
export function diffGitHookFiles(
	before: ReadonlyMap<string, GitHookFile>,
	after: ReadonlyMap<string, GitHookFile>,
): GitHookChange[] {
	const changes: GitHookChange[] = [];
	const change = (file: GitHookFile, kind: GitHookChangeKind): GitHookChange => ({
		path: file.path,
		kind,
		size: file.size,
		firstLine: file.firstLine,
		executable: file.executable,
		hash: kind === "removed" ? "" : file.hash,
	});
	for (const file of after.values()) {
		const prior = before.get(file.path);
		if (prior === undefined) changes.push(change(file, "added"));
		else if (prior.hash !== file.hash || prior.executable !== file.executable || prior.kind !== file.kind) {
			changes.push(change(file, "changed"));
		}
	}
	for (const file of before.values()) if (!after.has(file.path)) changes.push(change(file, "removed"));
	return changes.sort((a, b) => a.path.localeCompare(b.path));
}
