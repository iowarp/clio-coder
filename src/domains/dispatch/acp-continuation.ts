/**
 * Continuing an earlier ACP delegation in its peer's own session (Antigravity ACP Phase 3.2). Pure: reads the
 * earlier run's ledger row and says how the next run opens its peer session, or why it may not.
 */

import type { RunEnvelope } from "./types.js";

/** How a continuing run opens its peer session: the earlier one reopened, or a fresh one when it cannot take a turn. */
export type AcpContinuation =
	| { kind: "reopen"; fromRunId: string; acpSessionId: string }
	| { kind: "fresh"; fromRunId: string; acpSessionId: string; reason: string };

/**
 * The continuation `continue_run` asks for, judged against the earlier run's row: an ACP delegation of the same
 * agent, owned by the same session, settled, with a peer session on record. Anything else throws, naming why.
 */
export function resolveAcpContinuation(input: {
	runId: string;
	row: Readonly<RunEnvelope> | null;
	agentId: string;
	ownerSessionId: string | null;
}): AcpContinuation {
	const { runId, row } = input;
	const refuse = (why: string): never => {
		throw new Error(`dispatch: continue_run '${runId}' ${why}`);
	};
	if (row === null) return refuse("names no run in this state root's ledger");
	if (row.runtimeKind !== "acp-delegation") return refuse("is not an ACP delegation run");
	if (row.agentId !== input.agentId)
		return refuse(`ran agent '${row.agentId}', not '${input.agentId}'; a peer session continues with its own agent`);
	if ((row.sessionId ?? null) !== input.ownerSessionId)
		return refuse("belongs to another session; only the session that dispatched it can continue it");
	if (row.endedAt === null) return refuse("has not settled; steer it instead, or wait for it to end");
	const session = row.acpSession;
	if (session === undefined) return refuse("recorded no peer session (it ended before its peer opened one)");
	if (session.nonResumable !== undefined)
		return {
			kind: "fresh",
			fromRunId: runId,
			acpSessionId: session.sessionId,
			reason: `the peer marked session '${session.sessionId}' unable to take another turn (${session.nonResumable.reason})`,
		};
	return { kind: "reopen", fromRunId: runId, acpSessionId: session.sessionId };
}
