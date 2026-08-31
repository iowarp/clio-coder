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
import { type OverlayHandle, type SelectItem, SelectList, type TUI } from "../../engine/tui.js";
import { buildHint, DEFAULT_SELECT_THEME, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";

export const MODEL_SCOPE_OVERLAY_WIDTH = 72;

export type ModelScopeChoice = "session" | "global";

/** The swap awaiting a destination. `thinkingLevel` is set only when the operator named one. */
export interface PendingModelScope {
	target: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface OpenModelScopeOverlayDeps {
	ref: PendingModelScope;
	/** Called only for one of the two applying choices. */
	onChoose: (scope: ModelScopeChoice) => void;
	/** Called for the explicit Cancel row and for Esc. Nothing has changed yet. */
	onCancel: () => void;
}

/** The swap as the operator typed it, for the dialog title. */
export function formatPendingModelScope(ref: PendingModelScope): string {
	const thinking = ref.thinkingLevel ? ` thinking=${ref.thinkingLevel}` : "";
	return `${ref.target}/${ref.model}${thinking}`;
}

/** Three outcomes, least durable first, matching the settings center's order. */
function buildModelScopeItems(): SelectItem[] {
	return [
		{
			value: "session",
			label: "Apply this session",
			description: "route this session only; settings.yaml is untouched",
		},
		{
			value: "global",
			label: "Apply and save globally",
			description: "also the orchestrator route the next launch starts on",
		},
		{
			value: "cancel",
			label: "Cancel",
			description: "keep the current model",
		},
	];
}

export function openModelScopeOverlay(tui: TUI, deps: OpenModelScopeOverlayDeps): OverlayHandle {
	const items = buildModelScopeItems();
	const list = new SelectList(items, items.length, DEFAULT_SELECT_THEME);
	list.onSelect = (item: SelectItem): void => {
		if (item.value === "session" || item.value === "global") {
			deps.onChoose(item.value);
			return;
		}
		deps.onCancel();
	};
	list.onCancel = (): void => {
		deps.onCancel();
	};

	return showClioOverlayFrame(tui, new FocusBox(list), {
		anchor: "center",
		width: MODEL_SCOPE_OVERLAY_WIDTH,
		markerId: "model-scope",
		title: `Apply ${formatPendingModelScope(deps.ref)}`,
		footerHint: buildHint([{ key: "Enter", verb: "select" }]),
	});
}
