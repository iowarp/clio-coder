import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

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

/** Launches the platform opener for `url`. Returns false when this session has no local browser. */
export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!canOpenBrowser(env)) return false;
	const platform = process.platform;
	// `start` is a cmd builtin and its first quoted argument is the window title, so the empty string is required.
	const [command, args]: [string, string[]] =
		platform === "darwin"
			? ["open", [url]]
			: platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: !env.DISPLAY && !env.WAYLAND_DISPLAY && isWsl(env)
					? ["wslview", [url]]
					: ["xdg-open", [url]];
	try {
		// Detached rather than through safe-exec: the opener may stay alive as the browser, and safe-exec tears its group down.
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.on("error", () => {
			// Best effort only: the URL is also printed.
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
