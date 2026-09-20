import { type Static, Type } from "typebox";
import { Id } from "./common.js";

export const PermissionDecision = Type.Union([Type.Literal("allow-once"), Type.Literal("reject")]);
export type PermissionDecision = Static<typeof PermissionDecision>;
export const Permission = Type.Object(
	{
		id: Id,
		turnId: Id,
		toolCallId: Type.String({ maxLength: 128 }),
		title: Type.String({ maxLength: 4096 }),
		kind: Type.String({ maxLength: 64 }),
		requestedAt: Type.String(),
		escalateAt: Type.String(),
		expiresAt: Type.String(),
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("escalated"),
			Type.Literal("allowed"),
			Type.Literal("rejected"),
			Type.Literal("expired"),
			Type.Literal("cancelled"),
		]),
	},
	{ additionalProperties: false },
);
export type Permission = Static<typeof Permission>;
