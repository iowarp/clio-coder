import { type Static, Type } from "typebox";
import { ClientIdentity } from "./auth.js";
import { Id } from "./common.js";

/** Who drives a session. Every other client views it until it takes control. */
export const SessionControl = Type.Object(
	{
		sessionId: Id,
		/** Null while no present client holds it: the next one to act claims it. */
		controller: Type.Union([ClientIdentity, Type.Null()]),
		you: ClientIdentity,
	},
	{ additionalProperties: false },
);
export type SessionControl = Static<typeof SessionControl>;
