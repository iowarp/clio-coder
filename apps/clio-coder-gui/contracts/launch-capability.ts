/** Whether this host can keep the app running at one address from login, and why not when it cannot. */
export type BackgroundCapability = { available: true } | { available: false; reason: string };

/**
 * Background setup is a per-user service: a systemd user unit on Linux, a launchd LaunchAgent on macOS and a
 * Task Scheduler logon task on Windows. Any other host reports the capability as unavailable instead of failing
 * the action. `platform` is `process.platform`, or the `platform-arch` string the app's meta reports.
 */
export function backgroundCapability(platform: string): BackgroundCapability {
	const os = platform.split("-")[0] ?? platform;
	if (os === "linux" || os === "darwin" || os === "win32") return { available: true };
	return { available: false, reason: backgroundCapabilityReason(os) };
}

export function backgroundCapabilityReason(platform: string) {
	const os = platform.split("-")[0] ?? platform;
	return `Background setup needs systemd (Linux), launchd (macOS) or Task Scheduler (Windows), so it is not available on ${os}. clio-coder gui starts a private server for each terminal instead.`;
}
