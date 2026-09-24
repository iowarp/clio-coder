/**
 * Deterministic install-method detection for lifecycle verbs. `clio-coder upgrade`
 * must never offer the npm-global reinstall path to a source-checkout install:
 * the published package may not exist, and `npm install -g` would escape the
 * install's roots and touch the global npm prefix.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import { shellQuote } from "../../core/shell-quote.js";

const PACKAGE_NAME = "@iowarp/clio-coder";
const DIST_CLI_SUFFIX = join("dist", "cli", "index.js");

/** The checkout root for a source install, or null for any other method. */
function sourceCheckoutRoot(entryPath: string | undefined = process.argv[1]): string | null {
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

export interface Installation {
	kind: "source" | "npm" | "pnpm" | "bun" | "local" | "unknown";
	root: string;
	/** Stable entry used after replacement, independent of which launcher wins on PATH. */
	entry: string;
	/** The prefix belonging to this package, never npm's current default prefix. */
	prefix: string | null;
}

/** Inspect layout without running a package manager or consulting the network. */
export function inspectInstallation(entryPath = process.argv[1], fallbackRoot = resolvePackageRoot()): Installation {
	let entry = join(fallbackRoot, DIST_CLI_SUFFIX);
	try {
		if (entryPath) entry = realpathSync(resolve(entryPath));
	} catch {
		// A missing launcher still leaves the package root available for recovery advice.
	}
	const suffix = sep + DIST_CLI_SUFFIX;
	const root = entry.endsWith(suffix) ? entry.slice(0, -suffix.length) : fallbackRoot;
	const base = { root, entry: join(root, DIST_CLI_SUFFIX), prefix: null };
	try {
		if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name !== PACKAGE_NAME)
			return { ...base, kind: "unknown" };
	} catch {
		return { ...base, kind: "unknown" };
	}
	if (sourceCheckoutRoot(base.entry) !== null) return { ...base, kind: "source" };
	const parts = root.split(sep);
	const npmSuffix = sep + join("lib", "node_modules", "@iowarp", "clio-coder");
	if (root.endsWith(npmSuffix)) return { ...base, kind: "npm", prefix: root.slice(0, -npmSuffix.length) || sep };
	// Store paths also occur in project-local and temporary installs. Only known
	// global layouts should receive registry nudges or global-manager instructions.
	if (parts.includes("pnpm") && parts.some((part, i) => part === "global" && /^\d+$/.test(parts[i + 1] ?? "")))
		return { ...base, kind: "pnpm" };
	if (root.includes(sep + join("install", "global", "node_modules") + sep)) return { ...base, kind: "bun" };
	if (parts.includes("node_modules")) return { ...base, kind: "local" };
	return { ...base, kind: "unknown" };
}

export function npmInstallArgs(installation: Installation, channel: string): string[] {
	if (installation.kind !== "npm" || !installation.prefix)
		throw new Error(
			"Automatic upgrade requires an identified npm global installation. Use the original package manager.",
		);
	return ["install", "-g", "--prefix", installation.prefix, `${PACKAGE_NAME}@${channel}`];
}

export function installationCommand(
	installation: Installation,
	action: "upgrade" | "uninstall",
	channel = "latest",
): string {
	const spec = action === "upgrade" ? `${PACKAGE_NAME}@${channel}` : PACKAGE_NAME;
	if (installation.kind === "npm" && installation.prefix)
		return `npm ${action === "upgrade" ? "install" : "uninstall"} -g --prefix ${shellQuote(installation.prefix)} ${spec}`;
	if (installation.kind === "pnpm") return `pnpm ${action === "upgrade" ? "add" : "remove"} -g ${spec}`;
	if (installation.kind === "bun") return `bun ${action === "upgrade" ? "add" : "remove"} -g ${spec}`;
	if (installation.kind === "source")
		return action === "upgrade"
			? `cd ${shellQuote(installation.root)}\ngit fetch --tags\n# Check out the desired release tag, then:\npnpm run install:local`
			: `# Remove this checkout after unlinking its launcher:\n# ${shellQuote(installation.root)}`;
	return `# Use the original package manager for ${shellQuote(installation.root)}.${action === "upgrade" ? "\n# Then run clio-coder upgrade --post-install." : ""}`;
}
