import { type Static, Type } from "typebox";

// `_clio-coder/aside/*`: the terminal's /btw and /draft. Both are rounds beside the session that answer
// the operator and never become a turn. The agent bounds each answer and candidate at 64 KiB and every
// reason at 1 KiB, allows one round at a time, and takes 1 to 4 drafts.
const closed = { additionalProperties: false };
const method = Type.String({ maxLength: 128 });
const answer = Type.String({ maxLength: 66_000 });
const reason = Type.String({ maxLength: 1100 });
const label = Type.Union([Type.Literal("A"), Type.Literal("B"), Type.Literal("C"), Type.Literal("D")]);
export const ASIDE_TEXT_MAX_CHARACTERS = 8000;

export const AsideCapability = Type.Object(
	{
		version: Type.Literal(1),
		ask: method,
		draft: method,
		cancel: method,
		draftCounts: Type.Object(
			{
				min: Type.Integer({ minimum: 1, maximum: 4 }),
				max: Type.Integer({ minimum: 1, maximum: 4 }),
				default: Type.Integer({ minimum: 1, maximum: 4 }),
			},
			closed,
		),
	},
	closed,
);

const refusedOrFailed = Type.Object(
	{ status: Type.Union([Type.Literal("refused"), Type.Literal("failed")]), reason },
	closed,
);

export const AsideAskRequest = Type.Object(
	{ question: Type.String({ minLength: 1, maxLength: ASIDE_TEXT_MAX_CHARACTERS, pattern: "\\S" }) },
	closed,
);
export const AsideAnswer = Type.Union([
	Type.Object(
		{
			status: Type.Union([Type.Literal("answered"), Type.Literal("aborted")]),
			text: answer,
			truncated: Type.Boolean(),
		},
		closed,
	),
	refusedOrFailed,
]);
export type AsideAnswer = Static<typeof AsideAnswer>;

export const AsideDraftRequest = Type.Object(
	{
		request: Type.String({ minLength: 1, maxLength: ASIDE_TEXT_MAX_CHARACTERS, pattern: "\\S" }),
		count: Type.Integer({ minimum: 1, maximum: 4 }),
	},
	closed,
);
const share = Type.Number({ minimum: 0 });
export const AsideDrafts = Type.Union([
	Type.Object(
		{
			status: Type.Literal("drafted"),
			aborted: Type.Boolean(),
			candidates: Type.Array(
				Type.Union([
					Type.Object({ label, status: Type.Literal("drafted"), text: answer, truncated: Type.Boolean() }, closed),
					Type.Object({ label, status: Type.Literal("failed"), reason }, closed),
				]),
				{ maxItems: 4 },
			),
			judgment: Type.Optional(
				Type.Union([
					Type.Object(
						{
							status: Type.Literal("judged"),
							picked: Type.Union([label, Type.Null()]),
							probabilities: Type.Record(Type.String({ maxLength: 1 }), share),
							sound: Type.Record(Type.String({ maxLength: 1 }), Type.Union([Type.Boolean(), Type.Null()])),
							source: reason,
							elapsedMs: Type.Integer({ minimum: 0 }),
						},
						closed,
					),
					Type.Object({ status: Type.Literal("unjudged"), reason }, closed),
				]),
			),
		},
		closed,
	),
	Type.Object({ status: Type.Literal("refused"), reason }, closed),
]);
export type AsideDrafts = Static<typeof AsideDrafts>;

export const AsideCancelled = Type.Object({ cancelled: Type.Boolean() }, closed);
