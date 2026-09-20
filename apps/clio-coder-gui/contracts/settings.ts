import { type Static, Type } from "typebox";

const closed = { additionalProperties: false };
export const SettingsOrigin = Type.Union([
	Type.Literal("built-in"),
	Type.Literal("user"),
	Type.Literal("project"),
	Type.Literal("project.local"),
	Type.Literal("cli"),
]);
export const SettingRow = Type.Object(
	{
		key: Type.String(),
		source: SettingsOrigin,
		value: Type.Union([
			Type.String(),
			Type.Number(),
			Type.Boolean(),
			Type.Null(),
			Type.Array(Type.Unknown(), { maxItems: 0 }),
			Type.Object({}, closed),
		]),
		redacted: Type.Boolean(),
	},
	closed,
);
export const SettingsReport = Type.Object(
	{
		rows: Type.Array(SettingRow),
		layers: Type.Array(Type.Object({ origin: SettingsOrigin, path: Type.String(), present: Type.Boolean() }, closed)),
		issues: Type.Array(
			Type.Object({ origin: SettingsOrigin, path: Type.String(), kind: Type.String(), message: Type.String() }, closed),
		),
	},
	closed,
);
export const ConfigCategory = Type.Union([
	Type.Literal("settings"),
	Type.Literal("clio-md"),
	Type.Literal("rule"),
	Type.Literal("operator-profile"),
	Type.Literal("hook"),
	Type.Literal("extension"),
	Type.Literal("skill-root"),
	Type.Literal("prompt-root"),
	Type.Literal("agent-root"),
	Type.Literal("fleet-root"),
	Type.Literal("safety"),
	Type.Literal("memory"),
]);
export const ConfigEntry = Type.Object(
	{
		category: ConfigCategory,
		id: Type.String(),
		scope: Type.String(),
		sourcePath: Type.Optional(Type.String()),
		hash: Type.Optional(Type.String()),
		trust: Type.Optional(Type.Union([Type.Literal("trusted"), Type.Literal("untrusted"), Type.Literal("n/a")])),
		precedence: Type.Optional(
			Type.Union([Type.Literal("winner"), Type.Literal("loser"), Type.Literal("single"), Type.Literal("layer")]),
		),
		reloadClass: Type.Union([
			Type.Literal("hot"),
			Type.Literal("next-turn"),
			Type.Literal("reload"),
			Type.Literal("restart"),
			Type.Literal("n/a"),
		]),
		contextCostTokens: Type.Optional(Type.Number()),
		facts: Type.Record(Type.String(), Type.Union([Type.Number(), Type.Boolean()])),
	},
	closed,
);
export const ConfigGraph = Type.Object(
	{
		categories: Type.Array(ConfigCategory),
		entries: Type.Array(ConfigEntry),
		issues: Type.Array(
			Type.Object({ category: Type.String(), count: Type.Integer({ minimum: 1 }), message: Type.String() }, closed),
		),
	},
	closed,
);
export type SettingRow = Static<typeof SettingRow>;
export type SettingsReport = Static<typeof SettingsReport>;
export type ConfigGraph = Static<typeof ConfigGraph>;
