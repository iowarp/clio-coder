import { SessionBuffer } from "../../contracts/session-projection.js";

/** Per-session reads answered by the session's agent process, which a load or a resume replaces. */
export const SESSION_CACHES = [
	"session-capabilities",
	"session-commands",
	"session-queue",
	"session-settings",
	"session-targets",
	"session-autonomy",
	"session-context",
	"session-context-work",
	"session-context-push",
	"session-usage",
	"session-target-probe",
	"session-board",
	"session-tree",
	"session-artifacts",
	"session-artifact",
	"session-extensions",
	"session-interview",
] as const;

const buffers = new Map<string, SessionBuffer>();
const scopes = new Map<string, number>();
let nextScope = 0;
/** A new runtime or branch must never reuse the previous path's placeholder accounting. */
export function sessionReadScope(id: string): number {
	let scope = scopes.get(id);
	if (scope === undefined) {
		scope = ++nextScope;
		if (scopes.size >= 64) scopes.delete(scopes.keys().next().value ?? "");
		scopes.set(id, scope);
	}
	return scope;
}
export function advanceSessionReadScope(id: string) {
	scopes.delete(id);
	return sessionReadScope(id);
}
export function sessionBuffer(id: string) {
	let buffer = buffers.get(id);
	if (!buffer) {
		if (buffers.size >= 32) {
			const oldest = buffers.keys().next().value;
			if (oldest) buffers.delete(oldest);
		}
		buffer = new SessionBuffer();
	}
	buffers.delete(id);
	buffers.set(id, buffer);
	return buffer;
}
export function resetSessionBuffers() {
	buffers.clear();
	scopes.clear();
}
