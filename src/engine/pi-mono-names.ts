import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";

/**
 * Canonical pi-mono package names. The engine barrel is the sole place in
 * the codebase where the literal `@earendil-works/*` strings are allowed to
 * appear; domains and core must import these constants instead.
 */

export const PI_MONO_PACKAGES = {
	agentCore: "@earendil-works/pi-agent-core",
	ai: "@earendil-works/pi-ai",
	tui: "@earendil-works/pi-tui",
} as const;

export type PiMonoPackageName = (typeof PI_MONO_PACKAGES)[keyof typeof PI_MONO_PACKAGES];

let cachedPiMonoVersion: string | null = null;

/** Engine dependency metadata is outside the instant terminal's package/version path. */
export function readPiMonoVersion(): string {
	if (cachedPiMonoVersion) return cachedPiMonoVersion;
	const pkg = JSON.parse(readFileSync(join(resolvePackageRoot(), "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	cachedPiMonoVersion = pkg.dependencies?.[PI_MONO_PACKAGES.agentCore] ?? "unknown";
	return cachedPiMonoVersion;
}
