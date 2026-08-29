/**
 * Issue #227: the estimate and the provider's own count diverge, and the
 * budget follows the estimate.
 *
 * The failure these cover is one session: chars/4 said 63 percent of a 131,072
 * window while the backend answered "Context size has been exceeded". The
 * reconciliation data was already on the receipts; nothing fed it back into the
 * compaction verdict, the working-set carry-forward threw it away, and a resume
 * spent its first turn budgeting against a probed 262,144.
 *
 * Everything here drives the real turn context over a real session on disk
 * through `tests/harness/working-set-session.ts`; the provider counts are the
 * only fixture. One harness at a time, so the scenarios are sequenced.
 */

import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { resolveRuntimeTarget } from "../../src/domains/providers/runtime-resolution.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { shouldCompact } from "../../src/domains/session/compaction/auto.js";
import {
	appendContextSnapshot,
	captureContextSnapshot,
	getLatestContextSnapshot,
	lastLoadedContextWindow,
	reconcileSnapshot,
} from "../../src/domains/session/context-accounting.js";
import type { Usage } from "../../src/engine/types.js";
import type { AgentRuntime } from "../../src/interactive/turn-state.js";
import {
	createScenarioHarness,
	type ScenarioHarness,
	scenarioBody,
	seedScenarioTurns,
} from "../harness/working-set-session.js";

const THRESHOLD = 0.8;

/** The 2026-08-28 divergence: the backend counted 40 percent more than chars/4. */
const PROVIDER_INFLATION = 1.4;

function providerUsage(promptTokens: number, outputTokens = 0): Usage {
	return {
		input: promptTokens,
		output: outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: promptTokens + outputTokens,
	} as Usage;
}

/** The harness runtime holds a plain details object; the window is set after seeding. */
function setContextWindow(runtime: AgentRuntime, contextWindow: number): void {
	const details = runtime.runtimeResolution.contextWindowDetails as {
		desiredContextWindow: number;
		effectiveContextWindow: number;
	};
	details.desiredContextWindow = contextWindow;
	details.effectiveContextWindow = contextWindow;
}

describe("contracts/context reconciliation (#227)", () => {
	it("compacts on the provider's count when the estimate says there is room", async () => {
		const harness: ScenarioHarness = await createScenarioHarness({
			prefix: "reconcile-threshold",
			threshold: THRESHOLD,
			// The summary stage is the only stage under test: with the working set
			// off, crossing the threshold goes straight to it.
			workingSetEnabled: false,
			autoCompact: async () => null,
		});
		try {
			seedScenarioTurns(harness.session, [
				{
					id: "t1",
					user: "read the first file",
					calls: [{ callId: "c1", tool: "read", args: { path: "a.ts" }, body: scenarioBody("alpha", 200) }],
					assistant: { text: "read alpha" },
				},
				{
					id: "t2",
					user: "read the second file",
					calls: [{ callId: "c2", tool: "read", args: { path: "b.ts" }, body: scenarioBody("bravo", 200) }],
					assistant: { text: "read bravo" },
				},
				{
					id: "t3",
					user: "read the third file",
					calls: [{ callId: "c3", tool: "read", args: { path: "c.ts" }, body: scenarioBody("chuck", 200) }],
					assistant: { text: "read chuck" },
				},
			]);

			// Size the window so the third turn's estimate sits at 60 percent, well
			// under the 80 percent trigger, while the provider's count sits at 84.
			harness.syncRuntimeFromLedger("t3-assistant");
			const fullEstimate = harness.context.liveContextEstimate(harness.runtime).estimatedTokens;
			const contextWindow = Math.round(fullEstimate / 0.6);
			setContextWindow(harness.runtime, contextWindow);

			const rounds: Array<{ estimatePressure: number; reconciledPressure: number; summaryCalls: number }> = [];
			for (const leaf of ["t1-assistant", "t2-assistant", "t3-assistant"]) {
				harness.syncRuntimeFromLedger(leaf);
				const before = harness.context.liveContextEstimate(harness.runtime);
				harness.context.reconcileUsage(providerUsage(Math.round(before.estimatedTokens * PROVIDER_INFLATION)));
				const after = harness.context.liveContextEstimate(harness.runtime);

				strictEqual(
					after.reconciledTokens,
					Math.round(before.estimatedTokens * PROVIDER_INFLATION),
					"the reconciled figure is the provider's own prompt count",
				);
				strictEqual(after.tokens, after.reconciledTokens, "the budget figure follows the provider, not chars/4");

				await harness.context.runAutoCompact(harness.runtime, false);
				rounds.push({
					estimatePressure: after.estimatedTokens / contextWindow,
					reconciledPressure: after.tokens / contextWindow,
					summaryCalls: harness.summaryCalls(),
				});
			}

			const [first, second, third] = rounds;
			ok(first && second && third, "three turns were driven");

			for (const round of [first, second]) {
				ok(round.reconciledPressure < THRESHOLD, "the first two turns are under the trigger on both figures");
				strictEqual(round.summaryCalls, 0, "nothing to compact yet");
			}

			ok(
				third.estimatePressure < THRESHOLD,
				`the estimate alone never trips the trigger (${third.estimatePressure.toFixed(3)} < ${THRESHOLD})`,
			);
			ok(
				third.reconciledPressure >= THRESHOLD,
				`the provider's count does (${third.reconciledPressure.toFixed(3)} >= ${THRESHOLD})`,
			);
			strictEqual(third.summaryCalls, 1, "compaction fired on the reconciled number");

			// The same verdict function, read both ways, is the whole defect.
			strictEqual(
				shouldCompact(Math.round(third.estimatePressure * contextWindow), THRESHOLD, contextWindow).shouldCompact,
				false,
			);
			strictEqual(
				shouldCompact(Math.round(third.reconciledPressure * contextWindow), THRESHOLD, contextWindow).shouldCompact,
				true,
			);
		} finally {
			await harness.dispose();
		}
	});

	it("stops a continuation that only the provider's count says would overflow", async () => {
		const harness: ScenarioHarness = await createScenarioHarness({
			prefix: "reconcile-overflow",
			threshold: THRESHOLD,
			workingSetEnabled: false,
			autoCompact: async () => null,
		});
		try {
			seedScenarioTurns(harness.session, [
				{
					id: "t1",
					user: "read the file",
					// No assistant: the message list ends on a tool result, which is
					// what the post-tool guard runs against.
					calls: [{ callId: "c1", tool: "read", args: { path: "a.ts" }, body: scenarioBody("alpha", 400) }],
				},
			]);
			harness.syncRuntimeFromLedger("t1-result-1");

			const estimate = harness.context.liveContextEstimate(harness.runtime).estimatedTokens;
			// The estimate has room; the provider's count does not.
			const contextWindow = Math.round(estimate / 0.7);
			setContextWindow(harness.runtime, contextWindow);

			// Estimate-only: no compaction, no guard, the continuation proceeds.
			strictEqual(await harness.context.postToolContinuationGuard(harness.runtime), undefined);
			strictEqual(harness.summaryCalls(), 0);

			harness.context.reconcileUsage(providerUsage(Math.round(contextWindow * 1.1)));
			const reconciled = harness.context.liveContextEstimate(harness.runtime);
			ok(reconciled.estimatedTokens < contextWindow, "chars/4 still believes the request fits");
			ok(reconciled.tokens > contextWindow, "the provider's count says it does not");

			let blocked: string | null = null;
			try {
				await harness.context.postToolContinuationGuard(harness.runtime);
			} catch (error) {
				blocked = error instanceof Error ? error.message : String(error);
			}
			strictEqual(harness.summaryCalls(), 1, "the guard tried compaction first");
			ok(blocked !== null, "the turn was stopped rather than sent to the provider");
			ok(blocked?.includes("stopped continuation before provider call"), blocked ?? "");
		} finally {
			await harness.dispose();
		}
	});

	it("carries the reconciled figure through a working-set projection minus what it evicted", async () => {
		const harness: ScenarioHarness = await createScenarioHarness({
			prefix: "reconcile-eviction",
			threshold: THRESHOLD,
			policy: "age-horizon",
			protectLastTurns: 1,
			minEvictableTokens: 1,
			// No summary stage: the eviction is the only thing that runs, so the
			// carried figure is not then reset by a compaction.
		});
		try {
			seedScenarioTurns(harness.session, [
				{
					id: "t1",
					user: "read the first file",
					calls: [{ callId: "c1", tool: "read", args: { path: "a.ts" }, body: scenarioBody("alpha", 300) }],
					assistant: { text: "read alpha" },
				},
				{
					id: "t2",
					user: "read the second file",
					calls: [{ callId: "c2", tool: "read", args: { path: "b.ts" }, body: scenarioBody("bravo", 300) }],
					assistant: { text: "read bravo" },
				},
			]);
			harness.syncRuntimeFromLedger("t2-assistant");

			const estimate = harness.context.liveContextEstimate(harness.runtime).estimatedTokens;
			// Under the trigger on chars/4, over it on the provider's count.
			const contextWindow = Math.round(estimate / 0.6);
			setContextWindow(harness.runtime, contextWindow);

			const attested = Math.round(estimate * PROVIDER_INFLATION);
			harness.context.reconcileUsage(providerUsage(attested));
			strictEqual(harness.context.liveContextEstimate(harness.runtime).reconciledTokens, attested);

			strictEqual(
				await harness.context.runAutoCompact(harness.runtime, false),
				true,
				"the eviction relieved the pressure",
			);
			const [pruned] = harness.pruned;
			ok(pruned, "the eviction reported itself");
			strictEqual(pruned.stage, "working_set");

			const freed = (pruned.tokensBefore ?? 0) - (pruned.tokensAfter ?? 0);
			ok(freed > 0, "the projection removed tokens");

			const after = harness.context.liveContextEstimate(harness.runtime);
			strictEqual(
				after.reconciledTokens,
				attested - freed,
				"the attestation survives the projection, less exactly what the planner priced out",
			);
			ok(after.reconciledTokens !== null, "the reconciled figure is not discarded when usage is invalidated");
			ok(
				after.reconciledTokens > after.estimatedTokens,
				"and it is still the higher figure, so the budget keeps following it",
			);
		} finally {
			await harness.dispose();
		}
	});

	it("records the estimate, the reconciled total, and their divergence on the snapshot", async () => {
		const harness: ScenarioHarness = await createScenarioHarness({ prefix: "reconcile-snapshot" });
		try {
			seedScenarioTurns(harness.session, [
				{
					id: "t1",
					user: "read the file",
					calls: [{ callId: "c1", tool: "read", args: { path: "a.ts" }, body: scenarioBody("alpha", 120) }],
					assistant: { text: "read alpha" },
				},
			]);
			harness.syncRuntimeFromLedger("t1-assistant");

			const snapshot = harness.context.captureRuntimeContextSnapshot(harness.runtime, "t1-assistant", THRESHOLD);
			ok(snapshot.estimatedTokens && snapshot.estimatedTokens > 0, "capture records the estimate it was built from");
			strictEqual(snapshot.reconciledTokens, undefined, "and nothing is claimed as reconciled before a provider answers");

			const attested = Math.round(snapshot.estimatedTokens * PROVIDER_INFLATION);
			const reconciled = reconcileSnapshot(snapshot, providerUsage(attested, 64));
			strictEqual(reconciled.estimatedTokens, snapshot.estimatedTokens, "the estimate is not rewritten by the reconcile");
			strictEqual(reconciled.reconciledTokens, attested);
			strictEqual(reconciled.divergenceRatio, Math.round((attested / snapshot.estimatedTokens) * 1000) / 1000);
			strictEqual(reconciled.sources.total, "reconciled");

			harness.context.setCurrentSnapshot(reconciled);
			harness.context.persistContextSnapshot(reconciled);
			const meta = harness.session.current();
			ok(meta);
			const persisted = getLatestContextSnapshot(meta);
			strictEqual(persisted?.estimatedTokens, snapshot.estimatedTokens, "both figures reach context-snapshots.jsonl");
			strictEqual(persisted?.reconciledTokens, attested);
			ok(persisted?.divergenceRatio && persisted.divergenceRatio > 1);
		} finally {
			await harness.dispose();
		}
	});
});

/**
 * The resume half of #227. The 2026-08-28 session resumed against a probe that
 * reports the server's whole context pool, spent one turn budgeting against
 * 262,144, and corrected to the loaded 131,072 a turn later.
 */
const MODEL = "qwen3.8-27b";
const LOADED_WINDOW = 131_072;
const PROBED_WINDOW = 262_144;

function probeOnlyProviders(): ProvidersContract {
	const runtime: RuntimeDescriptor = {
		id: "lmstudio",
		displayName: "LM Studio",
		kind: "http",
		tier: "local-native",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, maxTokens: 4096 },
		synthesizeModel: () => ({ id: MODEL, provider: "lmstudio" }) as never,
	};
	const target: TargetDescriptor = { id: "dynamo", runtime: "lmstudio", url: "http://dynamo:1234", defaultModel: MODEL };
	const status: TargetStatus = {
		target,
		runtime,
		available: true,
		reason: "ready",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 4 },
		capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: PROBED_WINDOW },
		probeModelCapabilities: { [MODEL]: { contextWindow: PROBED_WINDOW } },
		probeModelId: MODEL,
		discoveredModels: [MODEL],
		discoveredModelsSource: "probe",
		// The resume case: discovery has not yet said what is open.
		discoveredModelStates: null,
	} as never;
	return {
		list: () => [status],
		getTarget: (id: string) => (id === "dynamo" ? target : null),
		getRuntime: (id: string) => (id === "lmstudio" ? runtime : null),
		getDetectedReasoning: () => null,
		knowledgeBase: null,
	} as never;
}

describe("contracts/resume carries the loaded context window (#227)", () => {
	it("resolves to the loaded window the session already recorded instead of re-probing", async () => {
		const harness: ScenarioHarness = await createScenarioHarness({ prefix: "reconcile-resume" });
		try {
			const meta = harness.session.current();
			ok(meta);

			// What the previous process wrote once discovery reported the open window.
			appendContextSnapshot(
				meta,
				captureContextSnapshot({
					sessionId: meta.id,
					turnId: "t1",
					providerId: "dynamo",
					runtimeId: "lmstudio",
					modelId: MODEL,
					conversationMessages: [],
					activeToolSchemas: [],
					desiredContextWindow: PROBED_WINDOW,
					effectiveContextWindow: LOADED_WINDOW,
					contextWindowSource: "loaded",
					compactionThreshold: THRESHOLD,
				}),
			);

			strictEqual(lastLoadedContextWindow(meta, "dynamo", MODEL), LOADED_WINDOW);
			strictEqual(lastLoadedContextWindow(meta, "dynamo", "some-other-model"), null, "scoped to the model");
			strictEqual(lastLoadedContextWindow(meta, "other-target", MODEL), null, "scoped to the target");
			strictEqual(
				harness.context.rememberedLoadedContextWindow("dynamo", MODEL),
				LOADED_WINDOW,
				"the turn context reads it back from the session ledger",
			);

			const providers = probeOnlyProviders();
			const probed = resolveRuntimeTarget(providers, { targetId: "dynamo", wireModelId: MODEL, use: "orchestrator" });
			ok(probed.ok);
			strictEqual(
				probed.target.contextWindowDetails.contextWindowSource,
				"probe",
				"without the carried value this is the turn that budgets against 262,144",
			);
			strictEqual(probed.target.contextWindowDetails.effectiveContextWindow, PROBED_WINDOW);

			const resumed = resolveRuntimeTarget(providers, {
				targetId: "dynamo",
				wireModelId: MODEL,
				use: "orchestrator",
				knownLoadedContextWindow: harness.context.rememberedLoadedContextWindow("dynamo", MODEL),
			});
			ok(resumed.ok);
			strictEqual(resumed.target.contextWindowDetails.contextWindowSource, "loaded");
			strictEqual(resumed.target.contextWindowDetails.effectiveContextWindow, LOADED_WINDOW);
			strictEqual(resumed.target.contextWindowDetails.loadedContextWindow, LOADED_WINDOW);
			strictEqual(resumed.target.capabilities.contextWindow, LOADED_WINDOW);

			// A model reloaded at a different size still corrects: a live loaded
			// window outranks the carried one.
			const relive = resolveRuntimeTarget(
				{
					...providers,
					list: () => [
						{
							...(providers.list()[0] as TargetStatus),
							discoveredModelStates: { [MODEL]: { state: "loaded", contextLength: 65_536 } },
						} as TargetStatus,
					],
				} as ProvidersContract,
				{
					targetId: "dynamo",
					wireModelId: MODEL,
					use: "orchestrator",
					knownLoadedContextWindow: LOADED_WINDOW,
				},
			);
			ok(relive.ok);
			strictEqual(relive.target.contextWindowDetails.effectiveContextWindow, 65_536);
			strictEqual(relive.target.contextWindowDetails.contextWindowSource, "loaded");
		} finally {
			await harness.dispose();
		}
	});
});
