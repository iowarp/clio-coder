import { Type } from "typebox";

/**
 * Compact string-enum schema. TypeBox unions of literals serialize as a
 * verbose `anyOf` of per-value `const` objects; the plain JSON Schema `enum`
 * keyword carries the same constraint in a fraction of the schema tokens,
 * which matters because every tool schema rides in the prompt prefix.
 */
export function stringEnum<T extends string>(values: ReadonlyArray<T>, description?: string) {
	return Type.Unsafe<T>({
		type: "string",
		enum: [...values],
		...(description !== undefined ? { description } : {}),
	});
}
