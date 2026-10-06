import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";

export interface SessionWorkspace {
	extensionId: string;
	workspaceId: string;
}

export function workspaceSessionPath(stateDir: string, sessionId: string): string {
	return join(stateDir, "extension-workspaces", `${encodeURIComponent(sessionId)}.json`);
}

export function writeSessionWorkspace(stateDir: string, sessionId: string, active: SessionWorkspace | null): void {
	safeResourceWrite(workspaceSessionPath(stateDir, sessionId), `${JSON.stringify(active)}\n`, { mode: 0o600 });
}

export function readSessionWorkspace(stateDir: string, sessionId: string): SessionWorkspace | null {
	try {
		const value: unknown = JSON.parse(readFileSync(workspaceSessionPath(stateDir, sessionId), "utf8"));
		if (
			value !== null &&
			typeof value === "object" &&
			"extensionId" in value &&
			"workspaceId" in value &&
			typeof value.extensionId === "string" &&
			typeof value.workspaceId === "string"
		)
			return { extensionId: value.extensionId, workspaceId: value.workspaceId };
	} catch {
		// No selection in old sessions; a malformed selection never grants a workspace.
	}
	return null;
}
