import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { ContextClearCommandOptions } from "../../session-control/slash-commands.js";
import { buildHint, createChoiceList, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";

export const CONTEXT_RESET_OVERLAY_WIDTH = 72;
export type ContextResetMutationChoice = "preserve-clio-md" | "delete-clio-md";

export interface OpenContextResetOverlayDeps {
	/** Called only for one of the two mutating choices. */
	onReset: (choice: ContextResetMutationChoice) => void;
	/** Called for both the explicit Cancel row and Esc. */
	onCancel: () => void;
}

/** Translate one confirmed chooser action into the existing context-domain contract. */
export function contextResetOptions(choice: ContextResetMutationChoice): ContextClearCommandOptions {
	return choice === "delete-clio-md" ? { all: true, confirmed: true, confirmedAll: true } : { confirmed: true };
}

/** Three intentional outcomes, ordered with the least destructive action first. */
const CHOICES = [
	{
		value: "preserve-clio-md",
		label: "Preserve CLIO-CODER.md",
		description: "remove generated context and keep the project handbook",
	},
	{
		value: "delete-clio-md",
		label: "Delete CLIO-CODER.md",
		description: "remove generated context and the project handbook",
	},
	{ value: "cancel", label: "Cancel", description: "close without changing any files" },
] as const;

/** Open the `/context reset` choice dialog. Cancel paths never reach onReset. */
export function openContextResetOverlay(tui: TUI, deps: OpenContextResetOverlayDeps): OverlayHandle {
	const list = createChoiceList({
		items: CHOICES,
		onSelect: (item) => {
			if (item.value === "preserve-clio-md" || item.value === "delete-clio-md") {
				deps.onReset(item.value);
				return;
			}
			deps.onCancel();
		},
		onCancel: () => deps.onCancel(),
	});
	return showClioOverlayFrame(tui, new FocusBox(list), {
		anchor: "center",
		width: CONTEXT_RESET_OVERLAY_WIDTH,
		markerId: "context-reset",
		title: "Reset Project Context",
		footerHint: buildHint([{ key: "Enter", verb: "select" }]),
	});
}
