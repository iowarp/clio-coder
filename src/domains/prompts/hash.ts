import { createHash } from "node:crypto";

/**
 * Lowercase-hex SHA-256 of a UTF-8 string.
 *
 * Used as the single hash primitive for prompt reproducibility. The prompts
 * domain wraps this together with `canonicalJson` so that any structural input
 * (fragment manifests, rendered prompt text) lands on a byte-identical hash
 * whenever the underlying content is equivalent.
 */
export function sha256(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Canonical JSON serialization with stable key order and no whitespace.
 *
 * Object keys are sorted recursively; arrays preserve their element order.
 * Primitives (string, number, boolean, null) serialize via JSON.stringify.
 * Undefined values in objects are dropped; undefined array entries become null
 * (matching standard JSON.stringify behavior for arrays). Non-finite numbers
 * and symbols throw, because they cannot be represented deterministically.
 */
export function canonicalJson(value: unknown): string {
	return serialize(value);
}

function serialize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`canonicalJson: non-finite number ${String(value)} is not representable`);
		}
		return JSON.stringify(value);
	}
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "bigint") {
		throw new Error("canonicalJson: bigint is not representable");
	}
	if (typeof value === "symbol" || typeof value === "function") {
		throw new Error(`canonicalJson: ${typeof value} is not representable`);
	}
	if (value === undefined) {
		throw new Error("canonicalJson: undefined is not representable at root");
	}
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (let i = 0; i < value.length; i++) {
			// `i in value` distinguishes a real `undefined` from a sparse hole;
			// both serialize as `null` to match JSON.stringify's array behavior.
			if (!(i in value) || value[i] === undefined) {
				parts.push("null");
				continue;
			}
			parts.push(serialize(value[i]));
		}
		return `[${parts.join(",")}]`;
	}
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		const parts: string[] = [];
		for (const key of keys) {
			const child = obj[key];
			if (child === undefined) continue;
			parts.push(`${JSON.stringify(key)}:${serialize(child)}`);
		}
		return `{${parts.join(",")}}`;
	}
	throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}
