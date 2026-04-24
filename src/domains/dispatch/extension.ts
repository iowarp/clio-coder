/**
 * Dispatch domain wire-up (post-W5).
 *
 * Resolves a DispatchRequest to an EndpointDescriptor + RuntimeDescriptor +
 * wire model id via the providers contract. Gates admission on safety
 * scopes, concurrency, budget, and capability flags. HTTP and SDK runtimes
 * spawn the native worker subprocess; subprocess runtimes (claude-code-cli,
 * codex-cli, gemini-cli) run the CLI agent inline through the engine's
 * subprocess-runtime.
 */

import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { readClioVersion, readPiMonoVersion } from "../../core/package-root.js";
import { startSubprocessWorkerRun } from "../../engine/subprocess-runtime.js";
import type { AgentsContract } from "../agents/contract.js";
import type { AgentRecipe } from "../agents/recipe.js";
import type { ConfigContract } from "../config/contract.js";
import type { ModesContract } from "../modes/contract.js";
import {
	type CapabilityFlags,
	type EndpointDescriptor,
	type ProvidersContract,
	type RuntimeDescriptor,
	type ThinkingLevel,
	targetRequiresAuth,
} from "../providers/index.js";
import type { SafetyContract } from "../safety/contract.js";
import type { ScopeSpec } from "../safety/scope.js";
import type { SchedulingContract } from "../scheduling/contract.js";
import { admit } from "./admission.js";
import type { DispatchContract, DispatchRequest } from "./contract.js";
import { type Ledger, openLedger } from "./state.js";
import type { RunKind, RunReceipt, RunReceiptDraft, RunStatus } from "./types.js";
import { validateJobSpec } from "./validation.js";
import { type SpawnedWorker, spawnNativeWorker, type WorkerSpec } from "./worker-spawn.js";

interface ActiveRun {
	runId: string;
	abort: () => void;
	promise: Promise<void>;
	recipe: AgentRecipe | null;
	startedAt: string;
	endpointId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	agentId: string;
	task: string;
	cwd: string;
	aborted: boolean;
	finalPromise: Promise<RunReceipt>;
}

interface DispatchBundleOptions {
	spawnWorker?: (spec: WorkerSpec, opts?: { cwd?: string }) => SpawnedWorker;
}

function pickOrchestratorScope(safety: SafetyContract, mode: string | undefined): ScopeSpec {
	if (mode === "super") return safety.scopes.super;
	return safety.scopes.default;
}

function pickWorkerScope(safety: SafetyContract, recipe: AgentRecipe | null): ScopeSpec {
	if (recipe?.mode === "advise") return safety.scopes.readonly;
	if (recipe?.mode === "super") return safety.scopes.super;
	return safety.scopes.default;
}

function buildSystemPrompt(req: DispatchRequest, recipe: AgentRecipe | null): string {
	if (req.systemPrompt && req.systemPrompt.length > 0) return req.systemPrompt;
	if (recipe) return recipe.body;
	return "";
}

interface ResolvedTarget {
	endpoint: EndpointDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	thinkingLevel: ThinkingLevel;
	capabilities: CapabilityFlags | null;
}

interface WorkerTargetConfig {
	endpoint: string | null;
	model: string | null;
	thinkingLevel: ThinkingLevel;
}

type WorkerProfileMap = Record<string, WorkerTargetConfig>;

function capabilityInfoForEndpoint(providers: ProvidersContract, endpointId: string): CapabilityFlags | null {
	return providers.list().find((entry) => entry.endpoint.id === endpointId)?.capabilities ?? null;
}

function runtimeIdForEndpoint(providers: ProvidersContract, endpointId: string): string | null {
	return providers.getEndpoint(endpointId)?.runtime ?? null;
}

function supportsRequiredCapabilities(
	capabilities: CapabilityFlags | null,
	required: ReadonlyArray<string> | undefined,
): boolean {
	if (!required || required.length === 0) return true;
	if (!capabilities) return false;
	const caps = capabilities as unknown as Record<string, unknown>;
	for (const name of required) {
		const value = caps[name];
		if (value === undefined || value === false || value === 0 || value === "") return false;
	}
	return true;
}

function pickCapabilityMatchedWorker(
	required: ReadonlyArray<string> | undefined,
	runtimeId: string | undefined,
	workerDefault: WorkerTargetConfig | null,
	workerProfiles: WorkerProfileMap,
	providers: ProvidersContract,
): WorkerTargetConfig | null {
	if ((!required || required.length === 0) && !runtimeId) return null;
	if (
		workerDefault?.endpoint &&
		(!runtimeId || runtimeIdForEndpoint(providers, workerDefault.endpoint) === runtimeId) &&
		supportsRequiredCapabilities(capabilityInfoForEndpoint(providers, workerDefault.endpoint), required)
	) {
		return workerDefault;
	}
	for (const profile of Object.values(workerProfiles)) {
		if (!profile.endpoint) continue;
		if (runtimeId && runtimeIdForEndpoint(providers, profile.endpoint) !== runtimeId) continue;
		if (supportsRequiredCapabilities(capabilityInfoForEndpoint(providers, profile.endpoint), required)) {
			return profile;
		}
	}
	return null;
}

function resolveDispatchTarget(
	req: DispatchRequest,
	recipe: AgentRecipe | null,
	workerDefault: WorkerTargetConfig | null,
	workerProfiles: WorkerProfileMap,
	providers: ProvidersContract,
): ResolvedTarget {
	let selectedWorkerTarget: WorkerTargetConfig | null = null;
	let endpointId = req.endpoint ?? null;
	if (!endpointId && req.workerProfile) {
		const profile = workerProfiles[req.workerProfile];
		if (!profile) throw new Error(`dispatch: worker profile '${req.workerProfile}' not configured`);
		if (!profile.endpoint) throw new Error(`dispatch: worker profile '${req.workerProfile}' has no target`);
		selectedWorkerTarget = profile;
		endpointId = profile.endpoint;
	}
	if (!endpointId) endpointId = recipe?.endpoint ?? null;
	if (!endpointId) {
		selectedWorkerTarget = pickCapabilityMatchedWorker(
			req.requiredCapabilities,
			req.workerRuntime,
			workerDefault,
			workerProfiles,
			providers,
		);
		endpointId = selectedWorkerTarget?.endpoint ?? null;
	}
	if (!endpointId && req.workerRuntime) {
		throw new Error(`dispatch: no worker target configured for runtime '${req.workerRuntime}'`);
	}
	if (!endpointId) {
		selectedWorkerTarget = workerDefault;
		endpointId = workerDefault?.endpoint ?? null;
	}
	if (!endpointId) {
		throw new Error(
			"dispatch: no target configured (set workers.default.target, add workers.profiles, or pass --target)",
		);
	}
	const endpoint = providers.getEndpoint(endpointId);
	if (!endpoint) throw new Error(`dispatch: target '${endpointId}' not found`);
	const runtime = providers.getRuntime(endpoint.runtime);
	if (!runtime) throw new Error(`dispatch: runtime '${endpoint.runtime}' not registered`);
	const matchingDefault = workerDefault?.endpoint === endpointId ? workerDefault : null;
	const fallbackWorkerTarget = selectedWorkerTarget ?? matchingDefault;
	const wireModelId = req.model ?? recipe?.model ?? fallbackWorkerTarget?.model ?? endpoint.defaultModel;
	if (!wireModelId) {
		throw new Error(`dispatch: no model for target '${endpointId}' (set worker profile model or target.defaultModel)`);
	}
	const thinkingLevel = (req.thinkingLevel ??
		recipe?.thinkingLevel ??
		fallbackWorkerTarget?.thinkingLevel ??
		"off") as ThinkingLevel;
	return {
		endpoint,
		runtime,
		wireModelId,
		thinkingLevel,
		capabilities: capabilityInfoForEndpoint(providers, endpoint.id),
	};
}

function enforceCapabilityGate(
	endpointId: string,
	capabilities: CapabilityFlags | null,
	required: ReadonlyArray<string> | undefined,
): void {
	if (!required || required.length === 0) return;
	if (!capabilities) {
		throw new Error(`dispatch: admission denied: capability info unavailable for endpoint '${endpointId}'`);
	}
	const caps = capabilities as unknown as Record<string, unknown>;
	for (const name of required) {
		const value = caps[name];
		if (value === undefined || value === false || value === 0 || value === "") {
			throw new Error(`dispatch: admission denied: capability '${name}' not supported by endpoint '${endpointId}'`);
		}
	}
}

export function createDispatchBundle(
	context: DomainContext,
	options?: DispatchBundleOptions,
): DomainBundle<DispatchContract> {
	const maybeSafety = context.getContract<SafetyContract>("safety");
	const maybeAgents = context.getContract<AgentsContract>("agents");
	const maybeModes = context.getContract<ModesContract>("modes");
	const maybeProviders = context.getContract<ProvidersContract>("providers");
	if (!maybeSafety) throw new Error("dispatch domain requires 'safety' contract");
	if (!maybeAgents) throw new Error("dispatch domain requires 'agents' contract");
	if (!maybeModes) throw new Error("dispatch domain requires 'modes' contract");
	if (!maybeProviders) throw new Error("dispatch domain requires 'providers' contract");
	const safety: SafetyContract = maybeSafety;
	const agents: AgentsContract = maybeAgents;
	const modes: ModesContract = maybeModes;
	const providers: ProvidersContract = maybeProviders;
	const config = context.getContract<ConfigContract>("config");
	const scheduling = context.getContract<SchedulingContract>("scheduling");
	const spawnWorker = options?.spawnWorker ?? spawnNativeWorker;

	let ledger: Ledger | null = null;
	const active = new Map<string, ActiveRun>();

	function requireLedger(): Ledger {
		if (!ledger) throw new Error("dispatch: ledger not initialised");
		return ledger;
	}

	async function dispatch(req: DispatchRequest): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunReceipt>;
	}> {
		const { systemPrompt: _sp, ...jobSpec } = req;
		const validated = validateJobSpec(jobSpec);
		if (!validated.ok) {
			throw new Error(`dispatch: invalid spec: ${validated.errors.join("; ")}`);
		}

		if (scheduling) {
			const preflight = scheduling.preflight();
			if (preflight.verdict === "over" || preflight.verdict === "at") {
				throw new Error(
					`dispatch: admission denied: budget ceiling crossed: $${preflight.currentUsd.toFixed(4)} / $${preflight.ceilingUsd.toFixed(4)}`,
				);
			}
		}

		const recipe = agents.get(req.agentId);
		const currentMode = modes.current();
		const orchScope = pickOrchestratorScope(safety, currentMode);
		const workerScope = pickWorkerScope(safety, recipe);

		const verdict = admit(
			{
				requestedScope: workerScope,
				orchestratorScope: orchScope,
				requestedActions: ["read"],
				agentId: req.agentId,
			},
			safety.isSubset,
		);
		if (!verdict.admitted) {
			throw new Error(`dispatch: admission denied: ${verdict.reason}`);
		}

		const settings = config?.get();
		const workerDefault = settings?.workers?.default
			? {
					endpoint: settings.workers.default.endpoint ?? null,
					model: settings.workers.default.model ?? null,
					thinkingLevel: (settings.workers.default.thinkingLevel ?? "off") as ThinkingLevel,
				}
			: null;
		const workerProfiles: WorkerProfileMap = {};
		for (const [name, profile] of Object.entries(settings?.workers?.profiles ?? {})) {
			workerProfiles[name] = {
				endpoint: profile.endpoint ?? null,
				model: profile.model ?? null,
				thinkingLevel: (profile.thinkingLevel ?? "off") as ThinkingLevel,
			};
		}
		const target = resolveDispatchTarget(req, recipe, workerDefault, workerProfiles, providers);
		enforceCapabilityGate(target.endpoint.id, target.capabilities, req.requiredCapabilities);

		const cwd = req.cwd ?? process.cwd();
		const systemPrompt = buildSystemPrompt(req, recipe);

		const recipeTools = recipe?.tools;
		const allowedTools =
			recipeTools && recipeTools.length > 0 ? Array.from(recipeTools) : Array.from(modes.visibleTools());
		const workerMode = recipe?.mode ?? currentMode;
		const auth = targetRequiresAuth(target.endpoint, target.runtime)
			? await providers.auth.resolveForTarget(target.endpoint, target.runtime)
			: null;
		const apiKey = auth?.apiKey;
		const runtimeKind: RunKind = target.runtime.kind;

		let workerSlotHeld = false;
		const releaseWorkerSlot = (): void => {
			if (!workerSlotHeld || !scheduling) return;
			workerSlotHeld = false;
			scheduling.releaseWorker();
		};

		if (scheduling) {
			workerSlotHeld = scheduling.tryAcquireWorker();
			if (!workerSlotHeld) {
				throw new Error(
					`dispatch: admission denied: concurrency limit reached (${scheduling.activeWorkers()} active workers)`,
				);
			}
		}

		const tokenMeter = { inputTokens: 0, outputTokens: 0 };
		let pid: number | null = null;
		let abort: () => void;
		let workerEvents: AsyncIterable<unknown>;
		let workerDone: Promise<{ exitCode: number | null }>;

		if (runtimeKind === "http" || runtimeKind === "sdk") {
			const spec: WorkerSpec = {
				systemPrompt,
				task: req.task,
				endpoint: target.endpoint,
				runtimeId: target.runtime.id,
				wireModelId: target.wireModelId,
				thinkingLevel: target.thinkingLevel,
				allowedTools,
				mode: workerMode,
			};
			if (apiKey) spec.apiKey = apiKey;
			let worker: SpawnedWorker;
			try {
				worker = spawnWorker(spec, { cwd });
			} catch (error) {
				releaseWorkerSlot();
				throw error;
			}
			pid = worker.pid;
			abort = () => worker.abort();
			workerEvents = worker.events;
			workerDone = worker.promise.then((r) => ({ exitCode: r.exitCode }));
		} else {
			// subprocess kind: run inline inside the orchestrator process
			const queue: unknown[] = [];
			const waiters: Array<(r: IteratorResult<unknown>) => void> = [];
			let finished = false;
			function push(value: unknown): void {
				const w = waiters.shift();
				if (w) {
					w({ value, done: false });
					return;
				}
				queue.push(value);
			}
			function end(): void {
				if (finished) return;
				finished = true;
				while (waiters.length > 0) {
					const w = waiters.shift();
					if (w) w({ value: undefined, done: true });
				}
			}
			const iterator: AsyncIterableIterator<unknown> = {
				next(): Promise<IteratorResult<unknown>> {
					if (queue.length > 0) {
						const value = queue.shift();
						return Promise.resolve({ value, done: false });
					}
					if (finished) return Promise.resolve({ value: undefined, done: true });
					return new Promise<IteratorResult<unknown>>((resolve) => {
						waiters.push(resolve);
					});
				},
				return(): Promise<IteratorResult<unknown>> {
					end();
					return Promise.resolve({ value: undefined, done: true });
				},
				[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
					return this;
				},
			};
			const abortController = new AbortController();
			const inputForSubprocess: Parameters<typeof startSubprocessWorkerRun>[0] = {
				systemPrompt,
				task: req.task,
				endpoint: target.endpoint,
				runtime: target.runtime,
				wireModelId: target.wireModelId,
				signal: abortController.signal,
			};
			if (apiKey) inputForSubprocess.apiKey = apiKey;
			const handle = startSubprocessWorkerRun(inputForSubprocess, (event) => push(event));
			pid = null;
			abort = () => {
				abortController.abort();
				handle.abort();
			};
			workerEvents = iterator;
			workerDone = handle.promise.then((r) => {
				end();
				return { exitCode: r.exitCode };
			});
		}

		const enrichedEvents: AsyncIterableIterator<unknown> = (async function* () {
			for await (const raw of workerEvents) {
				const event = raw as {
					type?: string;
					message?: {
						role?: string;
						usage?: { input?: number; output?: number; totalTokens?: number };
					};
				};
				if (event.type === "message_end" && event.message?.role === "assistant" && event.message.usage) {
					const u = event.message.usage;
					tokenMeter.inputTokens += typeof u.input === "number" ? u.input : 0;
					tokenMeter.outputTokens += typeof u.output === "number" ? u.output : 0;
				}
				yield raw;
			}
		})();

		const ledgerRef = requireLedger();
		const envelope = ledgerRef.create({
			agentId: req.agentId,
			task: req.task,
			endpointId: target.endpoint.id,
			wireModelId: target.wireModelId,
			runtimeId: target.runtime.id,
			runtimeKind,
			sessionId: null,
			cwd,
		});
		ledgerRef.update(envelope.id, { status: "running", pid });

		context.bus.emit(BusChannels.DispatchEnqueued, {
			runId: envelope.id,
			agentId: req.agentId,
			endpointId: target.endpoint.id,
			wireModelId: target.wireModelId,
			runtimeId: target.runtime.id,
			runtimeKind,
		});
		context.bus.emit(BusChannels.DispatchStarted, {
			runId: envelope.id,
			agentId: req.agentId,
			endpointId: target.endpoint.id,
			wireModelId: target.wireModelId,
			runtimeId: target.runtime.id,
			runtimeKind,
			pid,
		});

		const startedAt = envelope.startedAt;

		const activeRun: ActiveRun = {
			runId: envelope.id,
			abort,
			promise: workerDone.then(() => undefined),
			recipe,
			startedAt,
			endpointId: target.endpoint.id,
			wireModelId: target.wireModelId,
			runtimeId: target.runtime.id,
			runtimeKind,
			agentId: req.agentId,
			task: req.task,
			cwd,
			aborted: false,
			finalPromise: undefined as unknown as Promise<RunReceipt>,
		};

		const finalPromise = (async (): Promise<RunReceipt> => {
			try {
				const result = await workerDone;
				const receiptExitCode = result.exitCode ?? 1;
				const endedAt = new Date().toISOString();
				const status: RunStatus = activeRun.aborted ? "interrupted" : result.exitCode === 0 ? "completed" : "failed";
				const pricing = target.endpoint.pricing;
				const costUsd = pricing
					? (tokenMeter.inputTokens * pricing.input) / 1_000_000 + (tokenMeter.outputTokens * pricing.output) / 1_000_000
					: 0;
				const tokenCount = tokenMeter.inputTokens + tokenMeter.outputTokens;
				const receiptDraft: RunReceiptDraft = {
					runId: envelope.id,
					agentId: req.agentId,
					task: req.task,
					endpointId: target.endpoint.id,
					wireModelId: target.wireModelId,
					runtimeId: target.runtime.id,
					runtimeKind,
					startedAt,
					endedAt,
					exitCode: receiptExitCode,
					tokenCount,
					costUsd,
					compiledPromptHash: null,
					staticCompositionHash: null,
					clioVersion: readClioVersion(),
					piMonoVersion: readPiMonoVersion(),
					platform: process.platform,
					nodeVersion: process.version,
					toolCalls: 0,
					sessionId: null,
				};
				ledgerRef.update(envelope.id, { status, endedAt, exitCode: receiptExitCode, tokenCount, costUsd });
				const receipt = ledgerRef.recordReceipt(envelope.id, receiptDraft);
				await ledgerRef.persist();
				active.delete(envelope.id);
				const startMs = Date.parse(receipt.startedAt);
				const endMs = Date.parse(receipt.endedAt);
				const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
				if (status === "completed") {
					context.bus.emit(BusChannels.DispatchCompleted, {
						runId: envelope.id,
						agentId: req.agentId,
						endpointId: target.endpoint.id,
						wireModelId: target.wireModelId,
						runtimeId: target.runtime.id,
						runtimeKind,
						tokenCount: receipt.tokenCount,
						costUsd: receipt.costUsd,
						durationMs,
						exitCode: receiptExitCode,
					});
				} else {
					context.bus.emit(BusChannels.DispatchFailed, {
						runId: envelope.id,
						agentId: req.agentId,
						endpointId: target.endpoint.id,
						wireModelId: target.wireModelId,
						runtimeId: target.runtime.id,
						runtimeKind,
						tokenCount: receipt.tokenCount,
						costUsd: receipt.costUsd,
						durationMs,
						exitCode: receiptExitCode,
						reason: status,
					});
				}
				return receipt;
			} finally {
				releaseWorkerSlot();
			}
		})();

		activeRun.finalPromise = finalPromise;
		active.set(envelope.id, activeRun);

		return {
			runId: envelope.id,
			events: enrichedEvents,
			finalPromise,
		};
	}

	const extension: DomainExtension = {
		async start() {
			ledger = openLedger();
		},
		async stop() {
			await drain();
		},
	};

	async function drain(): Promise<void> {
		const runs = Array.from(active.values());
		for (const run of runs) {
			run.aborted = true;
			try {
				run.abort();
			} catch {
				// best-effort; promise still resolves on child close
			}
		}
		await Promise.allSettled(runs.map((r) => r.finalPromise));
		if (ledger) await ledger.persist();
	}

	const contract: DispatchContract = {
		dispatch,
		listRuns(status) {
			const l = requireLedger();
			return status ? l.list({ status }) : l.list();
		},
		getRun(runId) {
			if (!ledger) return null;
			return ledger.get(runId);
		},
		abort(runId) {
			const run = active.get(runId);
			if (!run) return;
			run.aborted = true;
			try {
				run.abort();
			} catch {
				// child may already be gone
			}
		},
		drain,
	};

	return { extension, contract };
}
