import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initializeClioHome } from "../../core/init.js";
import { clioDataDir } from "../../core/xdg.js";

export interface InstallInfo {
	version: string;
	installedAt: string;
	platform: string;
	nodeVersion: string;
}

export function readInstallInfo(): InstallInfo | null {
	const path = join(clioDataDir(), "install.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as InstallInfo;
	} catch {
		return null;
	}
}

export function ensureInstalled(): InstallInfo {
	initializeClioHome();
	const info = readInstallInfo();
	if (!info) throw new Error("install metadata was not written by initializeClioHome()");
	return info;
}
