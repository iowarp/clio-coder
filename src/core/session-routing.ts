/**
 * Session-owned live routing state.
 *
 * Saved settings (settings.yaml) are defaults shared by every Clio process.
 * Live routing for a running session — active orchestrator target/model/
 * thinking, the fleet default used by /run, and the Alt+J / Alt+K scope list —
 * is owned by the process that is running the session. Each process seeds its
 * routing from saved settings at boot and afterwards reads everything through
 * an effective view: the shared snapshot (targets, theme, safety, retry, …)
 * with the session's routing fields overlaid.
 *
 * Interactive routing changes update the session state first (immediate
 * effect in this session) and write through to saved settings so new sessions
 * inherit them. External writes to settings.yaml — another Clio session, the
 * CLI, an editor — update the shared snapshot and therefore the defaults, but
 * never redirect a running session's routing.
 */

import type { ClioSettings } from "./config.js";

type SessionThinkingLevel = ClioSettings["chat"]["thinkingLevel"];

export interface SessionRoutingTarget {
	target: string | null;
	model: string | null;
	thinkingLevel: SessionThinkingLevel;
}

export interface SessionRoutingState {
	orchestrator: SessionRoutingTarget;
	background: Pick<SessionRoutingTarget, "target" | "model">;
	workersDefault: SessionRoutingTarget;
	scope: string[];
}

/**
 * Partial routing update. Only the fields present are applied to the session
 * state and written through to saved settings, so a Shift+Tab in one session
 * never clobbers a default model another session saved a minute earlier.
 */
export interface RoutingPatch {
	orchestrator?: Partial<SessionRoutingTarget>;
	background?: Partial<Pick<SessionRoutingTarget, "target" | "model">>;
	workersDefault?: Partial<SessionRoutingTarget>;
	scope?: string[];
}

function targetFrom(source: {
	target: string | null;
	model: string | null;
	thinkingLevel: SessionThinkingLevel;
}): SessionRoutingTarget {
	return {
		target: source.target ?? null,
		model: source.model ?? null,
		thinkingLevel: source.thinkingLevel ?? "off",
	};
}

export function seedSessionRouting(saved: Readonly<ClioSettings>): SessionRoutingState {
	return {
		orchestrator: targetFrom(saved.chat),
		background: { target: saved.context.memory.target, model: saved.context.memory.model },
		workersDefault: targetFrom(saved.fleet.default),
		scope: [...saved.chat.modelPicker.cycleSet],
	};
}

/**
 * Effective settings view: the shared snapshot with the session's routing
 * overlaid. Everything that resolves a chat or dispatch target, and every UI
 * surface that displays routing, must read through this view.
 */
export function applySessionRouting(saved: Readonly<ClioSettings>, routing: SessionRoutingState): ClioSettings {
	const view = structuredClone(saved) as ClioSettings;
	view.chat.target = routing.orchestrator.target;
	view.chat.model = routing.orchestrator.model;
	view.chat.thinkingLevel = routing.orchestrator.thinkingLevel;
	view.context.memory.target = routing.background.target;
	view.context.memory.model = routing.background.model;
	view.fleet.default.target = routing.workersDefault.target;
	view.fleet.default.model = routing.workersDefault.model;
	view.fleet.default.thinkingLevel = routing.workersDefault.thinkingLevel;
	view.chat.modelPicker.cycleSet = [...routing.scope];
	return view;
}

export function applyRoutingPatch(routing: SessionRoutingState, patch: RoutingPatch): void {
	if (patch.orchestrator) Object.assign(routing.orchestrator, patch.orchestrator);
	if (patch.background) Object.assign(routing.background, patch.background);
	if (patch.workersDefault) Object.assign(routing.workersDefault, patch.workersDefault);
	if (patch.scope) routing.scope = [...patch.scope];
}

/**
 * Session-local overrides for the non-routing settings surface (autonomy,
 * budget, compaction, retry, …). Routing has its own dedicated state above;
 * everything else a session changes "for this session only" lives here as a
 * sparse map of dotted config paths to values. The /settings overlay edits one
 * leaf at a time and every editable id equals its config path, so the keys are
 * always object paths (never array indices). A value of `undefined` represents
 * "delete this optional leaf in the effective view" (e.g. clearing
 * compaction.model).
 */
export type SessionOverrides = Map<string, unknown>;

/** True for the dotted paths owned by the session routing state (never overrides). */
export function isRoutingPath(path: string): boolean {
	return ROUTING_PATHS.has(path);
}

const ROUTING_PATHS = new Set<string>([
	"chat.target",
	"chat.model",
	"chat.thinkingLevel",
	"context.memory.target",
	"context.memory.model",
	"fleet.default.target",
	"fleet.default.model",
	"fleet.default.thinkingLevel",
	"chat.modelPicker.cycleSet",
]);

/** Read a leaf from a settings blob by dotted object path. Missing ⇒ undefined. */
export function getAtPath(source: Readonly<ClioSettings>, path: string): unknown {
	let cursor: unknown = source;
	for (const key of path.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[key];
	}
	return cursor;
}

/**
 * Set (or, when `value === undefined`, delete) a leaf on a settings blob by
 * dotted object path. Intermediate objects must already exist — every editable
 * id targets a leaf under a known schema object, so this never has to create
 * containers.
 */
export function setAtPath(target: ClioSettings, path: string, value: unknown): void {
	const keys = path.split(".");
	const last = keys.pop();
	if (last === undefined) return;
	let cursor: Record<string, unknown> = target as unknown as Record<string, unknown>;
	for (const key of keys) {
		const nextCursor = cursor[key];
		if (nextCursor === null || typeof nextCursor !== "object") return;
		cursor = nextCursor as Record<string, unknown>;
	}
	if (value === undefined) delete cursor[last];
	else cursor[last] = value;
}

/**
 * Effective non-routing view: the shared snapshot with the session's overrides
 * applied. Returns the base untouched when there are no overrides so the common
 * (no session-only edits) path stays allocation-free.
 */
export function applyOverrides(base: Readonly<ClioSettings>, overrides: SessionOverrides): ClioSettings {
	if (overrides.size === 0) return base as ClioSettings;
	const view = structuredClone(base) as ClioSettings;
	for (const [path, value] of overrides) setAtPath(view, path, value);
	return view;
}

/** Write-through of a routing patch onto a (cloned) saved-settings blob. */
export function mergeRoutingPatchIntoSettings(settings: ClioSettings, patch: RoutingPatch): void {
	if (patch.orchestrator) Object.assign(settings.chat, patch.orchestrator);
	if (patch.background) Object.assign(settings.context.memory, patch.background);
	if (patch.workersDefault) Object.assign(settings.fleet.default, patch.workersDefault);
	if (patch.scope) settings.chat.modelPicker.cycleSet = [...patch.scope];
}

/**
 * Build the routing patch for a single /settings edit, keyed by its config-path
 * id and read from the supplied (already-changed) settings blob. Used by the
 * scoped /settings commit instead of a live diff: a session-only apply moves the
 * routing state first, which would zero out a subsequent diff and make a global
 * save no-op. Only the touched fields are included, so a global save never
 * rewrites routing fields the operator did not change. Changing a target also
 * carries its rebased model. Returns null for non-routing ids.
 */
export function routingPatchForId(path: string, settings: Readonly<ClioSettings>): RoutingPatch | null {
	switch (path) {
		case "chat.target":
			return { orchestrator: { target: settings.chat.target, model: settings.chat.model } };
		case "chat.model":
			return { orchestrator: { model: settings.chat.model } };
		case "chat.thinkingLevel":
			return { orchestrator: { thinkingLevel: settings.chat.thinkingLevel } };
		case "context.memory.target":
			return { background: { target: settings.context.memory.target, model: settings.context.memory.model } };
		case "context.memory.model":
			return { background: { model: settings.context.memory.model } };
		case "fleet.default.target":
			return { workersDefault: { target: settings.fleet.default.target, model: settings.fleet.default.model } };
		case "fleet.default.model":
			return { workersDefault: { model: settings.fleet.default.model } };
		case "fleet.default.thinkingLevel":
			return { workersDefault: { thinkingLevel: settings.fleet.default.thinkingLevel } };
		case "chat.modelPicker.cycleSet":
			return { scope: [...settings.chat.modelPicker.cycleSet] };
		default:
			return null;
	}
}

function diffTarget(
	prev: { target: string | null; model: string | null; thinkingLevel: SessionThinkingLevel },
	next: { target: string | null; model: string | null; thinkingLevel: SessionThinkingLevel },
): Partial<SessionRoutingTarget> | null {
	const out: Partial<SessionRoutingTarget> = {};
	if ((prev.target ?? null) !== (next.target ?? null)) out.target = next.target ?? null;
	if ((prev.model ?? null) !== (next.model ?? null)) out.model = next.model ?? null;
	if ((prev.thinkingLevel ?? "off") !== (next.thinkingLevel ?? "off")) out.thinkingLevel = next.thinkingLevel ?? "off";
	return Object.keys(out).length > 0 ? out : null;
}

function scopeEquals(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
	return a.length === b.length && a.every((entry, idx) => entry === b[idx]);
}

/**
 * Field-level diff of the routing surface between two settings blobs. Used to
 * absorb routing edits made through whole-settings writers (the /settings
 * overlay) into the session state without letting unrelated edits persist the
 * session's routing as new defaults.
 */
export function diffRouting(prev: Readonly<ClioSettings>, next: Readonly<ClioSettings>): RoutingPatch | null {
	const patch: RoutingPatch = {};
	const orchestrator = diffTarget(prev.chat, next.chat);
	if (orchestrator) patch.orchestrator = orchestrator;
	const background = diffTarget(
		{ ...prev.context.memory, thinkingLevel: "off" },
		{ ...next.context.memory, thinkingLevel: "off" },
	);
	if (background) patch.background = background;
	const workersDefault = diffTarget(prev.fleet.default, next.fleet.default);
	if (workersDefault) patch.workersDefault = workersDefault;
	if (!scopeEquals(prev.chat.modelPicker.cycleSet, next.chat.modelPicker.cycleSet))
		patch.scope = [...next.chat.modelPicker.cycleSet];
	return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Replace `target`'s routing fields with `source`'s. Applied before
 * persisting a whole-settings blob that was derived from the effective view,
 * so a /settings edit to, say, retry.maxRetries does not silently rewrite the
 * saved routing defaults with this session's live routing.
 */
export function restoreRoutingFields(target: ClioSettings, source: Readonly<ClioSettings>): void {
	target.chat.target = source.chat.target;
	target.chat.model = source.chat.model;
	target.chat.thinkingLevel = source.chat.thinkingLevel;
	target.context.memory.target = source.context.memory.target;
	target.context.memory.model = source.context.memory.model;
	target.fleet.default.target = source.fleet.default.target;
	target.fleet.default.model = source.fleet.default.model;
	target.fleet.default.thinkingLevel = source.fleet.default.thinkingLevel;
	target.chat.modelPicker.cycleSet = [...source.chat.modelPicker.cycleSet];
}

const ROUTING_FIELD_LABELS: ReadonlyArray<{
	field: string;
	label: string;
	read: (settings: Readonly<ClioSettings>) => unknown;
}> = [
	{ field: "chat.target", label: "chat target", read: (s) => s.chat.target ?? null },
	{ field: "chat.model", label: "chat model", read: (s) => s.chat.model ?? null },
	{ field: "chat.thinkingLevel", label: "chat thinking", read: (s) => s.chat.thinkingLevel ?? "off" },
	{ field: "context.memory.target", label: "memory target", read: (s) => s.context.memory.target ?? null },
	{ field: "context.memory.model", label: "memory model", read: (s) => s.context.memory.model ?? null },
	{ field: "fleet.default.target", label: "fleet target", read: (s) => s.fleet.default.target ?? null },
	{ field: "fleet.default.model", label: "fleet model", read: (s) => s.fleet.default.model ?? null },
	{
		field: "fleet.default.thinkingLevel",
		label: "fleet thinking",
		read: (s) => s.fleet.default.thinkingLevel ?? "off",
	},
	{
		field: "chat.modelPicker.cycleSet",
		label: "Alt+J/Alt+K cycle set",
		read: (s) => s.chat.modelPicker.cycleSet.join(","),
	},
];

/**
 * Given the changed paths from a settings reload, return the human labels of
 * routing fields whose saved value now differs from the session's effective
 * routing. A session's own write-through produces no divergence (the changed
 * fields carry the session's values), so a non-empty result means another
 * writer — a second session, the CLI, or a manual edit — moved the defaults
 * out from under this session.
 */
function externalRoutingDivergence(
	changedPaths: ReadonlyArray<string>,
	saved: Readonly<ClioSettings>,
	effective: Readonly<ClioSettings>,
): string[] {
	const labels: string[] = [];
	for (const entry of ROUTING_FIELD_LABELS) {
		const touched = changedPaths.some((path) => path === entry.field || path.startsWith(`${entry.field}.`));
		if (!touched) continue;
		if (entry.read(saved) !== entry.read(effective)) labels.push(entry.label);
	}
	return labels;
}

export interface RoutingChangeNotice {
	kind: "external-divergence" | "active-target-removed";
	level: "info" | "warning";
	text: string;
}

/**
 * The two advisory notices a running session emits when an external writer
 * moves settings.yaml underneath it. One helper feeds every surface — the TUI
 * notification center and the ACP session ledger — so the wording cannot
 * drift. `commandHints` appends the interactive remedies (/settings, /model,
 * Alt+L), which only make sense where a user can type slash commands.
 */
export function routingChangeNotices(
	changedPaths: ReadonlyArray<string>,
	saved: Readonly<ClioSettings>,
	effective: Readonly<ClioSettings>,
	options?: { commandHints?: boolean },
): RoutingChangeNotice[] {
	const notices: RoutingChangeNotice[] = [];
	const diverged = externalRoutingDivergence(changedPaths, saved, effective);
	if (diverged.length > 0) {
		const hint = options?.commandHints ? " Change live routing via /settings or /model." : "";
		notices.push({
			kind: "external-divergence",
			level: "info",
			text: `settings.yaml changed (${diverged.join(", ")}). This session keeps its routing; new sessions use the saved defaults.${hint}`,
		});
	}
	const activeTarget = effective.chat.target;
	const targetsTouched = changedPaths.some((path) => path === "targets" || path.startsWith("targets."));
	if (activeTarget && targetsTouched && !saved.targets.some((entry) => entry.id === activeTarget)) {
		const hint = options?.commandHints ? " (/model)" : "";
		notices.push({
			kind: "active-target-removed",
			level: "warning",
			text: `active target '${activeTarget}' was removed from settings.yaml; chat turns will fail until you pick a new target${hint}.`,
		});
	}
	return notices;
}
