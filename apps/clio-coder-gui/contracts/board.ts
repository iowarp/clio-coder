import { type Static, Type } from "typebox";

// `_clio-coder/session/board`: the read half of the terminal's /tasks, /decisions and /memory views.
// The agent bounds every list at 100 items and every string at 1 KiB; these schemas restate that.
const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 1100 });
const nullableText = Type.Union([text, Type.Null()]);
const items = 100;

export const BoardCapability = Type.Object(
	{
		version: Type.Literal(1),
		method: Type.String({ maxLength: 128 }),
		/** Present when the agent accepts the board's two writes. */
		supersede: Type.Optional(Type.String({ maxLength: 128 })),
		proposeMemory: Type.Optional(Type.String({ maxLength: 128 })),
	},
	closed,
);
export type BoardCapability = Static<typeof BoardCapability>;

export const SessionBoard = Type.Object(
	{
		version: Type.Literal(1),
		operatorTasks: Type.Array(
			Type.Object(
				{
					id: Type.String({ maxLength: 32 }),
					title: text,
					status: Type.Union([
						Type.Literal("open"),
						Type.Literal("handed"),
						Type.Literal("picked"),
						Type.Literal("done"),
						Type.Literal("dropped"),
					]),
					expectedOutputs: Type.Array(text, { maxItems: 8 }),
					verificationChecks: Type.Integer({ minimum: 0 }),
				},
				closed,
			),
			{ maxItems: items },
		),
		plan: Type.Union([
			Type.Object(
				{
					title: text,
					tasks: Type.Array(
						Type.Object(
							{
								id: Type.String({ maxLength: 64 }),
								title: text,
								status: Type.String({ maxLength: 32 }),
								origin: Type.Union([Type.Literal("agent"), Type.Literal("user")]),
								reason: nullableText,
							},
							closed,
						),
						{ maxItems: items },
					),
				},
				closed,
			),
			Type.Null(),
		]),
		decisions: Type.Array(
			Type.Object(
				{
					ref: Type.String({ maxLength: 2300 }),
					/** With key, what a supersede names; absent from older agents. */
					interviewId: Type.Optional(Type.String({ maxLength: 256 })),
					key: text,
					label: nullableText,
					value: text,
					status: Type.Union([Type.Literal("active"), Type.Literal("superseded")]),
					source: Type.Union([Type.Literal("operator"), Type.Literal("agent"), Type.Null()]),
					decidedAt: Type.String({ maxLength: 64 }),
					rationale: nullableText,
					correction: nullableText,
				},
				closed,
			),
			{ maxItems: items },
		),
		memory: Type.Union([
			Type.Object(
				{
					enabled: Type.Boolean(),
					tier: Type.Union([Type.Literal("llm"), Type.Literal("rules")]),
					entries: Type.Integer({ minimum: 0 }),
					stepInFlight: Type.Boolean(),
					/** Entries a person may propose as durable memory; absent from older agents. */
					bank: Type.Optional(
						Type.Array(
							Type.Object(
								{
									id: Type.String({ maxLength: 256 }),
									kind: Type.Union([Type.Literal("knowledge"), Type.Literal("procedural")]),
									content: text,
								},
								closed,
							),
							{ maxItems: items },
						),
					),
				},
				closed,
			),
			Type.Null(),
		]),
		truncated: Type.Boolean(),
	},
	closed,
);
export type SessionBoard = Static<typeof SessionBoard>;

export const DecisionSupersedeRequest = Type.Object(
	{
		interviewId: Type.String({ minLength: 1, maxLength: 256 }),
		key: Type.String({ minLength: 1, maxLength: 1024 }),
		correction: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
	},
	closed,
);
export const DecisionSuperseded = Type.Union([
	Type.Object(
		{
			status: Type.Union([Type.Literal("superseded"), Type.Literal("already_superseded")]),
			/** The operator turn the terminal sends with a correction, for the client to send as a request. */
			correctionTurn: Type.Optional(Type.String({ maxLength: 4200 })),
		},
		closed,
	),
	Type.Object({ status: Type.Literal("refused"), reason: Type.String({ maxLength: 1100 }) }, closed),
]);
export type DecisionSuperseded = Static<typeof DecisionSuperseded>;

export const MemoryProposeRequest = Type.Object(
	{
		entryId: Type.String({ minLength: 1, maxLength: 256 }),
		scope: Type.Union([Type.Literal("repo"), Type.Literal("global")]),
		acknowledgeGlobal: Type.Optional(Type.Boolean()),
	},
	closed,
);
export const MemoryProposed = Type.Union([
	Type.Object(
		{
			status: Type.Union([Type.Literal("proposed"), Type.Literal("existing")]),
			recordId: Type.String({ maxLength: 256 }),
		},
		closed,
	),
	Type.Object(
		{
			status: Type.Union([Type.Literal("needs_acknowledgement"), Type.Literal("refused")]),
			reason: Type.String({ maxLength: 1100 }),
		},
		closed,
	),
]);
export type MemoryProposed = Static<typeof MemoryProposed>;
