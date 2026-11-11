import { type Static, Type } from "typebox";

/** The desktop report dialog (R-24): the host plans and sends; the client shows `plan.rendered` and nothing it composed. */
const closed = { additionalProperties: false };
const text = (max: number) => Type.String({ maxLength: max });

export const ProblemReportDraftId = Type.String({ pattern: "^rpt_[0-9A-HJKMNP-TV-Z]{26}$" });
export const ProblemReportDraftParams = Type.Object(
	{ id: Type.String({ minLength: 1, maxLength: 128 }), draft: ProblemReportDraftId },
	closed,
);
export const ProblemReportPlanRequest = Type.Object(
	{
		kind: Type.Union([Type.Literal("bug"), Type.Literal("feature"), Type.Literal("question")]),
		summary: Type.Optional(text(120)),
		/** The session a failed-turn or failed-run card reports on; its recorded observations fill the draft. */
		sessionId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_.:-]{1,128}$" })),
	},
	closed,
);
export type ProblemReportPlanRequest = Static<typeof ProblemReportPlanRequest>;
export const ProblemReportEdits = Type.Object(
	{
		title: Type.Optional(text(200)),
		happened: Type.Optional(text(60_000)),
		expected: Type.Optional(text(60_000)),
		reproduce: Type.Optional(text(60_000)),
		unmasked: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 200 })),
		credit: Type.Optional(Type.Boolean()),
	},
	closed,
);
export type ProblemReportEdits = Static<typeof ProblemReportEdits>;
export const ProblemReportChoices = Type.Object(
	{
		/** True only from the dialog's Send button; anything else sends nothing. */
		consent: Type.Boolean(),
		replyCheck: Type.Optional(Type.Boolean()),
		duplicate: Type.Optional(
			Type.Union([Type.Literal("new"), Type.Object({ comment: Type.Integer({ minimum: 1 }) }, closed)]),
		),
		/** The send step's consent radio: "debug" attaches the bundle the Attach step showed; anything else attaches none. */
		bundle: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("debug")])),
	},
	closed,
);
export type ProblemReportChoices = Static<typeof ProblemReportChoices>;
export const ProblemReportBundleRequest = Type.Object({ transcript: Type.Optional(Type.Boolean()) }, closed);
export type ProblemReportBundleRequest = Static<typeof ProblemReportBundleRequest>;
/** The diagnostic bundle as the report domain built it, unwritten: ticks, inventory and every member for the viewer. */
export const ProblemReportBundle = Type.Object(
	{
		draftId: Type.String(),
		sha256: Type.String(),
		bytes: Type.Integer({ minimum: 0 }),
		transcript: Type.Union([Type.Object({ turns: Type.Integer(), of: Type.Integer() }, closed), Type.Null()]),
		readable: Type.Object(
			{
				model: Type.Array(Type.String()),
				runtime: Type.Array(Type.String()),
				tool: Type.Array(Type.String()),
				token: Type.Array(Type.String()),
			},
			closed,
		),
		anonymized: Type.Array(Type.Object({ kind: Type.String(), count: Type.Integer() }, closed)),
		withheld: Type.Integer({ minimum: 0 }),
		kept: Type.Array(Type.String()),
		neverKept: Type.Array(Type.String()),
		consent: Type.Object({ debug: Type.String(), transcript: Type.String() }, closed),
		members: Type.Array(Type.Object({ name: Type.String(), text: Type.String() }, closed)),
	},
	closed,
);
export type ProblemReportBundle = Static<typeof ProblemReportBundle>;
export const ProblemReportOfferRequest = Type.Object(
	{ sessionId: Type.String({ pattern: "^[A-Za-z0-9_.:-]{1,128}$" }) },
	closed,
);
export type ProblemReportOfferRequest = Static<typeof ProblemReportOfferRequest>;
/** Whether the report domain's offer rules let the app suggest a report now; null with the rule that refused. */
export const ProblemReportOffer = Type.Object(
	{
		offer: Type.Union([Type.Object({ text: Type.String(), fingerprint: Type.String() }, closed), Type.Null()]),
		refusal: Type.Union([Type.String(), Type.Null()]),
	},
	closed,
);
export type ProblemReportOffer = Static<typeof ProblemReportOffer>;

const Mask = Type.Object(
	{
		id: Type.String(),
		kind: Type.String(),
		count: Type.Integer(),
		masked: Type.Boolean(),
		locked: Type.Boolean(),
	},
	closed,
);
const Plan = Type.Object(
	{
		postedAs: Type.String(),
		destination: Type.String(),
		rendered: Type.Object({ title: Type.String(), body: Type.String() }),
		maskSummary: Type.String(),
		actions: Type.Array(Type.String()),
		bundle: Type.Union([Type.String(), Type.Null()]),
		consent: Type.String(),
		credit: Type.Boolean(),
		gates: Type.Array(Type.String()),
		rateWarning: Type.Union([Type.String(), Type.Null()]),
	},
	closed,
);
export const ProblemReportView = Type.Object(
	{
		draftId: Type.String(),
		state: Type.String(),
		headline: Type.String(),
		plan: Plan,
		masks: Type.Array(Mask),
		fields: Type.Object(
			{ title: Type.String(), happened: Type.String(), expected: Type.String(), reproduce: Type.String() },
			closed,
		),
		sendable: Type.Boolean(),
	},
	closed,
);
export type ProblemReportView = Static<typeof ProblemReportView>;
export const ProblemReportSent = Type.Union([
	Type.Object(
		{
			status: Type.Literal("sent"),
			draftId: Type.String(),
			state: Type.String(),
			line: Type.String(),
			url: Type.Union([Type.String(), Type.Null()]),
		},
		closed,
	),
	Type.Object(
		{ status: Type.Literal("failed"), draftId: Type.String(), state: Type.String(), line: Type.String() },
		closed,
	),
	Type.Object(
		{
			status: Type.Literal("duplicates"),
			draftId: Type.String(),
			state: Type.String(),
			related: Type.String(),
			comment: Type.Union([Type.Integer(), Type.Null()]),
			allowNew: Type.Boolean(),
		},
		closed,
	),
	Type.Object(
		{
			status: Type.Literal("blocked"),
			draftId: Type.String(),
			state: Type.String(),
			reasons: Type.Array(Type.String()),
		},
		closed,
	),
]);
export type ProblemReportSent = Static<typeof ProblemReportSent>;
export const ProblemReportRows = Type.Object(
	{
		rows: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					state: Type.String(),
					kind: Type.String(),
					title: Type.String(),
					url: Type.Union([Type.String(), Type.Null()]),
				},
				closed,
			),
		),
	},
	closed,
);
export type ProblemReportRows = Static<typeof ProblemReportRows>;
