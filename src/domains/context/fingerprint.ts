import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { internalGitArgv } from "../../core/internal-git.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { enumerateWorkspaceFiles } from "../../core/workspace-files.js";
import { clioCacheDir } from "../../core/xdg.js";
import { readCodewiki } from "./codewiki/artifact.js";
import { isIndexablePath, streamFile } from "./codewiki/paths.js";
import type { Codewiki } from "./codewiki/schema.js";
import { EXCLUDED_DIRS } from "./excluded-dirs.js";

export interface Fingerprint {
	treeHash: string;
	gitHead: string | null;
	loc: number;
}

const LOC_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".cc",
	".cpp",
	".cxx",
	".hpp",
	".hh",
	".hxx",
	".c",
	".h",
	".cu",
	".cuh",
	".java",
	".kt",
]);

function extensionOf(name: string): string {
	const index = name.lastIndexOf(".");
	return index === -1 ? "" : name.slice(index);
}

function currentGitHead(cwd: string): string | null {
	try {
		return execFileSync("git", internalGitArgv(["rev-parse", "--verify", "HEAD"], cwd), {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function locFromCodewiki(codewiki: Codewiki | null): number | null {
	if (!codewiki) return null;
	return codewiki.files.reduce((sum, file) => (file.lang === "config" ? sum : sum + file.loc), 0);
}

function createTreeHash(): ReturnType<typeof createHash> {
	// Migrate both unsalted and v2 metadata identities, including empty trees.
	return createHash("sha256").update("clio-codewiki-tree:v3\n");
}

/** size, mtimeMs, ctimeMs, ino, sha256 digest, line count. */
type DigestEntry = [number, number, number, number, string, number];

/**
 * Stat-keyed digest cache, kept in Clio's cache dir (never the workspace) so
 * an unchanged tree fingerprints with one stat per file and no reads. Entries
 * are self-validating, so a stale or concurrently replaced cache only costs
 * re-reads; any problem with the file itself means no cache.
 */
interface DigestCache {
	path: string;
	entries: Map<string, DigestEntry>;
}

/** Files modified this recently are not cached: a same-granularity rewrite could keep their stat. */
const RACY_WINDOW_MS = 2_000;

function digestCachePath(cwd: string): string {
	const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 32);
	return join(clioCacheDir(), "codewiki-digests", `${key}.json`);
}

function loadDigestCache(cwd: string): DigestCache | null {
	let path: string;
	try {
		path = digestCachePath(cwd);
	} catch {
		return null;
	}
	const entries = new Map<string, DigestEntry>();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { v?: unknown; entries?: unknown };
		if (parsed.v === 1 && parsed.entries && typeof parsed.entries === "object") {
			for (const [relPath, entry] of Object.entries(parsed.entries as Record<string, unknown>)) {
				if (Array.isArray(entry) && entry.length === 6) entries.set(relPath, entry as DigestEntry);
			}
		}
	} catch {
		// Missing or unreadable cache: start empty.
	}
	return { path, entries };
}

function saveDigestCache(cache: DigestCache, entries: Map<string, DigestEntry>): void {
	try {
		safeResourceWrite(cache.path, JSON.stringify({ v: 1, entries: Object.fromEntries(entries) }), {
			encoding: "utf8",
		});
	} catch {
		// Best effort; the next computation re-reads.
	}
}

/**
 * Hash one file's identity into the tree hash and accumulate its line count,
 * reading the file only when its stat no longer matches the cached entry.
 */
function accumulateFile(
	cwd: string,
	relPath: string,
	hash: ReturnType<typeof createHash>,
	artifactLoc: number | null,
	cached: DigestEntry | undefined,
	next: Map<string, DigestEntry>,
	now: number,
): { loc: number; read: boolean } {
	// Read failures must invalidate the operation, never certify a partial tree.
	const path = join(cwd, relPath);
	const stats = statSync(path);
	let entry = cached;
	const read =
		!entry ||
		entry[0] !== stats.size ||
		entry[1] !== stats.mtimeMs ||
		entry[2] !== stats.ctimeMs ||
		entry[3] !== stats.ino;
	if (read || !entry) {
		// Streamed in chunks: no file, however large, is held whole.
		const streamed = streamFile(path);
		entry = [
			stats.size,
			stats.mtimeMs,
			stats.ctimeMs,
			stats.ino,
			streamed.digest,
			stats.size === 0 ? 0 : streamed.newlines + 1,
		];
	}
	if (now - Math.max(stats.mtimeMs, stats.ctimeMs) > RACY_WINDOW_MS) next.set(relPath, entry);
	hash.update(`${JSON.stringify(relPath)}:${entry[4]}\n`);
	const loc = artifactLoc === null && LOC_EXTENSIONS.has(extensionOf(relPath)) ? entry[5] : 0;
	return { loc, read };
}

export interface ComputeFingerprintOptions {
	/**
	 * Line total recorded by an artifact the caller chose not to parse. The
	 * tree hash never depends on it; it only keeps `loc` byte-identical to the
	 * fingerprint the artifact's own build stamped.
	 */
	artifactLoc?: number;
}

export function computeFingerprint(
	cwd: string,
	codewiki: Codewiki | null = readCodewiki(cwd),
	options: ComputeFingerprintOptions = {},
): Fingerprint {
	const files = enumerateWorkspaceFiles(cwd, EXCLUDED_DIRS).filter(isIndexablePath);

	const hash = createTreeHash();
	const artifactLoc = options.artifactLoc ?? locFromCodewiki(codewiki);
	let loc = 0;
	const cache = loadDigestCache(cwd);
	const next = new Map<string, DigestEntry>();
	const now = Date.now();
	let reads = 0;
	for (const relPath of files) {
		const result = accumulateFile(cwd, relPath, hash, artifactLoc, cache?.entries.get(relPath), next, now);
		loc += result.loc;
		if (result.read) reads += 1;
	}
	if (cache && (reads > 0 || next.size !== cache.entries.size)) saveDigestCache(cache, next);

	return {
		treeHash: hash.digest("hex"),
		gitHead: currentGitHead(cwd),
		loc: artifactLoc ?? loc,
	};
}

export function isStale(prev: Fingerprint, curr: Fingerprint): boolean {
	return prev.treeHash !== curr.treeHash;
}
