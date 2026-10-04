import { type Static, Type } from "typebox";
import { Id } from "./common.js";
import { AcpDispatchPlanFactsSchema, AcpPermissionDecisionFactsSchema, AcpWorkerAskFactsSchema } from "./wire.js";

const closed = { additionalProperties: false };
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
export const PermissionDecisionFacts = AcpPermissionDecisionFactsSchema;
export type PermissionDecisionFacts = Static<typeof PermissionDecisionFacts>;
export { ACP_PERMISSION_WITHDRAW_METHOD as PERMISSION_WITHDRAW_METHOD } from "./wire.js";
/**
 * Who a forwarded worker ask is from and who may discharge it, carried under `clio-coder/workerAsk`.
 * Identifiers and enums only: nothing the worker's model wrote crosses here, which is what lets the
 * card state it as an authority fact.
 */
export const WorkerAskFacts = AcpWorkerAskFactsSchema;
export type WorkerAskFacts = Static<typeof WorkerAskFacts>;
/**
 * The dispatch plan admission rendered, carried under `clio-coder/dispatchPlan`. A plan-scale
 * approval covers every run in it, so the ask names each run's agent, task and placement, and the
 * hash the runs will seal. The agent bounds tasks at 32, a task at 1 KiB and a field at 256 bytes.
 */
export const DispatchPlanFacts = AcpDispatchPlanFactsSchema;
export type DispatchPlanFacts = Static<typeof DispatchPlanFacts>;
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
		/** Present for a dispatch ask from an agent that reports the plan it admitted. */
		plan: Type.Optional(DispatchPlanFacts),
		/** Present when the ask is a dispatched worker's escalation forwarded by the agent. */
		worker: Type.Optional(WorkerAskFacts),
		/** True when the agent offered a third, turn-ending refusal for this ask. */
		canStopTurn: Type.Boolean(),
	},
	closed,
);
export type Permission = Static<typeof Permission>;
