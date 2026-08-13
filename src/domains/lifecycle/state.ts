import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initializeClioHome } from "../../core/init.js";
import { clioStatePath } from "../../core/xdg.js";

export interface StateInfo {
	version: string;
	installedAt: string;
	upgradedAt?: string;
	platform: string;
	nodeVersion: string;
}

export interface StateInfoRead {
	info: StateInfo | null;
	/**
	 * Why the metadata could not be read, or null when it is absent or fine.
	 * Absent and unreadable are different problems with different remedies, and
	 * collapsing both to null had `clio doctor` report "state metadata missing"
	 * for an install.json that was present and merely mode 000, then send the
	 * user to a `--fix` that dies on EACCES.
	 */
	problem: string | null;
}

export function readStateInfoResult(): StateInfoRead {
	const path = join(clioStatePath(), "install.json");
	try {
		return { info: JSON.parse(readFileSync(path, "utf8")) as StateInfo, problem: null };
	} catch (error) {
		// `existsSync` cannot carry this distinction: it answers false for a
		// genuinely absent file and for one sitting behind a directory the process
		// may not traverse. Only ENOENT means the metadata was never written.
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
		if (code === "ENOENT") return { info: null, problem: null };
		const message = error instanceof Error ? error.message : String(error);
		return { info: null, problem: `${path} could not be read: ${message}` };
	}
}

export function readStateInfo(): StateInfo | null {
	return readStateInfoResult().info;
}

export function ensureClioState(): StateInfo {
	initializeClioHome();
	const info = readStateInfo();
	if (!info) throw new Error("state metadata was not written by initializeClioHome()");
	return info;
}
