import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveClioDirs } from "../core/xdg.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";

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

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = -1;
	do {
		value /= 1024;
		unit += 1;
	} while (value >= 1024 && unit < units.length - 1);
	return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}
