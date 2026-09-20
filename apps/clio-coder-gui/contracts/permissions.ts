import { type Static, Type } from "typebox";
import { Id } from "./common.js";

const closed = { additionalProperties: false };
const copy = Type.String({ maxLength: 512 });
/**
 * `reject` denies this one request and the turn continues. `reject-and-stop`
 * additionally denies every other parked request from the turn and aborts the
 * prompt, which settles with stopReason "cancelled" rather than "end_turn".
 * It is offered only when the agent announced the option; an older engine has
 * two choices and the third must not be drawn.
 */
export const PermissionDecision = Type.Union([
	Type.Literal("allow-once"),
	Type.Literal("reject"),
	Type.Literal("reject-and-stop"),
]);
export type PermissionDecision = Static<typeof PermissionDecision>;
/**
 * The facts the agent already computed when it classified the call, carried on
 * `session/request_permission` under `clio-coder/decision`. Without them a
 * client re-derives a tier and a consequence from a tool name, which is a
 * second, worse classifier. Every string arrives control-stripped and bounded
 * upstream; the bounds here are the contract, not the sanitizer.
 */
export const PermissionDecisionFacts = Type.Object(
	{
		tier: Type.String({ maxLength: 32 }),
		tierLabel: Type.String({ maxLength: 128 }),
		title: Type.String({ maxLength: 512 }),
		semanticToken: Type.Union([Type.Literal("accent"), Type.Literal("action"), Type.Literal("warning")]),
		authorizationCopy: copy,
		consequenceCopy: copy,
		reversibilityCopy: copy,
		requestedByCopy: copy,
		actionClass: Type.String({ maxLength: 32 }),
		affectedScope: Type.String({ maxLength: 32 }),
		reversibility: Type.String({ maxLength: 32 }),
		target: Type.Optional(Type.String({ maxLength: 512 })),
	},
	closed,
);
export type PermissionDecisionFacts = Static<typeof PermissionDecisionFacts>;
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
		/** Absent when the agent announced no decision facts, or sent none it could parse. */
		decision: Type.Optional(PermissionDecisionFacts),
		/** True when the agent offered a third, turn-ending refusal for this ask. */
		canStopTurn: Type.Boolean(),
	},
	closed,
);
export type Permission = Static<typeof Permission>;
