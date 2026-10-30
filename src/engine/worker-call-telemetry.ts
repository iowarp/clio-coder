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
import { callSettlementFromMessage, reportedModelFromMessage } from "../domains/observability/call-facts.js";
import type { CostProvenance } from "../domains/providers/types/cost-provenance.js";

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
		attempt.settle(callSettlementFromMessage(message, pricing), reportedModelFromMessage(message));
	};
	return {
		begin(request: Request): void {
			call = beginCall({ ...request, label: "worker", target }, context);
		},
		attempt(request: Request): void {
			call = call ? (call.nextAttempt(request) ?? call) : beginCall({ ...request, label: "worker", target }, context);
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
			return new Proxy(source, {
				get(target, key) {
					if (key === Symbol.asyncIterator)
						return async function* () {
							try {
								for await (const event of target) {
									if ((event.type === "text_delta" || event.type === "thinking_delta") && event.delta.length > 0)
										attempt?.mark("firstToken");
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
