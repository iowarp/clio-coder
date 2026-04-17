import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";

interface PackageJsonShape {
	version?: string;
	dependencies?: Record<string, string>;
}

let cached: VersionInfo | null = null;

export interface VersionInfo {
	clio: string;
	node: string;
	platform: string;
	piAgentCore: string | null;
	piAi: string | null;
	piTui: string | null;
}

export function getVersionInfo(): VersionInfo {
	if (cached) return cached;
	const root = resolvePackageRoot();
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJsonShape;
	cached = {
		clio: pkg.version ?? "0.0.0",
		node: process.version,
		platform: `${process.platform}-${process.arch}`,
		piAgentCore: pkg.dependencies?.["@mariozechner/pi-agent-core"] ?? null,
		piAi: pkg.dependencies?.["@mariozechner/pi-ai"] ?? null,
		piTui: pkg.dependencies?.["@mariozechner/pi-tui"] ?? null,
	};
	return cached;
}
