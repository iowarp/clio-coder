import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Migration, MigrationReport } from "./index.js";

/**
 * Removes the fleet workspace lock directory 0.8.4 wrote. A fleet run now holds the checkout's writer set
 * (`checkout-writer-leases/`) like every other writer, so nothing reads `fleet-locks/`. Only regular `.json` files are
 * removed, then the directory once it is empty; anything else is left in place and reported.
 */
const FLEET_LOCKS_DIR = "fleet-locks";

const migration: Migration = {
	id: "2026-11-21-retire-fleet-locks",
	async up(stateDir: string): Promise<MigrationReport> {
		const report: MigrationReport = { changed: [], attention: [] };
		const dir = join(stateDir, FLEET_LOCKS_DIR);
		const stat = lstatSync(dir, { throwIfNoEntry: false });
		if (stat === undefined) return report;
		if (!stat.isDirectory()) {
			report.attention.push(`${dir} is not a directory, so it was left in place; Clio no longer reads it.`);
			return report;
		}
		let removed = 0;
		const kept: string[] = [];
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const entry = lstatSync(path, { throwIfNoEntry: false });
			if (entry === undefined) continue;
			if (!entry.isFile() || !name.endsWith(".json")) {
				kept.push(name);
				continue;
			}
			try {
				unlinkSync(path);
				removed += 1;
			} catch (error) {
				// The records are inert, so a failed removal is reported and never stops the upgrade.
				report.attention.push(
					`${path} could not be removed (${error instanceof Error ? error.message : String(error)}); Clio no longer reads it, so it can be deleted by hand.`,
				);
				kept.push(name);
			}
		}
		if (kept.length === 0) {
			try {
				rmdirSync(dir);
			} catch (error) {
				report.attention.push(
					`${dir} could not be removed (${error instanceof Error ? error.message : String(error)}); Clio no longer reads it.`,
				);
			}
		} else {
			report.attention.push(`${dir} still holds ${kept.join(", ")}, so it was left in place; Clio no longer reads it.`);
		}
		report.changed.push(
			`Retired the fleet workspace locks (${removed} record(s) removed); a fleet run now joins the checkout's writer set.`,
		);
		return report;
	},
};

export default migration;
