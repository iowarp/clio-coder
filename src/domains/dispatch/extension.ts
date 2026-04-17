/**
 * Dispatch domain wire-up (Phase 6 slice 5).
 *
 * Owns the run ledger, active-worker tracking, admission gate, and the bridge
 * between a worker subprocess and the orchestrator's bus. A call to dispatch()
 * validates the spec, resolves an agent recipe, admits against safety scopes,
 * spawns the native worker, creates a ledger run envelope, and returns the
 * consumer an event iterator + final-receipt promise. When the worker exits we
 * write the receipt, update the ledger, and fire dispatch.completed/failed.
 *
 * drain() tears down every in-flight worker; any run that has not already
 * completed lands in the ledger as "interrupted".
 */

import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { readClioVersion, readPiMonoVersion } from "../../core/package-root.js";
import type { AgentsContract } from "../agents/contract.js";
import type { AgentRecipe } from "../agents/recipe.js";
import type { ModesContract } from "../modes/contract.js";
import type { SafetyContract } from "../safety/contract.js";
import type { ScopeSpec } from "../safety/scope.js";
import { admit } from "./admission.js";
import type { DispatchContract, DispatchRequest } from "./contract.js";
import { type Ledger, openLedger } from "./state.js";
import type { RunReceipt, RunStatus } from "./types.js";
import { validateJobSpec } from "./validation.js";
import { type SpawnedWorker, type WorkerSpec, spawnNativeWorker } from "./worker-spawn.js";

interface ActiveRun {
	runId: string;
	worker: SpawnedWorker;
	recipe: AgentRecipe | null;
	startedAt: string;
	providerId: string;
	modelId: string;
	runtime: "native" | "sdk" | "cli";
	agentId: string;
	task: string;
	cwd: string;
	aborted: boolean;
	finalPromise: Promise<RunReceipt>;
}

function pickOrchestratorScope(safety: SafetyContract, mode: string | undefined): ScopeSpec {
	if (mode === "super") return safety.scopes.super;
	return safety.scopes.default;
}

function pickWorkerScope(safety: SafetyContract, recipe: AgentRecipe | null): ScopeSpec {
	if (recipe?.mode === "advise") return safety.scopes.readonly;
	return safety.scopes.default;
}

function buildSystemPrompt(req: DispatchRequest, recipe: AgentRecipe | null): string {
	if (req.systemPrompt && req.systemPrompt.length > 0) return req.systemPrompt;
	if (recipe) return recipe.body;
	return "";
}

export function createDispatchBundle(context: DomainContext): DomainBundle<DispatchContract> {
	const maybeSafety = context.getContract<SafetyContract>("safety");
	const maybeAgents = context.getContract<AgentsContract>("agents");
	const maybeModes = context.getContract<ModesContract>("modes");
	if (!maybeSafety) throw new Error("dispatch domain requires 'safety' contract");
	if (!maybeAgents) throw new Error("dispatch domain requires 'agents' contract");
	if (!maybeModes) throw new Error("dispatch domain requires 'modes' contract");
	const safety: SafetyContract = maybeSafety;
	const agents: AgentsContract = maybeAgents;
	const modes: ModesContract = maybeModes;

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
		// systemPrompt is a dispatch-only override; strip before validating the JobSpec.
		const { systemPrompt: _sp, ...jobSpec } = req;
		const validated = validateJobSpec(jobSpec);
		if (!validated.ok) {
			throw new Error(`dispatch: invalid spec — ${validated.errors.join("; ")}`);
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
			throw new Error(`dispatch: admission denied — ${verdict.reason}`);
		}

		const providerId = req.providerId ?? recipe?.provider ?? "faux";
		const modelId = req.modelId ?? recipe?.model ?? "faux-model";
		const runtime = req.runtime ?? recipe?.runtime ?? "native";
		const cwd = req.cwd ?? process.cwd();
		const systemPrompt = buildSystemPrompt(req, recipe);

		const spec: WorkerSpec = {
			systemPrompt,
			task: req.task,
			providerId,
			modelId,
		};

		const worker = spawnNativeWorker(spec, { cwd });

		const ledgerRef = requireLedger();
		const envelope = ledgerRef.create({
			agentId: req.agentId,
			task: req.task,
			providerId,
			modelId,
			runtime,
			sessionId: null,
			cwd,
		});
		ledgerRef.update(envelope.id, { status: "running", pid: worker.pid });

		context.bus.emit(BusChannels.DispatchEnqueued, {
			runId: envelope.id,
			agentId: req.agentId,
			providerId,
			modelId,
		});
		context.bus.emit(BusChannels.DispatchStarted, {
			runId: envelope.id,
			agentId: req.agentId,
			providerId,
			modelId,
			pid: worker.pid,
		});

		const startedAt = envelope.startedAt;

		const activeRun: ActiveRun = {
			runId: envelope.id,
			worker,
			recipe,
			startedAt,
			providerId,
			modelId,
			runtime,
			agentId: req.agentId,
			task: req.task,
			cwd,
			aborted: false,
			finalPromise: undefined as unknown as Promise<RunReceipt>,
		};

		const finalPromise = (async (): Promise<RunReceipt> => {
			const result = await worker.promise;
			const receiptExitCode = result.exitCode ?? 1;
			const endedAt = new Date().toISOString();
			const status: RunStatus = activeRun.aborted ? "interrupted" : result.exitCode === 0 ? "completed" : "failed";
			const receipt: RunReceipt = {
				runId: envelope.id,
				agentId: req.agentId,
				task: req.task,
				providerId,
				modelId,
				runtime,
				startedAt,
				endedAt,
				exitCode: receiptExitCode,
				tokenCount: 0,
				costUsd: 0,
				compiledPromptHash: null,
				staticCompositionHash: null,
				clioVersion: readClioVersion(),
				piMonoVersion: readPiMonoVersion(),
				platform: process.platform,
				nodeVersion: process.version,
				toolCalls: 0,
				sessionId: null,
			};
			ledgerRef.update(envelope.id, { status, endedAt, exitCode: receiptExitCode });
			ledgerRef.recordReceipt(envelope.id, receipt);
			await ledgerRef.persist();
			active.delete(envelope.id);
			const startMs = Date.parse(receipt.startedAt);
			const endMs = Date.parse(receipt.endedAt);
			const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
			if (status === "completed") {
				context.bus.emit(BusChannels.DispatchCompleted, {
					runId: envelope.id,
					agentId: req.agentId,
					providerId,
					modelId,
					tokenCount: receipt.tokenCount,
					costUsd: receipt.costUsd,
					durationMs,
					exitCode: receiptExitCode,
				});
			} else {
				context.bus.emit(BusChannels.DispatchFailed, {
					runId: envelope.id,
					agentId: req.agentId,
					providerId,
					modelId,
					tokenCount: receipt.tokenCount,
					costUsd: receipt.costUsd,
					durationMs,
					exitCode: receiptExitCode,
					reason: status,
				});
			}
			return receipt;
		})();

		activeRun.finalPromise = finalPromise;
		active.set(envelope.id, activeRun);

		return {
			runId: envelope.id,
			events: worker.events,
			finalPromise,
		};
	}

	const extension: DomainExtension = {
		async start() {
			ledger = openLedger();
			// Subscribe (minimal) to modes + safety contract channels so the dispatch
			// domain participates in their lifecycle. Bodies are no-op today; slice 6+
			// wires the session/provider side effects.
			context.bus.on(BusChannels.ModeChanged, () => {});
			context.bus.on(BusChannels.SafetyBlocked, () => {});
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
				run.worker.abort();
			} catch {
				// best-effort; if abort fails the promise still resolves on child close.
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
				run.worker.abort();
			} catch {
				// child may already be gone; ignore.
			}
		},
		drain,
	};

	return { extension, contract };
}
