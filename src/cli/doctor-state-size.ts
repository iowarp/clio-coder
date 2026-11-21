import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readSettings } from "../core/config.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import {
	measureSandboxCache,
	pruneSandboxCache,
	type SandboxCachePruneResult,
	sandboxCacheCapBytes,
	sandboxCacheDir,
} from "../core/sandbox/sandbox-cache.js";
import { resolveClioDirs } from "../core/xdg.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { inactiveInstallerRecord, inspectInstallation } from "../domains/lifecycle/install-method.js";
import { formatBytes } from "./lifecycle-presenter.js";

interface MeasuredEntry {
	bytes: number;
	error: string | null;
}

/** Report aggregate state usage and the largest top-level contributor. */
export function stateStorageFinding(stateDir = resolveClioDirs().state): DoctorFinding {
	let names: string[];
	try {
		names = readdirSync(stateDir);
	} catch (error) {
		// A fresh home has no state root until the first session writes one; that is
		// empty, not broken, and the home storage row already says "nothing yet".
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ok: true, name: "state storage", detail: `${stateDir} not created yet` };
		}
		return {
			ok: false,
			name: "state storage",
			detail: `${stateDir} could not be measured: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	let total = 0;
	let largest: { name: string; bytes: number } | null = null;
	for (const name of names.sort()) {
		const measured = measureEntry(join(stateDir, name));
		if (measured.error !== null) {
			return { ok: false, name: "state storage", detail: measured.error };
		}
		total += measured.bytes;
		if (largest === null || measured.bytes > largest.bytes) largest = { name, bytes: measured.bytes };
	}

	return {
		ok: true,
		name: "state storage",
		detail:
			largest === null
				? `${formatBytes(total)} (${total.toLocaleString("en-US")} bytes); largest contributor none`
				: `${formatBytes(total)} (${total.toLocaleString("en-US")} bytes); largest contributor ${largest.name} at ${formatBytes(largest.bytes)} (${largest.bytes.toLocaleString("en-US")} bytes)`,
	};
}

/**
 * The other three roots, in one row. State has its own because it is the one that
 * grows with use, but on a real home the cache and the data root are far larger.
 */
export function homeStorageFinding(dirs = resolveClioDirs()): DoctorFinding {
	const parts: string[] = [];
	for (const role of ["config", "data", "cache"] as const) {
		if (!existsSync(dirs[role])) continue;
		const measured = measureEntry(dirs[role]);
		if (measured.error !== null) return { ok: false, name: "home storage", detail: measured.error };
		parts.push(`${role} ${formatBytes(measured.bytes)}`);
	}
	return { ok: true, name: "home storage", detail: parts.join(", ") || "nothing yet" };
}

/** The installer root, which sits outside the four roots and is usually the largest thing Clio owns. */
export function installRootFinding(installation = inspectInstallation()): DoctorFinding | null {
	const root = installation.installer?.root ?? inactiveInstallerRecord(installation)?.root;
	if (root === undefined) return null;
	const measured = measureEntry(root);
	if (measured.error !== null) return { ok: false, name: "install root", detail: measured.error };
	const size = `${formatBytes(measured.bytes)} at ${root}`;
	if (installation.installer) return { ok: true, name: "install root", detail: size };
	return {
		ok: true,
		level: "warn",
		name: "install root",
		detail: `${size}; this binary does not run from it, so nothing updates or prunes it. \`clio-coder uninstall --inactive\` removes only it`,
	};
}

export interface SandboxCacheFindingOptions {
	/** `doctor --fix`: prune to the cap now, whatever day it is. */
	fix?: boolean;
	/** `safety.sandboxCacheMaxGiB`; read from settings when absent. */
	capGiB?: number;
	cacheDir?: string;
}

function configuredCapGiB(): number {
	try {
		return readSettings().safety.sandboxCacheMaxGiB;
	} catch {
		// The settings row reports an unreadable file; the default cap still describes what startup prunes to.
		return DEFAULT_SETTINGS.safety.sandboxCacheMaxGiB;
	}
}

function pruneOutcome(result: SandboxCachePruneResult): string {
	const failed = result.failed.length > 0 ? `; could not remove ${result.failed.map((f) => f.name).join(", ")}` : "";
	switch (result.skipped) {
		case "in-use":
			return `; not pruned: ${result.liveLeases} running ${result.liveLeases === 1 ? "process" : "processes"} may use it, rerun doctor --fix after they exit${failed}`;
		case "leases-unreadable":
			return `; not pruned: its leases under sandbox-cache-leases could not be read${failed}`;
		case "busy":
			return `; not pruned: another process is pruning it${failed}`;
		case "stopped":
		case null:
			break;
	}
	if (result.removed.length === 0) return failed;
	const freed = result.removed.reduce((sum, entry) => sum + entry.bytes, 0);
	return `; pruned ${result.removed.map((entry) => entry.name).join(", ")} (${formatBytes(freed)})${failed}`;
}

/**
 * The sandbox cache against `safety.sandboxCacheMaxGiB`: a warning when it is over, and under `--fix` a prune of the
 * least recently used tool directories, which skips while a running process holds a lease on the cache.
 */
export async function sandboxCacheFinding(options: SandboxCacheFindingOptions = {}): Promise<DoctorFinding> {
	const cacheDir = options.cacheDir ?? sandboxCacheDir();
	const capGiB = options.capGiB ?? configuredCapGiB();
	const capBytes = sandboxCacheCapBytes(capGiB);
	const name = "sandbox cache";
	let bytes: number;
	let outcome = "";
	try {
		if (options.fix === true && capBytes > 0) {
			const result = await pruneSandboxCache({ capBytes, cacheDir });
			if (!result.exists) return { ok: true, name, detail: `${cacheDir} not created yet` };
			// A live lease stops the prune before it walks the tree; doctor runs on demand, so it measures for the row.
			bytes = result.afterBytes ?? (await measureSandboxCache(cacheDir))?.bytes ?? 0;
			outcome = pruneOutcome(result);
		} else {
			const measured = await measureSandboxCache(cacheDir);
			if (measured === null) return { ok: true, name, detail: `${cacheDir} not created yet` };
			bytes = measured.bytes;
		}
	} catch (error) {
		return {
			ok: false,
			name,
			detail: `${cacheDir} could not be measured: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (capBytes === 0)
		return { ok: true, name, detail: `${formatBytes(bytes)} at ${cacheDir}; no cap (safety.sandboxCacheMaxGiB is 0)` };
	const size = `${formatBytes(bytes)} of the ${capGiB} GiB cap at ${cacheDir}`;
	if (bytes <= capBytes) return { ok: true, name, detail: `${size}${outcome}` };
	return {
		ok: true,
		level: "warn",
		name,
		detail: `${size}, over the cap${outcome || "; doctor --fix removes the least recently used tool directories until it fits, and startup does once a day"}`,
	};
}

function measureEntry(path: string): MeasuredEntry {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(path);
	} catch (error) {
		return {
			bytes: 0,
			error: `${path} could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!stats.isDirectory() || stats.isSymbolicLink()) return { bytes: stats.size, error: null };

	let names: string[];
	try {
		names = readdirSync(path);
	} catch (error) {
		return { bytes: 0, error: `${path} could not be listed: ${error instanceof Error ? error.message : String(error)}` };
	}
	let bytes = 0;
	for (const name of names) {
		const child = measureEntry(join(path, name));
		if (child.error !== null) return child;
		bytes += child.bytes;
	}
	return { bytes, error: null };
}
