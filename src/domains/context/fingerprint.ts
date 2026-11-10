import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { internalGitArgv } from "../../core/internal-git.js";
import { enumerateWorkspaceFiles } from "../../core/workspace-files.js";
import { readCodewiki } from "./codewiki/artifact.js";
import { isIndexablePath, oversizeFileBytes, streamFile } from "./codewiki/paths.js";
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

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (const ch of text) {
		if (ch === "\n") lines += 1;
	}
	return lines;
}

function locFromCodewiki(codewiki: Codewiki | null): number | null {
	if (!codewiki) return null;
	return codewiki.files.reduce((sum, file) => (file.lang === "config" ? sum : sum + file.loc), 0);
}

function createTreeHash(): ReturnType<typeof createHash> {
	// Migrate both unsalted and v2 metadata identities, including empty trees.
	return createHash("sha256").update("clio-codewiki-tree:v3\n");
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
	// Read failures must invalidate the operation, never certify a partial tree.
	const path = join(cwd, relPath);
	if (oversizeFileBytes(path) !== null) {
		const streamed = streamFile(path);
		hash.update(`${JSON.stringify(relPath)}:${streamed.digest}\n`);
		return artifactLoc === null && LOC_EXTENSIONS.has(extensionOf(relPath)) ? streamed.newlines + 1 : 0;
	}
	const contents = readFileSync(path);
	const digest = createHash("sha256").update(contents).digest("hex");
	hash.update(`${JSON.stringify(relPath)}:${digest}\n`);
	if (artifactLoc === null && LOC_EXTENSIONS.has(extensionOf(relPath))) return countLines(contents.toString("utf8"));
	return 0;
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
	for (const relPath of files) loc += accumulateFile(cwd, relPath, hash, artifactLoc);

	return {
		treeHash: hash.digest("hex"),
		gitHead: currentGitHead(cwd),
		loc: artifactLoc ?? loc,
	};
}

export function isStale(prev: Fingerprint, curr: Fingerprint): boolean {
	return prev.treeHash !== curr.treeHash;
}
