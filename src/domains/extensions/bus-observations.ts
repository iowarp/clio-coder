import { BusChannels } from "../../core/bus-events.js";
import type { SafeEventBus } from "../../core/event-bus.js";
import type { ExtensionObservationV2, ExtensionUsage } from "./public-api-v2.js";

/**
 * Bus facts api 2 extensions may observe, as observations. Only metadata is
 * mapped: tool names, outcomes, run identity and usage. Nothing here carries
 * a prompt, arguments, results or assistant text, so the per-extension access
 * filter has nothing to strip from these.
 */
export function subscribeExtensionObservations(
	bus: Pick<SafeEventBus, "on">,
	observe: (observation: ExtensionObservationV2) => void,
): () => void {
	const send = (observation: ExtensionObservationV2): void => {
		try {
			observe(observation);
		} catch {
			// Observation is passive; a failed delivery changes nothing on the bus.
		}
	};
	const unsubscribers = [
		bus.on(BusChannels.PermissionRequested, (p) => send({ event: "permission_requested", tool: p.tool })),
		bus.on(BusChannels.PermissionResolved, (p) =>
			send({ event: "permission_resolved", tool: p.tool ?? "", decision: p.status === "granted" ? "allowed" : "denied" }),
		),
		bus.on(BusChannels.SafetyBlocked, (p) => send({ event: "safety_blocked", tool: p.tool })),
		bus.on(BusChannels.DispatchStarted, (p) => send({ event: "dispatch_started", runId: p.runId, agentId: p.agentId })),
		bus.on(BusChannels.DispatchCompleted, (p) => {
			const usage: ExtensionUsage = {
				inputTokens: p.inputTokenCount,
				outputTokens: p.outputTokenCount,
				cacheReadTokens: p.cacheReadTokenCount,
				cacheWriteTokens: p.cacheWriteTokenCount,
				// A cost the target did not declare is a guess; extensions get null rather than an estimate.
				costUsd: p.costProvenance === "known" || p.costProvenance === "known_free" ? p.costUsd : null,
				model: p.wireModelId,
				target: p.targetId,
			};
			send({ event: "dispatch_completed", runId: p.runId, agentId: p.agentId, durationMs: p.durationMs, usage });
		}),
		bus.on(BusChannels.DispatchFailed, (p) =>
			send({ event: "dispatch_failed", runId: p.runId, agentId: p.agentId, reason: String(p.reason) }),
		),
		bus.on(BusChannels.CompactionEnd, () => send({ event: "compaction_end", outcome: "ok" })),
		bus.on(BusChannels.BudgetAlert, (p) => send({ event: "budget_alert", costUsd: p.currentUsd })),
	];
	return () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
}

/** The part of a finished turn's summary an observation carries; the TUI's turn summary has this shape. */
export interface ObservedTurnSummary {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	modelId: string;
	targetId: string;
	stopReason: string;
}

/**
 * Tool and turn facts from the surface that runs the turns. A turn id is
 * the turn's position in this session, since the summary carries none.
 */
export function createTurnObservations(observe: (observation: ExtensionObservationV2) => void): {
	/** The access filter strips `text` for an extension that did not declare `prompt`. */
	turnStart(text: string): void;
	toolStart(toolCallId: string): void;
	toolEnd(toolName: string, toolCallId: string, isError: boolean): void;
	turnEnd(summary: ObservedTurnSummary): void;
} {
	const started = new Map<string, number>();
	let turn = 0;
	const send = (observation: ExtensionObservationV2): void => {
		try {
			observe(observation);
		} catch {
			// Passive delivery; the turn goes on.
		}
	};
	return {
		turnStart(text) {
			send({ event: "turn_start", turnId: `turn-${turn + 1}`, text });
		},
		toolStart(toolCallId) {
			started.set(toolCallId, performance.now());
		},
		toolEnd(toolName, toolCallId, isError) {
			const at = started.get(toolCallId);
			started.delete(toolCallId);
			send({
				event: "tool_end",
				turnId: `turn-${turn + 1}`,
				tool: toolName,
				outcome: isError ? "error" : "ok",
				durationMs: at === undefined ? 0 : Math.round(performance.now() - at),
			});
		},
		turnEnd(summary) {
			turn += 1;
			send({
				event: "turn_end",
				turnId: `turn-${turn}`,
				outcome:
					summary.stopReason === "cancelled" || summary.stopReason === "aborted"
						? "aborted"
						: summary.stopReason === "error"
							? "error"
							: "completed",
				usage: {
					inputTokens: summary.inputTokens,
					outputTokens: summary.outputTokens,
					cacheReadTokens: summary.cacheReadTokens,
					cacheWriteTokens: summary.cacheWriteTokens,
					costUsd: null,
					model: summary.modelId,
					target: summary.targetId,
				},
			});
		},
	};
}
