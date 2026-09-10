import {
	type Component,
	decodePrintableKey,
	Editor,
	Input,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
} from "../engine/tui.js";

/** Internal focus contract for Clio's existing components and frame wrappers. */
export interface KeyboardOwner {
	readonly keyboardScope?: "browse" | "edit" | "review";
	undoInput?(): boolean;
}

export function keyboardOwner(component: object | null): KeyboardOwner {
	if (component instanceof Editor || component instanceof Input) {
		return {
			keyboardScope: "edit",
			undoInput: () => {
				component.applyEdit("undo");
				return true;
			},
		};
	}
	return (component as KeyboardOwner | null) ?? {};
}

export function focusedComponent(tui: TUI): Component | null {
	return tui instanceof TuiAltScreen || tui instanceof TuiMainScreen ? tui.getFocusedComponent() : null;
}

/** Preserve controls and paste packets; normalize only encoded printable keys. */
export function localKey(data: string): string {
	return data.includes("\x1b[200~") ? data : (decodePrintableKey(data) ?? data);
}
