import { type Static, Type } from "typebox";
import { Id } from "./common.js";
import { SettingsReport } from "./settings.js";

const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 256 });
const nullable = Type.Union([text, Type.Null()]);
export const CliTargets = Type.Object(
	{
		targets: Type.Array(
			Type.Object(
				{
					id: text,
					runtime: text,
					url: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
					defaultModel: nullable,
					available: Type.Boolean(),
					health: text,
					tier: text,
					models: Type.Array(text, { maxItems: 200 }),
					modelsTruncated: Type.Boolean(),
					contextWindow: Type.Union([Type.Number(), Type.Null()]),
				},
				closed,
			),
			{ maxItems: 200 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);
export const TargetOperationResult = Type.Object(
	{
		kind: Type.Literal("targets"),
		id: Id,
		message: Type.String(),
		exitCode: Type.Literal(0),
		targets: CliTargets,
		settings: Type.Optional(SettingsReport),
	},
	closed,
);
export const Routing = Type.Object(
	{
		models: Type.Array(
			Type.Object(
				{
					target: text,
					runtime: text,
					id: nullable,
					capabilities: text,
					context: Type.Union([Type.Number(), Type.Null()]),
					maxOutputTokens: Type.Union([Type.Number(), Type.Null()]),
					state: text,
				},
				closed,
			),
			{ maxItems: 2000 },
		),
		profiles: Type.Array(
			Type.Object({ name: text, target: nullable, runtime: nullable, model: nullable, thinkingLevel: text }, closed),
			{ maxItems: 2000 },
		),
		bindings: Type.Array(
			Type.Object({ agentId: text, profile: text, target: nullable, model: nullable, resolved: Type.Boolean() }, closed),
			{ maxItems: 2000 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);
export type CliTargets = Static<typeof CliTargets>;
export type TargetOperationResult = Static<typeof TargetOperationResult>;
export type Routing = Static<typeof Routing>;
