import { AsyncLocalStorage } from "node:async_hooks";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { CallLabel } from "./enums.js";
import { AttemptIdSchema, CallIdSchema, ExistingId } from "./id-schemas.js";

export { AttemptIdSchema, CallIdSchema, ExistingId };

const contextFields = {
	toolCallId: Type.Optional(ExistingId),
	turnId: Type.Optional(ExistingId),
	batchId: Type.Optional(ExistingId),
	parentRunId: Type.Optional(ExistingId),
	callId: Type.Optional(CallIdSchema),
	attemptId: Type.Optional(AttemptIdSchema),
	label: CallLabel,
};
// Standalone runs have no session; their real run id owns the journal (#434).
export const TelemetryContextSchema = Type.Union([
	Type.Object(
		{ ...contextFields, sessionId: ExistingId, runId: Type.Optional(ExistingId) },
		{ additionalProperties: false },
	),
	Type.Object({ ...contextFields, sessionId: Type.Null(), runId: ExistingId }, { additionalProperties: false }),
	// A record that names neither a session nor a run belongs to the process that wrote it (#434).
	Type.Object(
		{ ...contextFields, sessionId: Type.Null(), runId: Type.Optional(Type.Never()), processId: ExistingId },
		{ additionalProperties: false },
	),
]);
export type TelemetryContext = Readonly<Static<typeof TelemetryContextSchema>>;
export type WorkerTelemetryContext = TelemetryContext & { readonly runId: string; readonly label: "worker" };

/** A parent passes run identity; each worker request mints its own call and attempt ids (#434). */
export function isWorkerTelemetryContext(value: unknown): value is WorkerTelemetryContext {
	return (
		Value.Check(TelemetryContextSchema, value) &&
		value.runId !== undefined &&
		value.label === "worker" &&
		value.callId === undefined &&
		value.attemptId === undefined
	);
}

/** Run facts belong to their run even when a parent session exists (#434). */
export function telemetryOwner(context: TelemetryContext): string {
	if ("processId" in context) return `process:${context.processId}`;
	return context.runId !== undefined ? `run:${context.runId}` : `session:${context.sessionId}`;
}

const contexts = new AsyncLocalStorage<TelemetryContext>();
export function telemetryContext(): TelemetryContext | undefined {
	return contexts.getStore();
}

export function withTelemetryContext<T>(context: TelemetryContext, fn: () => T): T {
	return contexts.run(Object.freeze({ ...context }), fn);
}

/**
 * The scope a record about a known owner belongs to, for a producer that may run outside that owner's async context
 * (an operator keypress, a dispatch callback): the current context when it already names the owner, else the owner
 * itself. Without an owner it is the current context (#434).
 */
export function ownerTelemetryContext(owner: {
	sessionId?: string | null | undefined;
	runId?: string | undefined;
	turnId?: string | undefined;
	toolCallId?: string | undefined;
}): TelemetryContext | undefined {
	const current = telemetryContext();
	const ids = {
		...(owner.turnId ? { turnId: owner.turnId } : {}),
		...(owner.toolCallId ? { toolCallId: owner.toolCallId } : {}),
	};
	if (owner.runId) {
		if (current?.runId === owner.runId) return { ...current, ...ids };
		return owner.sessionId
			? { sessionId: owner.sessionId, runId: owner.runId, label: "worker", ...ids }
			: { sessionId: null, runId: owner.runId, label: "worker", ...ids };
	}
	if (owner.sessionId) {
		if (current && current.sessionId === owner.sessionId && current.runId === undefined) return { ...current, ...ids };
		return { sessionId: owner.sessionId, label: "main", ...ids };
	}
	return current ? { ...current, ...ids } : undefined;
}

/** Tool admission uses host identities, never ids supplied in model arguments (#434). */
export function withToolTelemetryContext<T>(
	identity: {
		sessionId?: string;
		runId?: string;
		turnId?: string;
		toolCallId?: string;
		callId?: string;
		attemptId?: string;
	},
	work: () => T,
): T {
	const parent = telemetryContext();
	const hasOwner = identity.sessionId !== undefined || identity.runId !== undefined;
	const sameOwner =
		!hasOwner || ((identity.sessionId ?? null) === parent?.sessionId && identity.runId === parent?.runId);
	const inherited = sameOwner ? parent : undefined;
	const owner: TelemetryContext | undefined =
		inherited ??
		(identity.sessionId !== undefined
			? {
					sessionId: identity.sessionId,
					...(identity.runId === undefined ? {} : { runId: identity.runId }),
					label: identity.runId === undefined ? "main" : "worker",
				}
			: identity.runId !== undefined
				? { sessionId: null, runId: identity.runId, label: "worker" }
				: undefined);
	if (!owner) return work();
	// A new turn cannot inherit the preceding request's provider attribution (#434).
	const { callId: parentCallId, attemptId: parentAttemptId, ...base } = owner;
	const sameTurn = identity.turnId === undefined || identity.turnId === owner.turnId;
	const explicitCall = Value.Check(CallIdSchema, identity.callId) && Value.Check(AttemptIdSchema, identity.attemptId);
	const inheritCall = sameTurn && identity.callId === undefined && identity.attemptId === undefined;
	const callId = explicitCall ? identity.callId : inheritCall ? parentCallId : undefined;
	const attemptId = explicitCall ? identity.attemptId : inheritCall ? parentAttemptId : undefined;
	return withTelemetryContext(
		{
			...base,
			...(callId !== undefined ? { callId } : {}),
			...(attemptId !== undefined ? { attemptId } : {}),
			...(identity.turnId === undefined ? {} : { turnId: identity.turnId }),
			...(identity.toolCallId === undefined ? {} : { toolCallId: identity.toolCallId }),
		},
		work,
	);
}

/**
 * The context of a fact about one session, for a seam that knows which session it acted on: the async context when
 * it already names that session (keeping its turn and tool call), else the session's own. No session, no context;
 * the fact is then a gap rather than another scope's (#434).
 */
export function sessionTelemetryContext(sessionId: string | null | undefined): TelemetryContext | undefined {
	if (!sessionId) return undefined;
	return withToolTelemetryContext({ sessionId }, telemetryContext);
}

/** Match the actual tool block to ids Clio attached at settlement; provider ids are never inferred (#434). */
export function observedToolCallOrigin(
	messages: readonly unknown[],
	toolCallId: string | undefined,
): { callId: string; attemptId: string } | undefined {
	if (!toolCallId) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const row = message as Record<string, unknown>;
		if (row.role !== "assistant" || !Array.isArray(row.content)) continue;
		if (
			!row.content.some(
				(block) => block && typeof block === "object" && block.type === "toolCall" && block.id === toolCallId,
			)
		)
			continue;
		return Value.Check(CallIdSchema, row.callId) && Value.Check(AttemptIdSchema, row.attemptId)
			? { callId: row.callId, attemptId: row.attemptId }
			: undefined;
	}
	return undefined;
}
