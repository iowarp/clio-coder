/**
 * Deterministic install-method detection for lifecycle verbs. `clio upgrade`
 * must never offer the npm-global reinstall path to a source-checkout install:
 * the published package may not exist, and `npm install -g` would escape the
 * install's roots and touch the global npm prefix.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type InstallMethod = "source" | "npm";

const PACKAGE_NAME = "@iowarp/clio-coder";
const DIST_CLI_SUFFIX = join("dist", "cli", "index.js");

/**
 * Classify the running binary from its entry path (realpath through the
 * launcher symlink). "source" requires all of:
 *   - the entry resolves to <root>/dist/cli/index.js outside node_modules;
 *   - <root>/package.json names this package;
 *   - <root> carries checkout markers npm never ships (.git or src/cli).
 * Everything else is treated as an npm install, where the registry path is
 * the honest upgrade story.
 */
export function detectInstallMethod(entryPath: string | undefined = process.argv[1]): InstallMethod {
	const root = sourceCheckoutRoot(entryPath);
	return root === null ? "npm" : "source";
}

/** The checkout root for a source install, or null for any other method. */
export function sourceCheckoutRoot(entryPath: string | undefined = process.argv[1]): string | null {
	if (!entryPath || entryPath.trim().length === 0) return null;
	let entry: string;
	try {
		entry = realpathSync(resolve(entryPath));
	} catch {
		return null;
	}
	const suffix = sep + DIST_CLI_SUFFIX;
	if (!entry.endsWith(suffix)) return null;
	if (entry.split(sep).includes("node_modules")) return null;
	const root = entry.slice(0, entry.length - suffix.length);
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown };
		if (pkg.name !== PACKAGE_NAME) return null;
	} catch {
		return null;
	}
	const hasCheckoutMarker = existsSync(join(root, ".git")) || existsSync(join(root, "src", "cli", "index.ts"));
	return hasCheckoutMarker ? root : null;
}
