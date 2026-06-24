/**
 * The effective-customization graph behind `clio config inspect`. This is the
 * "why is Clio behaving this way" surface: it answers what settings, context
 * files, rules, skills, prompts, agents, extensions, safety, memory, hooks, and
 * the operator profile loaded, from where, with what precedence, and what each
 * costs in context.
 *
 * Every surface is read through its own loader, best-effort: a surface that
 * fails to load contributes an issue rather than aborting the inspection. The
 * graph uses one shared source-attribution model ({@link CustomizationEntry}) so
 * everything reports the same columns.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClioSettings } from "../core/config.js";
import { readLayeredSettings, type SettingsOrigin, settingsSourceFor } from "../core/settings-layers.js";
import { clioDataDir } from "../core/xdg.js";
import { loadOperatorProfile, loadProjectRules, renderOperatorProfile } from "../domains/context/index.js";
import { listInstalledExtensions } from "../domains/extensions/index.js";
import { loadMemoryRecordsSync, memoryStorePath } from "../domains/memory/index.js";
import { loadUserHooks, readHookSources } from "../domains/middleware/index.js";
import { defaultScopedResourceRoots } from "../domains/resources/common-loader.js";
import { ceilChars } from "../domains/session/context-accounting.js";

export type CustomizationCategory =
	| "settings"
	| "clio-md"
	| "rule"
	| "operator-profile"
	| "hook"
	| "extension"
	| "skill-root"
	| "prompt-root"
	| "agents"
	| "safety"
	| "memory";

export type ReloadClass = "hot" | "next-turn" | "restart" | "n/a";

export interface CustomizationEntry {
	category: CustomizationCategory;
	id: string;
	scope: string;
	sourcePath?: string;
	hash?: string;
	trust?: "trusted" | "untrusted" | "n/a";
	precedence?: "winner" | "loser" | "single";
	reloadClass: ReloadClass;
	/** Token cost where the item enters the prompt; absent when it does not. */
	contextCostTokens?: number;
	detail?: Record<string, unknown>;
}

export interface SettingsKeyReport {
	key: string;
	value: unknown;
	source: SettingsOrigin;
}

export interface CustomizationGraph {
	cwd: string;
	settings: SettingsKeyReport[];
	entries: CustomizationEntry[];
	issues: string[];
}

function getByPath(root: ClioSettings, dotted: string): unknown {
	let current: unknown = root;
	for (const key of dotted.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function shortHash(text: string): string {
	let hash = 0;
	for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function inspectSettings(cwd: string, graph: CustomizationGraph): void {
	try {
		const layered = readLayeredSettings(cwd);
		for (const issue of layered.issues) graph.issues.push(`settings ${issue.origin}: ${issue.path}: ${issue.message}`);
		// Report only the keys a layer explicitly set; built-in defaults are implicit.
		const keys = Object.keys(layered.sources).sort();
		for (const key of keys) {
			graph.settings.push({
				key,
				value: getByPath(layered.settings, key),
				source: settingsSourceFor(layered.sources, key),
			});
		}
	} catch (err) {
		graph.issues.push(`settings: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function inspectClioMd(cwd: string, graph: CustomizationGraph): void {
	const path = join(cwd, "CLIO.md");
	if (!existsSync(path)) return;
	try {
		const text = readFileSync(path, "utf8");
		graph.entries.push({
			category: "clio-md",
			id: "CLIO.md",
			scope: "project",
			sourcePath: path,
			hash: shortHash(text),
			trust: "trusted",
			precedence: "single",
			reloadClass: "next-turn",
			contextCostTokens: ceilChars(text.length),
		});
	} catch (err) {
		graph.issues.push(`clio-md: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function inspectRules(cwd: string, graph: CustomizationGraph): void {
	try {
		const loaded = loadProjectRules(cwd);
		for (const issue of loaded.issues) graph.issues.push(`rule: ${issue}`);
		for (const rule of loaded.rules) {
			graph.entries.push({
				category: "rule",
				id: rule.id,
				scope: "project",
				sourcePath: rule.sourcePath,
				hash: rule.hash,
				trust: "trusted",
				precedence: "single",
				reloadClass: "next-turn",
				contextCostTokens: rule.tokenEstimate,
				detail: {
					enabled: rule.enabled,
					conditional: rule.paths !== undefined,
					...(rule.paths ? { paths: rule.paths } : {}),
				},
			});
		}
		if (loaded.excludes.length > 0) {
			graph.entries.push({
				category: "rule",
				id: "context.excludes",
				scope: "project",
				reloadClass: "next-turn",
				detail: { excludes: loaded.excludes },
			});
		}
	} catch (err) {
		graph.issues.push(`rules: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function inspectOperatorProfile(cwd: string, graph: CustomizationGraph): void {
	try {
		const loaded = loadOperatorProfile(cwd);
		for (const issue of loaded.issues) graph.issues.push(`operator-profile: ${issue}`);
		if (loaded.origin === "none") return;
		const rendered = renderOperatorProfile(loaded.profile);
		const entry: CustomizationEntry = {
			category: "operator-profile",
			id: "operator-profile",
			scope: loaded.origin,
			trust: "trusted",
			precedence: "single",
			reloadClass: "next-turn",
			contextCostTokens: rendered.tokenEstimate,
			detail: { fields: Object.keys(loaded.profile) },
		};
		if (loaded.sourcePath !== undefined) entry.sourcePath = loaded.sourcePath;
		if (loaded.hash !== undefined) entry.hash = loaded.hash;
		graph.entries.push(entry);
	} catch (err) {
		graph.issues.push(`operator-profile: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function inspectHooks(cwd: string, graph: CustomizationGraph): void {
	try {
		const extensions = listInstalledExtensions(cwd)
			.filter((ext) => ext.enabled && ext.effective)
			.map((ext) => ({ id: ext.id, rootPath: ext.rootPath }));
		const { batches, fileIssues } = readHookSources({ cwd, extensions });
		for (const issue of fileIssues) graph.issues.push(`hook ${issue.source.origin}: ${issue.message}`);
		const loaded = loadUserHooks(batches, { workspaceRoot: cwd });
		for (const issue of loaded.issues) {
			graph.issues.push(`hook ${issue.source.sourcePath}#${issue.index}: ${issue.issues.join("; ")}`);
		}
		for (const hook of loaded.hooks) {
			graph.entries.push({
				category: "hook",
				id: hook.id,
				scope: hook.source.origin,
				sourcePath: hook.source.sourcePath,
				hash: hook.hash,
				trust: hook.source.origin === "extension" ? "untrusted" : "trusted",
				precedence: "winner",
				reloadClass: "restart",
				detail: { on: hook.on, kind: hook.spec.kind, enabled: hook.enabled, ...(hook.tools ? { tools: hook.tools } : {}) },
			});
		}
		for (const { loser } of loaded.overridden) {
			graph.entries.push({
				category: "hook",
				id: loser.id,
				scope: loser.source.origin,
				sourcePath: loser.source.sourcePath,
				hash: loser.hash,
				trust: loser.source.origin === "extension" ? "untrusted" : "trusted",
				precedence: "loser",
				reloadClass: "restart",
				detail: { on: loser.on, kind: loser.spec.kind },
			});
		}
	} catch (err) {
		graph.issues.push(`hooks: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function inspectExtensions(cwd: string, graph: CustomizationGraph): void {
	try {
		for (const ext of listInstalledExtensions(cwd, { all: true })) {
			graph.entries.push({
				category: "extension",
				id: ext.id,
				scope: ext.scope,
				sourcePath: ext.rootPath,
				hash: shortHash(`${ext.id}@${ext.version}`),
				trust: "untrusted",
				precedence: ext.effective ? "winner" : "loser",
				reloadClass: "restart",
				detail: { version: ext.version, enabled: ext.enabled, effective: ext.effective },
			});
		}
	} catch (err) {
		graph.issues.push(`extensions: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function inspectResourceRoots(cwd: string, graph: CustomizationGraph): void {
	for (const [kind, category] of [
		["skills", "skill-root"],
		["prompts", "prompt-root"],
	] as const) {
		try {
			for (const root of defaultScopedResourceRoots(kind, cwd)) {
				graph.entries.push({
					category,
					id: `${kind}:${root.scope}`,
					scope: root.scope,
					sourcePath: root.path,
					trust: root.scope === "package" ? "untrusted" : "trusted",
					precedence: "single",
					reloadClass: "next-turn",
					detail: { present: existsSync(root.path), source: root.source },
				});
			}
		} catch (err) {
			graph.issues.push(`${kind}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

function inspectSafetyAndMemory(cwd: string, graph: CustomizationGraph): void {
	try {
		const layered = readLayeredSettings(cwd);
		graph.entries.push({
			category: "safety",
			id: "autonomy",
			scope: settingsSourceFor(layered.sources, "autonomy"),
			reloadClass: "hot",
			trust: "n/a",
			precedence: "single",
			detail: { autonomy: layered.settings.autonomy ?? "auto-edit" },
		});
	} catch (err) {
		graph.issues.push(`safety: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		const path = memoryStorePath(clioDataDir());
		const records = existsSync(path) ? loadMemoryRecordsSync(path) : [];
		graph.entries.push({
			category: "memory",
			id: "memory-store",
			scope: "user",
			sourcePath: path,
			reloadClass: "hot",
			trust: "trusted",
			precedence: "single",
			detail: { present: existsSync(path), records: records.length },
		});
	} catch (err) {
		graph.issues.push(`memory: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Build the effective-customization graph for `cwd`. Never throws; every surface
 * is best-effort and failures land in `issues`.
 */
export function buildCustomizationGraph(cwd: string): CustomizationGraph {
	const graph: CustomizationGraph = { cwd, settings: [], entries: [], issues: [] };
	inspectSettings(cwd, graph);
	inspectClioMd(cwd, graph);
	inspectRules(cwd, graph);
	inspectOperatorProfile(cwd, graph);
	inspectHooks(cwd, graph);
	inspectExtensions(cwd, graph);
	inspectResourceRoots(cwd, graph);
	inspectSafetyAndMemory(cwd, graph);
	return graph;
}
