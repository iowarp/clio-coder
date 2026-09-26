import { type Static, Type } from "typebox";

// `_clio-coder/fleet/preview` and `/run`: the terminal's `/fleet run <name>` approval. A preview
// compiles and dispatches nothing; a run starts only the plan whose hash was approved. The agent
// bounds a preview at 64 steps, a field at 512 bytes and diagnostics at 32 lines of 1 KiB.
const closed = { additionalProperties: false };
const method = Type.String({ maxLength: 128 });
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

export const FleetCapability = Type.Object({ version: Type.Literal(1), preview: method, run: method }, closed);
export type FleetCapability = Static<typeof FleetCapability>;

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

const Refused = Type.Object(
	{
		status: Type.Literal("refused"),
		name: text,
		diagnostics: Type.Array(Type.String({ maxLength: 1100 }), { maxItems: 32 }),
	},
	closed,
);
export const FleetPreview = Type.Union([
	Type.Object(
		{
			status: Type.Literal("ready"),
			name: text,
			planHash: Hash,
			stepCount: Type.Integer({ minimum: 0 }),
			waves: Type.Array(
				Type.Object({ index: Type.Integer({ minimum: 0 }), steps: Type.Array(Step, { maxItems: 64 }) }, closed),
				{
					maxItems: 64,
				},
			),
			budget: Type.Object(
				{
					ceilingUsd: Type.Number({ minimum: 0 }),
					currentUsd: Type.Number({ minimum: 0 }),
					contractUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
				},
				closed,
			),
			truncated: Type.Boolean(),
		},
		closed,
	),
	Refused,
]);
export type FleetPreview = Static<typeof FleetPreview>;

export const FleetRunResult = Type.Union([
	Type.Object(
		{
			status: Type.Literal("started"),
			name: text,
			planHash: Hash,
			fleetRootId: Type.String({ maxLength: 128 }),
			stepCount: Type.Integer({ minimum: 0 }),
		},
		closed,
	),
	Type.Object(
		{ status: Type.Literal("changed"), name: text, planHash: Hash, reason: Type.String({ maxLength: 512 }) },
		closed,
	),
	/** The run ended before its first step: dispatch admission refused what the compiler accepted. */
	Type.Object(
		{
			status: Type.Literal("failed"),
			name: text,
			planHash: Hash,
			fleetRootId: Type.String({ maxLength: 128 }),
			reason: Type.String({ maxLength: 1100 }),
		},
		closed,
	),
	Refused,
]);
export type FleetRunResult = Static<typeof FleetRunResult>;
