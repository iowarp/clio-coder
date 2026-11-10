import { spawn } from "node:child_process";
import { isOpenableUrl, windowsUrlOpener } from "../core/open-browser.js";

/**
 * Provider runtimes supply OAuth authorize, device-code, and management-console
 * links, so the string is not ours to trust: only https: or loopback http:
 * opens, and Windows never goes through cmd.exe (R1-safety-secrets-07).
 */
export const maybeOpenExternalUrl = (url: string): void => {
	if (!isOpenableUrl(url)) return;
	const platform = process.platform;
	const opener: [string, string[]] | null =
		platform === "darwin" ? ["open", [url]] : platform === "win32" ? windowsUrlOpener(url) : ["xdg-open", [url]];
	if (!opener) return;
	try {
		const child = spawn(opener[0], opener[1], { stdio: "ignore", detached: true });
		child.on("error", () => {
			// Best effort only: the URL is also printed for the operator.
		});
		child.unref();
	} catch {
		// Best effort only.
	}
};
