/**
 * `run --output-schema` (SPEC 6.8): the host's structured finish. The schema is checked at preflight, the final
 * answer is parsed and validated by the host with no prose mining, and the main agent gets one repair turn that may
 * call no tool. The validator (TypeBox `Value`) loads by dynamic import only when a run gives a schema, so nothing
 * here widens the instant shell's Stage 0 closure.
 */
import { readFileSync, statSync } from "node:fs";
import { RESPONSE_SCHEMA_MAX_SERIALIZED_BYTES } from "../core/response-schema.js";
import type { TurnConstraints } from "../core/turn-constraints.js";

/** Every `--output-schema` refusal starts with this, which the v2 envelope reads as cause `schema_unsupported`. */
export const OUTPUT_SCHEMA_REFUSAL_PREFIX = "clio-coder run: --output-schema: ";

/** Who enforced the schema: the host alone, or the host behind a provider's response-schema dialect. */
export type StructuredEnforcement = "host" | "host+provider";

export type OutputSchemaLoad = { ok: true; schema: Record<string, unknown> } | { ok: false; reason: string };

export type StructuredVerdict =
	| { ok: true; value: Record<string, unknown>; json: string }
	| { ok: false; errors: string[] };

const MAX_ERRORS = 20;

/**
 * Read and check the schema file: JSON, at most 64 KiB, an object root (`type: "object"`), `$ref` only into this
 * document's `#/$defs/`, and a schema the host validator accepts. No provider dialect subset applies here: the host,
 * not the provider, enforces the schema.
 */
export async function loadOutputSchema(file: string): Promise<OutputSchemaLoad> {
	let raw: string;
	try {
		if (statSync(file).size > RESPONSE_SCHEMA_MAX_SERIALIZED_BYTES)
			return { ok: false, reason: `${file} is larger than ${RESPONSE_SCHEMA_MAX_SERIALIZED_BYTES} bytes` };
		raw = readFileSync(file, "utf8");
	} catch (error) {
		return { ok: false, reason: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` };
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		return { ok: false, reason: `${file} is not JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { ok: false, reason: 'the schema must be a JSON object whose root type is "object"' };
	const root = (value as Record<string, unknown>).type;
	if (root !== "object")
		return {
			ok: false,
			reason: `the schema root type must be "object" (got ${root === undefined ? "none" : JSON.stringify(root)})`,
		};
	const ref = foreignRef(value);
	if (ref !== null) return { ok: false, reason: `$ref ${JSON.stringify(ref)} is not a #/$defs/ reference in this file` };
	const schema = value as Record<string, unknown>;
	try {
		const { Value } = await import("typebox/value");
		Value.Check(schema, {});
	} catch (error) {
		return {
			ok: false,
			reason: `the host validator cannot use this schema: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return { ok: true, schema };
}

/** The first `$ref` (or `$dynamicRef`) that leaves this document's `#/$defs/`, else null. */
function foreignRef(value: unknown): string | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = foreignRef(item);
			if (found !== null) return found;
		}
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	for (const [key, child] of Object.entries(value)) {
		if ((key === "$ref" || key === "$dynamicRef") && (typeof child !== "string" || !child.startsWith("#/$defs/")))
			return typeof child === "string" ? child : JSON.stringify(child);
		const found = foreignRef(child);
		if (found !== null) return found;
	}
	return null;
}

/** The one line and the schema appended to the task text; no tool or system fragment varies (D8). */
export function outputSchemaInstruction(schema: Record<string, unknown>): string {
	return [
		"Finish with your final answer as one JSON object, and nothing else, that validates against this JSON Schema:",
		"```json",
		JSON.stringify(schema),
		"```",
	].join("\n");
}

/**
 * The text the host parses: the whole trimmed answer, or the body of its single fenced block when the answer is
 * exactly one fenced block. Nothing is mined out of surrounding prose.
 */
export function structuredAnswerBody(answer: string): string {
	const trimmed = answer.trim();
	const fenced = /^```[A-Za-z0-9_-]*[ \t]*\n([\s\S]*?)\n?```$/u.exec(trimmed);
	if (fenced === null) return trimmed;
	const body = fenced[1] ?? "";
	return body.includes("```") ? trimmed : body.trim();
}

/** Parse the answer as one JSON object and validate it against the schema. */
export async function validateStructuredAnswer(
	schema: Record<string, unknown>,
	answer: string,
): Promise<StructuredVerdict> {
	const body = structuredAnswerBody(answer);
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return { ok: false, errors: ["the answer is not one JSON object (it does not parse as JSON)"] };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { ok: false, errors: ["the answer must be a JSON object"] };
	const { Value } = await import("typebox/value");
	if (Value.Check(schema, value)) return { ok: true, value: value as Record<string, unknown>, json: body };
	const errors: string[] = [];
	for (const error of Value.Errors(schema, value)) {
		const at = error.instancePath.length > 0 ? error.instancePath : "/";
		errors.push(`${at}: ${error.message}`);
		if (errors.length >= MAX_ERRORS) break;
	}
	return { ok: false, errors: errors.length > 0 ? errors : ["the answer does not match the schema"] };
}

/** The repair turn's text: the validator's errors and the same demand once more. */
export function structuredRepairPrompt(errors: ReadonlyArray<string>): string {
	return [
		"Your last answer did not validate against the required JSON Schema:",
		...errors.map((error) => `- ${error}`),
		"Reply again with only the corrected JSON object. Do not call any tool.",
	].join("\n");
}

/** The repair turn's scope: the run's own scope under a tool ceiling of none, in answer mode. */
export function structuredRepairConstraints(base: TurnConstraints | undefined): TurnConstraints {
	return {
		...base,
		mode: "answer",
		allowedTools: [],
		toolSurfaceSources: [
			...(base?.toolSurfaceSources ?? []),
			{
				tools: [],
				source: "--output-schema repair turn",
				remedy: "The repair turn answers from what the run already found; it calls no tool.",
			},
		],
	};
}

/** The exit-1 sentence for an answer that still does not match. */
export function schemaMismatchMessage(errors: ReadonlyArray<string>): string {
	return `clio-coder run: schema_mismatch: the final answer does not match --output-schema: ${errors.join("; ")}`;
}
