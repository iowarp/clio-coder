import { AcpFleetPreviewSchema, AcpFleetRunResultSchema, AcpFleetCapability as FleetCapability } from "./wire.js";

export { FleetCapability };

import type { Static } from "typebox";
import { Type } from "typebox";

// `_clio-coder/fleet/preview` and `/run`: the terminal's `/fleet run <name>` approval. A preview
// compiles and dispatches nothing; a run starts only the plan whose hash was approved. The agent
// bounds a preview at 64 steps, a field at 512 bytes and diagnostics at 32 lines of 1 KiB.
const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 520 });
const Hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const FleetName = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" });
const Vars = Type.Record(
	Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,63}$" }),
	Type.String({ maxLength: 4096 }),
	{
		maxProperties: 32,
	},
);

export const FleetPreviewRequest = Type.Object({ name: FleetName, vars: Type.Optional(Vars) }, closed);
export const FleetRunRequest = Type.Object({ name: FleetName, vars: Type.Optional(Vars), planHash: Hash }, closed);

const Step = Type.Object(
	{
		stepId: text,
		kind: Type.Union([Type.Literal("agent"), Type.Literal("code")]),
		scope: Type.Union([Type.Literal("readonly"), Type.Literal("workspace")]),
		agentId: Type.Optional(text),
		commandId: Type.Optional(text),
		argv: Type.Optional(Type.Array(text, { maxItems: 16 })),
		writes: Type.Union([Type.Array(text, { maxItems: 16 }), Type.Null()]),
		route: Type.Optional(
			Type.Object(
				{
					targetId: text,
					model: text,
					nodeId: text,
					endpoint: Type.Optional(Type.Object({ label: text, limit: Type.Integer({ minimum: 0 }) }, closed)),
				},
				closed,
			),
		),
		loop: Type.Optional(
			Type.Object(
				{
					loopId: text,
					role: Type.Union([Type.Literal("check"), Type.Literal("repair")]),
					attempt: Type.Integer({ minimum: 0 }),
				},
				closed,
			),
		),
		gate: Type.Optional(Type.Object({ path: text }, closed)),
		target: Type.Optional(text),
		profile: Type.Optional(text),
	},
	closed,
);
export type FleetStep = Static<typeof Step>;

export const FleetPreview = AcpFleetPreviewSchema;
export type FleetPreview = Static<typeof FleetPreview>;

export const FleetRunResult = AcpFleetRunResultSchema;
export type FleetRunResult = Static<typeof FleetRunResult>;
