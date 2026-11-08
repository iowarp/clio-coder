/**
 * The background memory role's model route: which target and model a memory
 * step calls, whether it may call it now (budget, quota, endpoint capacity and
 * information flow), and the usage and call journal it settles. The
 * composition root constructs these with its live providers, settings, bus and
 * session spend; the policy itself lives here so changing it never means
 * editing the module that boots every interface.
 */
import { classifyCallFailure } from "../../core/call-failure.js";
import { codexAccountScope } from "../../core/codex-account.js";
import type { ClioSettings } from "../../core/config.js";
import { writeDiagnostic } from "../../core/diagnostics.js";
import { resolveMemoryRoute } from "../../core/session-routing.js";
import type { Fact } from "../../core/telemetry/fact.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import { noCallRunUsageFacts, pricingBasisFields, unobservedRunUsageFacts } from "../../core/telemetry/pricing.js";
import type { CallUsage } from "../../core/telemetry/schemas.js";
import { completeEngineText, type EngineTextCompletionResult } from "../../engine/ai.js";
import { declareRuntimeNoticeProducer } from "../../engine/apis/residency.js";
import { endpointCapacityUsage } from "../dispatch/capacity-lease.js";
import { announceMemoryStepEndpoint } from "../middleware/memory-step-endpoint.js";
import { prepareBackgroundModelMetadata } from "../providers/background-model-metadata.js";
import { resolveEffectivePricing } from "../providers/catalog.js";
import type { ProvidersContract, TargetDescriptor } from "../providers/index.js";
import {
	applyModelCapabilityPatch,
	backgroundMemoryAdmissionLimit,
	backgroundSlotKey,
	canonicalEndpointKey,
	endpointThroughput,
	firstRuntimeResolutionError,
	modelStreamUsage,
	recordEndpointThroughput,
	refineRuntimeTargetWithModelHints,
	resolveEndpointCapacities,
	resolveRuntimeTarget,
} from "../providers/index.js";
import { hasLiveModelCatalog, modelResidencyForStatus } from "../providers/model-discovery.js";
import { memoryInterventionModelMaxTokens } from "../providers/model-runtime-capabilities.js";
import { LOCAL_API_KEY_FALLBACK, resolveSideCallAuth } from "../providers/side-call-auth.js";
import { observedAnthropicQuota, observedCodexQuota } from "../quota/index.js";
import { observedQuota } from "../quota/observed.js";
import { quotaProviderIdForRuntime } from "../quota/registry.js";
import { redactSecretString } from "../safety/redaction.js";
import { ceilChars, estimateAgentContextTokens } from "../session/context-accounting.js";
import { callSettlementFromMessage } from "../telemetry/call-facts.js";
import type { CallJournalOptions } from "../telemetry/call-scope.js";
import { openCallScope } from "../telemetry/call-scope.js";
import type { BackgroundRouteFacts } from "./background-budget.js";
import { decideBackgroundStep } from "./background-budget.js";
import { OBSERVATION_PROMPT } from "./observations.js";
import type { TaskMemoryModelClient, TaskMemoryModelRequest, TaskMemoryStepUsage } from "./task-memory-policy.js";
import {
	TaskMemoryBudgetSkipError,
	TaskMemoryEndpointBusyError,
	TaskMemoryInformationFlowBlockedError,
} from "./task-memory-policy.js";

/**
 * The background memory role, resolved to the endpoint it would call.
 *
 * The endpoint key joins the existing dispatch capacity evidence and local
 * request holds. A gateway key does not identify one physical model server or
 * imply a one-slot limit; the configured protocol owns downstream routing.
 */
interface BackgroundMemoryRoute {
	client: TaskMemoryModelClient;
	selection: "dedicated" | "chat-default" | "chat-fallback";
	fallbackReason?: string;
	targetId: string;
	wireModelId: string;
	endpointKey: string | null;
	modelMaxTokens(configuredMaxTokens: number): number;
}

/**
 * What the background budget reads beside the route itself. Settings are the
 * snapshot the route was resolved from; spend is read when a step asks.
 */
interface BackgroundBudgetInputs {
	settings: Readonly<ClioSettings>;
	/** Priced session spend; absent where no session ledger exists, which reads as none. */
	sessionSpendUsd?: () => number;
}

function backgroundRouteFacts(
	refined: ReturnType<typeof prepareBackgroundMemoryModel>["refined"],
): BackgroundRouteFacts {
	const pricing = resolveEffectivePricing(refined.target, refined.runtime, refined.wireModelId);
	return {
		pricedBy: pricing.pricedBy,
		rates: pricing.rates,
		runtime: refined.runtime,
		quotaProviderId: quotaProviderIdForRuntime(refined.runtimeId),
	};
}

export type AdmitBackgroundModelFlow = (destination: {
	targetId: string;
	runtimeId: string;
	wireModelId: string;
}) => string | null;

export function createBackgroundMemoryModelClient(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
	timeoutMs: number,
	bus: Pick<TelemetryHub, "emit"> | null,
	fallbackOnly = false,
	admitModelFlow?: AdmitBackgroundModelFlow,
	sessionSpendUsd?: () => number,
): BackgroundMemoryRoute | null {
	if (!settings.context.memory.enabled) return null;
	const budget: BackgroundBudgetInputs = { settings, ...(sessionSpendUsd === undefined ? {} : { sessionSpendUsd }) };
	const memoryRoute = resolveMemoryRoute(settings);
	const configuredTarget = memoryRoute.target?.trim();
	const configuredModel = memoryRoute.model?.trim();
	if (!configuredTarget || !configuredModel) return null;
	if (memoryRoute.source === "chat") {
		if (fallbackOnly) return null;
		return prepareBackgroundMemoryRoute(
			providers,
			configuredTarget,
			configuredModel,
			timeoutMs,
			bus,
			"chat-default",
			settings.targets,
			admitModelFlow,
			budget,
		);
	}
	const chatTarget = settings.chat.target?.trim();
	const chatModel = settings.chat.model?.trim();
	const sameRoute = configuredTarget === chatTarget && configuredModel === chatModel;
	if (fallbackOnly && sameRoute) return null;
	let fallbackReason: string | undefined;
	if (!fallbackOnly) {
		try {
			return prepareBackgroundMemoryRoute(
				providers,
				configuredTarget,
				configuredModel,
				timeoutMs,
				bus,
				"dedicated",
				settings.targets,
				admitModelFlow,
				budget,
			);
		} catch (error) {
			fallbackReason = `configured route unavailable: ${memoryRouteFailureCause(error)}`;
		}
	} else fallbackReason = "configured route client error";
	if (!chatTarget || !chatModel || sameRoute) {
		if (fallbackOnly) return null;
		throw new Error("configured memory route is unavailable and no distinct chat fallback can run");
	}
	try {
		return {
			...prepareBackgroundMemoryRoute(
				providers,
				chatTarget,
				chatModel,
				timeoutMs,
				bus,
				"chat-fallback",
				settings.targets,
				admitModelFlow,
				budget,
			),
			fallbackReason,
		};
	} catch {
		if (fallbackOnly) return null;
		throw new Error("neither the configured memory route nor the active chat fallback is available");
	}
}

export function prepareBackgroundMemoryModel(providers: ProvidersContract, targetId: string, wireModelId: string) {
	const status = providers.list().find((entry) => entry.target.id === targetId);
	if (status) {
		if (!status.available) throw new Error(status.reason || "configured target unavailable");
		if (status.health.status === "down") throw new Error(status.health.lastError || "endpoint unreachable");
		if (hasLiveModelCatalog(status) && !status.discoveredModels.includes(wireModelId)) {
			throw new Error(`unknown model: ${wireModelId}`);
		}
		const residency = modelResidencyForStatus(status, wireModelId);
		if (residency === "absent" || residency === "loading") throw new Error(`model ${wireModelId} is ${residency}`);
	}
	const resolved = resolveRuntimeTarget(providers, {
		targetId,
		wireModelId,
		// Memory reads a trajectory and writes a fixed envelope. Reasoning adds
		// latency and, on a small local model, routinely consumes the entire
		// output budget before the envelope is ever written.
		requestedThinkingLevel: "off",
		use: "orchestrator",
		requireTools: false,
		requireOutputBudget: true,
	});
	if (!resolved.ok) {
		const detail = firstRuntimeResolutionError(resolved.diagnostics) ?? "background target resolution failed";
		throw new Error(detail);
	}
	const kbHit = providers.knowledgeBase?.lookup(resolved.target.wireModelId, resolved.target.runtime.id) ?? null;
	const model = resolved.target.runtime.synthesizeModel(resolved.target.target, resolved.target.wireModelId, kbHit);
	const refined = refineRuntimeTargetWithModelHints(resolved.target, model, providers.knowledgeBase);
	applyModelCapabilityPatch(model, refined.capabilities);
	return { model, refined };
}

/** A bounded preparation capacity when no foreground actor budget exists. Never activates actor context. */
export function memoryObservationCapacity(providers: ProvidersContract, settings: Readonly<ClioSettings>): number {
	const route = resolveMemoryRoute(settings);
	if (!route.target || !route.model) return 0;
	try {
		const { model } = prepareBackgroundMemoryModel(providers, route.target, route.model);
		return Math.max(
			0,
			model.contextWindow -
				estimateAgentContextTokens({ systemPrompt: OBSERVATION_PROMPT, messages: [] }) -
				settings.context.memory.maxOutputTokens -
				64,
		);
	} catch {
		return 0; /* An unknown route preserves raw-history fallback. */
	}
}

/**
 * The slot bound background memory admits against on the route's endpoint.
 * Unlike dispatch, an endpoint whose capacity nothing proves is one slot here;
 * see `backgroundMemoryAdmissionLimit`. The middleware's pre-check and the
 * reservation in the client both read this one function over the same target
 * set, so route selection, capacity and reservation cannot disagree.
 */
function memoryAdmissionLimitFor(
	providers: ProvidersContract,
	endpointKey: string,
	targets: ReadonlyArray<TargetDescriptor>,
): number {
	const capacity = resolveEndpointCapacities({
		statuses: providers.list(),
		targets,
		runtimeFor: (id) => providers.getRuntime(id),
	})[endpointKey];
	return backgroundMemoryAdmissionLimit(capacity);
}

/**
 * The slot key a background memory step admits against. Behind a model-routed
 * gateway that nothing bounds (no override, no discovered slots), the step's
 * own model is the scheduler it competes with, so it counts only that model's
 * streams; another model's turn through the same gateway no longer reads as
 * busy. Once the gateway carries a bound, the step admits against the
 * gateway total exactly as before, so optional work never exceeds what the
 * operator declared.
 */
function backgroundMemoryEndpointKey(
	providers: ProvidersContract,
	target: TargetDescriptor,
	wireModelId: string,
	targets: ReadonlyArray<TargetDescriptor>,
): string | null {
	return backgroundSlotKey(
		target,
		wireModelId,
		(gateway) =>
			resolveEndpointCapacities({
				statuses: providers.list(),
				targets,
				runtimeFor: (id) => providers.getRuntime(id),
			})[gateway] !== undefined,
	);
}

function backgroundMemoryEndpointBusy(
	providers: ProvidersContract,
	endpointKey: string | null,
	targets: ReadonlyArray<TargetDescriptor>,
): boolean {
	if (endpointKey === null) return false;
	const limit = memoryAdmissionLimitFor(providers, endpointKey, targets);
	return modelStreamUsage(endpointCapacityUsage(), endpointKey) >= limit;
}

function prepareBackgroundMemoryRoute(
	providers: ProvidersContract,
	targetId: string,
	wireModelId: string,
	timeoutMs: number,
	bus: Pick<TelemetryHub, "emit"> | null,
	selection: BackgroundMemoryRoute["selection"],
	targets: ReadonlyArray<TargetDescriptor>,
	admitModelFlow?: AdmitBackgroundModelFlow,
	budget?: BackgroundBudgetInputs,
): BackgroundMemoryRoute {
	const initial = prepareBackgroundMemoryModel(providers, targetId, wireModelId);
	const { refined } = initial;
	const gatewayKey = canonicalEndpointKey(refined.target);
	const endpointKey = backgroundMemoryEndpointKey(providers, refined.target, refined.wireModelId, targets);
	const routeFacts = backgroundRouteFacts(refined);
	return {
		selection,
		targetId,
		wireModelId: refined.wireModelId,
		endpointKey,
		modelMaxTokens: (configuredMaxTokens) =>
			memoryInterventionModelMaxTokens({
				configuredMaxTokens,
				thinkingMechanism: refined.modelRuntime.thinking.mechanism,
				modelMaxTokens: refined.capabilityDecisions.maxTokens,
			}),
		client: {
			// The route this client is bound to. The middleware reads it for the
			// telemetry row, so a fallback client names the target that served the step.
			route: { targetId, modelId: refined.wireModelId },
			// Wrapped at the layer that knows a request left the process: the step
			// holds endpoint capacity while it is out and publishes the cache
			// disturbance even when a timeout means the usage sink never sees it.
			complete: async (request) => {
				let usageObserved = false;
				try {
					// Decided before the metadata probe, auth or any byte leaves, so a
					// skipped step costs nothing; the next cadence tick decides again.
					const nowMs = Date.now();
					const throughput = endpointThroughput(endpointKey);
					let routeQuota = routeFacts.quotaProviderId === null ? null : observedQuota(routeFacts.quotaProviderId, nowMs);
					if (initial.refined.runtimeId === "openai-codex") {
						const status = providers.auth.statusForTarget(initial.refined.target, initial.refined.runtime);
						const stored = providers.auth.getStored(status.providerId);
						const scope =
							status.source === "stored-oauth" && stored?.type === "oauth" ? codexAccountScope(stored.access) : null;
						// #434: the `codex` poll reads Clio's default openai-codex login and stands in for no other profile.
						if (status.source !== "stored-oauth" || status.providerId !== "openai-codex") routeQuota = null;
						const streamed = observedCodexQuota(targetId, scope, nowMs);
						if (streamed !== null && !streamed.stale) routeQuota = streamed;
					} else if (initial.refined.runtimeId === "anthropic-max") {
						const status = providers.auth.statusForTarget(initial.refined.target, initial.refined.runtime);
						const profile = status.source === "stored-oauth" ? status.providerId : null;
						// #423: the provider-wide poll belongs only to Clio's default OAuth profile.
						if (profile !== "anthropic-max") routeQuota = null;
						const streamed = observedAnthropicQuota(targetId, nowMs, profile);
						if (streamed !== null && !streamed.stale) routeQuota = streamed;
					}
					const decision = decideBackgroundStep({
						route: routeFacts,
						inputTokens: ceilChars(request.systemPrompt.length + request.userPrompt.length),
						maxOutputTokens: budget?.settings.context.memory.maxOutputTokens ?? request.maxTokens,
						timeoutCapMs: timeoutMs,
						nowMs,
						session: {
							spendUsd: budget?.sessionSpendUsd?.() ?? 0,
							ceilingUsd: budget?.settings.safety.limits.sessionCostUsd ?? 0,
						},
						quota: routeQuota,
						endpoint: {
							occupied: endpointKey === null ? 0 : modelStreamUsage(endpointCapacityUsage(), endpointKey),
							admissionLimit:
								endpointKey === null ? Number.POSITIVE_INFINITY : memoryAdmissionLimitFor(providers, endpointKey, targets),
							prefillTokensPerSecond: throughput?.prefillTokensPerSecond ?? null,
							generationTokensPerSecond: throughput?.generationTokensPerSecond ?? null,
						},
					});
					if (!decision.admit) {
						if (decision.reason === "endpoint_busy") {
							throw new TaskMemoryEndpointBusyError("endpoint occupancy exhausts the background memory slot bound");
						}
						throw new TaskMemoryBudgetSkipError(decision.reason, decision.resumeAt);
					}
					await prepareBackgroundModelMetadata(providers, targetId, request.signal);
					const { model, refined } = prepareBackgroundMemoryModel(providers, targetId, wireModelId);
					if (refined.runtimeId !== initial.refined.runtimeId || canonicalEndpointKey(refined.target) !== gatewayKey) {
						throw new Error("background memory target changed during preparation");
					}
					if (request.purpose) {
						const inputTokens = estimateAgentContextTokens({
							systemPrompt: request.systemPrompt,
							messages: [{ role: "user", content: [{ type: "text", text: request.userPrompt }], timestamp: Date.now() }],
						});
						if (!(model.contextWindow > 0) || inputTokens + request.maxTokens + 64 > model.contextWindow)
							throw new TaskMemoryBudgetSkipError("time_budget");
					}
					const sideAuth = await resolveSideCallAuth(
						providers.auth,
						refined.target,
						refined.runtime,
						LOCAL_API_KEY_FALLBACK,
						request.signal,
					);
					request.signal.throwIfAborted();
					const refusal =
						admitModelFlow?.({ targetId, runtimeId: refined.runtimeId, wireModelId: refined.wireModelId }) ?? null;
					if (refusal !== null) throw new TaskMemoryInformationFlowBlockedError(refusal);
					// Preparation yielded after the middleware's first check. The wrapper
					// rechecks occupancy and registers the preemptible hold in one
					// synchronous step, so no local request can take the last slot between.
					const admissionLimit =
						endpointKey === null ? Number.POSITIVE_INFINITY : memoryAdmissionLimitFor(providers, endpointKey, targets);
					return await announceMemoryStepEndpoint(
						{
							bus,
							endpointKey,
							targetId,
							admissionLimit,
							admit: () => endpointKey === null || modelStreamUsage(endpointCapacityUsage(), endpointKey) < admissionLimit,
						},
						async (request: TaskMemoryModelRequest) => {
							const startedAt = performance.now();
							let observedUsage: TaskMemoryStepUsage | undefined;
							let facts = unobservedRunUsageFacts();
							const observer = request.callTelemetry;
							const callTelemetry = {
								startAttempt: () => observer?.startAttempt(),
								withContext: <T>(work: () => T): T => (observer ? observer.withContext(work) : work()),
								settle(message: unknown) {
									const settled = callSettlementFromMessage(message, refined);
									facts =
										settled.usage === null
											? noCallRunUsageFacts()
											: {
													usage: settled.usage,
													totalTokens: memoryTotalTokens(settled.usage),
													apiCalls: { kind: "measured", value: 1, source: "local-count" },
													pricing: settled.pricing,
												};
									observer?.settle(message);
								},
							};
							const mapUsage = (
								completion: Pick<EngineTextCompletionResult, "usage" | "backend" | "failure">,
							): TaskMemoryStepUsage => ({
								...facts.usage,
								totalTokens: facts.totalTokens,
								pricing: facts.pricing,
								...(completion.failure === undefined ? {} : { failure: completion.failure }),
								targetId,
								attributedModelId: refined.wireModelId,
								durationMs: performance.now() - startedAt,
								backend: completion.backend,
							});
							const completion = await completeEngineText({
								callTelemetry,
								model,
								systemPrompt: request.systemPrompt,
								userPrompt: request.userPrompt,
								maxTokens:
									refined.capabilityDecisions.maxTokens > 0
										? Math.min(request.maxTokens, refined.capabilityDecisions.maxTokens)
										: request.maxTokens,
								// Always off, never the operator's chat thinking level. A model that
								// reasons anyway still works: `completeEngineText` keeps only text
								// blocks, and the memory output budget leaves room for the preamble.
								thinkingLevel: "off",
								// Memory decides what to keep; the same completed task must get the same answer.
								// A live Ornith review retained a validator recipe in one run and abstained on
								// the identical trajectory in the next, at the server's default temperature.
								deterministicRuntimeId: refined.runtimeId,
								signal: request.signal,
								timeoutMs: decision.timeoutMs,
								onUsage: (observation) => {
									usageObserved = true;
									observedUsage = mapUsage(observation);
									request.onUsage?.(observedUsage);
								},
								...sideAuth,
								...(refined.target.auth?.headers ? { headers: refined.target.auth.headers } : {}),
							});
							recordEndpointThroughput(endpointKey, completion.backend);
							// The step is billed here whatever the policy later decides about the
							// answer. A model that read a trajectory and chose silence spent the
							// same prefill as one that produced a reminder.
							return {
								text: completion.text,
								inputTokens: facts.usage.input,
								outputTokens: facts.usage.output,
								usage: observedUsage ?? mapUsage(completion),
							};
						},
					)(request);
				} catch (error) {
					if (
						!usageObserved &&
						!(error instanceof TaskMemoryBudgetSkipError) &&
						!(error instanceof TaskMemoryEndpointBusyError) &&
						!(error instanceof TaskMemoryInformationFlowBlockedError)
					)
						request.onUsage?.({
							targetId,
							attributedModelId: initial.refined.wireModelId,
							...noCallRunUsageFacts().usage,
							totalTokens: noCallRunUsageFacts().totalTokens,
							pricing: noCallRunUsageFacts().pricing,
							durationMs: 0,
							backend: null,
							failure: classifyCallFailure(error, { invoked: false, aborted: request.signal.aborted }),
						});
					throw error;
				}
			},
		},
	};
}

function memoryTotalTokens(usage: CallUsage): Fact<number> {
	if (usage.total) return usage.total;
	const fields = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
	const unknown = fields.find((fact) => fact.kind === "unknown" || fact.kind === "absent");
	if (unknown) return unknown;
	const estimated = fields.find((fact) => fact.kind === "estimated");
	const value = fields.reduce((sum, fact) => sum + ("value" in fact ? fact.value : 0), 0);
	return estimated?.kind === "estimated"
		? { kind: "estimated", value, method: estimated.method }
		: { kind: "measured", value, source: "provider" };
}

const emitMemoryFlowNotice = declareRuntimeNoticeProducer("background-memory-flow", ["memory-flow-blocked"]);

/**
 * Information-flow admission for background memory steps. The session's own
 * flow restrictions decide; the first refusal in a session is announced once,
 * and later refusals in that session stay quiet.
 */
export function createMemoryFlowAdmission(
	admitModelFlow: AdmitBackgroundModelFlow,
	currentSessionId: () => string | null,
	bus: Pick<TelemetryHub, "emit">,
): AdmitBackgroundModelFlow {
	const memoryFlowNoticedSessions = new Set<string | null>();
	return (destination) => {
		const refusal = admitModelFlow(destination);
		const sessionId = currentSessionId();
		if (refusal !== null && !memoryFlowNoticedSessions.has(sessionId)) {
			memoryFlowNoticedSessions.add(sessionId);
			emitMemoryFlowNotice(
				{
					kind: "memory-flow-blocked",
					level: "info",
					message: `Memory skipped target ${destination.targetId}: ${refusal}`,
					targetId: destination.targetId,
					runtimeId: destination.runtimeId,
					model: destination.wireModelId,
				},
				bus,
			);
		}
		return refusal;
	};
}

/**
 * Each memory step is a journaled call, in its session's journal or the
 * process journal (#434). Undefined when telemetry cannot journal or the
 * target no longer resolves.
 */
export function createBackgroundCallJournal(
	providers: ProvidersContract,
	acquireTelemetrySession: () => CallJournalOptions["acquire"] | undefined,
	currentOrigin: () => CallJournalOptions["origin"] | undefined,
): (targetId: string, modelId: string) => CallJournalOptions | undefined {
	return (targetId, modelId) => {
		const origin = currentOrigin();
		const acquire = acquireTelemetrySession();
		const target = providers.getTarget(targetId);
		const runtime = target ? providers.getRuntime(target.runtime) : null;
		if (!acquire || !target || !runtime) return undefined;
		return {
			origin: origin ?? null,
			acquire,
			role: "memory",
			targetId,
			runtimeId: runtime.id,
			...pricingBasisFields(resolveEffectivePricing(target, runtime, modelId)),
		};
	};
}

const emitRouteFallbackNotice = declareRuntimeNoticeProducer("background-memory-route", ["route-fallback"]);

function memoryRouteFailureCause(error: unknown): string {
	return (
		redactSecretString(error instanceof Error ? error.message : String(error))
			.split("\n", 1)[0]
			?.slice(0, 180) || "unknown route error"
	);
}

/** Production callback composition shared with routing/capacity contracts. */
export function createBackgroundMemoryRouting(
	providers: ProvidersContract,
	getSettings: () => Readonly<ClioSettings> | undefined,
	bus: Pick<TelemetryHub, "emit"> | null,
	admitModelFlow?: AdmitBackgroundModelFlow,
	/** False for a second routing instance whose fallback the first already announces. */
	announceFallback = true,
	/** Priced session spend the metered budget adds a step's projected cost to. */
	sessionSpendUsd?: () => number,
	callJournal?: (targetId: string, modelId: string) => CallJournalOptions | undefined,
) {
	let route: BackgroundMemoryRoute | null = null;
	let snapshot: Readonly<ClioSettings> | undefined;
	let lastNotice: string | null = null;
	let clientFailure: string | null = null;
	const observeClient = (client: TaskMemoryModelClient | null): TaskMemoryModelClient | null => {
		if (!client) return null;
		return {
			...client,
			async complete(request) {
				const destination = client.route;
				const options = destination ? callJournal?.(destination.targetId, destination.modelId) : undefined;
				const scope = await openCallScope(options, {
					api: options ? (providers.getRuntime(options.runtimeId)?.apiFamily ?? "unknown") : "unknown",
					id: destination?.modelId ?? "unknown",
				});
				const callTelemetry = {
					...scope,
					startAttempt() {
						const identity = scope.startAttempt();
						if (identity && options?.origin) {
							try {
								request.onCall?.({ ...identity, sessionId: options.origin.id, repoIdentity: options.origin.cwdHash });
							} catch {
								writeDiagnostic("[clio-coder:telemetry] memory call reference was not recorded\n");
							}
						}
					},
				};
				callTelemetry.startAttempt();
				try {
					const result = await scope.withContext(() =>
						client.complete({
							...request,
							callTelemetry,
							onUsage: (usage) => {
								if (!scope.identity() && usage.failure)
									scope.settle({ stopReason: request.signal.aborted ? "aborted" : "error", failure: usage.failure });
								request.onUsage?.({ ...usage, ...scope.identity() });
							},
						}),
					);
					return { ...result, ...(result.usage ? { usage: { ...result.usage, ...scope.identity() } } : {}) };
				} catch (error) {
					// Engine attempts settle first; only failures in preparation reach this fallback (#434).
					scope.settle({
						stopReason: request.signal.aborted ? "aborted" : "error",
						failure: classifyCallFailure(error, { invoked: false, aborted: request.signal.aborted }),
					});
					throw error;
				} finally {
					await scope.close();
				}
			},
		};
	};
	const noteFallback = (): void => {
		if (route?.selection !== "chat-fallback") {
			lastNotice = null;
			return;
		}
		const message = `Memory: ${route.fallbackReason}; selected chat fallback ${route.targetId}/${route.wireModelId} for this step, subject to available endpoint capacity.`;
		if (message === lastNotice) return;
		lastNotice = message;
		if (!bus || !announceFallback) return;
		emitRouteFallbackNotice(
			{
				kind: "route-fallback",
				level: "info",
				message,
				targetId: route.targetId,
				runtimeId: providers.getTarget(route.targetId)?.runtime ?? "unknown",
				model: route.wireModelId,
			},
			bus,
		);
	};
	return {
		getModelClient: (): TaskMemoryModelClient | null => {
			const current = getSettings();
			snapshot = current === undefined ? undefined : structuredClone(current);
			route =
				snapshot === undefined
					? null
					: createBackgroundMemoryModelClient(
							providers,
							snapshot,
							snapshot.context.memory.timeoutMs,
							bus,
							false,
							admitModelFlow,
							sessionSpendUsd,
						);
			noteFallback();
			clientFailure = null;
			const client = observeClient(route?.client ?? null);
			return client
				? {
						...client,
						complete: async (request) => {
							try {
								return await client.complete(request);
							} catch (error) {
								clientFailure = memoryRouteFailureCause(error);
								throw error;
							}
						},
					}
				: null;
		},
		getFallbackModelClient: (): TaskMemoryModelClient | null => {
			if (route?.selection !== "dedicated" || snapshot === undefined) return null;
			route = createBackgroundMemoryModelClient(
				providers,
				snapshot,
				snapshot.context.memory.timeoutMs,
				bus,
				true,
				admitModelFlow,
				sessionSpendUsd,
			);
			if (route && clientFailure) route.fallbackReason = `configured route client error: ${clientFailure}`;
			noteFallback();
			return observeClient(route?.client ?? null);
		},
		getModelMaxTokens: (configured: number): number => route?.modelMaxTokens(configured) ?? configured,
		backgroundEndpointBusy: (): boolean => {
			if (route?.endpointKey == null || snapshot === undefined) return false;
			return backgroundMemoryEndpointBusy(providers, route.endpointKey, snapshot.targets);
		},
	};
}

/** Memory is on and its route names both a target and a model. */
export function memoryRouteConfigured(settings: Readonly<ClioSettings>): boolean {
	const route = resolveMemoryRoute(settings);
	return settings.context.memory.enabled && Boolean(route.target?.trim()) && Boolean(route.model?.trim());
}
