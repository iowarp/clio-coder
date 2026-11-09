import type { Installation, InstallerRecord } from "./install-method.js";

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
