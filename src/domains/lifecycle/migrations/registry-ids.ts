import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir, resolveClioDirs } from "../../../core/xdg.js";

/**
 * Ids of every registered migration, in registry order, and where the record of
 * them lives. Kept free of migration bodies so home initialization can record
 * them for a fresh home without loading those. `migrations/index.ts` refuses to
 * load when its registry drifts from this list.
 */
export const REGISTERED_MIGRATION_IDS: ReadonlyArray<string> = Object.freeze([
	"2026-11-21-retired-settings",
	"2026-11-21-fleet-role-names",
	"2026-11-21-run-role-populations",
	"2026-10-06-playbooks-and-packages",
	"2026-10-07-acp-adapters",
	"2026-10-07-claude-subscription",
	"2026-10-20-fleet-permissions-judge",
	"2026-10-31-remove-old-telemetry",
	"2026-11-02-approvals-to-config",
	"2026-11-07-remove-copilot-consent",
	"2026-11-21-retire-fleet-locks",
	"2026-11-21-writer-set-lease-clock",
]);

/**
 * Ids an earlier release registered and a later one removed. Manifests keep
 * them forever, so they are known ids, not evidence of a newer Clio.
 */
export const RETIRED_MIGRATION_IDS: ReadonlyArray<string> = Object.freeze([
	"2026-04-17-initial",
	"2026-06-11-compaction-single-threshold",
	"2026-08-18-lmstudio-runtime-id",
	"2026-09-01-clio-coder-naming",
	"2026-09-01-extension-install-digests",
	"2026-09-01-retire-panes-knobs",
	"2026-09-01-settings-v2",
	"2026-09-18-ollama-runtime-id",
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

/**
 * The one command that applies pending migrations, named by every surface that
 * advises one. It runs them with the active binary on a checkout and on every
 * installed build. Bare `clio-coder upgrade` is not it: on a package-manager
 * install it refuses without migrating, and on an npm or installer build it
 * first installs any newer release (M-34).
 */
export const APPLY_MIGRATIONS_COMMAND = "clio-coder upgrade --post-install";

/**
 * What to tell an operator whose settings.yaml fails on a key or value the
 * unrecorded `2026-11-21-retired-settings` migration rewrites:
 * {@link APPLY_MIGRATIONS_COMMAND} applies it. The caller decides whether an issue is one; no other
 * migration repairs a validation failure, so none is advised for one. A home
 * upgraded by a package manager, or a settings file provisioned with no
 * manifest, reaches the strict reader without that run. This only names the
 * command; nothing is read in the migration's place. Null when nothing is
 * pending or the manifest cannot be read (the upgrade refuses that one by name).
 */
export function pendingMigrationAdvice(): string | null {
	let applied: unknown = [];
	for (const path of [migrationManifestPath(), legacyMigrationManifestPath(clioStateDir())]) {
		if (!existsSync(path)) continue;
		try {
			applied = (JSON.parse(readFileSync(path, "utf8")) as { applied?: unknown } | null)?.applied;
		} catch {
			return null;
		}
		break;
	}
	if (!Array.isArray(applied)) return null;
	const recorded = new Set(applied);
	const pending = REGISTERED_MIGRATION_IDS.filter((id) => !recorded.has(id));
	if (!pending.includes("2026-11-21-retired-settings")) return null;
	return `run \`${APPLY_MIGRATIONS_COMMAND}\`: its pending migration 2026-11-21-retired-settings rewrites retired keys and old value spellings`;
}
