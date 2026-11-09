/**
 * Deterministic install-method detection for lifecycle verbs. `clio-coder upgrade`
 * must never offer the npm-global reinstall path to a source-checkout install:
 * the published package may not exist, and `npm install -g` would escape the
 * install's roots and touch the global npm prefix.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import { shellQuote } from "../../core/shell-quote.js";
import { xdgBaseDir } from "../../core/xdg.js";

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

/**
 * What scripts/install.sh recorded in `<install root>/install.json`: the
 * managed Node, the package prefix the launcher runs, and the one kept for
 * rollback.
 */
export interface InstallerRecord {
	/** The install root holding runtime/, versions/ and install.json. */
	root: string;
	node: string;
	nodeVersion: string;
	nodeBuild: string;
	/** Package prefix the launcher runs now. */
	current: string;
	/** Package prefix kept for rollback, or null. */
	previous: string | null;
	launcher: string;
	channel: string;
	versionPin?: string;
	/** How the pin was set: an exact --version, a --package file, or a rollback. */
	pinSource?: "version-flag" | "package-file" | "rollback" | undefined;
	/** ISO time the pin was set; older manifests fall back to installedAt. */
	pinnedAt?: string;
	installedAt?: string;
	autoUpdate?: boolean;
	manager?: string;
	pathAdded?: boolean;
	pathEntry?: string;
}

export const INSTALLER_MANIFEST_KIND = "clio-coder-installer";
/** First line after the shebang of every launcher scripts/install.sh writes. */
export const INSTALLER_LAUNCHER_MARK = "# clio-coder-installer launcher";

export interface Installation {
	kind: "source" | "npm" | "pnpm" | "bun" | "installer" | "homebrew" | "winget" | "local" | "unknown";
	root: string;
	/** Stable entry used after replacement, independent of which launcher wins on PATH. */
	entry: string;
	/** The prefix belonging to this package, never npm's current default prefix. */
	prefix: string | null;
	/** Present for kind "installer". */
	installer?: InstallerRecord;
}

/** The resolved path; a missing tail is kept as written under its nearest resolved ancestor. */
export function realPathOf(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		const parent = dirname(absolute);
		return parent === absolute ? absolute : join(realPathOf(parent), basename(absolute));
	}
}

function strictlyInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** True when `child` is `parent` or inside it, comparing resolved paths so a symlinked home matches. */
export function pathWithin(parent: string, child: string): boolean {
	const real = realPathOf(parent);
	const target = realPathOf(child);
	const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
	return fold(real) === fold(target) || strictlyInside(fold(real), fold(target));
}

/** The installer manifest under `installRoot`, or null when there is none or it is not ours. */
export function readInstallerRecord(installRoot: string): InstallerRecord | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(installRoot, "install.json"), "utf8"));
	} catch {
		return null;
	}
	if (raw === null || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	if (record.schema !== 1 && record.schema !== 2) return null;
	const text = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
	// install.sh records logical paths; a root reached through a symlinked ~/.local or HOME
	// still owns them when they resolve inside it.
	const owned = (folder: string, file: string) =>
		isAbsolute(file) &&
		(strictlyInside(join(installRoot, folder), file) ||
			strictlyInside(realPathOf(join(installRoot, folder)), realPathOf(file)));
	if (!owned("versions", text("current")) || !owned("runtime", text("node"))) return null;
	if (text("previous") && !owned("versions", text("previous"))) return null;
	if (text("kind") !== INSTALLER_MANIFEST_KIND || text("current") === "" || text("node") === "") return null;
	return {
		root: installRoot,
		node: text("node"),
		nodeVersion: text("nodeVersion"),
		nodeBuild: text("nodeBuild"),
		current: text("current"),
		previous: text("previous") || null,
		launcher: text("launcher"),
		channel: text("channel") || "latest",
		versionPin: text("versionPin"),
		pinSource: (["version-flag", "package-file", "rollback"] as const).find((value) => value === text("pinSource")),
		pinnedAt: text("pinnedAt"),
		installedAt: text("installedAt"),
		autoUpdate: record.autoUpdate === true,
		manager: text("manager"),
		pathAdded: record.pathAdded === true,
		pathEntry: text("pathEntry"),
	};
}

/** Everything an installer creates inside its root, which may be a directory it shares with other files. */
export const INSTALLER_OWNED_ENTRIES = [
	"runtime",
	"versions",
	"launchers",
	"launcher.cjs",
	".active",
	".installer-owner",
	"install.json",
] as const;

/** Where the installers put their root when none is named: `default_install_root` in scripts/install.sh, and install.ps1. */
export function defaultInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
	const named = env.CLIO_CODER_INSTALL_DIR?.trim();
	if (named) return resolve(named);
	const clioHome = env.CLIO_CODER_HOME?.trim();
	if (clioHome) return join(clioHome, "install");
	const home = homedir();
	if (process.platform === "win32")
		return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "clio-coder", "install");
	if (process.platform === "darwin") return join(home, "Library", "Application Support", "clio-coder", "install");
	return join(xdgBaseDir(env.XDG_DATA_HOME, join(home, ".local", "share")), "clio-coder-install");
}

/** The launcher path that belongs to this installation, whether or not anything is there. */
export function launcherPathFor(installation: Installation, env: NodeJS.ProcessEnv = process.env): string {
	if (installation.kind === "installer" && installation.installer?.launcher) return installation.installer.launcher;
	if (installation.kind === "npm" && installation.prefix) return join(installation.prefix, "bin", "clio-coder");
	return join(env.CLIO_CODER_BIN_DIR?.trim() || join(homedir(), ".local", "bin"), "clio-coder");
}

/**
 * An installer root this binary does not run from, left behind when the launcher
 * moved to a checkout or a package manager. Nothing runs its pruning any more, so
 * `paths`, `doctor` and `uninstall` have to name it or it is invisible.
 */
export function inactiveInstallerRecord(installation: Installation): InstallerRecord | null {
	if (installation.installer) return null;
	const record = readInstallerRecord(defaultInstallRoot());
	// A root this binary runs from is never inactive, whatever path spelling reached it.
	if (
		record === null ||
		pathWithin(record.root, installation.root) ||
		pathWithin(record.root, installation.entry) ||
		pathWithin(record.root, process.execPath)
	)
		return null;
	return record;
}

/** The package root inside an installer prefix. */
export function installerPackageRoot(prefix: string): string {
	return join(prefix, "lib", "node_modules", "@iowarp", "clio-coder");
}

/**
 * An installer prefix is `<install root>/versions/<version>`, and the root
 * holds the manifest. A bare npm prefix that happens to sit in a `versions`
 * directory has no such manifest and stays an npm install.
 */
function installerRecordForPrefix(prefix: string): InstallerRecord | null {
	const versions = dirname(prefix);
	if (basename(versions) !== "versions") return null;
	return readInstallerRecord(dirname(versions));
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
	if (parts.includes("Cellar") && parts.includes("clio-coder")) return { ...base, kind: "homebrew" };
	const npmSuffix = sep + join("lib", "node_modules", "@iowarp", "clio-coder");
	if (root.endsWith(npmSuffix)) {
		const prefix = root.slice(0, -npmSuffix.length) || sep;
		const installer = installerRecordForPrefix(prefix);
		if (installer !== null)
			return {
				...base,
				kind: installer.manager === "winget" && process.env.CLIO_CODER_MANAGER_UNINSTALL !== "1" ? "winget" : "installer",
				prefix,
				installer,
			};
		return { ...base, kind: "npm", prefix };
	}
	if (process.platform === "win32" && root.endsWith(sep + join("node_modules", "@iowarp", "clio-coder"))) {
		const prefix = root.slice(0, -(sep + join("node_modules", "@iowarp", "clio-coder")).length);
		if (existsSync(join(prefix, "clio-coder.cmd"))) return { ...base, kind: "npm", prefix };
	}
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

export interface UpgradeInvocation {
	command: string;
	args: string[];
	env: Record<string, string | undefined>;
}

/** A resolved version makes "Installing with" name the exact version that runs. */
export function npmUpgradeInvocation(
	installation: Installation,
	version: string,
	runtime: { windows: boolean; node: string; npmCli: string | null },
): UpgradeInvocation {
	const args = npmInstallArgs(installation, version);
	if (!runtime.windows) return { command: "npm", args, env: {} };
	if (runtime.npmCli === null)
		throw new Error("Cannot locate npm-cli.js beside Node; use npm install -g from your terminal");
	return { command: runtime.node, args: [runtime.npmCli, ...args], env: {} };
}

/**
 * The runtime stays the one the manifest names unless --refresh-runtime,
 * so an upgrade does not quietly download a new Node.
 */
export function installerUpgradeInvocation(
	installation: Installation,
	opts: { channel: string; channelExplicit: boolean; refreshRuntime: boolean },
	windows: boolean,
): UpgradeInvocation {
	const record = installation.installer;
	if (installation.kind !== "installer" || record === undefined)
		throw new Error("installer upgrade needs an install.sh installation");
	const args = windows
		? [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				join(installation.root, "scripts", "install.ps1"),
				"-Channel",
				opts.channel,
				"-InstallDir",
				record.root,
				"-BinDir",
				dirname(record.launcher),
				"-NoPostInstall",
			]
		: [
				join(installation.root, "scripts", "install.sh"),
				"--channel",
				opts.channel,
				"--install-dir",
				record.root,
				"--bin-dir",
				dirname(record.launcher),
				"--no-post-install",
			];
	if (record.versionPin && !opts.channelExplicit) args.push(windows ? "-Version" : "--version", record.versionPin);
	const env: UpgradeInvocation["env"] = {};
	if (opts.refreshRuntime) {
		env.CLIO_CODER_NODE_VERSION = undefined;
		args.push(windows ? "-RefreshRuntime" : "--refresh-runtime");
	} else if (record.nodeVersion) env.CLIO_CODER_NODE_VERSION = record.nodeVersion;
	return { command: windows ? "powershell.exe" : "sh", args, env };
}

export function formatUpgradeInvocation(invocation: UpgradeInvocation, windows = process.platform === "win32"): string {
	if (windows) {
		const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
		const overrides = Object.entries(invocation.env).map(([name, value]) =>
			value === undefined ? `Remove-Item Env:${name};` : `$env:${name}=${quote(value)};`,
		);
		return [...overrides, "&", ...[invocation.command, ...invocation.args].map(quote)].join(" ");
	}
	const quote = (value: string) => (/^[A-Za-z0-9_./:@=+-]+$/u.test(value) ? value : shellQuote(value));
	const removed = Object.entries(invocation.env).filter(([, value]) => value === undefined);
	const prefix = removed.flatMap(([name]) => ["-u", name]);
	const overrides = Object.entries(invocation.env).flatMap(([name, value]) =>
		value === undefined ? [] : [`${name}=${quote(value)}`],
	);
	return [
		...(prefix.length ? ["env", ...prefix] : []),
		...overrides,
		...[invocation.command, ...invocation.args].map(quote),
	].join(" ");
}

/**
 * The installer run that releases a version pin. A pinned install keeps its
 * version through `clio-coder upgrade` and installer reruns; only an explicit
 * channel spec (`--version latest`) clears the pin, and `--auto-update` turns
 * background updates back on.
 */
export function installerUnpinCommand(installation: Installation, channel = "latest"): string | null {
	const record = installation.installer;
	if (installation.kind !== "installer" || record === undefined) return null;
	if (process.platform === "win32")
		return `powershell -NoProfile -ExecutionPolicy Bypass -File "${join(installation.root, "scripts", "install.ps1")}" -Version ${channel} -AutoUpdate -InstallDir "${record.root}" -BinDir "${dirname(record.launcher)}"`;
	return `sh ${shellQuote(join(installation.root, "scripts", "install.sh"))} --version ${channel} --auto-update --install-dir ${shellQuote(record.root)} --bin-dir ${shellQuote(dirname(record.launcher))}`;
}

export function installationCommand(
	installation: Installation,
	action: "upgrade" | "uninstall",
	channel = "latest",
): string {
	const spec = action === "upgrade" ? `${PACKAGE_NAME}@${channel}` : PACKAGE_NAME;
	if (installation.kind === "npm" && installation.prefix)
		return `npm ${action === "upgrade" ? "install" : "uninstall"} -g --prefix ${shellQuote(installation.prefix)} ${spec}`;
	if (installation.kind === "installer" && installation.installer) {
		const record = installation.installer;
		if (process.platform === "win32")
			return action === "upgrade"
				? `powershell -NoProfile -ExecutionPolicy Bypass -File "${join(installation.root, "scripts", "install.ps1")}" -Channel ${channel} -InstallDir "${record.root}" -BinDir "${dirname(record.launcher)}"`
				: "clio-coder uninstall";
		return action === "upgrade"
			? `sh ${shellQuote(join(installation.root, "scripts", "install.sh"))} --channel ${channel} --install-dir ${shellQuote(record.root)} --bin-dir ${shellQuote(dirname(record.launcher))}`
			: "clio-coder uninstall";
	}
	if (installation.kind === "homebrew") return `brew ${action} clio-coder`;
	if (installation.kind === "winget") return `winget ${action} --id IOWarp.ClioCoder --exact`;
	if (installation.kind === "pnpm") return `pnpm ${action === "upgrade" ? "add" : "remove"} -g ${spec}`;
	if (installation.kind === "bun") return `bun ${action === "upgrade" ? "add" : "remove"} -g ${spec}`;
	if (installation.kind === "source")
		return action === "upgrade"
			? `cd ${shellQuote(installation.root)}\ngit fetch --tags\n# Check out the desired release tag, then:\npnpm run install:local`
			: `# Remove this checkout after unlinking its launcher:\n# ${shellQuote(installation.root)}`;
	return `# Use the original package manager for ${shellQuote(installation.root)}.${action === "upgrade" ? "\n# Then run clio-coder upgrade --post-install." : ""}`;
}
