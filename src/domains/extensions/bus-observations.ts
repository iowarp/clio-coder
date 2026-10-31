import type { Fact, FactSum } from "../../core/telemetry/fact.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import { sumFacts } from "../../core/telemetry/pricing.js";
import { callSettlementFromMessage } from "../telemetry/call-facts.js";
import type { ExtensionObservationV2, ExtensionUsage } from "./public-api-v2.js";

/**
 * Bus facts api 2 extensions may observe, as observations. Only metadata is
 * mapped: tool names, outcomes, run identity and usage. Nothing here carries
 * a prompt, arguments, results or assistant text, so the per-extension access
 * filter has nothing to strip from these.
 */
export function subscribeExtensionObservations(
	bus: Pick<TelemetryHub, "subscribe">,
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
		bus.subscribe("approval.requested", (p) => send({ event: "permission_requested", tool: p.tool })),
		bus.subscribe("approval.resolved", (p) =>
			send({ event: "permission_resolved", tool: p.tool ?? "", decision: p.status === "granted" ? "allowed" : "denied" }),
		),
		bus.subscribe("safety.blocked", (p) => send({ event: "safety_blocked", tool: p.tool })),
		bus.subscribe("run.started", (p) => send({ event: "dispatch_started", runId: p.runId, agentId: p.agentId })),
		bus.subscribe("run.completed", (p) => {
			const { usage: tokens, pricing } = p.spend;
			const usage: ExtensionUsage = {
				inputTokens: sumFacts([tokens.input]),
				outputTokens: sumFacts([tokens.output]),
				cacheReadTokens: sumFacts([tokens.cacheRead]),
				cacheWriteTokens: sumFacts([tokens.cacheWrite]),
				costUsd: pricing.pricedBy === "none" ? null : sumFacts([pricing.usd]),
				model: p.wireModelId,
				target: p.targetId,
			};
			send({ event: "dispatch_completed", runId: p.runId, agentId: p.agentId, durationMs: p.durationMs, usage });
		}),
		bus.subscribe("run.failed", (p) =>
			send({ event: "dispatch_failed", runId: p.runId, agentId: p.agentId, reason: String(p.reason) }),
		),
		bus.subscribe("compaction.ended", (p) =>
			send({
				event: "compaction_end",
				outcome:
					p.outcome === "completed" || p.outcome === "unchanged"
						? "ok"
						: p.outcome === "failed" || p.outcome === "cancelled"
							? "failed"
							: "unknown",
			}),
		),
		bus.subscribe("budget.alerted", (p) => send({ event: "budget_alert", costUsd: p.currentUsd })),
	];
	return () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
}

/** The part of a finished turn an observation carries: its token sums over the turn's calls. */
export interface ObservedTurnSummary {
	inputTokens: FactSum;
	outputTokens: FactSum;
	cacheReadTokens: FactSum;
	cacheWriteTokens: FactSum;
	modelId: string;
	targetId: string;
	stopReason: string;
}

/**
 * The provider-reported usage of the run in flight, folded from its chat events: reset by `agent_start`, added to by
 * each assistant `message_end`. Every session host reads a turn's `turn_end` usage from here, so the terminal,
 * headless runs and ACP report the same counts for the same turn.
 */
export function createChatTurnUsage(): {
	observe(event: unknown): void;
	/** The usage so far, with the model and stop reason the run's last assistant message reported. */
	current(): Omit<ObservedTurnSummary, "targetId">;
} {
	const fresh = () => ({
		input: [] as Fact<number>[],
		output: [] as Fact<number>[],
		cacheRead: [] as Fact<number>[],
		cacheWrite: [] as Fact<number>[],
	});
	let usage = fresh();
	let modelId = "";
	let stopReason = "completed";
	return {
		observe(raw) {
			const event = raw as {
				type?: unknown;
				message?: { role?: unknown; model?: unknown; stopReason?: unknown; usage?: Record<string, unknown> };
			};
			if (event.type === "agent_start") {
				usage = fresh();
				modelId = "";
				stopReason = "completed";
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				// Each reply reads its usage as its call.settled does; a reply that never reached a provider adds nothing.
				const reported = callSettlementFromMessage(event.message, "none").usage;
				if (reported) {
					usage.input.push(reported.input);
					usage.output.push(reported.output);
					usage.cacheRead.push(reported.cacheRead);
					usage.cacheWrite.push(reported.cacheWrite);
				}
				if (typeof event.message.model === "string") modelId = event.message.model;
				if (typeof event.message.stopReason === "string") stopReason = event.message.stopReason;
			}
		},
		current: () => ({
			inputTokens: sumFacts(usage.input),
			outputTokens: sumFacts(usage.output),
			cacheReadTokens: sumFacts(usage.cacheRead),
			cacheWriteTokens: sumFacts(usage.cacheWrite),
			modelId,
			stopReason,
		}),
	};
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

/**
 * Tool and turn facts read from a chat event stream, for session hosts without
 * the terminal's turn summary (headless `run`, ACP). Only names, ids, outcomes
 * and usage are read; message content never leaves this function.
 */
export function observeChatTurns(
	onEvent: (handler: (event: unknown) => void) => () => void,
	turns: ReturnType<typeof createTurnObservations>,
	targetId: () => string,
): () => void {
	const usage = createChatTurnUsage();
	return onEvent((raw) => {
		usage.observe(raw);
		const event = raw as { type?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown };
		if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
			turns.toolStart(event.toolCallId);
		} else if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
			turns.toolEnd(typeof event.toolName === "string" ? event.toolName : "", event.toolCallId, event.isError === true);
		} else if (event.type === "agent_end") {
			turns.turnEnd({ ...usage.current(), targetId: targetId() });
		}
	});
}
