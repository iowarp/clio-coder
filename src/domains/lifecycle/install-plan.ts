import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { resolveClioDirs } from "../../core/xdg.js";
import {
	INSTALLER_LAUNCHER_MARK,
	type Installation,
	type InstallerRecord,
	inactiveInstallerRecord,
	realPathOf,
} from "./install-method.js";

/** Why background updates are off for an installer install; see nativeAutoUpdatePolicy. */
export type TrackingAutoUpdate = { enabled: boolean; blocker: string | null } | null;

function pinOrigin(record: InstallerRecord, windows: boolean): string {
	const pin = record.versionPin ?? "";
	if (record.pinSource === "package-file") return "installed from a package file";
	if (record.pinSource === "rollback") return "upgrade --rollback";
	return windows ? `install.ps1 -Version ${pin}` : `install.sh --version ${pin}`;
}

/**
 * One phrase for what an installation follows or is pinned to, shared by doctor,
 * paths, upgrade and /upgrade so they never disagree.
 */
export function describeTracking(
	installation: Installation,
	opts: { autoUpdate?: TrackingAutoUpdate; windows?: boolean } = {},
): string {
	const record = installation.installer;
	const windows = opts.windows ?? process.platform === "win32";
	if (record) {
		if (record.versionPin) {
			const since = (record.pinnedAt || record.installedAt || "").slice(0, 10);
			return `pinned to ${record.versionPin}${since ? ` since ${since}` : ""} (${pinOrigin(record, windows)}); release with clio-coder upgrade --channel ${record.channel}`;
		}
		const policy = opts.autoUpdate;
		const updates =
			policy === undefined || policy === null
				? ""
				: policy.enabled
					? "; background updates on"
					: `; background updates off (${policy.blocker ?? "installer"})`;
		return `follows ${record.channel}${updates}`;
	}
	switch (installation.kind) {
		case "npm":
		case "pnpm":
		case "bun":
			return `${installation.kind} global; follows latest through ${installation.kind}`;
		case "homebrew":
			return "follows brew upgrade";
		case "winget":
			return "follows winget upgrade";
		case "source":
			return "source checkout; follows its git branch and pnpm run build";
		default:
			return "not tracked; update it with the tool that installed it";
	}
}

/** Installer roots this binary does not run from. */
export function inactiveInstallerRoots(installation: Installation): InstallerRecord[] {
	const record = inactiveInstallerRecord(installation);
	return record ? [record] : [];
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

/**
 * Processes still loading files from an installer root, named for the operator:
 * live launch receipts, live session records, and on Linux any process of this
 * user whose command line or working directory lies inside it.
 */
export function installRootHolders(root: string, state = resolveClioDirs().state): string[] {
	// Records and /proc carry resolved paths; the manifest may name the root through a symlink.
	const spellings = [...new Set([root, realPathOf(root)])];
	const insideAny = (text: string) => spellings.some((spelling) => text.includes(`${spelling}${sep}`));
	const atOrUnder = (path: string) =>
		spellings.some((spelling) => path === spelling || path.startsWith(`${spelling}${sep}`));
	const holders: string[] = [];
	const own = new Set([process.pid, Number(process.env.CLIO_CODER_LAUNCHER_PID)]);
	const json = (file: string): Record<string, unknown> | null => {
		try {
			return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch {
			return null;
		}
	};
	const receipts = join(root, ".active");
	for (const name of existsSync(receipts) ? readdirSync(receipts) : []) {
		const receipt = json(join(receipts, name));
		const pid = Number(receipt?.pid ?? name.replace(/\.json$/, ""));
		if (!Number.isSafeInteger(pid) || pid <= 0 || own.has(pid)) continue;
		if (receipt?.host !== undefined && receipt.host !== hostname()) holders.push(`pid ${pid}@${String(receipt.host)}`);
		else if (alive(pid)) holders.push(`pid ${pid} (launched from it)`);
	}
	const builds = join(state, "running-builds");
	for (const name of existsSync(builds) ? readdirSync(builds) : []) {
		const build = json(join(builds, name));
		const pid = Number(build?.pid);
		if (!build || typeof build.root !== "string" || !atOrUnder(build.root) || own.has(pid)) continue;
		if (build.host !== hostname()) holders.push(`pid ${pid}@${String(build.host)} (${String(build.surface)})`);
		else if (alive(pid)) holders.push(`pid ${pid} (${String(build.surface)} session)`);
	}
	if (process.platform === "linux") {
		let pids: string[] = [];
		try {
			pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
		} catch {
			/* No process table; receipts and session records still apply. */
		}
		for (const name of pids) {
			const pid = Number(name);
			if (own.has(pid) || holders.some((holder) => holder.startsWith(`pid ${pid} `))) continue;
			try {
				if (statSync(`/proc/${name}`).uid !== process.getuid?.()) continue;
				const command = readFileSync(`/proc/${name}/cmdline`, "utf8");
				const cwd = readlinkSync(`/proc/${name}/cwd`);
				if (insideAny(command) || atOrUnder(cwd))
					holders.push(`pid ${pid} (${command.split("\0")[0]})`);
			} catch {
				/* The process exited or is not inspectable. */
			}
		}
	}
	return holders;
}

const NATIVE_PACKAGE = join("lib", "node_modules", "@iowarp", "clio-coder");

/**
 * What one installation is, for comparing two package roots: the install root of
 * a native install (every upgrade lands in a new versions/<version> prefix), and
 * the package root itself for every other method.
 */
export function installIdentity(packageRoot: string): string {
	const root = resolve(packageRoot);
	if (!root.endsWith(`${sep}${NATIVE_PACKAGE}`)) return root;
	const versions = dirname(root.slice(0, -(NATIVE_PACKAGE.length + 1)));
	return basename(versions) === "versions" ? dirname(versions) : root;
}

/** The package root the background app was installed from, or null when there is none or it is unreadable. */
export function backgroundPackageRoot(stateDir: string): string | null {
	try {
		const config = JSON.parse(readFileSync(join(stateDir, "gui", "background", "server.json"), "utf8")) as {
			packageRoot?: unknown;
		};
		return typeof config.packageRoot === "string" && config.packageRoot !== "" ? config.packageRoot : null;
	} catch {
		return null;
	}
}

/** The launcher an inactive installer root still owns: a regular file with the installer mark naming that root. */
export function inactiveInstallerLauncher(record: InstallerRecord): string | null {
	try {
		if (lstatSync(record.launcher).isSymbolicLink()) return null;
		const text = readFileSync(record.launcher, "utf8");
		const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
		return text.includes(INSTALLER_LAUNCHER_MARK) && fold(text).includes(fold(`${record.root}${sep}`))
			? record.launcher
			: null;
	} catch {
		return null;
	}
}

/** True when `launcher` is the first `clio-coder` a shell finds on PATH (POSIX names only). */
export function launcherWinsOnPath(launcher: string, path = process.env.PATH ?? ""): boolean {
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, basename(launcher));
		if (!existsSync(candidate)) continue;
		return resolve(candidate) === resolve(launcher);
	}
	return false;
}
