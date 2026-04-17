import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;
let cachedClioVersion: string | null = null;
let cachedPiMonoVersion: string | null = null;

export function resolvePackageRoot(metaUrl = import.meta.url): string {
	if (cached) return cached;
	const override = process.env.CLIO_PACKAGE_ROOT?.trim();
	if (override) {
		cached = resolve(override);
		return cached;
	}
	let dir = resolve(dirname(fileURLToPath(metaUrl)));
	while (true) {
		if (existsSync(join(dir, "package.json"))) {
			cached = dir;
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(`Could not find package.json above ${dir}`);
		}
		dir = parent;
	}
}

interface PartialPackageJson {
	version?: string;
	dependencies?: Record<string, string>;
}

function readPackageJson(): PartialPackageJson {
	const root = resolvePackageRoot();
	const raw = readFileSync(join(root, "package.json"), "utf8");
	return JSON.parse(raw) as PartialPackageJson;
}

export function readClioVersion(): string {
	if (cachedClioVersion) return cachedClioVersion;
	const pkg = readPackageJson();
	cachedClioVersion = pkg.version ?? "0.0.0";
	return cachedClioVersion;
}

export function readPiMonoVersion(): string {
	if (cachedPiMonoVersion) return cachedPiMonoVersion;
	const pkg = readPackageJson();
	cachedPiMonoVersion = pkg.dependencies?.["@mariozechner/pi-agent-core"] ?? "unknown";
	return cachedPiMonoVersion;
}

export function resetPackageRootCache(): void {
	cached = null;
	cachedClioVersion = null;
	cachedPiMonoVersion = null;
}
