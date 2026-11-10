/**
 * `/thinking` with no level: a plain list of the levels the current model
 * takes. It used to open the interview card, which framed a settings choice
 * as a question from the model and offered a free-text answer and notes that
 * a fixed set of levels has no use for.
 */

import type { OverlayHandle, TUI } from "../../engine/tui.js";
import { buildResponsiveHint, createChoiceList, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";

export const THINKING_LEVEL_OVERLAY_WIDTH = 56;

export interface ThinkingLevelChoice {
	/** The level as `/thinking <level>` takes it. */
	value: string;
	label: string;
}

export interface OpenThinkingLevelOverlayDeps {
	choices: ReadonlyArray<ThinkingLevelChoice>;
	current?: string;
	onPick: (level: string) => void;
	/** Esc: nothing changes. */
	onCancel: () => void;
}

export function openThinkingLevelOverlay(tui: TUI, deps: OpenThinkingLevelOverlayDeps): OverlayHandle {
	const currentIndex = deps.choices.findIndex((choice) => choice.value === deps.current);
	const list = createChoiceList({
		items: deps.choices.map((choice) => ({
			value: choice.value,
			// On the label: a one-line list's frame keeps one row per choice, which cut a description under it.
			label: choice.value === deps.current ? `${choice.label} · in use` : choice.label,
		})),
		...(currentIndex >= 0 ? { initialIndex: currentIndex } : {}),
		onSelect: (item) => deps.onPick(item.value),
		onCancel: () => deps.onCancel(),
	});
	return showClioOverlayFrame(tui, new FocusBox(list), {
		anchor: "center",
		width: THINKING_LEVEL_OVERLAY_WIDTH,
		markerId: "thinking-level",
		title: "Thinking level",
		footerHint: buildResponsiveHint([{ key: "Enter", verb: "use" }]),
	});
}
