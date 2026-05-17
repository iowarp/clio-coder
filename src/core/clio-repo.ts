import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface ClioCoderRepoAwareness {
	isClioCoderRepo: boolean;
	repoRoot: string | null;
}

interface PackageJsonShape {
	name?: unknown;
	repository?: unknown;
}

const CLIO_PACKAGE_NAME = "@iowarp/clio-coder";

const SOURCE_MARKERS = [
	"src/entry/orchestrator.ts",
	"src/worker/entry.ts",
	"src/domains/prompts/fragments/identity/clio.md",
] as const;

function isFile(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function readPackageJson(root: string): PackageJsonShape | null {
	try {
		const raw = readFileSync(path.join(root, "package.json"), "utf8");
		const parsed = JSON.parse(raw) as PackageJsonShape;
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function repositoryMatches(value: unknown): boolean {
	if (typeof value === "string") return value.includes("iowarp/clio-coder");
	if (!value || typeof value !== "object") return false;
	const url = (value as { url?: unknown }).url;
	return typeof url === "string" && url.includes("iowarp/clio-coder");
}

function hasGitMarker(root: string): boolean {
	return existsSync(path.join(root, ".git"));
}

function hasSourceMarkers(root: string): boolean {
	return SOURCE_MARKERS.every((marker) => isFile(path.join(root, marker)));
}

function isClioCoderRepoRoot(root: string): boolean {
	const pkg = readPackageJson(root);
	if (pkg?.name !== CLIO_PACKAGE_NAME) return false;
	if (!repositoryMatches(pkg.repository)) return false;
	if (!hasGitMarker(root)) return false;
	return hasSourceMarkers(root);
}

export function detectClioCoderRepo(cwd = process.cwd()): ClioCoderRepoAwareness {
	let current = path.resolve(cwd);
	for (;;) {
		if (isClioCoderRepoRoot(current)) {
			return { isClioCoderRepo: true, repoRoot: current };
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return { isClioCoderRepo: false, repoRoot: null };
}
