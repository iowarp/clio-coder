import { spawn } from "node:child_process";

/**
 * Provider runtimes supply OAuth authorize, device-code, and management-console
 * links, so the string is not ours to trust. the graphical app browser opener opens
 * a browser the right way; this is the same shape.
 */
export const maybeOpenExternalUrl = (url: string): void => {
	const platform = process.platform;
	const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	// `start` is a cmd builtin rather than an executable, and its first
	// quoted argument is the window title, so the empty string is required.
	const args = platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.on("error", () => {
			// Best effort only: the URL is also printed for the operator.
		});
		child.unref();
	} catch {
		// Best effort only.
	}
};
