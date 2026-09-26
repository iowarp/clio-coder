import { createContext, useContext } from "react";
import type { NavigationArea } from "./navigation-area.js";

/** Workspace tools change the sidebar while the conversation keeps its identity and draft. */
export const WorkspaceChrome = createContext<{ openArea: (area: NavigationArea) => void } | null>(null);
export function useWorkspaceChrome() {
	return useContext(WorkspaceChrome);
}
