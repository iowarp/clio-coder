import { createContext, useContext } from "react";

/** What a page may ask of the workbench around it. */
export interface ShellApi {
	readonly sidebarCollapsed: boolean;
	/** Desktop collapses the rail; a phone opens it as a drawer. Pages call this and need not know which. */
	revealSidebar(): void;
	/** Start a task in the current project, or open the workspace chooser when there is none. */
	startTask(): void;
	openWorkspace(): void;
	openHelp(): void;
	readonly activeWorkspaceId: string | null;
	readonly starting: boolean;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi | null {
	return useContext(ShellContext);
}
