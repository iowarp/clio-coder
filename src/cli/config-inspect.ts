/**
 * The effective-customization graph behind `clio-coder config inspect`. This is the
 * "why is Clio behaving this way" surface: it answers what settings, context
 * files, rules, skills, prompts, agents, fleets, extensions, safety, memory, hooks, and
 * the operator profile loaded, from where, with what precedence, and what each
 * costs in context.
 *
 * Every surface is read through its own loader, best-effort: a surface that
 * fails to load contributes an issue rather than aborting the inspection. The
 * graph uses one shared source-attribution model ({@link CustomizationEntry}) so
 * everything reports the same columns.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ClioSettings } from "../core/config.js";
import { resolvePackageRoot } from "../core/package-root.js";
import { readLayeredSettings, type SettingsOrigin, settingsSourceFor } from "../core/settings-layers.js";
import { clioDataDir, clioStateDir } from "../core/xdg.js";
import {
	loadOperatorProfile,
	loadProjectClioMd,
	loadProjectRules,
	renderOperatorProfile,
	renderPromptContext,
} from "../domains/context/index.js";
import { extensionSnapshotFor, listInstalledExtensions } from "../domains/extensions/index.js";
import { loadMemoryRecordsSync, memoryStorePath } from "../domains/memory/index.js";
import {
	HOOK_RECEIPT_LOG_CAPACITY,
	loadUserHooks,
	readHookSources,
	readPersistedHookReceipts,
} from "../domains/middleware/index.js";
import { classifyProjectPreload } from "../domains/prompts/preload.js";
import { defaultScopedResourceRoots } from "../domains/resources/common-loader.js";
import { ceilChars } from "../domains/session/context-accounting.js";
import { capturedHookSourcesFor } from "../entry/extension-hook-sources.js";

export type CustomizationCategory =
	| "settings"
	| "clio-md"
	| "rule"
	| "operator-profile"
	| "hook"
	| "extension"
	| "skill-root"
	| "prompt-root"
	| "agent-root"
	| "fleet-root"
	| "safety"
	| "memory";

/** `reload` means an explicit `/resources extensions reload` (or a restart) publishes the change. */
export type ReloadClass = "hot" | "next-turn" | "reload" | "restart" | "n/a";

export interface CustomizationEntry {
	category: CustomizationCategory;
	id: string;
	scope: string;
	sourcePath?: string;
	hash?: string;
	trust?: "trusted" | "untrusted" | "n/a";
	precedence?: "winner" | "loser" | "single" | "layer";
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
	const loaded = loadProjectClioMd(cwd);
	for (const issue of loaded.errors) graph.issues.push(`clio-md ${issue.path}: ${issue.error}`);
	if (loaded.files.length === 0) return;
	try {
		const promptContext = renderPromptContext(cwd);
		const preload = classifyProjectPreload({ hasClioMd: promptContext.clioMd !== null, text: promptContext.text });
		for (const [index, file] of loaded.files.entries()) {
			const text = readFileSync(file.path, "utf8");
			graph.entries.push({
				category: "clio-md",
				id: basename(file.path),
				scope: "project",
				sourcePath: file.path,
				hash: shortHash(text),
				trust: "trusted",
				precedence: loaded.files.length === 1 ? "single" : "layer",
				reloadClass: "next-turn",
				contextCostTokens: ceilChars(text.length),
				detail: {
					layer: index + 1,
					layers: loaded.files.length,
					preload: preload.label,
					preloadChars: preload.chars,
					preloadLines: preload.lines,
					...(preload.nearLimit ? { preloadNearLimit: true } : {}),
				},
			});
		}
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
		// Extension declarations come from the same captured bytes a booted
		// session admits; an inspecting process without a bound store builds an
		// ephemeral generation-0 projection.
		const { batches, fileIssues } = readHookSources({
			cwd,
			capturedSources: capturedHookSourcesFor(extensionSnapshotFor(cwd)),
		});
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
				reloadClass: "reload",
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
				reloadClass: "reload",
				detail: { on: loser.on, kind: loser.spec.kind },
			});
		}
	} catch (err) {
		graph.issues.push(`hooks: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Rolls up the durable hook-execution receipt log (`<stateDir>/hook-receipts.json`,
 * written by `createHookReceiptLog` in `src/domains/middleware/hook-receipts.ts`)
 * into one entry, since this process never held the live in-memory ring a
 * running session's own invocation writes through. One entry rather than one
 * per receipt: this graph explains configuration provenance, and a couple
 * hundred execution rows would swamp that rather than answer it.
 */
function inspectHookReceipts(graph: CustomizationGraph): void {
	const path = join(clioStateDir(), "hook-receipts.json");
	try {
		const receipts = existsSync(path) ? readPersistedHookReceipts(path) : [];
		const outcomes: Record<string, number> = {};
		for (const receipt of receipts) outcomes[receipt.outcome] = (outcomes[receipt.outcome] ?? 0) + 1;
		const last = receipts.at(-1);
		graph.entries.push({
			category: "hook",
			id: "hook-receipts",
			scope: "user",
			sourcePath: path,
			reloadClass: "n/a",
			trust: "n/a",
			precedence: "single",
			detail: {
				present: existsSync(path),
				count: receipts.length,
				capacity: HOOK_RECEIPT_LOG_CAPACITY,
				outcomes,
				...(last === undefined ? {} : { mostRecent: { at: last.at, hookId: last.hookId, outcome: last.outcome } }),
			},
		});
	} catch (err) {
		graph.issues.push(`hook-receipts: ${err instanceof Error ? err.message : String(err)}`);
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
				reloadClass: "reload",
				detail: {
					version: ext.version,
					enabled: ext.enabled,
					valid: ext.valid,
					effective: ext.effective,
					loadable: ext.loadable,
				},
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
		["agents", "agent-root"],
		["fleets", "fleet-root"],
	] as const) {
		try {
			if (kind === "agents" || kind === "fleets") {
				const builtinPath = join(
					resolvePackageRoot(),
					"src",
					"domains",
					"agents",
					kind === "agents" ? "builtins" : "fleets",
				);
				graph.entries.push({
					category,
					id: `${kind}:builtin`,
					scope: "builtin",
					sourcePath: builtinPath,
					trust: "trusted",
					precedence: "layer",
					reloadClass: "next-turn",
					detail: { present: existsSync(builtinPath), source: "builtin", resourcePrecedence: 0 },
				});
			}
			for (const root of defaultScopedResourceRoots(kind, cwd)) {
				graph.entries.push({
					category,
					id: `${kind}:${root.scope}`,
					scope: root.scope === "package" ? "extension" : root.scope,
					sourcePath: root.path,
					trust: root.scope === "package" ? "untrusted" : "trusted",
					precedence: "layer",
					reloadClass: "next-turn",
					detail: {
						present: existsSync(root.path),
						source: root.source,
						...(root.precedence === undefined ? {} : { resourcePrecedence: root.precedence }),
					},
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
			id: "safety.autonomy",
			scope: settingsSourceFor(layered.sources, "safety.autonomy"),
			reloadClass: "hot",
			trust: "n/a",
			precedence: "single",
			detail: { autonomy: layered.settings.safety.autonomy ?? "auto-edit" },
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
	inspectHookReceipts(graph);
	inspectExtensions(cwd, graph);
	inspectResourceRoots(cwd, graph);
	inspectSafetyAndMemory(cwd, graph);
	return graph;
}
