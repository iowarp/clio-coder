/**
 * Admission and journal accounting for one side request, with the paid-request
 * check in front of it. The safety judge's one-shot and System One's LLM engine
 * both ask through this; the role names whose call the journal records.
 */

import type { CallObservation } from "../core/call-failure.js";
import type { AgentRole } from "../core/telemetry/enums.js";
import { pricesCalls } from "../core/telemetry/pricing.js";
import { beginCall, processTelemetryContext } from "../core/telemetry/producer.js";
import { calculatePricingCostUsd, resolveEffectivePricing } from "../domains/providers/catalog.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import type { LlmRequestAdmission, LlmRequestUsage } from "../domains/providers/one-shot.js";
import { LlmAdmissionRefused } from "../domains/providers/one-shot.js";
import { SessionCostCeilingError, sessionCeilingReached } from "../domains/scheduling/budget.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import { noteSystemOneCall } from "../domains/system-one/index.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "../domains/telemetry/call-facts.js";
import type { TelemetryContract } from "../domains/telemetry/contract.js";

export function createSideRequestAdmission(deps: {
	providers: Pick<ProvidersContract, "getTarget"> & Partial<Pick<ProvidersContract, "getRuntime">>;
	scheduling?: SchedulingContract;
	telemetry?: TelemetryContract;
	getCeilingUsd: () => number;
	currentSession: () => string | null;
	repoIdentity: () => string | null;
	role?: Extract<AgentRole, "system-one" | "safety-judge">;
}): LlmRequestAdmission {
	const role = deps.role ?? "system-one";
	return async ({ engine, targetId, model, signal }) => {
		const session = deps.currentSession();
		const repoIdentity = deps.repoIdentity();
		const target = deps.providers.getTarget(targetId);
		if (target === null) throw new LlmAdmissionRefused(`target '${targetId}' is no longer configured`);
		const pricing = resolveEffectivePricing(
			target,
			deps.providers.getRuntime?.(target.runtime) ?? { id: target.runtime },
			model,
		);
		const lease =
			session && repoIdentity
				? await deps.telemetry?.acquireTelemetrySession?.(
						{ id: session, cwdHash: repoIdentity },
						{ role, id: engine ?? session },
					)
				: undefined;
		// A decision outside a session is the process's own call; a session whose writer failed to open mints none and
		// its journal records the gap (#434). An engine names its own calls; the safety judge is named by its scope.
		const processContext = session && repoIdentity ? undefined : processTelemetryContext();
		const owner = processContext
			? { ...processContext, agent: { role, id: engine ?? processContext.agent.id } }
			: lease?.journaled
				? lease.context
				: undefined;
		const call = owner
			? beginCall(
					{
						target: {
							targetId,
							runtimeId: target.runtime,
							api: deps.providers.getRuntime?.(target.runtime)?.apiFamily ?? "unknown",
							requestedModel: model,
							reportedModel: { kind: "unknown", reason: "not-observed" },
						},
						roundKind: "tools-removed",
						toolChoice: "none",
					},
					owner,
				)
			: undefined;
		if (call) noteSystemOneCall(call.callId);
		let settled = false;
		const settle = (message: unknown): void => {
			if (settled) return;
			settled = true;
			try {
				call?.settle(callSettlementFromMessage(message, pricing.pricedBy), reportedModelFromMessage(message));
			} finally {
				void lease?.release();
			}
		};
		try {
			signal.throwIfAborted();
			if (pricesCalls(pricing.pricedBy)) {
				if (deps.scheduling?.admitPaidRequest) {
					await deps.scheduling.admitPaidRequest({ waitForRaise: false, getCeilingUsd: deps.getCeilingUsd, signal });
				} else {
					const currentUsd = (await deps.telemetry?.settledSessionSpend())?.usd ?? 0;
					const ceilingUsd = deps.getCeilingUsd();
					if (sessionCeilingReached(currentUsd, ceilingUsd)) throw new SessionCostCeilingError(currentUsd, ceilingUsd);
				}
			}
			signal.throwIfAborted();
			if (deps.currentSession() !== session) throw new Error("System One session changed before the request");
		} catch (error) {
			settle({
				stopReason: signal.aborted ? "aborted" : "error",
				callInvoked: false,
				failure: { invoked: false, stage: "admission" },
			});
			throw new LlmAdmissionRefused(error instanceof Error ? error.message : String(error), { cause: error });
		}
		const account = (usage: LlmRequestUsage | null, observation?: CallObservation): void => {
			if (settled) return;
			settle({
				stopReason:
					observation?.callOutcome === "aborted"
						? "aborted"
						: observation?.callOutcome === "error" || (observation === undefined && usage === null)
							? "error"
							: "stop",
				...(observation?.failure ? { failure: observation.failure } : {}),
				usage:
					usage === null
						? null
						: {
								...usage,
								// Only the direct HTTP parser proves explicit zero. Pi placeholders remain unknown, and the
								// key is omitted for them: a present `clioExternal` without the mark reads as unmeasured (#434).
								...(usage.providerReported ? { clioExternal: { tokenUsage: "provider-reported" as const } } : {}),
								...(usage.providerReported && usage.cacheRead === undefined ? { input: undefined } : {}),
								cost: {
									total:
										usage.costUsd ??
										calculatePricingCostUsd(pricing.rates, {
											input: usage.input,
											output: usage.output,
											cacheRead: usage.cacheRead ?? 0,
											cacheWrite: usage.cacheWrite ?? 0,
											cacheWrite1h: usage.cacheWrite1h ?? 0,
										}),
								},
							},
			});
		};
		// The engine runs its request inside the call, so its own stages say whether the request ever left (#429).
		return call ? Object.assign(account, { withContext: <T>(work: () => T): T => call.withContext(work) }) : account;
	};
}
