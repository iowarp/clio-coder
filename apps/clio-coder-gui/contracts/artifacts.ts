import type { Static } from "typebox";
import { Type } from "typebox";

const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 8192 });
const count = Type.Integer({ minimum: 0 });
const format = Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("json")]);
export const ArtifactsCapability = Type.Object(
	{
		version: Type.Literal(1),
		list: text,
		read: text,
		categories: Type.Array(text, { maxItems: 32 }),
		perCategory: count,
	},
	closed,
);
export const ArtifactList = Type.Object(
	{
		artifacts: Type.Array(
			Type.Object(
				{
					id: text,
					category: text,
					title: text,
					format,
					subtitle: Type.Optional(text),
					at: Type.Optional(text),
					sizeBytes: Type.Optional(count),
					protected: Type.Optional(Type.Literal(true)),
				},
				closed,
			),
			{ maxItems: 6400 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);
export type ArtifactList = Static<typeof ArtifactList>;
export const ArtifactRead = Type.Object(
	{
		id: text,
		offset: Type.Optional(count),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
		details: Type.Optional(Type.Boolean()),
	},
	closed,
);
export const ArtifactPage = Type.Object(
	{
		id: text,
		category: text,
		title: text,
		format,
		lines: Type.Array(Type.String(), { maxItems: 2000 }),
		offset: count,
		totalLines: count,
		nextOffset: Type.Union([count, Type.Null()]),
		clippedLines: Type.Optional(count),
		details: Type.Optional(Type.Object({ format, lineCount: count }, closed)),
		refused: Type.Optional(Type.Object({ reason: text }, closed)),
	},
	closed,
);
