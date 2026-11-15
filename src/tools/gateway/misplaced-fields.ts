/**
 * A long nested object argument that the model closed one brace early leaves
 * its last fields at the top level, where a closed schema rejects them as
 * unknown. The validator names each field but not where it belongs, so a model
 * resent the same shape until the loop guard locked its tools (WTF-P campaign,
 * an extension's `record` call). This reads the schema, not the error text, so
 * it holds for any extension, MCP server or builtin with a closed object schema.
 */

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function properties(schema: JsonSchema): Record<string, unknown> | null {
	return isRecord(schema.properties) ? schema.properties : null;
}

function admitsObject(schema: unknown): boolean {
	if (!isRecord(schema)) return false;
	const type = schema.type;
	if (type === "object" || (Array.isArray(type) && type.includes("object"))) return true;
	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = schema[key];
		if (Array.isArray(branches) && branches.some(admitsObject)) return true;
	}
	return false;
}

function declaresField(schema: unknown, field: string): boolean {
	if (!isRecord(schema)) return false;
	const own = properties(schema);
	if (own !== null && Object.hasOwn(own, field)) return true;
	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = schema[key];
		if (Array.isArray(branches) && branches.some((branch) => declaresField(branch, field))) return true;
	}
	return false;
}

const quote = (name: string): string => `\`${name}\``;

/**
 * One line naming top-level fields the schema does not declare that sit beside
 * an object argument the call did send, or null when there are none. A field
 * the nested schema declares is named as belonging there; an opaque object
 * only gets the conditional advice, since the host cannot know its shape.
 */
export function misplacedFieldHint(schema: unknown, args: Readonly<Record<string, unknown>>): string | null {
	if (!isRecord(schema) || schema.additionalProperties !== false) return null;
	const declared = properties(schema);
	if (declared === null) return null;
	const unknown = Object.keys(args).filter((key) => !Object.hasOwn(declared, key));
	if (unknown.length === 0) return null;
	const containers = Object.keys(args).filter(
		(key) => Object.hasOwn(declared, key) && isRecord(args[key]) && admitsObject(declared[key]),
	);
	if (containers.length === 0) return null;
	const parts: string[] = [];
	const unplaced: string[] = [];
	for (const container of containers) {
		const fits = unknown.filter((field) => declaresField(declared[container], field));
		if (fits.length > 0)
			parts.push(`${fits.map(quote).join(", ")} ${fits.length === 1 ? "belongs" : "belong"} inside ${quote(container)}`);
	}
	for (const field of unknown) {
		if (!containers.some((container) => declaresField(declared[container], field))) unplaced.push(field);
	}
	if (unplaced.length > 0) {
		const beside =
			containers.length === 1
				? `${quote(containers[0] as string)} (an object)`
				: `${containers.map(quote).join(", ")} (objects)`;
		const one = unplaced.length === 1;
		const target = containers.length === 1 ? "inside it" : "inside one of them";
		parts.push(
			`${unplaced.map(quote).join(", ")} ${one ? "is not a top-level argument but sits" : "are not top-level arguments but sit"} beside ${beside}; if ${one ? "it belongs" : "they belong"} ${target}, move ${one ? "it" : "them"} there`,
		);
	}
	return `Misplaced fields: ${parts.join("; ")}. A nested object closed too early leaves its last fields at the top level.`;
}
