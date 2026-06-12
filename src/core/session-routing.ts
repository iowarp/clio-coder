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

type SessionThinkingLevel = ClioSettings["orchestrator"]["thinkingLevel"];

export interface SessionRoutingTarget {
	target: string | null;
	model: string | null;
	thinkingLevel: SessionThinkingLevel;
}

export interface SessionRoutingState {
	orchestrator: SessionRoutingTarget;
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
		orchestrator: targetFrom(saved.orchestrator),
		workersDefault: targetFrom(saved.workers.default),
		scope: [...(saved.scope ?? [])],
	};
}

/**
 * Effective settings view: the shared snapshot with the session's routing
 * overlaid. Everything that resolves a chat or dispatch target, and every UI
 * surface that displays routing, must read through this view.
 */
export function applySessionRouting(saved: Readonly<ClioSettings>, routing: SessionRoutingState): ClioSettings {
	const view = structuredClone(saved) as ClioSettings;
	view.orchestrator.target = routing.orchestrator.target;
	view.orchestrator.model = routing.orchestrator.model;
	view.orchestrator.thinkingLevel = routing.orchestrator.thinkingLevel;
	view.workers.default.target = routing.workersDefault.target;
	view.workers.default.model = routing.workersDefault.model;
	view.workers.default.thinkingLevel = routing.workersDefault.thinkingLevel;
	view.scope = [...routing.scope];
	return view;
}

export function applyRoutingPatch(routing: SessionRoutingState, patch: RoutingPatch): void {
	if (patch.orchestrator) Object.assign(routing.orchestrator, patch.orchestrator);
	if (patch.workersDefault) Object.assign(routing.workersDefault, patch.workersDefault);
	if (patch.scope) routing.scope = [...patch.scope];
}

/** Write-through of a routing patch onto a (cloned) saved-settings blob. */
export function mergeRoutingPatchIntoSettings(settings: ClioSettings, patch: RoutingPatch): void {
	if (patch.orchestrator) Object.assign(settings.orchestrator, patch.orchestrator);
	if (patch.workersDefault) Object.assign(settings.workers.default, patch.workersDefault);
	if (patch.scope) settings.scope = [...patch.scope];
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
	const orchestrator = diffTarget(prev.orchestrator, next.orchestrator);
	if (orchestrator) patch.orchestrator = orchestrator;
	const workersDefault = diffTarget(prev.workers.default, next.workers.default);
	if (workersDefault) patch.workersDefault = workersDefault;
	if (!scopeEquals(prev.scope ?? [], next.scope ?? [])) patch.scope = [...(next.scope ?? [])];
	return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Replace `target`'s routing fields with `source`'s. Applied before
 * persisting a whole-settings blob that was derived from the effective view,
 * so a /settings edit to, say, retry.maxRetries does not silently rewrite the
 * saved routing defaults with this session's live routing.
 */
export function restoreRoutingFields(target: ClioSettings, source: Readonly<ClioSettings>): void {
	target.orchestrator.target = source.orchestrator.target;
	target.orchestrator.model = source.orchestrator.model;
	target.orchestrator.thinkingLevel = source.orchestrator.thinkingLevel;
	target.workers.default.target = source.workers.default.target;
	target.workers.default.model = source.workers.default.model;
	target.workers.default.thinkingLevel = source.workers.default.thinkingLevel;
	target.scope = [...(source.scope ?? [])];
}

const ROUTING_FIELD_LABELS: ReadonlyArray<{
	field: string;
	label: string;
	read: (settings: Readonly<ClioSettings>) => unknown;
}> = [
	{ field: "orchestrator.target", label: "chat target", read: (s) => s.orchestrator.target ?? null },
	{ field: "orchestrator.model", label: "chat model", read: (s) => s.orchestrator.model ?? null },
	{ field: "orchestrator.thinkingLevel", label: "chat thinking", read: (s) => s.orchestrator.thinkingLevel ?? "off" },
	{ field: "workers.default.target", label: "fleet target", read: (s) => s.workers.default.target ?? null },
	{ field: "workers.default.model", label: "fleet model", read: (s) => s.workers.default.model ?? null },
	{
		field: "workers.default.thinkingLevel",
		label: "fleet thinking",
		read: (s) => s.workers.default.thinkingLevel ?? "off",
	},
	{ field: "scope", label: "Alt+J/Alt+K scope", read: (s) => (s.scope ?? []).join(",") },
];

/**
 * Given the changed paths from a settings reload, return the human labels of
 * routing fields whose saved value now differs from the session's effective
 * routing. A session's own write-through produces no divergence (the changed
 * fields carry the session's values), so a non-empty result means another
 * writer — a second session, the CLI, or a manual edit — moved the defaults
 * out from under this session.
 */
export function externalRoutingDivergence(
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
	const activeTarget = effective.orchestrator.target;
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
