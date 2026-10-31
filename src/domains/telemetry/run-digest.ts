import { createHash } from "node:crypto";
import type { RunSettled } from "../../core/telemetry/schemas.js";
import { canonicalJson } from "../prompts/hash.js";

/**
 * A finished run's identity: the sha256 of its run.settled payload as canonical JSON (#434). The payload names its
 * result object by digest, so the identity commits to what the run delivered too. Gate subjects, Scout sources and
 * plan sources cite it; a reader that acts on one checks it against the sealed record.
 */
export function runSettledDigest(payload: RunSettled): string {
	return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}
