import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
