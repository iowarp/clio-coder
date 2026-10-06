import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { readStrictLayeredSettings } from "../core/settings-layers.js";
import { diffSettings, settingsChangeKind } from "../domains/config/classify.js";
import type { ConfigContract } from "../domains/config/contract.js";
import type { InstalledExtension } from "../domains/extensions/types.js";
import type { InstalledPlugin, PluginSnapshot } from "../domains/plugins/types.js";
import type { ReloadClassesController, ReloadReport } from "../session-control/reload-report.js";

type Inventory = Map<string, string>;

function leaves(value: unknown, prefix = "", result: Inventory = new Map()): Inventory {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, child] of Object.entries(value)) leaves(child, prefix ? `${prefix}.${key}` : key, result);
	} else result.set(prefix, JSON.stringify(value) ?? "undefined");
	return result;
}

function packages(entries: ReadonlyArray<InstalledExtension | InstalledPlugin>): Inventory {
	return new Map(
		entries.map((entry) => [
			`${entry.scope}:${entry.id}`,
			JSON.stringify({
				digest: entry.observedContentDigest ?? entry.provenance?.contentDigest,
				root: entry.rootPath,
				enabled: entry.enabled,
				loadable: entry.loadable,
			}),
		]),
	);
}

export function inventoryChanges(
	before: Inventory,
	after: Inventory,
): Record<"added" | "removed" | "modified" | "unchanged", string[]> {
	const result: ReturnType<typeof inventoryChanges> = { added: [], removed: [], modified: [], unchanged: [] };
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		const kind = !before.has(key)
			? "added"
			: !after.has(key)
				? "removed"
				: before.get(key) !== after.get(key)
					? "modified"
					: "unchanged";
		result[kind].push(key);
	}
	for (const values of Object.values(result)) values.sort();
	return result;
}

function summary(label: string, before: Inventory, after: Inventory): string[] {
	const changed = inventoryChanges(before, after);
	return [
		label,
		...Object.entries(changed).map(
			([kind, ids]) => `  ${kind}: ${ids.length}${kind === "unchanged" || ids.length === 0 ? "" : ` (${ids.join(", ")})`}`,
		),
	];
}

export interface ReloadClassesDeps {
	config: ConfigContract | undefined;
	bus: SafeEventBus;
	cwd(): string;
	library(): PluginSnapshot | undefined;
	reloadLibrary(): PluginSnapshot;
	extensions(): ReadonlyArray<InstalledExtension>;
}

/** Owns just one command's reporting scope; the existing reloads remain the writers. */
export function createReloadClasses(deps: ReloadClassesDeps): ReloadClassesController {
	let active = false;
	let issues: string[] = [];
	let configFailure: string | null = null;
	const bootSettings = deps.config ? structuredClone(deps.config.get()) : undefined;
	let reportedSettings = bootSettings;
	deps.bus.on(BusChannels.ConfigReloadFailed, ({ message }) => {
		configFailure = message;
	});
	return {
		get active() {
			return active;
		},
		captureIssue(message) {
			if (!active) return false;
			issues.push(message);
			return true;
		},
		async run(target, reloadOperators): Promise<ReloadReport> {
			if (active) return { failed: true, text: "Reload refused: another reload report is in progress." };
			active = true;
			issues = [];
			const lines = [`Reload report (${target})`];
			let failed = false;
			const failure = (label: string, error: unknown): void => {
				failed = true;
				lines.push(`${label}: failed — ${error instanceof Error ? error.message : String(error)}`);
			};
			try {
				if (target === "all" || target === "settings") {
					try {
						const config = deps.config;
						if (!config?.reload) throw new Error("settings domain is not available; restart to recover it");
						// Watchers may have applied the edit already. Compare to the last report,
						// while restart-bound differences remain pending against this boot.
						const before = reportedSettings ?? structuredClone(config.get());
						// The watcher intentionally swallows invalid files. Validate before invoking it,
						// and retain its namespace rejection for the report as well.
						readStrictLayeredSettings(deps.cwd());
						config.reload();
						if (configFailure) throw new Error(configFailure);
						const after = config.get();
						reportedSettings = structuredClone(after);
						lines.push(...summary("Settings", leaves(before), leaves(after)));
						const diff = diffSettings(before, after);
						const restart = inventoryChanges(leaves(bootSettings ?? before), leaves(after));
						const keys = [...restart.added, ...restart.removed, ...restart.modified];
						lines.push(
							`  restart required: ${keys.filter((key) => settingsChangeKind(key) === "restartRequired").join(", ") || "none"}`,
						);
						lines.push(`  next turn: ${diff.nextTurn.join(", ") || "none"}`);
						lines.push("  failed: none");
					} catch (error) {
						failure("Settings", error);
					}
				}
				if (target === "all" || target === "library") {
					const before = packages(deps.library()?.packages ?? []);
					try {
						const snapshot = deps.reloadLibrary();
						lines.push(...summary(`Library (generation ${snapshot.generation})`, before, packages(snapshot.packages)));
						for (const entry of snapshot.packages)
							for (const issue of entry.diagnostics) {
								if (issue.type === "error") failed = true;
								lines.push(`  ${issue.type}: ${entry.id}: ${issue.message}`);
							}
						lines.push("  restart required: none (skills, prompts, agents and playbooks reload here)");
						if (!snapshot.packages.some((entry) => entry.diagnostics.some((issue) => issue.type === "error")))
							lines.push("  failed: none");
					} catch (error) {
						failure("Library", error);
					}
				}
				if (target === "all" || target === "extensions") {
					const before = packages(deps.extensions());
					try {
						const result = await reloadOperators();
						lines.push(...summary("Extensions (operator runtimes and paired hooks)", before, packages(deps.extensions())));
						lines.push(`  ${result.status}: ${result.message}`);
						if (result.status === "rejected" || result.failures.length > 0) failed = true;
						for (const issue of new Set([...issues, ...result.failures])) lines.push(`  issue: ${issue}`);
						if (result.status !== "rejected" && result.failures.length === 0 && issues.length === 0)
							lines.push("  failed: none");
						lines.push(`  next session: ${result.nextSession.join("; ") || "none"}`);
						lines.push("  restart required: none for operator runtimes and hooks");
					} catch (error) {
						failure("Extensions", error);
					}
				}
				lines.push(
					"Restart-bound classes: core tool schemas, provider runtimes, runtime plugins, safety rule packs, config/session schemas and pane host are not reloaded by these commands.",
				);
				return { text: lines.join("\n"), failed };
			} finally {
				active = false;
			}
		},
	};
}
