import { AcpInterviewsCapability as InterviewCapability } from "./wire.js";

export { InterviewCapability };

import { type Static, Type } from "typebox";
import { Id } from "./common.js";

const closed = { additionalProperties: false };

export {
	ACP_INTERVIEW_CANCEL_METHOD as INTERVIEW_CANCEL_METHOD,
	ACP_INTERVIEW_REQUEST_METHOD as INTERVIEW_REQUEST_METHOD,
} from "./wire.js";
/** Additive ACP bridge. The current runtime must opt in before the GUI enables it. */
export const InterviewQuestion = Type.Object(
	{
		question: Type.String({ minLength: 1, maxLength: 8192 }),
		header: Type.Optional(Type.String({ maxLength: 128 })),
		options: Type.Optional(
			Type.Array(
				Type.Object(
					{
						label: Type.String({ minLength: 1, maxLength: 512 }),
						description: Type.Optional(Type.String({ maxLength: 2048 })),
					},
					closed,
				),
				{ maxItems: 16 },
			),
		),
		multi_select: Type.Optional(Type.Boolean()),
	},
	closed,
);
export type InterviewQuestion = Static<typeof InterviewQuestion>;
export const InterviewRequest = Type.Object(
	{
		sessionId: Id,
		interviewId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		questions: Type.Array(InterviewQuestion, { minItems: 1, maxItems: 4 }),
	},
	closed,
);
export const InterviewWithdrawal = Type.Object(
	{ sessionId: Id, interviewId: Type.String({ minLength: 1, maxLength: 128 }) },
	closed,
);
export const InterviewRound = Type.Object(
	{
		id: Id,
		turnId: Id,
		requestedAt: Type.String(),
		interviewId: Type.Optional(Type.String({ maxLength: 128 })),
		questions: Type.Array(InterviewQuestion, { minItems: 1, maxItems: 4 }),
	},
	closed,
);
export type InterviewRound = Static<typeof InterviewRound>;
export const InterviewSubmission = Type.Union([
	Type.Object({ cancelled: Type.Literal(true) }, closed),
	Type.Object(
		{
			answers: Type.Array(
				Type.Object(
					{
						selected: Type.Array(Type.Integer({ minimum: 0, maximum: 15 }), { maxItems: 16, uniqueItems: true }),
						text: Type.String({ maxLength: 8192 }),
					},
					closed,
				),
				{ minItems: 1, maxItems: 4 },
			),
		},
		closed,
	),
]);
export type InterviewSubmission = Static<typeof InterviewSubmission>;

/** Mirrors the runtime's AskUserResult. The GUI reconstructs question and option labels itself. */
export type InterviewResult = {
	answers: { question: string; answer: string; options?: string[]; value?: string }[];
	cancelled?: true;
};
