/**
 * Hoists the schema shapes an OpenAPI document repeats into `components.schemas`, so each shape is written once and
 * referenced everywhere else (#434). The read-model DTOs repeat the quantity, fact and fact-sum shapes dozens of
 * times each, and every operation inlines the Problem schema; without this the document carries each copy.
 *
 * The hoist is deterministic: a shape is keyed by its canonical JSON (sorted keys), named from its kind, its first
 * property names and a structural fingerprint, assigned in sorted key order, and the component table is sorted, so
 * regenerating the document twice yields the same bytes and tests/openapi.test.ts can detect drift by comparison.
 * The TypeBox schemas themselves are untouched: they also drive runtime validation, and `$id` references would
 * change how Value.Check resolves them for every consumer.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** A shape repeated this often, and at least this long in canonical form, is worth a component. */
const MIN_REPEATS = 3;
const MIN_LENGTH = 64;
/** Only structured shapes are hoisted; a repeated string or number schema stays inline, where a generated client reads it as a primitive. */
const structured = (key: string) =>
	/^\{"(?:anyOf|enum|items|properties)"/.test(key) || /,"(?:anyOf|enum|items|properties)":/.test(key);

const isObject = (value: Json | undefined): value is JsonObject =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function canonical(value: Json): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isObject(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key] as Json)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/** FNV-1a over the code units, under two seeds, as 16 hex characters; the browser surface has no node:crypto. */
function fingerprint(text: string): string {
	const fnv = (seed: number) => {
		let hash = seed >>> 0;
		for (let index = 0; index < text.length; index += 1) {
			hash ^= text.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, "0");
	};
	return fnv(0x811c9dc5) + fnv(0x9747b28c);
}

function capitalize(word: string): string {
	return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
}

/** `Object_display_fact_ref_1a2b3c4d` or `String_1a2b3c4d`: readable where a shape has a kind, unique through the fingerprint. */
function shapeName(key: string): string {
	const shape = JSON.parse(key) as { properties?: JsonObject; anyOf?: Json; enum?: Json; type?: Json };
	const kind = shape.properties
		? "Object"
		: shape.anyOf
			? "Union"
			: shape.enum
				? "Enum"
				: typeof shape.type === "string"
					? capitalize(shape.type)
					: "Shape";
	const keys = Object.keys(shape.properties ?? {})
		.slice(0, 3)
		.join("_");
	return `${kind}${keys ? `_${keys}` : ""}_${fingerprint(key).slice(0, 8)}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

interface Slot {
	parent: JsonObject;
	key: string;
	/** A component is the home of its shape and stays a body; an operation slot may become a reference. */
	component: boolean;
}

/** Every position that holds a schema: each component, and each operation's parameter, body and response schemas. */
function schemaSlots(document: JsonObject): Slot[] {
	const slots: Slot[] = [];
	const components = document.components;
	const schemas = isObject(components) && isObject(components.schemas) ? components.schemas : null;
	if (schemas) for (const key of Object.keys(schemas)) slots.push({ parent: schemas, key, component: true });
	const contentSlots = (holder: Json | undefined) => {
		if (!isObject(holder) || !isObject(holder.content)) return;
		for (const media of Object.values(holder.content))
			if (isObject(media) && "schema" in media) slots.push({ parent: media, key: "schema", component: false });
	};
	const paths = isObject(document.paths) ? document.paths : {};
	for (const item of Object.values(paths)) {
		if (!isObject(item)) continue;
		for (const operation of Object.values(item)) {
			if (!isObject(operation)) continue;
			if (Array.isArray(operation.parameters))
				for (const parameter of operation.parameters)
					if (isObject(parameter) && "schema" in parameter)
						slots.push({ parent: parameter, key: "schema", component: false });
			contentSlots(operation.requestBody);
			if (isObject(operation.responses))
				for (const response of Object.values(operation.responses)) {
					contentSlots(response);
					if (isObject(response) && isObject(response.headers))
						for (const header of Object.values(response.headers))
							if (isObject(header) && "schema" in header) slots.push({ parent: header, key: "schema", component: false });
				}
		}
	}
	return slots;
}

/** The document keeps its static shape: the hoist only rewrites schema positions inside it. */
export function hoistSharedSchemas<T extends object>(input: T): T {
	const document = JSON.parse(JSON.stringify(input)) as JsonObject;
	if (!isObject(document.components)) document.components = {};
	const componentsHolder = document.components as JsonObject;
	if (!isObject(componentsHolder.schemas)) componentsHolder.schemas = {};
	const components = componentsHolder.schemas as JsonObject;
	const slots = schemaSlots(document);
	const counts = new Map<string, number>();
	const count = (node: Json) => {
		if (Array.isArray(node)) {
			for (const item of node) count(item);
			return;
		}
		if (!isObject(node)) return;
		const key = canonical(node);
		counts.set(key, (counts.get(key) ?? 0) + 1);
		for (const value of Object.values(node)) count(value);
	};
	for (const slot of slots) count(slot.parent[slot.key] as Json);
	// A named component is the home of its own shape: an inline copy of Problem references Problem.
	const names = new Map<string, string>();
	for (const [name, schema] of Object.entries(components)) names.set(canonical(schema), name);
	const taken = new Set(Object.keys(components));
	const candidates = [...counts]
		.filter(([key, repeats]) => repeats >= MIN_REPEATS && key.length >= MIN_LENGTH && structured(key) && !names.has(key))
		.map(([key]) => key)
		.sort();
	for (const key of candidates) {
		const base = shapeName(key);
		let name = base;
		for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}_${suffix}`;
		taken.add(name);
		names.set(key, name);
	}
	const hoisted: JsonObject = {};
	const transform = (node: Json, home: boolean): Json => {
		if (Array.isArray(node)) return node.map((item) => transform(item, false));
		if (!isObject(node)) return node;
		const name = home ? undefined : names.get(canonical(node));
		const body: JsonObject = {};
		for (const [key, value] of Object.entries(node)) body[key] = transform(value, false);
		if (name === undefined) return body;
		if (!(name in components) && !(name in hoisted)) hoisted[name] = body;
		return { $ref: `#/components/schemas/${name}` };
	};
	for (const slot of slots) slot.parent[slot.key] = transform(slot.parent[slot.key] as Json, slot.component);
	componentsHolder.schemas = Object.fromEntries(
		[...Object.entries(components), ...Object.entries(hoisted)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
	return document as unknown as T;
}
