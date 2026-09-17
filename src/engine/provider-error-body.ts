/**
 * pi-ai formats an HTTP error from the parsed JSON body and keeps only its first
 * 4000 characters. Clio's fetch wrapper sees the same response first, so the
 * discarded tail can be restored when the captured body provably is the one the
 * SDK truncated. Anything else leaves the SDK diagnostic unchanged.
 */
const SDK_BODY_CHARS = 4000;
const SDK_MARKER = /\.\.\. \[truncated (\d+) chars\]/u;
/** Bounds both the capture read and the restored diagnostic kept in the ledger. */
export const MAX_RESTORED_ERROR_BODY_CHARS = 65_536;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

/** Read a clone so the SDK still owns the original body. Never throws. */
export async function captureErrorBody(response: Response): Promise<string | null> {
	if (response.ok || response.body === null) return null;
	try {
		const reader = response.clone().body?.getReader();
		if (reader === undefined) return null;
		const decoder = new TextDecoder();
		let text = "";
		let bytes = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			// A body too large to hold cannot be compared exactly; keep the SDK text.
			if (bytes > MAX_CAPTURE_BYTES) {
				await reader.cancel().catch(() => {});
				return null;
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} catch {
		return null;
	}
}

export function restoreTruncatedErrorBody(message: string, capturedBody: string | null): string {
	if (capturedBody === null) return message;
	const marker = SDK_MARKER.exec(message);
	if (marker === null || marker.index < SDK_BODY_CHARS) return message;
	let parsed: unknown;
	try {
		parsed = JSON.parse(capturedBody);
	} catch {
		return message;
	}
	const start = marker.index - SDK_BODY_CHARS;
	const kept = message.slice(start, marker.index);
	const dropped = Number(marker[1]);
	// The openai SDK exposes the body's `error` member when present, else the body.
	const nested = typeof parsed === "object" && parsed !== null ? (parsed as { error?: unknown }).error : undefined;
	for (const candidate of [nested, parsed]) {
		if (typeof candidate !== "object" || candidate === null) continue;
		const full = JSON.stringify(candidate).trim();
		if (full.length - SDK_BODY_CHARS !== dropped || !full.startsWith(kept)) continue;
		const restored =
			full.length > MAX_RESTORED_ERROR_BODY_CHARS
				? `${full.slice(0, MAX_RESTORED_ERROR_BODY_CHARS)}... [truncated ${full.length - MAX_RESTORED_ERROR_BODY_CHARS} chars]`
				: full;
		return `${message.slice(0, start)}${restored}${message.slice(marker.index + marker[0].length)}`;
	}
	return message;
}
