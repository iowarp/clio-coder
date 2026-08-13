import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { enumerateWorkspaceFiles } from "../../core/workspace-files.js";
import { type CooperativeSlicer, createSlicer } from "./codewiki/cooperative.js";
import { type Codewiki, isIndexablePath, readCodewiki, readCodewikiAsync } from "./codewiki/indexer.js";
import { EXCLUDED_DIRS } from "./excluded-dirs.js";

const execFileAsync = promisify(execFile);

export interface Fingerprint {
	treeHash: string;
	gitHead: string | null;
	loc: number;
}

export interface FingerprintCacheOptions {
	ttlMs?: number;
}

const DEFAULT_FINGERPRINT_CACHE_TTL_MS = 5_000;

interface CachedFingerprint {
	fingerprint: Fingerprint;
	expiresAtMs: number;
}

const cachedFingerprints = new Map<string, CachedFingerprint>();

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
		return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

async function currentGitHeadAsync(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd, encoding: "utf8" });
		return stdout.trim();
	} catch {
		return null;
	}
}

function countLines(filePath: string): number {
	try {
		const text = readFileSync(filePath, "utf8");
		if (text.length === 0) return 0;
		let lines = 1;
		for (const ch of text) {
			if (ch === "\n") lines += 1;
		}
		return lines;
	} catch {
		return 0;
	}
}

function locFromCodewiki(codewiki: Codewiki | null): number | null {
	if (!codewiki) return null;
	return codewiki.files.reduce((sum, file) => (file.lang === "config" ? sum : sum + file.loc), 0);
}

/**
 * Hash one file's identity into the tree hash and accumulate its line count.
 * Shared verbatim by the sync and sliced walks so the two produce identical
 * fingerprints for the same tree.
 */
function accumulateFile(
	cwd: string,
	relPath: string,
	hash: ReturnType<typeof createHash>,
	artifactLoc: number | null,
): number {
	const absPath = join(cwd, relPath);
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(absPath);
	} catch {
		return 0;
	}
	hash.update(`${relPath}:${stat.size}:${Math.floor(stat.mtimeMs)}\n`);
	if (artifactLoc === null && LOC_EXTENSIONS.has(extensionOf(relPath))) return countLines(absPath);
	return 0;
}

export function computeFingerprint(cwd: string, codewiki: Codewiki | null = readCodewiki(cwd)): Fingerprint {
	const files = enumerateWorkspaceFiles(cwd, EXCLUDED_DIRS).filter(isIndexablePath);

	const hash = createHash("sha256");
	const artifactLoc = locFromCodewiki(codewiki);
	let loc = 0;
	for (const relPath of files) loc += accumulateFile(cwd, relPath, hash, artifactLoc);

	return {
		treeHash: hash.digest("hex"),
		gitHead: currentGitHead(cwd),
		loc: artifactLoc ?? loc,
	};
}

export interface ComputeFingerprintAsyncOptions {
	slicer?: CooperativeSlicer;
}

/**
 * Same fingerprint, sliced. One `statSync` per visible file plus a `git
 * rev-parse` is tens of milliseconds on a large repository, which is a dropped
 * frame if it lands in one turn. Callers on a status-surface poll or on the
 * session-start path should use this; one-shot CLI paths need not bother.
 *
 * `enumerateWorkspaceFiles` still runs as a single synchronous turn. It lives in
 * src/core and has no sliced form, so it is the remaining floor here.
 */
export async function computeFingerprintAsync(
	cwd: string,
	codewiki: Codewiki | null | undefined = undefined,
	options: ComputeFingerprintAsyncOptions = {},
): Promise<Fingerprint> {
	const slicer = options.slicer ?? createSlicer();
	const artifact = codewiki === undefined ? await readCodewikiAsync(cwd) : codewiki;
	await slicer.tick();
	const files = enumerateWorkspaceFiles(cwd, EXCLUDED_DIRS).filter(isIndexablePath);

	const hash = createHash("sha256");
	const artifactLoc = locFromCodewiki(artifact);
	let loc = 0;
	for (const relPath of files) {
		await slicer.tick();
		loc += accumulateFile(cwd, relPath, hash, artifactLoc);
	}

	return {
		treeHash: hash.digest("hex"),
		gitHead: await currentGitHeadAsync(cwd),
		loc: artifactLoc ?? loc,
	};
}

export function computeFingerprintCached(
	cwd: string,
	codewiki: Codewiki | null = readCodewiki(cwd),
	options: FingerprintCacheOptions = {},
): Fingerprint {
	const now = Date.now();
	const cached = cachedFingerprints.get(cwd);
	if (cached && cached.expiresAtMs > now) return cached.fingerprint;

	const fingerprint = computeFingerprint(cwd, codewiki);
	const ttlMs = options.ttlMs ?? DEFAULT_FINGERPRINT_CACHE_TTL_MS;
	cachedFingerprints.set(cwd, {
		fingerprint,
		expiresAtMs: Date.now() + Math.max(0, ttlMs),
	});
	return fingerprint;
}

export function isStale(prev: Fingerprint, curr: Fingerprint): boolean {
	return prev.treeHash !== curr.treeHash;
}
