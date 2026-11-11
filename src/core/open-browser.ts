import { accessSync, constants } from "node:fs";
import path, { win32 } from "node:path";
import { launchDetached } from "./safe-exec.js";

/** What an opener needs from the session to reach the operator's desktop; provider keys stay behind. */
const OPENER_SESSION_ENV = [
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"DBUS_SESSION_BUS_ADDRESS",
	"XDG_RUNTIME_DIR",
	"XDG_SESSION_TYPE",
	"XDG_CURRENT_DESKTOP",
	"XDG_DATA_DIRS",
	"XDG_CONFIG_DIRS",
	"DESKTOP_SESSION",
	"BROWSER",
	"WSL_DISTRO_NAME",
	"WSL_INTEROP",
] as const;

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		try {
			accessSync(path.join(dir, command), constants.X_OK);
			return true;
		} catch {
			// Not in this directory.
		}
	}
	return false;
}

function isWsl(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

/**
 * Whether a browser opened here would appear in front of the operator. An SSH
 * session or a Linux box without a display opens nothing they can see, and an
 * OAuth callback to this machine's localhost cannot arrive from their browser.
 */
export function canOpenBrowser(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (env.SSH_CONNECTION || env.SSH_TTY) return false;
	if (platform !== "linux") return true;
	if (env.DISPLAY || env.WAYLAND_DISPLAY) return true;
	return isWsl(env) && onPath("wslview", env);
}

/**
 * Only https: and loopback http: URLs reach a platform opener. Provider and
 * device-code servers supply some of these links, so a `file:`, custom-scheme
 * or remote plain-http link is printed, never opened (R1-safety-secrets-07).
 * The opener gets the parsed URL with shell-active characters percent-encoded,
 * never the raw string: `wslview` ends in a double-quoted PowerShell `Start`,
 * where `$(...)` would run (R2-safety-secrets-18). Null means refused.
 */
export function openableUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol === "http:") {
		const host = parsed.hostname.toLowerCase();
		if (!(host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/u.test(host))) return null;
	} else if (parsed.protocol !== "https:") return null;
	return parsed.href.replace(
		/[$`"'();\s]/gu,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
	);
}

/**
 * Never cmd.exe or `start`, which split a URL at `&` and run the rest as a
 * command even with shell:false. The system rundll32 is named by absolute path
 * so a PATH entry cannot stand in for it, as the GUI's opener does.
 */
export function windowsUrlOpener(url: string, env: NodeJS.ProcessEnv = process.env): [string, string[]] | null {
	const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
	if (!win32.isAbsolute(root)) return null;
	return [win32.join(root, "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url]];
}

/** Launches the platform opener for `url`. Returns false when this session has no local browser or the URL is refused. */
export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const href = openableUrl(url);
	if (!canOpenBrowser(env) || href === null) return false;
	const platform = process.platform;
	const opener: [string, string[]] | null =
		platform === "darwin"
			? ["open", [href]]
			: platform === "win32"
				? windowsUrlOpener(href, env)
				: !env.DISPLAY && !env.WAYLAND_DISPLAY && isWsl(env)
					? ["wslview", [href]]
					: ["xdg-open", [href]];
	if (!opener) return false;
	const [command, args] = opener;
	return launchDetached(command, args, { source: env, passThrough: OPENER_SESSION_ENV });
}
