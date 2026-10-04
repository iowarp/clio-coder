// Whether the server has refused this browser's launch token. A refused token never recovers on its
// own, so the shell stops retrying and asks for a fresh link instead of reading "Reconnecting…" forever.

import { useSyncExternalStore } from "react";

let rejected = false;
const listeners = new Set<() => void>();

export function markTokenRejected() {
	if (rejected) return;
	rejected = true;
	for (const listener of listeners) listener();
}
export const tokenRejected = () => rejected;
/** Runs once when the token is refused, or at once if it already was. Returns the unsubscribe. */
export function onTokenRejected(listener: () => void) {
	if (rejected) {
		listener();
		return () => {};
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
export function useTokenRejected() {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		tokenRejected,
		() => false,
	);
}

/** The token inside a pasted launch link, or a bare token. Null when the text holds neither. */
export function tokenFromLaunchInput(text: string): string | null {
	const input = text.trim();
	if (/https?:\/\//i.test(input) && !originFromLaunchInput(input)) return null;
	const fromHash = /[#&?]token=([\w-]{1,256})(?:$|[&#\s])/.exec(`${input} `)?.[1];
	const token = fromHash ?? (/^[\w-]{32,256}$/.test(input) ? input : null);
	return token ?? null;
}

/** A pasted local launch link also carries the current port; never attach its token to the old origin. */
export function originFromLaunchInput(text: string): string | null {
	try {
		const url = new URL(text.match(/https?:\/\/[^\s]+/i)?.[0] ?? text.trim());
		return url.protocol === "http:" &&
			["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
			!url.username &&
			!url.password
			? url.origin
			: null;
	} catch {
		return null;
	}
}
