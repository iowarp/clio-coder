import { createHash } from "node:crypto";

/**
 * The effect descriptor a worker's parked call crosses to the orchestrator
 * for a live grant (Phase D). The grant broker evaluates the descriptor as
 * the main agent's own call and binds the decision to its digest, so the
 * worker can check that a decision names exactly the call it parked.
 *
 * Long string values are replaced by their digest and length. Admission reads
 * paths, commands and short options; bulk content (a file body, an edit's
 * replacement text) never decides a disposition, and hashing it keeps the
 * descriptor inside the control-lane frame bound without dropping the binding.
 */

/** Strings at or under this many UTF-8 bytes cross verbatim; longer ones cross as digests. */
export const GRANT_EFFECT_INLINE_STRING_BYTES = 2048;

export interface GrantEffectDescriptor {
	tool: string;
	args: Record<string, unknown>;
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonical(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of Object.keys(record).sort()) {
			const child = record[key];
			if (child === undefined) continue;
			parts.push(`${JSON.stringify(key)}:${canonical(child)}`);
		}
		return `{${parts.join(",")}}`;
	}
	return "null";
}

function digestLongStrings(value: unknown, depth: number): unknown {
	if (typeof value === "string") {
		const bytes = Buffer.byteLength(value, "utf8");
		return bytes > GRANT_EFFECT_INLINE_STRING_BYTES ? { $sha256: sha256(value), bytes } : value;
	}
	if (depth > 8) return { $sha256: sha256(canonical(value)), bytes: -1 };
	if (Array.isArray(value)) return value.map((entry) => digestLongStrings(entry, depth + 1));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (child === undefined) continue;
			out[key] = digestLongStrings(child, depth + 1);
		}
		return out;
	}
	return value;
}

/** The descriptor for one parked call. Deterministic for equal calls. */
export function grantEffectDescriptor(tool: string, args: Record<string, unknown> | undefined): GrantEffectDescriptor {
	return { tool, args: digestLongStrings(args ?? {}, 0) as Record<string, unknown> };
}

/** The argument digest a decision must name: sha256 over the canonical descriptor. */
export function grantEffectDigest(effect: GrantEffectDescriptor): string {
	return sha256(`clio-coder.grantEffect:${canonical({ tool: effect.tool, args: effect.args })}`);
}
