import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../domains/safety/call-target.js";

/**
 * Keys whose text may keep its line structure: a description is prose that
 * renders as Markdown under a fact table. Every other string is one line.
 */
const MULTILINE_KEYS = new Set(["description", "lesson", "message", "text"]);

/**
 * A deep copy of `value` with every string neutralized for display: terminal
 * controls, bidi overrides and zero-width characters removed, control bytes
 * replaced by a placeholder. Overlays apply it once to the records they
 * project, so a field that a later change adds to a row or a pane is covered
 * without a call at every use. Maps, arrays and plain objects are walked;
 * functions and class instances pass through untouched.
 */
export function displaySafe<T>(value: T): T {
	return walk(value, undefined) as T;
}

function walk(value: unknown, key: string | undefined): unknown {
	if (typeof value === "string") {
		return key !== undefined && MULTILINE_KEYS.has(key)
			? sanitizeMultilineDisplayText(value).text
			: sanitizeCallTargetText(value);
	}
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((entry) => walk(entry, key));
	if (value instanceof Map) {
		const out = new Map<unknown, unknown>();
		for (const [mapKey, entry] of value) out.set(walk(mapKey, undefined), walk(entry, undefined));
		return out;
	}
	if (value instanceof Set) return new Set([...value].map((entry) => walk(entry, undefined)));
	if (value instanceof Date) return value;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return value;
	const out: Record<string, unknown> = {};
	for (const [field, entry] of Object.entries(value as Record<string, unknown>)) out[field] = walk(entry, field);
	return out;
}
