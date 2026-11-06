/**
 * Where a `/model` swap lands: this session, or this session and settings.yaml.
 *
 * Smoke pass 2 (G3) swapped the live model mid-conversation and found the
 * orchestrator role rewritten in settings.yaml with no prompt, so the next
 * launch came up pointed at an endpoint that no longer existed. Every other
 * durable change in the product goes through the settings center's scoped
 * commit; this is that commit for the one path that used to skip it.
 *
 * Session is first and selected by default: a mid-conversation swap is a thing
 * the operator is trying, and the cheap answer to a bad try is closing the
 * session rather than editing a file.
 */

import type { ThinkingLevel } from "../../core/defaults.js";
import { type Component, type OverlayHandle, type TUI, wrapTextWithAnsi } from "../../engine/tui.js";
import { buildHint, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme } from "../theme/index.js";
import { type ChoiceItem, ChoiceList } from "./settings-submenus.js";

export const MODEL_SCOPE_OVERLAY_WIDTH = 72;

export type ModelScopeChoice = "session" | "project" | "global";

/** The swap awaiting a destination. `thinkingLevel` is set only when the operator named one. */
export interface PendingModelScope {
	target: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface OpenModelScopeOverlayDeps {
	ref: PendingModelScope;
	/** Called only for an applying choice. */
	onChoose: (scope: ModelScopeChoice) => void;
	/** Called for the explicit Cancel row, and for Esc when there is nothing to go back to. Nothing has changed yet. */
	onCancel: () => void;
	/**
	 * Esc from a card the picker opened: back to the picker with the same row
	 * selected, because backing out of the destination is not abandoning the pick.
	 */
	onBack?: () => void;
	/** What choosing does to the turn in flight, asked on every frame so it stays true up to the Enter. */
	turnEffect?: () => string | null;
	/** What the swap costs the session's history, when it costs anything. Sized once: choosing does not change it. */
	switchCost?: string | null;
	/** Whether the model is loaded where it would run, as the picker showed it, so the choice is made knowing the wait. */
	residency?: string | null;
	/** The route in use now, named the way the composer names it, so the card reads as a change from one to the other. */
	current?: string | null;
}

/** The swap as the operator typed it, for the dialog title. */
export function formatPendingModelScope(ref: PendingModelScope): string {
	const thinking = ref.thinkingLevel ? ` with thinking ${ref.thinkingLevel}` : "";
	return `${ref.target} · ${ref.model}${thinking}`;
}

/** Three outcomes, least durable first, matching the settings center's order. */
function buildModelScopeItems(): ChoiceItem[] {
	return [
		{
			value: "session",
			label: "Apply this session",
			description: "Live now and not saved; the next session starts from the saved model",
		},
		{
			value: "project",
			label: "Apply and save for this project",
			description: "Saved in this project's .clio-coder/settings.local.yaml, live now",
		},
		{
			value: "global",
			label: "Apply and save globally",
			description: "Saved in your user settings.yaml for every project, live now",
		},
		{
			value: "cancel",
			label: "Cancel",
			description: "Nothing changes; Clio keeps the current model",
		},
	];
}

export function openModelScopeOverlay(tui: TUI, deps: OpenModelScopeOverlayDeps): OverlayHandle {
	const items = buildModelScopeItems();
	// The same choice list the settings center confirms with: each destination
	// carries its consequence under it, so the label never has to be cut to fit
	// beside a description column.
	const list = new ChoiceList(items);
	list.onSelect = (item: ChoiceItem): void => {
		if (item.value === "session" || item.value === "project" || item.value === "global") {
			deps.onChoose(item.value);
			return;
		}
		deps.onCancel();
	};
	list.onCancel = (): void => {
		(deps.onBack ?? deps.onCancel)();
	};

	const effect: Component = {
		render(width) {
			const room = Math.max(1, width);
			const theme = clioTheme();
			const text = deps.turnEffect?.();
			const current = deps.current?.trim();
			return [
				...(current ? [...wrapTextWithAnsi(theme.fg("annotation", `Now on ${current}`), room), ""] : []),
				...(text ? [...wrapTextWithAnsi(theme.fg("accent", text), room), ""] : []),
				...(deps.residency ? [...wrapTextWithAnsi(theme.fg("annotation", deps.residency), room), ""] : []),
				...(deps.switchCost ? [...wrapTextWithAnsi(theme.fg("annotation", deps.switchCost), room), ""] : []),
			];
		},
		invalidate() {},
	};

	return showClioOverlayFrame(tui, new FocusBox([effect, list], { inputTarget: list }), {
		anchor: "center",
		width: MODEL_SCOPE_OVERLAY_WIDTH,
		markerId: "model-scope",
		title: `Apply ${formatPendingModelScope(deps.ref)}`,
		footerHint: buildHint([{ key: "Enter", verb: "choose" }], deps.onBack ? "back to models" : "close"),
	});
}
