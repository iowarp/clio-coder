import { hostname } from "node:os";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { CallFailureRecord } from "../core/call-failure.js";
import { processBirthToken } from "../core/process-identity.js";
import type { WorkerTelemetryContext } from "../core/telemetry/context.js";
import type { WorkerTelemetryFrame } from "../core/telemetry/forwarder.js";
import { createTelemetryForwarder } from "../core/telemetry/forwarder.js";
import type { TelemetryCall } from "../core/telemetry/producer.js";
import { beginCall, recordTelemetry } from "../core/telemetry/producer.js";
import type { CallStarted } from "../core/telemetry/schemas.js";
import type { CostProvenance } from "../domains/providers/types/cost-provenance.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "../domains/telemetry/call-facts.js";
import { hasAssistantGenerationDelta } from "./generation-delta.js";

type Request = Pick<CallStarted, "roundKind" | "toolChoice">;

/** Capture each wire attempt before retry wrappers suppress its terminal event (#434). */
export function createWorkerCallTelemetry(
	context: WorkerTelemetryContext,
	target: CallStarted["target"],
	pricing: CostProvenance,
	emit: (frame: WorkerTelemetryFrame) => void,
) {
	const forwarder = createTelemetryForwarder(
		context,
		{
			host: hostname(),
			pid: process.pid,
			birthToken: processBirthToken(),
			monoEpochWallMs: performance.timeOrigin,
		},
		emit,
	);
	// Announce the fact lane before a synchronous stream can publish legacy usage (#434).
	recordTelemetry("process.started", {}, context);
	forwarder.flush();
	let call: TelemetryCall | undefined;
	const settle = (attempt: TelemetryCall | undefined, message: unknown): void => {
		if (!attempt) return;
		// Once per attempt, never per delta: the settlement reaches stdout ahead of the message_end the live display
		// counts, so a kill between the two cannot keep a call the display showed out of the receipt (#434).
		if (attempt.settle(callSettlementFromMessage(message, pricing), reportedModelFromMessage(message))) forwarder.flush();
	};
	return {
		begin(request: Request): void {
			call = beginCall({ ...request, label: "worker", target }, context);
			// Pi converts the conversation before it resolves the key; getApiKey closes this stage (#434).
			call.stage("transform", "start");
		},
		attempt(request: Request): void {
			call = call ? (call.nextAttempt(request) ?? call) : beginCall({ ...request, label: "worker", target }, context);
			call.stage("send", "start");
		},
		/** Stage facts for the live attempt; a settled attempt ignores them (#434). */
		stage(...args: Parameters<TelemetryCall["stage"]>): void {
			call?.stage(...args);
		},
		mark(name: Parameters<TelemetryCall["mark"]>[0]): void {
			call?.mark(name);
		},
		settle(message: unknown): void {
			settle(call, message);
			if (call && message && typeof message === "object")
				Object.assign(message, { callId: call.callId, attemptId: call.attemptId });
		},
		observe(
			source: AssistantMessageEventStream,
			failure: (message: unknown) => CallFailureRecord,
		): AssistantMessageEventStream {
			const attempt = call;
			// The stream is handed back once Pi's provider owns the request; TTFT is firstToken minus this mark (#434).
			attempt?.stage("send", "end");
			return new Proxy(source, {
				get(target, key) {
					if (key === Symbol.asyncIterator)
						return async function* () {
							try {
								for await (const event of target) {
									if (hasAssistantGenerationDelta(event)) attempt?.mark("firstToken");
									if (event.type === "done") settle(attempt, event.message);
									else if (event.type === "error") settle(attempt, { ...event.error, failure: failure(event.error) });
									yield event;
								}
							} catch (error) {
								settle(attempt, { stopReason: "error", failure: failure(error) });
								throw error;
							}
						};
					const value: unknown = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
		close(fallback: unknown): void {
			settle(call, fallback);
			forwarder.close();
		},
	};
}
