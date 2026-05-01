import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface Fingerprint {
	treeHash: string;
	gitHead: string | null;
	loc: number;
}

const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", ".clio", ".venv", "target"]);
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

function excludeFile(name: string): boolean {
	if (name.endsWith(".lock")) return true;
	if (/\.tar($|\.)/.test(name)) return true;
	return false;
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
		if (excludeFile(entry.name)) continue;
		out.push(relative(cwd, join(dir, entry.name)).split("\\").join("/"));
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

export function computeFingerprint(cwd: string): Fingerprint {
	const files: string[] = [];
	walkFiles(cwd, cwd, files);
	files.sort((a, b) => a.localeCompare(b));

	const hash = createHash("sha256");
	let loc = 0;
	for (const relPath of files) {
		const absPath = join(cwd, relPath);
		let size = 0;
		try {
			size = statSync(absPath).size;
		} catch {
			continue;
		}
		hash.update(`${relPath}:${size}\n`);
		if (LOC_EXTENSIONS.has(extensionOf(relPath))) loc += countLines(absPath);
	}

	return {
		treeHash: hash.digest("hex"),
		gitHead: currentGitHead(cwd),
		loc,
	};
}

export function fingerprintsEqual(prev: Fingerprint, curr: Fingerprint): boolean {
	return prev.treeHash === curr.treeHash && prev.gitHead === curr.gitHead && prev.loc === curr.loc;
}

export function isStale(prev: Fingerprint, curr: Fingerprint): boolean {
	if (prev.gitHead !== curr.gitHead && prev.treeHash !== curr.treeHash) return true;
	const locDelta = Math.abs(curr.loc - prev.loc) / Math.max(prev.loc, 1);
	if (locDelta > 0.1) return true;
	return false;
}
