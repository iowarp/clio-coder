import { createContext, useContext } from "react";
import type { PaneView } from "./pane-model.js";

/** A part of a drill-in the pane can open at: the board's Decisions, for the terminal's `/decisions`. */
export type PaneSection = "decisions";

/** A view, or a view opened at one of its sections. */
export type PaneTarget = PaneView | { readonly view: PaneView; readonly section: PaneSection };

export function paneTargetParts(target: PaneTarget): { view: PaneView; section: PaneSection | null } {
	return typeof target === "string" ? { view: target, section: null } : target;
}

/** What a transcript card may ask of the pane beside it. */
export interface PaneActions {
	show(target: PaneTarget): void;
}

export const PaneContext = createContext<PaneActions | null>(null);

export function usePaneActions(): PaneActions | null {
	return useContext(PaneContext);
}
