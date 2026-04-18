import type { ClioSettings } from "../../core/config.js";

/**
 * Classifies a settings change into one of three buckets per spec §13:
 *   - hotReload   : theme, keybindings, safety rules, mode defaults, prompt fragments,
 *                   audit verbosity. Apply immediately (≤100ms).
 *   - nextTurn    : model selection, thinking level, budget ceiling. Apply before the
 *                   next turn starts.
 *   - restartRequired : provider credentials, active provider list, runtime enable/disable,
 *                       engine settings. Needs a restart nudge.
 *
 * Output is an exhaustive per-bucket list. A single patch can touch multiple buckets;
 * the caller emits the event(s) for every non-empty bucket.
 */

export type ChangeKind = "hotReload" | "nextTurn" | "restartRequired";

export interface ConfigDiff {
	hotReload: string[];
	nextTurn: string[];
	restartRequired: string[];
}

const HOT_RELOAD_FIELDS = new Set<string>(["theme", "keybindings", "safetyLevel", "defaultMode", "state.lastMode"]);

const NEXT_TURN_FIELDS = new Set<string>([
	"endpoints",
	"orchestrator.endpoint",
	"orchestrator.model",
	"orchestrator.thinkingLevel",
	"workers.default.endpoint",
	"workers.default.model",
	"workers.default.thinkingLevel",
	"scope",
	"budget.sessionCeilingUsd",
]);

const RESTART_REQUIRED_FIELDS = new Set<string>(["budget.concurrency"]);

function matchesPrefix(path: string, fields: Set<string>): boolean {
	if (fields.has(path)) return true;
	for (const field of fields) {
		if (path.startsWith(`${field}.`)) return true;
	}
	return false;
}

export function diffSettings(prev: ClioSettings, next: ClioSettings): ConfigDiff {
	const changed = collectChangedPaths(prev, next);
	const diff: ConfigDiff = { hotReload: [], nextTurn: [], restartRequired: [] };
	for (const p of changed) {
		if (matchesPrefix(p, HOT_RELOAD_FIELDS)) diff.hotReload.push(p);
		else if (matchesPrefix(p, NEXT_TURN_FIELDS)) diff.nextTurn.push(p);
		else if (matchesPrefix(p, RESTART_REQUIRED_FIELDS)) diff.restartRequired.push(p);
		else {
			// Unknown field falls back to restartRequired to fail closed.
			diff.restartRequired.push(p);
		}
	}
	return diff;
}

function collectChangedPaths(a: unknown, b: unknown, prefix = ""): string[] {
	if (Object.is(a, b)) return [];
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
		return [prefix || "(root)"];
	}
	const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
	const paths: string[] = [];
	for (const k of keys) {
		const nextPrefix = prefix ? `${prefix}.${k}` : k;
		const av = (a as Record<string, unknown>)[k];
		const bv = (b as Record<string, unknown>)[k];
		paths.push(...collectChangedPaths(av, bv, nextPrefix));
	}
	return paths;
}
