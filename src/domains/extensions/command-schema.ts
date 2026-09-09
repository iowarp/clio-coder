import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionCapabilities, ExtensionCommandTool } from "./types.js";

const TOOL_KEYS = new Set([
	"name",
	"description",
	"runtime",
	"entrypoint",
	"inputSchema",
	"timeoutMs",
	"maxOutputBytes",
]);
const SCHEMA_KEYS = new Set([
	"type",
	"description",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"minimum",
	"maximum",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
]);
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function extensionToolName(id: string, name: string): string {
	return `extension_${id}__${name}`;
}

function validateSchema(value: unknown, depth = 0): asserts value is Record<string, unknown> {
	if (depth > 12 || !record(value))
		throw new Error("inputSchema must be a JSON schema object with at most 12 nesting levels");
	for (const key of Object.keys(value)) {
		if (!SCHEMA_KEYS.has(key)) throw new Error(`unsupported inputSchema keyword '${key}'`);
	}
	if (typeof value.type !== "string" || !TYPES.has(value.type))
		throw new Error("inputSchema.type must be a supported JSON type");
	if (value.description !== undefined && typeof value.description !== "string")
		throw new Error("inputSchema.description must be a string");
	if (
		value.enum !== undefined &&
		(!Array.isArray(value.enum) ||
			value.enum.length === 0 ||
			value.enum.some((item) => item !== null && typeof item === "object"))
	) {
		throw new Error("inputSchema.enum must contain JSON scalar values");
	}
	for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
		if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key])))
			throw new Error(`inputSchema.${key} must be finite`);
	}
	if (value.type === "object") {
		if (!record(value.properties) || value.additionalProperties !== false)
			throw new Error("object inputSchema requires properties and additionalProperties: false");
		for (const [key, child] of Object.entries(value.properties)) {
			if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("unsafe inputSchema property name");
			validateSchema(child, depth + 1);
		}
		if (
			value.required !== undefined &&
			(!Array.isArray(value.required) ||
				value.required.some((key) => typeof key !== "string" || !Object.hasOwn(value.properties as object, key)))
		) {
			throw new Error("inputSchema.required must name declared properties");
		}
	} else if (value.type === "array") {
		validateSchema(value.items, depth + 1);
	}
}

export function parseExtensionCapabilities(value: unknown, id: string): ExtensionCapabilities {
	if (
		!record(value) ||
		Object.keys(value).some((key) => key !== "tools") ||
		!Array.isArray(value.tools) ||
		value.tools.length === 0 ||
		value.tools.length > 32
	) {
		throw new Error("capabilities must contain tools with between 1 and 32 command declarations");
	}
	if (id.includes("__")) throw new Error("v2 extension id cannot contain double underscores");
	const names = new Set<string>();
	const tools: ExtensionCommandTool[] = value.tools.map((tool) => {
		if (!record(tool)) throw new Error("capabilities.tools entries must be objects");
		for (const key of Object.keys(tool)) if (!TOOL_KEYS.has(key)) throw new Error(`unknown command tool key '${key}'`);
		if (typeof tool.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool.name) || tool.name.includes("__"))
			throw new Error("command tool name must use lowercase letters, digits, and single underscores");
		const name = extensionToolName(id, tool.name);
		if (name.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(name))
			throw new Error("qualified command tool name must use provider-safe characters and fit 64 characters");
		if (names.has(name)) throw new Error(`duplicate command tool name '${name}'`);
		names.add(name);
		if (typeof tool.description !== "string" || tool.description.trim().length === 0 || tool.description.length > 2000)
			throw new Error("command tool description must contain 1 to 2000 characters");
		if (tool.runtime !== "node" && tool.runtime !== "python3")
			throw new Error("command tool runtime must be node or python3");
		if (
			typeof tool.entrypoint !== "string" ||
			tool.entrypoint.includes("\0") ||
			tool.entrypoint.includes("\\") ||
			path.isAbsolute(tool.entrypoint) ||
			tool.entrypoint.split("/").some((part) => part === ".." || part === "." || part === "")
		)
			throw new Error("command tool entrypoint must be a contained relative file path");
		validateSchema(tool.inputSchema);
		if (tool.inputSchema.type !== "object") throw new Error("command tool inputSchema root must be object");
		for (const [key, maximum] of [
			["timeoutMs", 300000],
			["maxOutputBytes", 1048576],
		] as const) {
			const limit = tool[key];
			if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > maximum))
				throw new Error(`command tool ${key} must be between 1 and ${maximum}`);
		}
		return structuredClone(tool) as unknown as ExtensionCommandTool;
	});
	return { tools };
}

/** Entry paths must resolve to ordinary package files, including every parent directory. */
export function resolveExtensionEntrypoint(root: string, entrypoint: string): string {
	const canonicalRoot = realpathSync(root);
	let cursor = canonicalRoot;
	for (const segment of entrypoint.split("/")) {
		if (segment === ".." || segment === "." || segment.length === 0)
			throw new Error("invalid command entrypoint segment");
		cursor = path.join(cursor, segment);
		if (lstatSync(cursor).isSymbolicLink()) throw new Error("command entrypoint cannot contain symbolic links");
	}
	const stat = lstatSync(cursor);
	if (!stat.isFile() || stat.nlink !== 1) throw new Error("command entrypoint must be an ordinary file with one link");
	const relative = path.relative(canonicalRoot, realpathSync(cursor));
	if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		throw new Error("command entrypoint escapes extension root");
	return cursor;
}
