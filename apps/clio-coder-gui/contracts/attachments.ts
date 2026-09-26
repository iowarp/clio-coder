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

// Text files that ride a request as ACP embedded resources, sharing the images' line budget. JSON
// escaping can at most double a file's bytes once C0 controls other than tab, newline and carriage
// return are refused, so a file weighs twice its UTF-8 size against that budget.
export const TURN_FILE_MAX = 4;
export const TURN_FILE_MAX_BYTES = 128 * 1024;
export const TURN_FILE_WEIGHT = 2;

export const TurnFile = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
		text: Type.String({ minLength: 1, maxLength: TURN_FILE_MAX_BYTES }),
	},
	{ additionalProperties: false },
);
export type TurnFile = Static<typeof TurnFile>;

/** What files and images weigh together against one agent line. */
export function attachmentWeight(images: ReadonlyArray<{ data: string }>, files: ReadonlyArray<{ text: string }>) {
	let weight = 0;
	for (const image of images) weight += image.data.length;
	for (const file of files) weight += TURN_FILE_WEIGHT * new TextEncoder().encode(file.text).length;
	return weight;
}
