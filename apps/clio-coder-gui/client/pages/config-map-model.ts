// The Effective Clio Map, in the order the operator reads it: four figures, then the path from a
// source through a loaded layer to the moment it changes behavior, then the inventory itself. Pure,
// so the ordering, the counting and every sentence are testable without a browser.

import type { ConfigGraph, SettingRow, SettingsReport } from "../../contracts/settings.js";
import { humanizeKey } from "../design/facts-model.js";

type Entry = ConfigGraph["entries"][number];
type Category = Entry["category"];
type ReloadClass = Entry["reloadClass"];

/** Display order. A category the graph reports and this table lacks is a type error, not a blank. */
export const CATEGORY_PRESENTATION: Record<Category, { short: string; label: string; description: string }> = {
	settings: { short: "SET", label: "Settings", description: "Layered values that shape Clio Coder's behavior." },
	"clio-md": {
		short: "CTX",
		label: "Project context",
		description: "CLIO-CODER.md context Clio Coder can add to the next turn.",
	},
	rule: { short: "RUL", label: "Rules", description: "Project rules and conditional context boundaries." },
	"operator-profile": {
		short: "OPR",
		label: "Operator profile",
		description: "Declared operator preferences added to context.",
	},
	hook: { short: "HOK", label: "Hooks", description: "Middleware reactions loaded by Clio Coder." },
	extension: { short: "EXT", label: "Extensions", description: "Installed packages and their effective precedence." },
	"skill-root": { short: "SKL", label: "Skill roots", description: "Locations Clio Coder searches for skills." },
	"prompt-root": {
		short: "PMT",
		label: "Prompt roots",
		description: "Locations Clio Coder searches for saved prompts.",
	},
	"agent-root": { short: "AGT", label: "Agent roots", description: "Agent recipe sources visible to this project." },
	"fleet-root": { short: "FLT", label: "Fleet roots", description: "Locations Clio Coder searches for saved fleets." },
	safety: { short: "SAFE", label: "Safety", description: "Effective working-freedom and safety facts." },
	memory: { short: "MEM", label: "Memory", description: "The durable memory surface Clio Coder can consult." },
};
export const CATEGORY_ORDER = Object.keys(CATEGORY_PRESENTATION) as Category[];

export const RELOAD_PRESENTATION: Record<ReloadClass, { label: string; description: string }> = {
	hot: { label: "Now", description: "Clio Coder reports this surface as hot-reloadable." },
	"next-turn": { label: "Next turn", description: "Clio Coder reads this surface when the next turn begins." },
	reload: { label: "On reload", description: "A reload inside the conversation picks this up." },
	restart: { label: "Restart", description: "A new Clio Coder process is required before this changes." },
	"n/a": { label: "Informational", description: "No apply timing is attached to this entry." },
};

export const SETTING_SOURCE_LABELS: Record<SettingRow["source"], string> = {
	"built-in": "Built in",
	user: "User",
	project: "Project",
	"project.local": "Project local",
	cli: "Command line",
};

export interface MapFigure {
	label: string;
	value: string;
	note: string;
}
export interface MapCount {
	label: string;
	count: number;
}
export interface MapLayer extends MapCount {
	category: Category;
	short: string;
	description: string;
	entries: Entry[];
}
export interface MapTiming extends MapCount {
	description: string;
}
export interface ConfigMapView {
	figures: MapFigure[];
	sources: MapCount[];
	/** How many distinct sources were left out of the top eight. Zero when all are shown. */
	sourcesOmitted: number;
	layers: MapLayer[];
	timing: MapTiming[];
}

const count = (value: number) => value.toLocaleString("en-US");

/** A scope is a wire word (`user`, `project`, `package`). It reads as a label, never as an enum. */
export function scopeLabel(scope: string): string {
	// The graph spells the built-in scope as one word and the settings layers spell it as two. They
	// are one source, so they count as one.
	return scope === "builtin" || scope === "built-in" ? SETTING_SOURCE_LABELS["built-in"] : humanizeKey(scope);
}

/** Where an entry came from: its path, the project root, or the scope alone when no path crossed. */
export function entrySource(entry: Pick<Entry, "scope" | "sourcePath">): string {
	if (entry.sourcePath === undefined) return `${entry.scope} scope`;
	return entry.sourcePath === "/" ? "project root" : entry.sourcePath;
}

/**
 * `settings` is null while the effective values have not arrived. The figure then says so, because
 * a settings report that has not been read is not a report with no settings in it.
 */
export function configMap(graph: ConfigGraph, settings: SettingsReport | null): ConfigMapView {
	const layers: MapLayer[] = CATEGORY_ORDER.map((category) => {
		const entries = graph.entries.filter((entry) => entry.category === category);
		return { category, ...CATEGORY_PRESENTATION[category], count: entries.length, entries };
	}).filter((layer) => layer.count > 0);

	const sourceCounts = new Map<string, number>();
	const bump = (label: string) => sourceCounts.set(label, (sourceCounts.get(label) ?? 0) + 1);
	for (const row of settings?.rows ?? []) bump(SETTING_SOURCE_LABELS[row.source]);
	for (const entry of graph.entries) bump(scopeLabel(entry.scope));
	const sources = [...sourceCounts]
		.map(([label, total]) => ({ label, count: total }))
		.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "en-US"));

	const timing = (Object.keys(RELOAD_PRESENTATION) as ReloadClass[])
		.map((reloadClass) => ({
			...RELOAD_PRESENTATION[reloadClass],
			count: graph.entries.filter((entry) => entry.reloadClass === reloadClass).length,
		}))
		.filter((row) => row.count > 0);

	const costed = graph.entries.filter((entry) => entry.contextCostTokens !== undefined);
	const contextTokens = costed.reduce((total, entry) => total + (entry.contextCostTokens ?? 0), 0);
	const issues = graph.issues.reduce((total, issue) => total + issue.count, 0);
	const restarts = graph.entries.filter((entry) => entry.reloadClass === "restart").length;

	return {
		figures: [
			settings
				? { label: "Effective setting facts", value: count(settings.rows.length), note: "reported in this snapshot" }
				: { label: "Effective setting facts", value: "—", note: "the effective values have not been read yet" },
			{
				label: "Customization surfaces",
				value: count(graph.entries.length),
				note: `${layers.length} represented ${layers.length === 1 ? "category" : "categories"}`,
			},
			{
				label: "Estimated context cost",
				// No costed entry is a different fact from costed entries that sum to zero.
				value: costed.length === 0 ? "—" : `~${count(contextTokens)}`,
				note:
					costed.length === 0
						? "no surface reported a cost"
						: `tokens across ${count(costed.length)} costed ${costed.length === 1 ? "entry" : "entries"}`,
			},
			{
				label: "Needs a restart",
				value: count(restarts),
				note:
					issues === 0 ? "no reported inspection issues" : `${count(issues)} reported ${issues === 1 ? "issue" : "issues"}`,
			},
		],
		sources: sources.slice(0, 8),
		sourcesOmitted: Math.max(0, sources.length - 8),
		layers,
		timing,
	};
}

export interface SettingFamily {
	family: string;
	rows: SettingRow[];
}

/** `chat.model` and `chat[0]` both belong to `chat`. */
export const settingFamily = (key: string): string => key.split(/[.[]/u, 1)[0] ?? key;

/** Families alphabetical, rows in wire order. The filter folds case and matches the exact key. */
export function settingFamilies(rows: ReadonlyArray<SettingRow>, filter = ""): SettingFamily[] {
	const needle = filter.trim().toLocaleLowerCase("en-US");
	const families = new Map<string, SettingRow[]>();
	for (const row of rows) {
		if (needle && !row.key.toLocaleLowerCase("en-US").includes(needle)) continue;
		const family = settingFamily(row.key);
		families.set(family, [...(families.get(family) ?? []), row]);
	}
	return [...families]
		.map(([family, members]) => ({ family, rows: members }))
		.sort((left, right) => left.family.localeCompare(right.family, "en-US"));
}

/**
 * An effective value in words. Strings, numbers and booleans are exact configuration and stay as
 * written; only the shapes that would otherwise print as JSON punctuation get a name.
 */
export function settingValue(row: SettingRow): string {
	if (row.value === null) return "Not set";
	if (row.value === "") return "Empty";
	if (typeof row.value === "object") return Array.isArray(row.value) ? "Empty list" : "Empty map";
	return String(row.value);
}
