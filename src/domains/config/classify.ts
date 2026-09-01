import type { ClioSettings } from "../../core/config.js";

/**
 * Classifies a version-2 settings change into one of three effect buckets:
 *   - hotReload: a live reader observes the value without rebuilding runtime state.
 *   - nextTurn: the next request, dispatch, or explicit open observes the value.
 *   - restartRequired: process or pane-host setup must be rebuilt.
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

const HOT_RELOAD_FIELDS = new Set<string>([
	"interface.keybindings",
	"safety.autonomy",
	"chat.modelPicker",
	"interface.smoothStreaming",
	"interface.panes.notifications",
	"integrations.git.commitAttribution",
	// The bridge reads these on every explicit open; no mux re-detection is
	// needed because the host capability rung remains `panes.enabled`.
	"interface.panes.files",
	// The watchdog registration reads its settings live on every trigger, so
	// enabling it, retargeting it, or changing its cadence takes effect on the
	// next turn boundary without a restart or a session-routing patch.
	"safety.review",
]);

const NEXT_TURN_FIELDS = new Set<string>([
	"targets",
	"chat",
	"fleet.default",
	"fleet.profiles",
	"fleet.rosters",
	"fleet.agentProfiles",
	"fleet.adaptiveRouting",
	"fleet.nodes",
	"fleet.permissions",
	"fleet.retry",
	"fleet.limits",
	"fleet.history",
	"context",
	"safety.limits",
	"interface.outputDetail",
	"interface.terminalProgress",
	"interface.desktopNotifications",
	"integrations.projectResources",
	"integrations.externalAgents",
	"integrations.library",
]);

const RESTART_REQUIRED_FIELDS = new Set<string>([
	"fleet.concurrency",
	"interface.mode",
	"interface.fullscreenScrollbar",
	"interface.panes.enabled",
	"integrations.runtimePlugins",
]);

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
		else if (matchesPrefix(p, RESTART_REQUIRED_FIELDS)) diff.restartRequired.push(p);
		else if (matchesPrefix(p, NEXT_TURN_FIELDS)) diff.nextTurn.push(p);
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
