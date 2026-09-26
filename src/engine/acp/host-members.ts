/**
 * The ACP host's members for the allowlisted commands that need more than a
 * reply: the worker runs `/share` picks from, the record `/oracle` briefs on,
 * and the tool calls `/council` makes on the operator's behalf.
 *
 * `/council` is a plan-scale dispatch, and supervised autonomy parks it for
 * approval. The ACP permission bridge binds an approval to a `tool_call` the
 * client has already been shown, so a dispatch the host starts is announced
 * through the same engine-shaped events the chat emits, under one call id, and
 * the registry is invoked under that id. Nothing here builds a request,
 * resolves a route, or touches the dispatch domain; the registry admits the
 * call exactly as it admits a model's.
 *
 * Only the composition root imports this module (a declared seam in
 * tests/boundaries/check-boundaries.ts), so the worker-stream and oracle
 * modules it reaches stay off the ACP CLI's own import graph.
 */

import { randomUUID } from "node:crypto";
import { ToolNames } from "../../core/tool-names.js";
import type { CouncilDispatchOutcome } from "../../interactive/slash-commands.js";
import type { ToolRegistry } from "../../tools/registry.js";

export { oracleBriefingFromEntries } from "../../interactive/oracle.js";
export { followWorkerRuns } from "../../interactive/worker-run-ledger.js";

export interface HostToolEvents {
	emit(event: Record<string, unknown>): void;
	onEvent(handler: (event: unknown) => void): () => void;
}

export function createHostToolEvents(): HostToolEvents {
	const handlers = new Set<(event: unknown) => void>();
	return {
		emit: (event) => {
			for (const handler of handlers) handler(event);
		},
		onEvent: (handler) => {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
	};
}

/** One dispatch the operator asked for by command, announced, admitted and settled as a model's call is. */
export async function runHostDispatch(
	registry: Pick<ToolRegistry, "invoke">,
	events: HostToolEvents,
	args: Readonly<Record<string, unknown>>,
): Promise<CouncilDispatchOutcome> {
	const toolCallId = `host-${randomUUID()}`;
	events.emit({ type: "tool_execution_start", toolCallId, toolName: ToolNames.Dispatch, args: { ...args } });
	const verdict = await registry.invoke({ tool: ToolNames.Dispatch, args: { ...args } }, { toolCallId });
	const outcome: CouncilDispatchOutcome =
		verdict.kind === "blocked"
			? { status: "blocked", reason: verdict.reason }
			: verdict.kind === "not_visible"
				? { status: "error", message: verdict.reason }
				: verdict.result.kind === "error"
					? { status: "error", message: verdict.result.message }
					: { status: "ok" };
	const text =
		verdict.kind === "ok" && verdict.result.kind === "ok"
			? verdict.result.output
			: outcome.status === "blocked"
				? outcome.reason
				: outcome.status === "error"
					? outcome.message
					: "";
	events.emit({
		type: "tool_execution_end",
		toolCallId,
		toolName: ToolNames.Dispatch,
		result: { content: [{ type: "text", text }] },
		isError: outcome.status !== "ok",
	});
	return outcome;
}
