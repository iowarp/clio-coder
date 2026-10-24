import { dirname, join } from "node:path";
import type { Installation } from "./install-method.js";
import { readInstallerRecord } from "./install-method.js";
import { compareReleaseVersions } from "./release-version.js";

/** Hard cap on one background installer run. */
export const NATIVE_UPDATE_TIMEOUT_MS = 10 * 60_000;

/** Which switch turned background installs off; null when they are on (#436). */
export type AutoUpdateBlocker = "env" | "setting" | "installer" | "pin";

/**
 * The effective background-install policy of a native install: the
 * environment opt-out, the `interface.autoUpdate` setting, the installer's
 * recorded `autoUpdate` flag and a version pin must all allow it. Null for
 * every other install kind, which never installs from a session.
 */
export function nativeAutoUpdatePolicy(
	installation: Installation,
	setting: boolean,
): { enabled: boolean; blocker: AutoUpdateBlocker | null } | null {
	if (installation.kind !== "installer" || !installation.installer) return null;
	const record = readInstallerRecord(installation.installer.root);
	const blocker: AutoUpdateBlocker | null =
		process.env.CLIO_CODER_AUTO_UPDATE === "0"
			? "env"
			: !setting
				? "setting"
				: !record?.autoUpdate
					? "installer"
					: record.versionPin
						? "pin"
						: null;
	return { enabled: blocker === null, blocker };
}

export interface NativeUpdateResult {
	ok: boolean;
	exitCode: number | null;
	/** Last non-empty stderr line of a failed run, at most 160 characters. */
	detail: string;
}

/** A new prefix is activated without touching state or restarting the current session. */
export async function runNativeBackgroundUpdate(
	installation: Installation,
	version: string,
	signal: AbortSignal,
	setting = true,
): Promise<NativeUpdateResult> {
	const skipped = (detail: string): NativeUpdateResult => ({ ok: false, exitCode: null, detail });
	const policy = nativeAutoUpdatePolicy(installation, setting);
	if (!policy?.enabled || !installation.installer)
		return skipped(`auto-update off (${policy?.blocker ?? "not native"})`);
	const record = readInstallerRecord(installation.installer.root);
	if (!record || compareReleaseVersions(version.split("-")[0] ?? "", "0.6.0") === -1)
		return skipped(`v${version} predates background updates`);
	const windows = process.platform === "win32";
	const args = windows
		? [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				join(installation.root, "scripts", "install.ps1"),
				"-InstallDir",
				record.root,
				"-BinDir",
				dirname(record.launcher),
				"-Channel",
				record.channel,
				"-Version",
				version,
				"-NoPostInstall",
				"-NoModifyPath",
			]
		: [
				join(installation.root, "scripts", "install.sh"),
				"--install-dir",
				record.root,
				"--bin-dir",
				dirname(record.launcher),
				"--channel",
				record.channel,
				"--version",
				version,
				"--no-post-install",
				"--no-modify-path",
			];
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	// The exact download target is not an operator pin; the installer preserves the recorded policy.
	env.CLIO_CODER_BACKGROUND_UPDATE = "1";
	env.CLIO_CODER_BACKGROUND_CURRENT = record.current;
	env.CLIO_CODER_NODE_VERSION = record.nodeVersion;
	delete env.CLIO_CODER_PACKAGE;
	delete env.CLIO_CODER_VERSION;
	const { runCommandVector } = await import("../../core/safe-exec.js");
	const result = await runCommandVector(windows ? "powershell.exe" : "sh", args, {
		env,
		signal,
		timeoutMs: NATIVE_UPDATE_TIMEOUT_MS,
		maxOutputBytes: 1024 * 1024,
	});
	if (result.exitCode === 0) return { ok: true, exitCode: 0, detail: "" };
	// A timeout names itself: the last stderr line of a killed run is whatever
	// npm happened to print, not why it stopped.
	const line = result.timedOut
		? "timed out after 10 minutes"
		: (result.stderr
				.split(/\r?\n/u)
				.map((entry) => entry.trim())
				.filter(Boolean)
				.pop() ??
			(result.aborted ? "interrupted" : result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`));
	return { ok: false, exitCode: result.exitCode, detail: line.slice(0, 160) };
}
