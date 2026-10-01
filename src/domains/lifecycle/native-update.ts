import { dirname, join } from "node:path";
import type { Installation } from "./install-method.js";
import { readInstallerRecord } from "./install-method.js";
import { compareReleaseVersions } from "./release-version.js";

/** A new prefix is activated without touching state or restarting the current session. */
export async function runNativeBackgroundUpdate(
	installation: Installation,
	version: string,
	signal: AbortSignal,
): Promise<boolean> {
	if (process.env.CLIO_CODER_AUTO_UPDATE === "0" || installation.kind !== "installer" || !installation.installer)
		return false;
	const record = readInstallerRecord(installation.installer.root);
	if (!record?.autoUpdate || record.versionPin || compareReleaseVersions(version.split("-")[0] ?? "", "0.6.0") === -1)
		return false;
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
		timeoutMs: 10 * 60_000,
		maxOutputBytes: 1024 * 1024,
	});
	return result.exitCode === 0;
}
