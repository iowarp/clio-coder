import type { JournalEventName } from "../../core/telemetry/events.js";
import { journalDefinition } from "../../core/telemetry/events.js";
import { PromptStructureObjectSchema } from "./objects.js";
import type { FieldProjection } from "./share-projection.js";
import { SHARE_EVENT_PROJECTIONS, SHARE_OBJECT_PROJECTIONS } from "./share-projection.js";

/**
 * Whether the share allowlist is sound by construction (#434). A `keep` copies a value verbatim, so it is safe only
 * where the schema already bounds what the value can say: every string under a `keep` must be a vocabulary, a literal
 * or a pattern-constrained id, and every object under it must have fixed keys or keys a closed pattern bounds. Any
 * other string is a channel for paths, credentials and prose, and must be projected instead. The boundary check runs
 * this over every shareable journal event and every structural object with a schema, so a field that loosens its
 * schema, or a table entry that keeps one, fails lint rather than leaking from the next share.
 */

type Schema = Readonly<Record<string, unknown>>;

const asSchema = (value: unknown): Schema | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Schema) : null;

/** A pattern bounds a string when it is anchored at both ends and admits no wildcard or negated class. */
function closedPattern(pattern: string): boolean {
	if (!pattern.startsWith("^") || !pattern.endsWith("$")) return false;
	if (/\\[sSwWD]|\[\^/u.test(pattern)) return false;
	return !pattern
		.replace(/\\./gu, "")
		.replace(/\[[^\]]*\]/gu, "")
		.includes(".");
}

function branches(schema: Schema): Schema[] | null {
	const union = schema.anyOf ?? schema.oneOf ?? schema.allOf;
	return Array.isArray(union) ? union.map((branch) => asSchema(branch) ?? {}) : null;
}

/** Every way a `keep` over this schema could carry an unbounded string or key. */
function keepErrors(schema: Schema, path: string, errors: string[]): void {
	if (Array.isArray(schema.enum) || Object.hasOwn(schema, "const")) return;
	const union = branches(schema);
	if (union) {
		for (const branch of union) keepErrors(branch, path, errors);
		return;
	}
	switch (schema.type) {
		case "number":
		case "integer":
		case "boolean":
		case "null":
			return;
		case "string":
			if (typeof schema.pattern !== "string" || !closedPattern(schema.pattern))
				errors.push(`${path}: a free string under keep`);
			return;
		case "array": {
			// A tuple lists its items' schemas, in `items` (draft 7, which TypeBox emits) or `prefixItems`.
			const tuple = Array.isArray(schema.items)
				? schema.items
				: Array.isArray(schema.prefixItems)
					? schema.prefixItems
					: null;
			if (tuple) for (const item of tuple) keepErrors(asSchema(item) ?? {}, `${path}[]`, errors);
			else if (asSchema(schema.items)) keepErrors(asSchema(schema.items) as Schema, `${path}[]`, errors);
			else errors.push(`${path}: an unconstrained array under keep`);
			return;
		}
		case "object": {
			for (const [key, child] of Object.entries(asSchema(schema.properties) ?? {}))
				keepErrors(asSchema(child) ?? {}, `${path}.${key}`, errors);
			for (const [key, child] of Object.entries(asSchema(schema.patternProperties) ?? {})) {
				if (!closedPattern(key)) errors.push(`${path}: dynamic keys under keep`);
				keepErrors(asSchema(child) ?? {}, `${path}[*]`, errors);
			}
			if (schema.additionalProperties !== false && schema.patternProperties === undefined)
				errors.push(`${path}: an open object under keep`);
			return;
		}
		default:
			errors.push(`${path}: an unconstrained value under keep`);
	}
}

function projectionErrors(schema: Schema, projection: FieldProjection, path: string, errors: string[]): void {
	if (projection === "keep") {
		keepErrors(schema, path, errors);
		return;
	}
	if (projection === "token-keys") {
		const values = [
			...Object.values(asSchema(schema.patternProperties) ?? {}),
			...(asSchema(schema.additionalProperties) ? [schema.additionalProperties] : []),
		];
		if (values.length === 0 || schema.properties !== undefined)
			errors.push(`${path}: token-keys over a schema that is not a dictionary`);
		for (const value of values) keepErrors(asSchema(value) ?? {}, `${path}[*]`, errors);
		return;
	}
	if (typeof projection === "string") return;
	const fields = new Set<string>();
	const visit = (node: Schema, at: string): void => {
		const union = branches(node);
		if (union) {
			for (const branch of union) visit(branch, at);
			return;
		}
		if (node.type === "array") {
			visit(asSchema(node.items) ?? {}, `${at}[]`);
			return;
		}
		if (node.type === "null" || node.type === "number" || node.type === "integer" || node.type === "boolean") return;
		if (node.type !== "object") {
			errors.push(`${at}: a field projection over a value that is not an object`);
			return;
		}
		for (const [key, child] of Object.entries(asSchema(node.properties) ?? {})) {
			fields.add(key);
			const field = projection[key];
			if (field === undefined) errors.push(`${at}.${key}: a field the share projection does not classify`);
			else projectionErrors(asSchema(child) ?? {}, field, `${at}.${key}`, errors);
		}
	};
	visit(schema, path);
	for (const key of Object.keys(projection))
		if (!fields.has(key)) errors.push(`${path}.${key}: a projected field the schema does not declare`);
}

/** The structural objects whose shape a schema fixes; tool schemas and settings are projected by kind instead. */
const OBJECT_SCHEMAS: Readonly<Record<string, Schema>> = {
	"prompt-structure": PromptStructureObjectSchema as unknown as Schema,
};

/** Every unsound entry in the share allowlist, as `<event or object>.<field path>: <why>`; empty when sound. */
export function shareProjectionErrors(): string[] {
	const errors: string[] = [];
	for (const [name, projection] of Object.entries(SHARE_EVENT_PROJECTIONS))
		projectionErrors(
			journalDefinition(name as JournalEventName).schema as Schema,
			projection as FieldProjection,
			name,
			errors,
		);
	for (const [subject, schema] of Object.entries(OBJECT_SCHEMAS)) {
		const projection = SHARE_OBJECT_PROJECTIONS[subject];
		if (projection === undefined) errors.push(`${subject}: a structural object the share projection does not admit`);
		else projectionErrors(schema, projection, subject, errors);
	}
	return errors;
}
