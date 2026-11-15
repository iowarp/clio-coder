import type { ToolName } from "../../core/tool-names.js";
import type { ToolRegistry, ToolSpec } from "../registry.js";
import { gatewayCapabilityKind, surfaceSpecPlacement } from "../surface.js";

/** Whole block budget; past it the rest are named for describe. */
const SCOPE_SHAPES_MAX_BYTES = 1600;
const SHAPE_LINE_MAX_BYTES = 280;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeLabel(schema: unknown): string {
	if (!isRecord(schema)) return "any";
	if ("const" in schema) return JSON.stringify(schema.const);
	if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 4)
		return schema.enum.map((value) => JSON.stringify(value)).join("|");
	if (typeof schema.type === "string") return schema.type === "array" ? `${typeLabel(schema.items)}[]` : schema.type;
	if (Array.isArray(schema.type)) return schema.type.filter((entry) => typeof entry === "string").join("|");
	if (Array.isArray(schema.anyOf)) return schema.anyOf.map(typeLabel).join("|");
	return "any";
}

/** `name(a: string, b?: integer)`: top-level arguments only, optional ones marked. */
function signature(spec: ToolSpec): string {
	const schema: unknown = spec.parameters;
	const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(
		isRecord(schema) && Array.isArray(schema.required)
			? schema.required.filter((name): name is string => typeof name === "string")
			: [],
	);
	const args = Object.entries(properties)
		.sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)))
		.map(([name, value]) => `${name}${required.has(name) ? "" : "?"}: ${typeLabel(value)}`);
	const line = `${spec.name}(${args.join(", ")})`;
	return Buffer.byteLength(line) > SHAPE_LINE_MAX_BYTES ? `${line.slice(0, SHAPE_LINE_MAX_BYTES - 2)}…)` : line;
}

/**
 * Argument shapes for the extension and MCP capabilities a turn's explicit
 * scope admits. Those sit behind the gateway, so without them the model spent
 * one full request per `describe` (35-45K tokens each in the WTF-P campaign)
 * to learn what a template already admitted. Built-in tools are left out: the
 * compiled capability map already carries their shapes. The block rides the
 * turn's scope reminder, never the cached prompt prefix.
 */
export function scopedCapabilityShapes(
	registry: Pick<ToolRegistry, "get"> | undefined,
	allowedTools: readonly string[] | undefined,
): string {
	if (registry === undefined || allowedTools === undefined) return "";
	const surface = new Set(allowedTools);
	const lines: string[] = [];
	const omitted: string[] = [];
	let bytes = 0;
	for (const name of [...surface].sort()) {
		if (gatewayCapabilityKind(name) === "builtin") continue;
		const spec = registry.get(name as ToolName);
		if (spec === undefined || surfaceSpecPlacement(spec, surface) !== "gateway") continue;
		const line = `- ${signature(spec)}`;
		if (bytes + Buffer.byteLength(line) > SCOPE_SHAPES_MAX_BYTES) {
			omitted.push(name);
			continue;
		}
		bytes += Buffer.byteLength(line) + 1;
		lines.push(line);
	}
	if (lines.length === 0) return "";
	return [
		'Argument shapes for this turn\'s capabilities (call as gateway(op="call", capability="<name>", args={...}); `?` marks optional; describe only for nested fields):',
		...lines,
		...(omitted.length > 0 ? [`Describe for the rest: ${omitted.join(", ")}.`] : []),
	].join("\n");
}
