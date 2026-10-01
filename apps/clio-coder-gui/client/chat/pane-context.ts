import { createContext, useContext } from "react";
import type { PaneView } from "./pane-model.js";

/** What a transcript card may ask of the pane beside it. */
export interface PaneActions {
	show(view: PaneView): void;
}

export const PaneContext = createContext<PaneActions | null>(null);

export function usePaneActions(): PaneActions | null {
	return useContext(PaneContext);
}
