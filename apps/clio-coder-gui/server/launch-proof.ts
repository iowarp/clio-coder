import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Launchers prove they hold the launch token instead of sending it, over a single-use challenge the app
 * issued and the port they dialed, and the app proves the same back. A listener squatting the app's port
 * can only collect a proof over a challenge it made up, which the real app never issued, so the proof
 * opens nothing there, before or after a restart (R1-safety-secrets-06).
 */
const mac = (token: string, message: string) => createHmac("sha256", token).update(message).digest("base64url");
export const launcherProof = (token: string, challenge: string, port: number) =>
	mac(token, `clio-coder-gui/launcher/v2|${challenge}|${port}`);
export const serverProof = (token: string, challenge: string, port: number) =>
	mac(token, `clio-coder-gui/server/v2|${challenge}|${port}`);

export function sameSecret(expected: string, supplied: string) {
	const a = Buffer.from(expected),
		b = Buffer.from(supplied);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** The server's answer to a valid proof for `port` over a challenge the caller has already spent; null otherwise. */
export function answerLaunchProof(token: string, challenge: string, proof: string, port: number): string | null {
	return sameSecret(launcherProof(token, challenge, port), proof) ? serverProof(token, challenge, port) : null;
}
