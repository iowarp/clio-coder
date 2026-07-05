import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type Codewiki, isIndexablePath, readCodewiki } from "./codewiki/indexer.js";
import { EXCLUDED_DIRS } from "./excluded-dirs.js";

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
	".cpp",
	".hpp",
	".c",
	".h",
	".java",
	".kt",
]);

function extensionOf(name: string): string {
	const index = name.lastIndexOf(".");
	return index === -1 ? "" : name.slice(index);
}

function walkFiles(cwd: string, dir: string, out: string[]): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (EXCLUDED_DIRS.has(entry.name)) continue;
			walkFiles(cwd, join(dir, entry.name), out);
			continue;
		}
		if (!entry.isFile()) continue;
		const relPath = relative(cwd, join(dir, entry.name)).split("\\").join("/");
		if (isIndexablePath(relPath)) out.push(relPath);
	}
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

export function computeFingerprint(cwd: string, codewiki: Codewiki | null = readCodewiki(cwd)): Fingerprint {
	const files: string[] = [];
	walkFiles(cwd, cwd, files);
	files.sort((a, b) => a.localeCompare(b));

	const hash = createHash("sha256");
	const artifactLoc = locFromCodewiki(codewiki);
	let loc = 0;
	for (const relPath of files) {
		const absPath = join(cwd, relPath);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(absPath);
		} catch {
			continue;
		}
		hash.update(`${relPath}:${stat.size}:${Math.floor(stat.mtimeMs)}\n`);
		if (artifactLoc === null && LOC_EXTENSIONS.has(extensionOf(relPath))) loc += countLines(absPath);
	}

	return {
		treeHash: hash.digest("hex"),
		gitHead: currentGitHead(cwd),
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
