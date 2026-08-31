/**
 * The Settings Center's section table.
 *
 * It sits in its own module rather than inside `settings.ts` because the slash
 * registry parses `/settings <section>` and every `/targets`-style deep link
 * against it, and the registry has to stay off the render module graph. Pulling
 * the whole settings overlay in for eleven ids made `src/cli/run.ts` a second,
 * disjoint reacher of the interactive theme and `src/engine/tui.ts`, which
 * splits the merged chunk the Stage 0 instant shell depends on. See
 * `tests/contracts/instant-shell-import-graph.test.ts`.
 *
 * Pure data: no imports, no rendering, no settings I/O. `settings.ts` re-exports
 * both symbols, so every existing importer keeps the path it had.
 */

export const SETTINGS_SECTIONS = [
	{ id: "safety", label: "Autonomy & Safety", group: "CORE" },
	{ id: "orchestrator", label: "Orchestrator", group: "CORE" },
	{ id: "fleet", label: "Fleet", group: "ROUTING" },
	{ id: "targets", label: "Targets", group: "ROUTING" },
	{ id: "models", label: "Models", group: "ROUTING" },
	{ id: "budget", label: "Budget", group: "RUNTIME" },
	{ id: "compaction", label: "Compaction", group: "RUNTIME" },
	{ id: "retry", label: "Retry", group: "RUNTIME" },
	{ id: "terminal", label: "Terminal", group: "EXPERIENCE" },
	{ id: "watchdog", label: "Watchdog", group: "EXPERIENCE" },
	{ id: "advanced", label: "Advanced", group: "EXPERIENCE" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
