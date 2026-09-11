import { SessionBuffer } from "../../contracts/session-projection.js";

const buffers = new Map<string, SessionBuffer>();
export function sessionBuffer(id: string) {
	let buffer = buffers.get(id);
	if (!buffer) {
		buffer = new SessionBuffer();
		buffers.set(id, buffer);
	}
	return buffer;
}
export function resetSessionBuffers() {
	buffers.clear();
}
