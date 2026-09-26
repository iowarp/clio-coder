import { type Static, Type } from "typebox";
import { Id } from "./common.js";

const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 4096 });
const heading = Type.Array(text, { maxItems: 40 });
export const SetupStatus = Type.Object(
	{
		state: Type.Union([
			Type.Literal("ready"),
			Type.Literal("unconfigured"),
			Type.Literal("needs-model"),
			Type.Literal("needs-credentials"),
		]),
		targetId: Type.Union([Id, Type.Null()]),
		model: Type.Union([text, Type.Null()]),
		message: text,
	},
	closed,
);
export const SetupPrompt = Type.Union([
	Type.Object(
		{
			id: Type.Integer({ minimum: 1 }),
			kind: Type.Literal("select"),
			heading,
			choices: Type.Array(Type.Object({ id: Type.Integer({ minimum: 0 }), label: text, hint: text }, closed), {
				maxItems: 2000,
			}),
			initial: Type.Integer({ minimum: 0 }),
			searchable: Type.Boolean(),
		},
		closed,
	),
	Type.Object(
		{
			id: Type.Integer({ minimum: 1 }),
			kind: Type.Literal("text"),
			heading,
			initial: text,
			hint: text,
			mask: Type.Boolean(),
		},
		closed,
	),
]);
export const SetupState = Type.Object(
	{
		id: Id,
		status: Type.Union([
			Type.Literal("working"),
			Type.Literal("prompt"),
			Type.Literal("saved"),
			Type.Literal("cancelled"),
			Type.Literal("failed"),
		]),
		prompt: Type.Union([SetupPrompt, Type.Null()]),
		messages: Type.Array(text, { maxItems: 80 }),
		problem: Type.Union([text, Type.Null()]),
	},
	closed,
);
export const SetupStart = Type.Object({ targetId: Type.Optional(Id) }, closed);
export const SetupAnswer = Type.Union([
	Type.Object(
		{
			promptId: Type.Integer({ minimum: 1 }),
			action: Type.Literal("select"),
			choice: Type.Integer({ minimum: 0, maximum: 1999 }),
		},
		closed,
	),
	Type.Object({ promptId: Type.Integer({ minimum: 1 }), action: Type.Literal("text"), value: text }, closed),
	Type.Object({ promptId: Type.Integer({ minimum: 1 }), action: Type.Literal("back") }, closed),
]);
export type SetupStatus = Static<typeof SetupStatus>;
export type SetupState = Static<typeof SetupState>;
export type SetupAnswer = Static<typeof SetupAnswer>;
export type SetupStart = Static<typeof SetupStart>;
