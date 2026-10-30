import { writeDiagnostic } from "../../core/diagnostics.js";
import type { TelemetryCall } from "../../core/telemetry/producer.js";
import { beginCall } from "../../core/telemetry/producer.js";
import type { CallSettled, CallStarted } from "../../core/telemetry/schemas.js";
import type { CostProvenance } from "../providers/types/cost-provenance.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "./call-facts.js";
import type { ObservabilityContract } from "./contract.js";
import type { TelemetrySessionOrigin } from "./session-journals.js";

export interface CallJournalOptions {
	origin: TelemetrySessionOrigin;
	acquire: NonNullable<ObservabilityContract["acquireTelemetrySession"]>;
	label: CallStarted["label"];
	targetId: string;
	runtimeId: string;
	costProvenance: CostProvenance;
	onSettled?: (facts: CallSettled) => void;
}

/** One logical helper call retains its originating writer across schema and auth retries (#434). */
export async function openCallScope(options: CallJournalOptions | undefined, model: { api: string; id: string }) {
	const lease = options ? await options.acquire(options.origin, options.label) : undefined;
	let call: TelemetryCall | undefined;
	return {
		startAttempt(request?: Partial<Pick<CallStarted, "roundKind" | "toolChoice">>): void {
			if (!options || !lease) return;
			call = call
				? (call.nextAttempt(request) ?? call)
				: beginCall(
						{
							label: options.label,
							target: {
								targetId: options.targetId,
								runtimeId: options.runtimeId,
								api: model.api,
								requestedModel: model.id,
								reportedModel: { kind: "unknown", reason: "not-observed" },
							},
							roundKind: "tools-removed",
							toolChoice: "none",
							...request,
						},
						lease.context,
					);
		},
		settle(message: unknown): CallSettled | undefined {
			if (!call || !options) return undefined;
			const facts = call.settle(
				callSettlementFromMessage(message, options.costProvenance),
				reportedModelFromMessage(message),
			);
			if (facts && options.onSettled) {
				try {
					options.onSettled(facts);
				} catch {
					writeDiagnostic("[clio-coder:telemetry] live helper projection failed; journal retains the call\n");
				}
			}
			return facts;
		},
		withContext<T>(work: () => T): T {
			return call ? call.withContext(work) : work();
		},
		async close(): Promise<void> {
			await lease?.release();
		},
	};
}
export type CallScope = Awaited<ReturnType<typeof openCallScope>>;
