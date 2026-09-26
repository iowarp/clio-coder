import { type Static, Type } from "typebox";

// Images that ride a request. The agent reads them from ACP image blocks on one stdio line of 1 MiB,
// which the request text shares, so their base64 is bounded together rather than each alone. The
// agent judges each by its bytes; the declared type here only has to be one it could accept.
export const TURN_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const TURN_IMAGE_MAX = 4;
export const TURN_IMAGES_MAX_BASE64 = 900_000;

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
