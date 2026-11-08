/** Whether this host can keep the app running at one address from login, and why not when it cannot. */
export type BackgroundCapability = { available: true } | { available: false; reason: string };

const PLATFORM_NAMES: Record<string, string> = { darwin: "macOS", win32: "Windows" };

/**
 * Background setup is a systemd user service, so only Linux offers it. launchd and Windows services are
 * not built, so those hosts report the capability as unavailable instead of failing the action.
 * `platform` is `process.platform`, or the `platform-arch` string the app's meta reports.
 */
export function backgroundCapability(platform: string): BackgroundCapability {
	const os = platform.split("-")[0] ?? platform;
	if (os === "linux") return { available: true };
	const name = PLATFORM_NAMES[os] ?? os;
	return {
		available: false,
		reason: `Background setup needs Linux with a systemd user session, so it is not available on ${name}. clio-coder gui starts a private server for each terminal instead.`,
	};
}
