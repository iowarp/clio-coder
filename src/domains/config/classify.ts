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
	// C1 / #422: pressure checkpoints and /context read the economic ceiling live.
	"context.compaction.maxTokens",
	// Native checkpoint selection is read at each compaction and replay (#423).
	"context.compaction.provider",
	"interface.exitSummary",
	"interface.keybindings",
	"safety.autonomy",
	// The parked request re-reads the ceiling every 250 ms, and dispatch admission
	// reads it per call, so a raise lifts a live wait (#424).
	"safety.limits.sessionCostUsd",
	"chat.modelPicker",
	// The keepalive reads it before every refresh, so a change applies to the next one (#423).
	"chat.cacheKeepalive",
	"interface.outputDetail",
	"interface.demo",
	"interface.smoothStreaming",
	// The update monitor reads it before each background install (#436).
	"interface.autoUpdate",
	"interface.panes.notifications",
	"integrations.git.commitAttribution",
	// `/music` reads both on every invocation.
	"integrations.music.enabled",
	"integrations.music.station",
	// The bridge reads these on every explicit open; no mux re-detection is
	// needed because the host capability rung remains `panes.enabled`.
	"interface.panes.files",
	// The workers dock reads its share through getWorkersRatio each time the
	// pane opens, so a new ratio applies to the next dock without a restart.
	"interface.panes.workers",
	// The watchdog registration reads its settings live on every trigger, so
	// enabling it, retargeting it, or changing its cadence takes effect on the
	// next turn boundary without a restart or a session-routing patch.
	"safety.review",
	// The main registry reads it at every admission, so the next tool call
	// observes a change (#419).
	"safety.scratchRoots",
	// The main registry reads it for every contained call; dispatch copies it
	// into each new WorkerSpec, so a running worker keeps the list it started with.
	"safety.sandboxPassEnv",
	// Read the same way: per contained call in the main session, into each
	// new WorkerSpec for workers.
	"safety.sandboxUnixSockets",
	// The main registry asks on every mutating call whether to snapshot.
	"safety.snapshots",
	// Each permission card and ask_user round reads it when it starts waiting,
	// so the next one observes a change; a running countdown keeps its window.
	"safety.unattendedAfterSeconds",
	// Read at each interactive yolo activation, so the next toggle observes it (#407).
	"safety.yoloAccepted",
	// The judge reads its settings at every review, so the next parked call
	// observes a change.
	"safety.judge",
]);

const NEXT_TURN_FIELDS = new Set<string>([
	"context.memory.observations.enabled",
	"turnControl",
	// Every site resolves its binding per call; consult alone is registered at
	// startup and is listed as restart-required.
	"systemOne",
	"targets",
	"chat",
	"fleet.default",
	"fleet.profiles",
	"fleet.rosters",
	"fleet.agentProfiles",
	"fleet.adaptiveRouting",
	"fleet.speculativeDispatch",
	"fleet.nodes",
	"fleet.defaultNode",
	"fleet.permissions",
	"fleet.retry",
	"fleet.worktrees",
	"fleet.limits",
	"fleet.history",
	"context",
	"safety.limits",
	"safety.limits.workerResponseSeconds",
	// Dispatch reads both into each new WorkerSpec; a running worker keeps the
	// policy it was spawned with.
	"safety.sandbox",
	"safety.sandboxNetwork",
	"interface.terminalProgress",
	"interface.desktopNotifications",
	"integrations.projectResources",
	"integrations.externalAgents",
	"integrations.library",
	// Session journal writers read the capture before each batch and open a new
	// segment on a change; a running worker keeps the mode it started with (#434).
	"telemetry",
]);

const RESTART_REQUIRED_FIELDS = new Set<string>([
	"fleet.concurrency",
	"systemOne.sites.consult",
	"interface.mode",
	"interface.fullscreenScrollbar",
	"interface.panes.enabled",
	"integrations.runtimePlugins",
	// The `music` tool is registered once at startup, like consult.
	"integrations.music.agentControl",
]);

function matchesPrefix(path: string, fields: Set<string>): boolean {
	if (fields.has(path)) return true;
	for (const field of fields) {
		if (path.startsWith(`${field}.`)) return true;
	}
	return false;
}

/** Shared effect timing for settings editors and the runtime reload path. */
export function settingsChangeKind(path: string): ChangeKind {
	if (matchesPrefix(path, HOT_RELOAD_FIELDS)) return "hotReload";
	if (matchesPrefix(path, RESTART_REQUIRED_FIELDS)) return "restartRequired";
	if (matchesPrefix(path, NEXT_TURN_FIELDS)) return "nextTurn";
	return "restartRequired";
}

export function diffSettings(prev: ClioSettings, next: ClioSettings): ConfigDiff {
	const changed = collectChangedPaths(prev, next);
	const diff: ConfigDiff = { hotReload: [], nextTurn: [], restartRequired: [] };
	for (const p of changed) {
		diff[settingsChangeKind(p)].push(p);
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
