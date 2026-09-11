import { type Static, Type } from "typebox";
import { Id } from "./common.js";

const NullableString = Type.Union([Type.String(), Type.Null()]);
export const Tool = Type.Object(
	{
		id: Id,
		version: Type.String(),
		summary: Type.String(),
		license: Type.String(),
		platform: NullableString,
		supported: Type.Boolean(),
		installed: Type.Boolean(),
		installDir: Type.String(),
		resolution: Type.Object(
			{
				source: Type.Union([Type.Literal("path"), Type.Literal("vendored"), Type.Literal("none")]),
				binaryPath: NullableString,
				version: NullableString,
				description: Type.String(),
				vendoredPath: NullableString,
				pathCandidate: Type.Union([
					Type.Null(),
					Type.Object(
						{
							path: Type.String(),
							version: NullableString,
							satisfiesMinimum: Type.Boolean(),
						},
						{ additionalProperties: false },
					),
				]),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type Tool = Static<typeof Tool>;
export const Tools = Type.Array(Tool);
export const Install = Type.Object({ force: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export const ToolResult = Type.Object({ id: Id, message: Type.String() }, { additionalProperties: false });
