import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { upgradeLegacyExtensionInstallState } from "../../extensions/state.js";
import type { Migration } from "./index.js";

export const EXTENSION_INSTALL_DIGESTS_MIGRATION_ID = "2026-09-01-extension-install-digests";

function migrateExtensionInstallDigests(stateDir: string, cwd = process.cwd()): void {
	const scopes = upgradeLegacyExtensionInstallState(cwd);
	const reportDir = join(stateDir, "migration-reports");
	mkdirSync(reportDir, { recursive: true });
	safeResourceWrite(
		join(reportDir, `${EXTENSION_INSTALL_DIGESTS_MIGRATION_ID}.json`),
		`${JSON.stringify({ migration: EXTENSION_INSTALL_DIGESTS_MIGRATION_ID, scopes }, null, 2)}\n`,
		{ encoding: "utf8", mode: 0o644 },
	);
}

const migration: Migration = {
	id: EXTENSION_INSTALL_DIGESTS_MIGRATION_ID,
	async up(stateDir: string): Promise<void> {
		migrateExtensionInstallDigests(stateDir);
	},
};

export default migration;
