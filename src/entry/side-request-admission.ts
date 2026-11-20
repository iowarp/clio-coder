/**
 * Admission and journal accounting for one side request, with the paid-request
 * check in front of it. The safety judge's one-shot and System One's LLM engine
 * both ask through this; the role names whose call the journal records.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CallObservation } from "../core/call-failure.js";
import type { SurfaceId } from "../core/side-surfaces.js";
import type { AgentRole } from "../core/telemetry/enums.js";
import { beginCall, processTelemetryContext } from "../core/telemetry/producer.js";
import { calculatePricingCostUsd, resolveEffectivePricing } from "../domains/providers/catalog.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import type { LlmRequestAdmission, LlmRequestUsage } from "../domains/providers/one-shot.js";
import { LlmAdmissionRefused } from "../domains/providers/one-shot.js";
import { SessionCostCeilingError, sessionCeilingReached } from "../domains/scheduling/budget.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import { noteSystemOneCall } from "../domains/system-one/index.js";
import {
	callSettlementFromMessage,
	reportedModelFromMessage,
	sideCallShutdownCause,
} from "../domains/telemetry/call-facts.js";
import type { TelemetryContract } from "../domains/telemetry/contract.js";

/** The surface a System One ask runs for, set by the host that asks (memory design 4.1). */
const sidePurpose = new AsyncLocalStorage<SurfaceId>();
/** The safety judge's own call, noted while one review runs so its decision row can name it (memory design 4.5). */
const judgeCalls = new AsyncLocalStorage<{ callId?: string }>();

/** Run a System One ask under the surface it is for; its admitted calls journal that purpose. */
export function withSidePurpose<T>(purpose: SurfaceId, work: () => T): T {
	return sidePurpose.run(purpose, work);
}

/** Run one safety judge review with a fresh slot for the judge call it makes. */
export function withJudgeCallCapture<T>(work: () => T): T {
	return judgeCalls.run({}, work);
}

/** The last judge call the current review opened, if it opened one. */
export function capturedJudgeCallId(): string | undefined {
	return judgeCalls.getStore()?.callId;
}

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
		const purpose = role === "safety-judge" ? "judge" : sidePurpose.getStore();
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
						...(purpose !== undefined ? { purpose } : {}),
						toolChoice: "none",
					},
					owner,
				)
			: undefined;
		if (call) noteSystemOneCall(call.callId);
		const judgeCall = role === "safety-judge" ? judgeCalls.getStore() : undefined;
		if (call && judgeCall) judgeCall.callId = call.callId;
		let settled = false;
		const settle = (message: unknown): void => {
			if (settled) return;
			settled = true;
			try {
				call?.settle(
					callSettlementFromMessage(message, pricing, sideCallShutdownCause(message)),
					reportedModelFromMessage(message),
				);
			} finally {
				void lease?.release();
			}
		};
		try {
			signal.throwIfAborted();
			// Checked whatever the route's pricing: an unpriced route projects nothing, but the session's settled
			// spend may already be at the ceiling.
			if (deps.scheduling?.admitPaidRequest) {
				await deps.scheduling.admitPaidRequest({ waitForRaise: false, getCeilingUsd: deps.getCeilingUsd, signal });
			} else {
				const currentUsd = (await deps.telemetry?.settledSessionSpend())?.usd ?? 0;
				const ceilingUsd = deps.getCeilingUsd();
				if (sessionCeilingReached(currentUsd, ceilingUsd)) throw new SessionCostCeilingError(currentUsd, ceilingUsd);
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
								// A runtime that computed no cost hands its counts to the declared rates; a billed cost outranks
								// them, and reportedFields (spread above) keeps a placeholder count unknown (#434).
								cost: usage.costUncomputed
									? { totalUncomputed: true }
									: {
											total:
												usage.costUsd ??
												calculatePricingCostUsd(pricing.rates, {
													input: usage.input,
													output: usage.output,
													cacheRead: usage.cacheRead ?? 0,
													cacheWrite: usage.cacheWrite ?? 0,
													cacheWrite1h: usage.cacheWrite1h ?? 0,
												}),
											...(usage.costFromProvider ? { totalFromProvider: true } : {}),
										},
							},
			});
		};
		// The engine runs its request inside the call, so its own stages say whether the request ever left (#429).
		return call ? Object.assign(account, { withContext: <T>(work: () => T): T => call.withContext(work) }) : account;
	};
}
