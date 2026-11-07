import { TURN_FILE_MAX_BYTES, TURN_IMAGES_MAX_BASE64 } from "./runtime.js";

export {
	attachmentWeight,
	TURN_FILE_MAX,
	TURN_FILE_MAX_BYTES,
	TURN_FILE_WEIGHT,
	TURN_IMAGE_MAX,
	TURN_IMAGE_TYPES,
	TURN_IMAGES_MAX_BASE64,
} from "./runtime.js";

import { type Static, Type } from "typebox";

export const TurnImage = Type.Object(
	{
		mimeType: Type.Union([
			Type.Literal("image/png"),
			Type.Literal("image/jpeg"),
			Type.Literal("image/gif"),
			Type.Literal("image/webp"),
		]),
		data: Type.String({ minLength: 4, maxLength: TURN_IMAGES_MAX_BASE64, pattern: "^[A-Za-z0-9+/]+={0,2}$" }),
	},
	{ additionalProperties: false },
);
export type TurnImage = Static<typeof TurnImage>;

export const TurnFile = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
		text: Type.String({ minLength: 1, maxLength: TURN_FILE_MAX_BYTES }),
	},
	{ additionalProperties: false },
);
export type TurnFile = Static<typeof TurnFile>;
