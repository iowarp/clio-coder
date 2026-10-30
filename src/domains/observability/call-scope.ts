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

/** Filled by an admission gate while it runs; `waitedOn` names what held the request (#424, #434). */
export interface AdmissionHold {
	waitedOn?: "budget" | "capacity" | "steering";
}

/** One logical helper call retains its originating writer across schema and auth retries (#434). */
export async function openCallScope(options: CallJournalOptions | undefined, model: { api: string; id: string }) {
	const acquired = options ? await options.acquire(options.origin, options.label) : undefined;
	// A writer that failed to open owns no call: its rounds settle no call id, so their writers keep the spend in the
	// out-of-turn store rather than skip it for a journal that never received it (#434).
	const lease = acquired?.journaled ? acquired : undefined;
	let call: TelemetryCall | undefined;
	let settledIdentity: { callId: string; attemptId: string } | undefined;
	const settled = (facts: CallSettled | undefined): CallSettled | undefined => {
		if (facts) settledIdentity = { callId: facts.callId, attemptId: facts.attemptId };
		if (facts && options?.onSettled) {
			try {
				options.onSettled(facts);
			} catch {
				writeDiagnostic("[clio-coder:telemetry] live helper projection failed; journal retains the call\n");
			}
		}
		return facts;
	};
	return {
		identity: () => settledIdentity,
		startAttempt(
			request?: Partial<Pick<CallStarted, "roundKind" | "toolChoice">>,
		): { callId: string; attemptId: string } | undefined {
			if (!options || !lease) return;
			const previousAttempt = call?.attemptId;
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
			if (call.attemptId !== previousAttempt) settledIdentity = undefined;
			return { callId: call.callId, attemptId: call.attemptId };
		},
		settle(message: unknown): CallSettled | undefined {
			if (!call || !options) return undefined;
			return settled(
				call.settle(callSettlementFromMessage(message, options.costProvenance), reportedModelFromMessage(message)),
			);
		},
		/** Time a gate as the current attempt's admission stage, so a wait reads as admission and never as a stall. */
		async admit<T>(gate: (hold: AdmissionHold) => T | Promise<T>): Promise<T> {
			const hold: AdmissionHold = {};
			call?.stage("admission", "start");
			try {
				// Inside the attempt's context, so a budget hold the gate makes is journaled for this call (#424, #434).
				return await (call ? call.withContext(() => gate(hold)) : gate(hold));
			} finally {
				call?.stage("admission", "end", hold);
			}
		},
		withContext<T>(work: () => T): T {
			return call ? call.withContext(work) : work();
		},
		async close(): Promise<void> {
			// An attempt that got no message before its helper finished still settles; a settled one is untouched (#434).
			if (call) settled(call.abandon("internal"));
			await acquired?.release();
		},
	};
}
export type CallScope = Awaited<ReturnType<typeof openCallScope>>;
