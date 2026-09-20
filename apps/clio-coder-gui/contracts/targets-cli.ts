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

/** How a runtime authenticates, in the CLI's own `configure --list` vocabulary. No credential ever crosses. */
export const RuntimeAuthState = Type.Union([
	Type.Literal("none"),
	Type.Literal("login"),
	Type.Literal("connected"),
	Type.Literal("credential"),
	Type.Literal("needs-key"),
	Type.Literal("key-optional"),
	Type.Literal("other"),
]);
export const TargetRuntimes = Type.Object(
	{
		runtimes: Type.Array(
			Type.Object(
				{
					id: Id,
					label: text,
					group: text,
					summary: text,
					defaultModel: nullable,
					modelHints: Type.Array(text, { maxItems: 60 }),
					/** True when the model ids come from a provider catalog, so the engine refuses to guess one. */
					modelRequired: Type.Boolean(),
					supportsCustomUrl: Type.Boolean(),
					auth: RuntimeAuthState,
					targetCount: Type.Integer({ minimum: 0 }),
				},
				closed,
			),
			{ maxItems: 200 },
		),
	},
	closed,
);
export const TargetAdd = Type.Object(
	{
		id: Id,
		runtime: Id,
		url: Type.Optional(Type.String({ maxLength: 2048, pattern: "^(https?|wss?)://[^\\s]+$" })),
		model: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$" })),
		apiKeyEnv: Type.Optional(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" })),
		useForChat: Type.Optional(Type.Boolean()),
	},
	closed,
);
export type TargetRuntimes = Static<typeof TargetRuntimes>;
export type TargetAdd = Static<typeof TargetAdd>;
