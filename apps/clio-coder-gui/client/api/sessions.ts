import { SessionBuffer } from "../../contracts/session-projection.js";

/** Per-session reads answered by the session's agent process, which a load or a resume replaces. */
export const SESSION_CACHES = [
	"session-capabilities",
	"session-commands",
	"session-queue",
	"session-settings",
	"session-targets",
	"session-autonomy",
] as const;

const buffers = new Map<string, SessionBuffer>();
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
}
