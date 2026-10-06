import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";

export const GATEWAY_OPS = ["find", "describe", "call", "chain"] as const;
export type GatewayOp = (typeof GATEWAY_OPS)[number];

const DESCRIPTION =
	'Discover registered builtin, extension and MCP capabilities. op="find" searches; op="describe" returns a schema; op="call" executes with args under its own admission; op="chain" runs tool steps. For chain syntax: op="describe", capability="gateway". Gateway operations are not chain capabilities. Discovery grants no authority.';

export const gatewayToolSurface = {
	name: ToolNames.Gateway,
	description: DESCRIPTION,
	parameters: Type.Object({
		op: StringEnum(GATEWAY_OPS, { description: "Gateway operation." }),
		capability: Type.Optional(Type.String({ description: "describe and call: the capability name." })),
		query: Type.Optional(Type.String({ description: "find: task terms or the next step." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "find: page size." })),
		offset: Type.Optional(Type.Integer({ minimum: 0, description: "find: nextOffset." })),
		// The find payload names the exact refresh call for a server whose catalog
		// is missing, so the remedy is taught where it is needed rather than
		// carried in every turn's attached schema.
		server: Type.Optional(Type.String({ description: "find: one MCP server id." })),
		refresh: Type.Optional(Type.Boolean({ description: "find: list that server live." })),
		args: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description: "call: the capability's arguments.",
			}),
		),
		steps: Type.Optional(
			Type.Array(Type.Unknown(), {
				maxItems: 16,
				description: 'chain: {id,capability,args,after?:[ids]}; describe capability="gateway" for bindings.',
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "sequential",
} satisfies ToolSurface;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept the weak-model shapes: `args` as a JSON string, `name`/`tool` for
 * `capability`, and a missing `op` inferred from what else was given.
 */
export function prepareGatewayArguments(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	if (typeof out.capability !== "string") {
		const alias = out.name ?? out.tool;
		if (typeof alias === "string") out.capability = alias;
	}
	if (typeof out.args === "string") {
		try {
			const parsed: unknown = JSON.parse(out.args);
			if (isRecord(parsed)) out.args = parsed;
		} catch {
			// The body reports the unparseable string.
		}
	}
	if (typeof out.op !== "string") {
		if (typeof out.capability === "string" && out.args !== undefined) out.op = "call";
		else if (typeof out.capability === "string") out.op = "describe";
		else out.op = "find";
	}
	return out;
}

