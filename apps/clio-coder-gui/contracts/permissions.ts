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
		/** What a bash command would do, one sentence per step, written by the agent from the full command. */
		consequenceLines: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 9 })),
	},
	closed,
);
export type PermissionDecisionFacts = Static<typeof PermissionDecisionFacts>;
export const PERMISSION_WITHDRAW_METHOD = "_clio-coder/permission/withdraw";
/**
 * Who a forwarded worker ask is from and who may discharge it, carried under `clio-coder/workerAsk`.
 * Identifiers and enums only: nothing the worker's model wrote crosses here, which is what lets the
 * card state it as an authority fact.
 */
export const WorkerAskFacts = Type.Object(
	{
		requestId: Type.String({ maxLength: 128 }),
		requestedBy: Type.String({ maxLength: 128 }),
		agentId: Type.String({ maxLength: 128 }),
		approvalAuthority: Type.Optional(Type.Union([Type.Literal("main"), Type.Literal("operator")])),
		forwardedByMain: Type.Boolean(),
		fallback: Type.Union([Type.Literal("deny"), Type.Literal("fail")]),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	closed,
);
export type WorkerAskFacts = Static<typeof WorkerAskFacts>;
const planField = Type.String({ maxLength: 300 });
/**
 * The dispatch plan admission rendered, carried under `clio-coder/dispatchPlan`. A plan-scale
 * approval covers every run in it, so the ask names each run's agent, task and placement, and the
 * hash the runs will seal. The agent bounds tasks at 32, a task at 1 KiB and a field at 256 bytes.
 */
export const DispatchPlanFacts = Type.Object(
	{
		topology: Type.String({ maxLength: 32 }),
		taskCount: Type.Integer({ minimum: 0 }),
		planScale: Type.Boolean(),
		hash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		costCeilingUsd: Type.Optional(Type.Number({ minimum: 0 })),
		deadlineMs: Type.Optional(Type.Integer({ minimum: 0 })),
		tasks: Type.Array(
			Type.Object(
				{
					agent: planField,
					task: Type.String({ maxLength: 1100 }),
					role: Type.Optional(Type.String({ maxLength: 32 })),
					position: Type.Optional(Type.Integer({ minimum: 0 })),
					target: Type.Optional(planField),
					model: Type.Optional(planField),
					node: Type.Optional(planField),
					nodeKind: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("ssh")])),
					worktree: Type.Optional(Type.Literal(true)),
					apply: Type.Optional(Type.Union([Type.Literal("merge"), Type.Literal("preserve")])),
					stepId: Type.Optional(planField),
					dependencies: Type.Array(planField, { maxItems: 8 }),
					wave: Type.Optional(Type.Integer({ minimum: 0 })),
				},
				closed,
			),
			{ maxItems: 32 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);
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
