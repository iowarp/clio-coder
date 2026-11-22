import { lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { withStateFileLock } from "../../../core/state-file-lock.js";
import type { Migration, MigrationReport } from "./index.js";

/**
 * Drops the checkout's version 1 writer set records (fleet M12). Version 1 persisted a duration and was aged by its
 * file's modification time; version 2 persists `expiresAt` like every other lease. A writer set lease is transient, so
 * a version 1 record is deleted instead of converted: at most one stale writer set is lost at upgrade, and the next
 * writer acquires a fresh version 2 lease. Version 2 records are left alone. Records this migration cannot read are left
 * in place and named; the writer set refuses them until they are removed.
 */
const WRITER_SET_DIR = "checkout-writer-leases";

const migration: Migration = {
	id: "2026-11-21-writer-set-lease-clock",
	async up(stateDir: string): Promise<MigrationReport> {
		const report: MigrationReport = { changed: [], attention: [] };
		const dir = join(stateDir, WRITER_SET_DIR);
		if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) return report;
		let deleted = 0;
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (!name.endsWith(".json") || lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) continue;
			try {
				// Under the record's own lock, so a live owner's beat never interleaves with the delete.
				const removed = await withStateFileLock(path, () => {
					const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
					const version =
						typeof value === "object" && value !== null && !Array.isArray(value)
							? (value as { version?: unknown }).version
							: undefined;
					if (version === 2) return false;
					if (version !== 1) throw new Error("not a writer set record this migration knows");
					unlinkSync(path);
					return true;
				});
				if (removed) deleted += 1;
			} catch (error) {
				report.attention.push(
					`${path} was left as it was (${error instanceof Error ? error.message : String(error)}); the writer set refuses it, so remove it once no CLIO Coder process writes in that checkout.`,
				);
			}
		}
		if (deleted > 0)
			report.changed.push(
				`Deleted ${deleted} version 1 writer set record(s); a writer set lease is transient, so the next writer in that checkout acquires a fresh one.`,
			);
		return report;
	},
};

export default migration;
