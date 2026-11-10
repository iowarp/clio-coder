import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Launchers prove they hold the launch token instead of sending it, bound to the port they dialed, and
 * the app proves the same back. A listener squatting the app's port learns nothing that opens a client
 * at the real app on the other port, and a launcher ignores a listener that cannot answer.
 */
// Wide enough for the clock drift between this host and a fleet node it attaches to.
export const PROOF_WINDOW_MS = 120_000;
const SEEN_MAX = 1024;

const mac = (token: string, message: string) => createHmac("sha256", token).update(message).digest("base64url");
export const launcherProof = (token: string, nonce: string, port: number) =>
	mac(token, `clio-coder-gui/launcher/v1|${nonce}|${port}`);
export const serverProof = (token: string, nonce: string, port: number) =>
	mac(token, `clio-coder-gui/server/v1|${nonce}|${port}`);

/** Carries its issue time, so a proof kept by a squatter is refused once the window has passed, even after a restart. */
export function launcherNonce(now = Date.now()) {
	return `${now.toString(36)}.${randomBytes(32).toString("base64url")}`;
}
function issuedAt(nonce: string) {
	const match = /^([a-z0-9]{1,12})\.[A-Za-z0-9_-]{43}$/.exec(nonce);
	return match ? Number.parseInt(match[1] as string, 36) : null;
}
export function sameSecret(expected: string, supplied: string) {
	const a = Buffer.from(expected),
		b = Buffer.from(supplied);
	return a.length === b.length && timingSafeEqual(a, b);
}

export class LaunchProofs {
	private readonly seen = new Map<string, number>();
	constructor(
		private readonly token: string,
		private readonly now: () => number = Date.now,
	) {}

	/** The server's answer to a fresh, valid proof for `port`; null for anything else, including a replay. */
	verify(nonce: string, proof: string, port: number): string | null {
		const now = this.now();
		const at = issuedAt(nonce);
		if (at === null || Math.abs(now - at) > PROOF_WINDOW_MS) return null;
		if (!sameSecret(launcherProof(this.token, nonce, port), proof)) return null;
		for (const [seen, expires] of this.seen) if (expires <= now) this.seen.delete(seen);
		if (this.seen.has(nonce)) return null;
		while (this.seen.size >= SEEN_MAX) this.seen.delete(this.seen.keys().next().value as string);
		this.seen.set(nonce, at + PROOF_WINDOW_MS);
		return serverProof(this.token, nonce, port);
	}
}
