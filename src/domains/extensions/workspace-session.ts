import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clioHomeWriteRefused } from "../../core/home-write-guard.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";

export interface SessionWorkspace {
	extensionId: string;
	workspaceId: string;
}

function workspaceSessionPath(stateDir: string, sessionId: string): string {
	return join(stateDir, "extension-workspaces", `${encodeURIComponent(sessionId)}.json`);
}

/** Selections a read-only process keeps instead of writing them to the Clio home, by file. */
const withheldSelections = new Map<string, string>();

export function writeSessionWorkspace(stateDir: string, sessionId: string, active: SessionWorkspace | null): void {
	const file = workspaceSessionPath(stateDir, sessionId);
	const encoded = `${JSON.stringify(active)}\n`;
	if (clioHomeWriteRefused(file)) withheldSelections.set(file, encoded);
	else safeResourceWrite(file, encoded, { mode: 0o600 });
}

export function readSessionWorkspace(stateDir: string, sessionId: string): SessionWorkspace | null {
	try {
		const file = workspaceSessionPath(stateDir, sessionId);
		const value: unknown = JSON.parse(withheldSelections.get(file) ?? readFileSync(file, "utf8"));
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
