import { type Static, Type } from "typebox";

const closed = { additionalProperties: false };
const identifier = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const ConfigId = Type.Union([Type.Literal("model"), Type.Literal("thinkingLevel")]);
export const ConfigOption = Type.Object(
	{
		id: ConfigId,
		currentValue: identifier,
		notice: Type.Optional(Type.String({ maxLength: 4096 })),
		options: Type.Array(
			Type.Object(
				{ value: identifier, name: identifier, thinkingLevels: Type.Optional(Type.Array(identifier, { maxItems: 7 })) },
				closed,
			),
			{ maxItems: 64 },
		),
	},
	closed,
);
export const SessionConfig = Type.Object(
	{
		target: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()])),
		options: Type.Array(ConfigOption, { maxItems: 2 }),
	},
	closed,
);
export type SessionConfig = Static<typeof SessionConfig>;
export const SetConfigOption = Type.Object({ configId: ConfigId, value: identifier }, closed);
export type SetConfigOption = Static<typeof SetConfigOption>;
