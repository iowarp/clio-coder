import { AcpArtifactListSchema, AcpArtifactPageSchema, AcpArtifactsCapability as ArtifactsCapability } from "./wire.js";

export { ArtifactsCapability };

import type { Static } from "typebox";
import { Type } from "typebox";

const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 8192 });
const count = Type.Integer({ minimum: 0 });

export const ArtifactList = AcpArtifactListSchema;
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
export const ArtifactPage = AcpArtifactPageSchema;
