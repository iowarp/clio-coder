import { StringEnum } from "../engine/ai.js";

/**
 * Compact string-enum schema. pi-ai's `StringEnum` owns the shape: a plain
 * JSON Schema `enum` on `type: "string"` instead of TypeBox's `anyOf` of
 * per-value `const` objects, which every provider accepts and which costs a
 * fraction of the schema tokens in the prompt prefix. This wrapper only keeps
 * Clio's positional `description` argument for the tool specs that call it.
 */
export function stringEnum<T extends string>(values: ReadonlyArray<T>, description?: string) {
	return StringEnum(values as readonly T[], description !== undefined ? { description } : undefined);
}
