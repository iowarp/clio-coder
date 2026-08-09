export const RESPONSE_SCHEMA_MAX_SERIALIZED_BYTES = 64 * 1024;

/**
 * The one runtime whose wire dialect carries a JSON-schema response constraint.
 *
 * This is a name check rather than a capability check, deliberately. The
 * constraint travels as `response_format: { type: "json_object", schema }`,
 * which is llama-server's own spelling and not the openai-completions standard
 * (`type: "json_schema"` with a nested `json_schema` object). A generic
 * OpenAI-compatible gateway accepts that request, ignores the unrecognized
 * `schema` key, and returns HTTP 200 with unconstrained JSON, so widening this
 * to the api family would convert a clean refusal into a silent
 * non-enforcement. lmstudio-native declares `structuredOutputs: "json-schema"`
 * truthfully and is still excluded here, because Clio has no dialect for its
 * transport. Widen this only together with a dialect for the runtime added.
 */
export const RESPONSE_SCHEMA_RUNTIME_ID = "llamacpp";

/** Whether this runtime speaks the dialect above. Transport shape, not capability. */
export function runtimeSpeaksResponseSchemaDialect(runtime: { id: string; kind: string; apiFamily: string }): boolean {
	return (
		runtime.id === RESPONSE_SCHEMA_RUNTIME_ID && runtime.kind === "http" && runtime.apiFamily === "openai-completions"
	);
}

/**
 * Admission-time signal that the resolved worker runtime cannot enforce a
 * response schema. A caller that treats native enforcement as an optimization
 * may retry without the schema only after receiving this exact error type.
 */
export class UnsupportedResponseSchemaError extends Error {
	readonly code = "UNSUPPORTED_RESPONSE_SCHEMA";

	constructor(message: string) {
		super(message);
		this.name = "UnsupportedResponseSchemaError";
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

const SUPPORTED_SCHEMA_KEYS = new Set(["type", "properties", "required", "items", "additionalProperties"]);
const SUPPORTED_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function definesToJson(value: object): boolean {
	let current: object | null = value;
	while (current) {
		if (Object.getOwnPropertyDescriptor(current, "toJSON")) return true;
		current = Object.getPrototypeOf(current) as object | null;
	}
	return false;
}

function jsonDataError(value: unknown): string | null {
	type Frame = { value: unknown; path: string; exit?: object };
	const stack: Frame[] = [{ value, path: "$" }];
	const active = new Set<object>();

	while (stack.length > 0) {
		const frame = stack.pop();
		if (!frame) break;
		if (frame.exit) {
			active.delete(frame.exit);
			continue;
		}

		const current = frame.value;
		if (current === null || typeof current === "string" || typeof current === "boolean") continue;
		if (typeof current === "number") {
			if (!Number.isFinite(current)) return `${frame.path} must be a finite number`;
			continue;
		}
		if (typeof current !== "object") return `${frame.path} contains a non-JSON value`;
		if (active.has(current)) return `${frame.path} contains a circular reference`;

		if (!Array.isArray(current) && !isPlainObject(current)) {
			return `${frame.path} must contain only plain objects and arrays`;
		}
		if (definesToJson(current)) {
			return `${frame.path} must not define toJSON`;
		}

		active.add(current);
		stack.push({ value: null, path: frame.path, exit: current });

		if (Array.isArray(current)) {
			const descriptors = Object.getOwnPropertyDescriptors(current);
			for (const [key, descriptor] of Object.entries(descriptors)) {
				if (key === "length" || /^(?:0|[1-9]\d*)$/.test(key)) continue;
				if (descriptor.enumerable) return `${frame.path}.${key} is not a JSON array index`;
			}
			for (let index = current.length - 1; index >= 0; index -= 1) {
				if (!Object.hasOwn(current, index)) return `${frame.path}[${index}] must not be an array hole`;
				const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
				if (!descriptor || !("value" in descriptor)) return `${frame.path}[${index}] must be a data property`;
				stack.push({ value: descriptor.value, path: `${frame.path}[${index}]` });
			}
			continue;
		}

		for (const symbol of Object.getOwnPropertySymbols(current)) {
			if (Object.getOwnPropertyDescriptor(current, symbol)?.enumerable) {
				return `${frame.path} must not contain symbol keys`;
			}
		}
		const descriptors = Object.getOwnPropertyDescriptors(current);
		const keys = Object.keys(descriptors);
		for (let index = keys.length - 1; index >= 0; index -= 1) {
			const key = keys[index];
			if (key === undefined) continue;
			const descriptor = descriptors[key];
			if (!descriptor?.enumerable) continue;
			if (!("value" in descriptor)) return `${frame.path}.${key} must be a data property`;
			stack.push({ value: descriptor.value, path: `${frame.path}.${key}` });
		}
	}

	return null;
}

function schemaSyntaxError(value: Record<string, unknown>): string | null {
	const stack: Array<{ schema: Record<string, unknown>; path: string }> = [{ schema: value, path: "$" }];
	while (stack.length > 0) {
		const frame = stack.pop();
		if (!frame) break;
		const { schema, path } = frame;
		for (const key of Object.keys(schema)) {
			if (!SUPPORTED_SCHEMA_KEYS.has(key)) return `${path}.${key} is not supported by the llama.cpp schema subset`;
		}
		if (typeof schema.type !== "string" || !SUPPORTED_SCHEMA_TYPES.has(schema.type)) {
			return `${path}.type must be one of ${[...SUPPORTED_SCHEMA_TYPES].join(", ")}`;
		}
		if (schema.type === "object") {
			if (schema.items !== undefined) return `${path}.items is only valid for array schemas`;
			if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
				return `${path}.properties must be a plain object`;
			}
			const properties = (schema.properties ?? {}) as Record<string, unknown>;
			for (const [name, child] of Object.entries(properties)) {
				if (!isPlainObject(child)) return `${path}.properties.${name} must be a schema object`;
				stack.push({ schema: child, path: `${path}.properties.${name}` });
			}
			if (schema.required !== undefined) {
				if (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === "string")) {
					return `${path}.required must be an array of strings`;
				}
				if (new Set(schema.required).size !== schema.required.length) {
					return `${path}.required must not contain duplicates`;
				}
				for (const name of schema.required) {
					if (!Object.hasOwn(properties, name)) return `${path}.required names unknown property '${name}'`;
				}
			}
			if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
				return `${path}.additionalProperties must be a boolean`;
			}
			continue;
		}
		if (schema.type === "array") {
			if (!isPlainObject(schema.items)) return `${path}.items must be a schema object`;
			if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
				return `${path} contains object-only keywords on an array schema`;
			}
			stack.push({ schema: schema.items, path: `${path}.items` });
			continue;
		}
		if (
			schema.properties !== undefined ||
			schema.required !== undefined ||
			schema.items !== undefined ||
			schema.additionalProperties !== undefined
		) {
			return `${path} contains container keywords on a ${schema.type} schema`;
		}
	}
	return null;
}

/** Return a user-facing reason when a response schema cannot safely cross the worker JSON boundary. */
function responseSchemaValidationError(value: unknown, source = "responseSchema"): string | null {
	try {
		if (!isPlainObject(value)) return `${source} must be a plain object`;
		const valueError = jsonDataError(value);
		if (valueError) return `${source} must be JSON-serializable: ${valueError}`;
		const syntaxError = schemaSyntaxError(value);
		if (syntaxError) return `${source} is not an enforceable JSON schema: ${syntaxError}`;

		const serialized = JSON.stringify(value);
		const bytes = Buffer.byteLength(serialized, "utf8");
		if (bytes > RESPONSE_SCHEMA_MAX_SERIALIZED_BYTES) {
			return `${source} must be at most ${RESPONSE_SCHEMA_MAX_SERIALIZED_BYTES} serialized bytes`;
		}
		return null;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return `${source} could not be safely inspected: ${detail}`;
	}
}

export function assertValidResponseSchema(
	value: unknown,
	source = "responseSchema",
): asserts value is Record<string, unknown> {
	const error = responseSchemaValidationError(value, source);
	if (error) throw new Error(error);
}

/** Validate and detach a schema from caller-owned objects before any async dispatch work. */
export function cloneValidatedResponseSchema(value: unknown, source = "responseSchema"): Record<string, unknown> {
	assertValidResponseSchema(value, source);
	try {
		const serialized = JSON.stringify(value);
		if (Buffer.byteLength(serialized, "utf8") > RESPONSE_SCHEMA_MAX_SERIALIZED_BYTES) {
			throw new Error(`${source} changed while being validated`);
		}
		const cloned: unknown = JSON.parse(serialized);
		const cloneError = responseSchemaValidationError(cloned, source);
		if (cloneError) throw new Error(cloneError);
		return cloned as Record<string, unknown>;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(source)) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${source} could not be canonically cloned: ${detail}`);
	}
}
