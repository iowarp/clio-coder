import type { Static } from "typebox";
import { Type } from "typebox";

const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 4096 });
const nullableText = Type.Union([text, Type.Null()]);
const count = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
export const ReceiptFacts = Type.Object(
	{
		receiptId: text,
		outcome: nullableText,
		contract: nullableText,
		contractKind: nullableText,
		trust: nullableText,
		validation: nullableText,
		tokens: count,
		elapsedMs: count,
		placement: Type.Union([
			Type.Object(
				{
					mode: Type.Union([Type.Literal("current"), Type.Literal("worktree")]),
					branch: Type.Optional(text),
					changedPaths: Type.Optional(Type.Array(text)),
				},
				closed,
			),
			Type.Null(),
		]),
		unavailable: Type.Optional(Type.Literal(true)),
	},
	closed,
);
export type ReceiptFacts = Static<typeof ReceiptFacts>;
