import {
	AcpAsideAnswerSchema,
	AcpAsideCancelledSchema,
	AcpAsideDraftsSchema,
	AcpAsideCapability as AsideCapability,
} from "./wire.js";

export { AsideCapability };

import type { Static } from "typebox";
import { Type } from "typebox";

// `_clio-coder/aside/*`: the terminal's /btw and /draft. Both are rounds beside the session that answer
// the operator and never become a turn. The agent bounds each answer and candidate at 64 KiB and every
// reason at 1 KiB, allows one round at a time, and takes 1 to 4 drafts.
const closed = { additionalProperties: false };

export const ASIDE_TEXT_MAX_CHARACTERS = 8000;

export const AsideAskRequest = Type.Object(
	{ question: Type.String({ minLength: 1, maxLength: ASIDE_TEXT_MAX_CHARACTERS, pattern: "\\S" }) },
	closed,
);
export const AsideAnswer = AcpAsideAnswerSchema;
export type AsideAnswer = Static<typeof AsideAnswer>;

export const AsideDraftRequest = Type.Object(
	{
		request: Type.String({ minLength: 1, maxLength: ASIDE_TEXT_MAX_CHARACTERS, pattern: "\\S" }),
		count: Type.Integer({ minimum: 1, maximum: 4 }),
	},
	closed,
);

export const AsideDrafts = AcpAsideDraftsSchema;
export type AsideDrafts = Static<typeof AsideDrafts>;

export const AsideCancelled = AcpAsideCancelledSchema;
