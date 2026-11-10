import { statfsSync } from "node:fs";
import path from "node:path";
import { storeRoot } from "../core/store-paths.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { attachClioCore, readStoreBackendSelection } from "../domains/store/selection.js";

function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Free space where the store root is or would be: the nearest existing ancestor answers, and nothing is created. */
function storeRootFinding(): DoctorFinding {
	const root = storeRoot();
	let probe = root;
	for (;;) {
		try {
			const stats = statfsSync(probe);
			const free = formatBytes(Number(stats.bavail) * Number(stats.bsize));
			return {
				ok: true,
				name: "store root",
				detail: probe === root ? `${root} (${free} free)` : `${root} (not created yet; ${free} free at ${probe})`,
			};
		} catch {
			const parent = path.dirname(probe);
			if (parent === probe) return { ok: true, level: "info", name: "store root", detail: `${root} (free space unknown)` };
			probe = parent;
		}
	}
}

/**
 * The store section: which backend is in use, the store root and its free
 * space, and for clio-core the probe rows. The probe never starts the daemon.
 */
export async function storeFindings(): Promise<DoctorFinding[]> {
	const selection = readStoreBackendSelection();
	const backend = selection.record?.backend ?? "local";
	const findings: DoctorFinding[] = [
		selection.problem !== null
			? { ok: false, level: "warn", name: "store backend", detail: selection.problem }
			: {
					ok: true,
					name: "store backend",
					detail: selection.record === null ? "local (no selection; the default)" : `${backend} (${selection.path})`,
				},
		storeRootFinding(),
	];
	if (selection.record?.backend !== "clio-core") return findings;
	const attach = await attachClioCore(selection.record, { checkWheel: true, startDaemon: false });
	await attach.host?.close();
	for (const row of attach.rows) {
		findings.push({
			ok: row.ok,
			name: `store ${row.name}`,
			detail: row.detail,
			...(row.ok ? (row.info ? { level: "info" as const } : {}) : { level: "error" as const }),
		});
	}
	return findings;
}
