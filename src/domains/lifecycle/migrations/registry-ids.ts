import { join } from "node:path";
import { resolveClioDirs } from "../../../core/xdg.js";

/**
 * Ids of every registered migration, in registry order, and where the record of
 * them lives. Kept free of migration bodies so home initialization can record
 * them for a fresh home without loading those. `migrations/index.ts` refuses to
 * load when its registry drifts from this list.
 */
export const REGISTERED_MIGRATION_IDS: ReadonlyArray<string> = Object.freeze([
	"2026-09-01-settings-v2",
	"2026-09-01-retire-panes-knobs",
	"2026-10-06-playbooks-and-packages",
	"2026-10-07-acp-adapters",
	"2026-10-07-claude-subscription",
	"2026-10-20-fleet-permissions-judge",
	"2026-10-31-remove-old-telemetry",
	"2026-11-02-approvals-to-config",
]);

const MIGRATION_MANIFEST_FILE = "migrations.json";

/**
 * The manifest sits in the config root because it vouches for the shape of the
 * settings there. In the state root, `reset --state` and `uninstall --keep-config`
 * deleted it and left a current settings.yaml reporting every migration pending.
 */
export function migrationManifestPath(): string {
	return join(resolveClioDirs().config, MIGRATION_MANIFEST_FILE);
}

/** Before 0.6.8 the manifest lived in the state root; `runPending` moves it once. */
export function legacyMigrationManifestPath(stateDir: string): string {
	return join(stateDir, MIGRATION_MANIFEST_FILE);
}
