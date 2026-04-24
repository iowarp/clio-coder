import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initializeClioHome } from "../../core/init.js";
import { clioDataPath } from "../../core/xdg.js";

export interface StateInfo {
	version: string;
	installedAt: string;
	platform: string;
	nodeVersion: string;
}

export function readStateInfo(): StateInfo | null {
	const path = join(clioDataPath(), "install.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as StateInfo;
	} catch {
		return null;
	}
}

export function ensureClioState(): StateInfo {
	initializeClioHome();
	const info = readStateInfo();
	if (!info) throw new Error("state metadata was not written by initializeClioHome()");
	return info;
}
