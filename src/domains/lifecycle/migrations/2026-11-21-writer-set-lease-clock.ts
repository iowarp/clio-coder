import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { withStateFileLock } from "../../../core/state-file-lock.js";
import type { Migration, MigrationReport } from "./index.js";

/**
 * Moves the checkout's writer set records onto the lease clock rule (fleet M12). A version 1 record persisted a
 * duration, `heartbeatExpiresMs`, and was aged by its file's modification time; version 2 persists `expiresAt` like
 * every other lease, judged on the reader's wall clock with the skew tolerance. Each version 1 record keeps the life
 * it had: it expires at its last write plus its old duration. Records this migration cannot read are left in place and
 * named; the writer set refuses them until they are removed.
 */
const WRITER_SET_DIR = "checkout-writer-leases";

interface WriterSetRecordV1 {
	version: 1;
	checkout: string;
	host: string;
	pid: number;
	processBirthToken: string;
	acquiredAt: string;
	heartbeatAt: string;
	heartbeatExpiresMs: number;
}

function isV1(value: unknown): value is WriterSetRecordV1 {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<WriterSetRecordV1>;
	return (
		record.version === 1 &&
		typeof record.checkout === "string" &&
		typeof record.host === "string" &&
		Number.isSafeInteger(record.pid) &&
		typeof record.processBirthToken === "string" &&
		typeof record.acquiredAt === "string" &&
		Number.isFinite(Date.parse(record.acquiredAt)) &&
		typeof record.heartbeatAt === "string" &&
		Number.isFinite(Date.parse(record.heartbeatAt)) &&
		Number.isSafeInteger(record.heartbeatExpiresMs) &&
		(record.heartbeatExpiresMs ?? 0) > 0
	);
}

const migration: Migration = {
	id: "2026-11-21-writer-set-lease-clock",
	async up(stateDir: string): Promise<MigrationReport> {
		const report: MigrationReport = { changed: [], attention: [] };
		const dir = join(stateDir, WRITER_SET_DIR);
		if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) return report;
		let moved = 0;
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (!name.endsWith(".json") || lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) continue;
			try {
				// Under the record's own lock, so a live owner's beat never interleaves with the rewrite.
				const changed = await withStateFileLock(path, () => {
					const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
					if (typeof value === "object" && value !== null && (value as { version?: unknown }).version === 2) return false;
					if (!isV1(value)) throw new Error("not a writer set record this migration knows");
					const { heartbeatExpiresMs, ...rest } = value;
					const expiresAt = new Date(statSync(path).mtimeMs + heartbeatExpiresMs).toISOString();
					safeResourceWrite(path, JSON.stringify({ ...rest, version: 2, expiresAt }, null, 2));
					return true;
				});
				if (changed) moved += 1;
			} catch (error) {
				report.attention.push(
					`${path} was left as it was (${error instanceof Error ? error.message : String(error)}); the writer set refuses it, so remove it once no CLIO Coder process writes in that checkout.`,
				);
			}
		}
		if (moved > 0)
			report.changed.push(
				`Moved ${moved} writer set record(s) to the lease clock rule: each now persists its expiry instead of a duration.`,
			);
		return report;
	},
};

export default migration;
