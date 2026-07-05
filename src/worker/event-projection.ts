/**
 * Worker-only event projection applied just before an event is serialized to
 * the worker subprocess NDJSON stdout channel.
 *
 * pi-agent-core's `message_update` event carries the full cumulative assistant
 * message twice: once at the top level (`message: AgentMessage`) and once
 * nested under `assistantMessageEvent.partial: AssistantMessage`. Only the
 * event's `delta` is incremental. Because both cumulative snapshots are
 * re-serialized on every streaming delta, a long worker response amplifies
 * stdout quadratically. Measured against the current emitter: ~72x for a 1KB
 * response, ~531x for 10KB, ~2570x for 100KB (matching the receipt
 * 2runue8q1v7q postmortem, which recorded ~4.67M tokens and 133 tool calls on
 * a canceled native worker run).
 *
 * No worker-stdout consumer reads either cumulative field:
 *   - the dispatch board reads only `assistantMessageEvent.type` to stamp the
 *     first-token latency (src/interactive/dispatch-board.ts),
 *   - the streamed answer and the finish contract are reconstructed from the
 *     last assistant `message_end` (src/tools/dispatch.ts,
 *     src/domains/dispatch/extension.ts), and
 *   - token accounting reads `message_end.message.usage`
 *     (src/domains/observability/projection.ts, dispatch-board.ts).
 *
 * The in-process orchestrator surfaces that DO render `assistantMessageEvent.partial`
 * live (chat-loop, ACP server, status state machine) subscribe to their own
 * in-process Agent and never cross this NDJSON seam, so slimming the worker
 * stream leaves interactive streaming untouched. That is why the fix lives here
 * at the worker stdout boundary rather than in the shared engine emit path.
 *
 * This projection drops the two per-delta cumulative snapshots and keeps the
 * incremental `delta` plus the structural discriminants (`type`,
 * `contentIndex`), collapsing worker stdout back to linear size while
 * preserving every consumer contract. Every non-`message_update` event
 * (including the load-bearing `message_end`/`agent_end` transcripts and every
 * `clio_*` event) passes through byte-identical, so unknown-event passthrough
 * and terminal reconstruction are unaffected.
 */

import type { AgentEvent } from "../engine/types.js";
import type { ClioWorkerEvent } from "../engine/worker-events.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function projectWorkerEventForStdout(event: AgentEvent | ClioWorkerEvent): unknown {
	if (!isRecord(event) || event.type !== "message_update") return event;
	// Drop the top-level cumulative AgentMessage snapshot.
	const { message: _message, assistantMessageEvent, ...rest } = event as Record<string, unknown>;
	if (!isRecord(assistantMessageEvent)) return rest;
	// Drop the nested cumulative AssistantMessage snapshot, keep the rest
	// (`type`, `contentIndex`, `delta`, and any once-per-block fields such as
	// `content`/`toolCall` that are not re-emitted per delta).
	const { partial: _partial, ...slimAssistantMessageEvent } = assistantMessageEvent;
	return { ...rest, assistantMessageEvent: slimAssistantMessageEvent };
}
