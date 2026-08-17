import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeClioHome } from "../../core/init.js";
import { clioStatePath } from "../../core/xdg.js";

export interface StateInfo {
	version: string;
	/** Absent when this record was rebuilt over a state root whose install time was gone. */
	installedAt?: string;
	upgradedAt?: string;
	/** When the record itself was rebuilt. Never the same claim as an install. */
	repairedAt?: string;
	/** The version on record before the most recent version change. */
	upgradedFrom?: string;
	/** The version whose upgrade notice has already been shown once. */
	noticedVersion?: string;
	platform: string;
	nodeVersion: string;
}

export interface UpgradeTransition {
	from: string;
	to: string;
}

export interface StateInfoRead {
	info: StateInfo | null;
	/**
	 * Why the metadata could not be read, or null when it is absent or fine.
	 * Absent and unreadable are different problems with different remedies, and
	 * collapsing both to null had `clio-coder doctor` report "state metadata missing"
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

/**
 * The version transition the operator has not been told about yet, or null.
 * `initializeClioHome` refreshes `install.json` silently on every boot, so by
 * the time anything can speak the record already says the current version;
 * `upgradedFrom` is what remembers where it came from. Claiming the notice
 * stamps `noticedVersion`, so it is shown once per version and never again.
 * A record without an `upgradedFrom`, or one already noticed, yields null and
 * writes nothing.
 */
export function takeUpgradeNotice(): UpgradeTransition | null {
	const path = join(clioStatePath(), "install.json");
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		raw = parsed as Record<string, unknown>;
	} catch {
		return null;
	}
	const { version, upgradedFrom, noticedVersion } = raw;
	if (typeof version !== "string" || typeof upgradedFrom !== "string") return null;
	if (upgradedFrom === version || noticedVersion === version) return null;
	try {
		writeFileSync(path, `${JSON.stringify({ ...raw, noticedVersion: version }, null, 2)}\n`, "utf8");
	} catch {
		// A record that cannot be rewritten still gets its notice; it will repeat
		// on the next boot, which is the lesser wrong against staying silent.
	}
	return { from: upgradedFrom, to: version };
}
