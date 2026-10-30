import { createHash } from "node:crypto";
import { canonicalJson } from "../../worker/protocol.js";

/**
 * Fingerprint of the immutable settings snapshot a dispatch was admitted
 * under. The whole document enters the digest: any setting that can change a
 * route, an authority, or a tool surface must invalidate an in-flight worker,
 * and enumerating a subset would silently exempt whatever was forgotten. The
 * journal's config records carry the same digest, so a receipt's fingerprint
 * resolves to the settings it names (#434).
 */
export function computeSettingsFingerprint(settings: unknown): string {
	return createHash("sha256")
		.update(`clio-coder.settings:${canonicalJson(settings)}`, "utf8")
		.digest("hex");
}
