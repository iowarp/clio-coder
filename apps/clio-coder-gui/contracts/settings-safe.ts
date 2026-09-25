import { type Static, Type } from "typebox";

const closed = { additionalProperties: false };
export const AutonomyLevel = Type.Union([Type.Literal("default"), Type.Literal("yolo")]);
export const ThinkingLevel = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
const target = Type.Union([
	Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
	Type.Null(),
]);
const model = Type.Union([
	Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
	Type.Null(),
]);
export const SafeSettingsPatch = Type.Object(
	{
		"chat.target": Type.Optional(target),
		"chat.model": Type.Optional(model),
		"chat.thinkingLevel": Type.Optional(ThinkingLevel),
		"safety.autonomy": Type.Optional(AutonomyLevel),
	},
	closed,
);
export type SafeSettingsPatch = Static<typeof SafeSettingsPatch>;
export const SafeSettings = Type.Object(
	{
		settings: Type.Object(
			{
				chat: Type.Object({ target, model, thinkingLevel: ThinkingLevel }, closed),
				safety: Type.Object({ autonomy: AutonomyLevel }, closed),
			},
			closed,
		),
		editable: Type.Array(
			Type.Union([
				Type.Literal("chat.target"),
				Type.Literal("chat.model"),
				Type.Literal("chat.thinkingLevel"),
				Type.Literal("safety.autonomy"),
			]),
			{ maxItems: 4, minItems: 4, uniqueItems: true },
		),
	},
	closed,
);
export type SafeSettings = Static<typeof SafeSettings>;
export const Autonomy = Type.Object({ level: AutonomyLevel, source: Type.String({ maxLength: 64 }) }, closed);
