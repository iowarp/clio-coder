/**
 * Ids of every registered migration, in registry order. Kept free of imports so
 * home initialization can record them for a fresh home without loading the
 * migration bodies. `migrations/index.ts` refuses to load when its registry
 * drifts from this list.
 */
export const REGISTERED_MIGRATION_IDS: ReadonlyArray<string> = Object.freeze([
	"2026-09-01-settings-v2",
	"2026-09-01-retire-panes-knobs",
	"2026-10-06-playbooks-and-packages",
	"2026-10-07-acp-adapters",
	"2026-10-07-claude-subscription",
]);
