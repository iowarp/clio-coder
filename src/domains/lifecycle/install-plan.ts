import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join, sep } from "node:path";
import { resolveClioDirs } from "../../core/xdg.js";
import { type Installation, type InstallerRecord, inactiveInstallerRecord } from "./install-method.js";

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
	const inside = `${root}${sep}`;
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
		if (!build || typeof build.root !== "string" || !build.root.startsWith(inside) || own.has(pid)) continue;
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
				if (command.includes(inside) || cwd.startsWith(inside) || cwd === root)
					holders.push(`pid ${pid} (${command.split("\0")[0]})`);
			} catch {
				/* The process exited or is not inspectable. */
			}
		}
	}
	return holders;
}
