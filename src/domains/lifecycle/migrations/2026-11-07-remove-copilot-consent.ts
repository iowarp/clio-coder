import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Migration, MigrationReport } from "./index.js";

/**
 * Removes the per-account Copilot consent record 0.7.0-rc.1 wrote. Signing in with `copilot login` is now the
 * authorization, so nothing reads the file. Only a regular file is removed; a symlink or any other entry under
 * that name is left in place and reported.
 */
const CONSENT_FILE = "copilot-sdk-consent.json";

const migration: Migration = {
	id: "2026-11-07-remove-copilot-consent",
	async up(stateDir: string): Promise<MigrationReport> {
		const report: MigrationReport = { changed: [], attention: [] };
		const path = join(stateDir, CONSENT_FILE);
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (stat === undefined) return report;
		if (!stat.isFile()) {
			report.attention.push(`${path} is not a regular file, so it was left in place; Clio no longer reads it.`);
			return report;
		}
		try {
			unlinkSync(path);
		} catch (error) {
			// The file is inert, so a failed removal is reported and never stops the upgrade.
			report.attention.push(
				`${path} could not be removed (${error instanceof Error ? error.message : String(error)}); Clio no longer reads it, so it can be deleted by hand.`,
			);
			return report;
		}
		report.changed.push(
			"Removed the GitHub Copilot consent record; signing in with `copilot login` is the authorization.",
		);
		return report;
	},
};

export default migration;
