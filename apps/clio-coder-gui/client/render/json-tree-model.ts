/** Past this size a JSON text stays text: parsing it on the main thread would cost a visible frame. */
export const JSON_TREE_MAX_CHARS = 1_000_000;
/** Children an open node shows before it offers the rest in steps of the same size. */
export const JSON_TREE_PAGE = 100;

export type JsonContainer = Record<string, unknown> | unknown[];

/**
 * The parsed value when `text` is a JSON object or array within the size bound, else undefined. A scalar
 * has nothing to fold, so it is not a tree.
 */
export function parseJsonContainer(text: string): JsonContainer | undefined {
	if (text.length > JSON_TREE_MAX_CHARS) return undefined;
	const start = text.search(/\S/u);
	if (start < 0 || (text[start] !== "{" && text[start] !== "[")) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null ? (value as JsonContainer) : undefined;
	} catch {
		return undefined;
	}
}

/** What a folded node says about itself: `{3 keys}`, `[1 item]`. */
export function jsonSummary(value: JsonContainer): string {
	if (Array.isArray(value)) return `[${value.length} ${value.length === 1 ? "item" : "items"}]`;
	const keys = Object.keys(value).length;
	return `{${keys} ${keys === 1 ? "key" : "keys"}}`;
}

export type JsonScalarKind = "string" | "number" | "boolean" | "null";

export function jsonScalar(value: unknown): { kind: JsonScalarKind; text: string } {
	if (value === null) return { kind: "null", text: "null" };
	if (typeof value === "string") return { kind: "string", text: JSON.stringify(value) };
	if (typeof value === "number") return { kind: "number", text: String(value) };
	return { kind: "boolean", text: String(value) };
}
