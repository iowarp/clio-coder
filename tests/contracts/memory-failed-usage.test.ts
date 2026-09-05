import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { createMemoryInterventionRegistration } from "../../src/domains/middleware/memory-intervention.js";
import { readOutOfTurnUsageRows } from "../../src/domains/observability/out-of-turn-usage.js";
import { EMPTY_CAPABILITIES, type ProvidersContract } from "../../src/domains/providers/index.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { completeEngineText } from "../../src/engine/ai.js";
import {
	createEngineFauxCore,
	registerEngineApiProvider,
	registerEngineFauxProvider,
} from "../../src/engine/api-registry.js";
import { createBackgroundMemoryModelClient } from "../../src/entry/orchestrator.js";
import { bindTaskMemoryLifecycle, captureTaskMemoryUsage } from "../../src/entry/task-memory-lifecycle.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const TEXT =
	'<operations>[{"op":"save_knowledge","content":"private origin fact"}]</operations><context_for_action>[tm-k-1] origin reminder</context_for_action>';
const USAGE = {
	input: 7,
	output: 3,
	cacheRead: 5,
	cacheWrite: 2,
	reasoning: 1,
	totalTokens: 17,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.025, total: 0.375 },
};

for (const ending of ["error", "aborted", "stop", "no-usage"] as const) {
	for (const switched of [false, true]) {
		test(`memory engine usage: ${ending}, ${switched ? "switched origin" : "current origin"}`, async (t) => {
			const env = await isolateClioEnv("clio-memory-engine-");
			t.after(() => {
				registerEngineFauxProvider({ api: "memory-usage-fixture" }).unregister();
				env.restore();
			});
			const faux = createEngineFauxCore({ api: "memory-usage-fixture", models: [{ id: "memory-model" }] });
			const model = faux.getModel();
			const provider = faux;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let entered!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			faux.setResponses([
				async () => {
					entered();
					await gate;
					if (ending === "no-usage") throw new Error("fixture transport failed before usage");
					return {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: 1,
						content: [{ type: "text", text: TEXT }],
						usage: USAGE,
						stopReason: ending,
						...(ending === "stop" ? {} : { errorMessage: `fixture ${ending}` }),
					};
				},
			]);
			// Faux estimates its own usage. Decorate only the provider result with
			// explicit reported cache/cost facts, before the real engine boundary.
			// Dropping the signal in the stop case exercises an abort-ignoring host.
			registerEngineApiProvider({
				...provider,
				streamSimple: (m, context, options) => {
					const effectiveOptions = { ...options };
					if (ending === "stop") delete effectiveOptions.signal;
					const stream = provider.streamSimple(m, context, effectiveOptions);
					const result = stream.result.bind(stream);
					stream.result = async () => {
						const response = await result();
						return ending === "no-usage"
							? response
							: {
									...response,
									usage: USAGE,
									backendTimings: {
										promptTokens: 12,
										cachedTokens: 5,
										predictedTokens: 3,
										promptMs: 4,
										predictedMs: 2,
										source: "llamacpp-timings",
									},
								};
					};
					return stream;
				},
			});
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.targets = [{ id: "origin-target", runtime: "openai-compat", defaultModel: model.id }];
			settings.context.memory.target = "origin-target";
			settings.context.memory.model = model.id;
			const providers = dispatchStubContext({
				settings,
				runtime: {
					id: "openai-compat",
					displayName: "fixture",
					kind: "http",
					apiFamily: "openai-completions",
					auth: "none",
					defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, contextWindow: 32768, maxTokens: 4096 },
					synthesizeModel: () => model,
				},
			}).getContract<ProvidersContract>("providers");
			assert.ok(providers);
			const route = createBackgroundMemoryModelClient(providers, settings, 1000, null);
			assert.ok(route);
			const bus = createSafeEventBus();
			const { contract: session } = createSessionBundle({ bus, getContract: () => undefined });
			const origin = session.create({ cwd: env.dir });
			const bank = new TaskMemoryBank();
			const live: number[] = [];
			const reminders: string[] = [];
			const proposals: unknown[] = [];
			const registration = createMemoryInterventionRegistration({
				bank,
				getModelClient: () => route.client,
				captureStepUsage: () =>
					captureTaskMemoryUsage({
						stateDir: join(env.dir, "state"),
						sessionId: origin.id,
						repoIdentity: origin.cwdHash,
						observability: {
							recordTokens: (_target, _model, tokens) => {
								live.push(tokens);
							},
						},
					}),
				onDeferredReminder: (text) => reminders.push(text),
				onInjectedEntries: (entries) => proposals.push(entries),
			});
			const dispose = bindTaskMemoryLifecycle(bus, registration);
			try {
				registration.evaluate({ hook: "turn_start", sessionId: origin.id, text: "origin task" });
				registration.signalLoop();
				await registration.evaluateAsync({ hook: "turn_end", sessionId: origin.id, turnId: "origin-turn" });
				await started;
				const idle = registration.whenIdle();
				if (switched) session.create({ cwd: env.dir });
				release();
				await idle;
				await new Promise<void>((resolve) => setImmediate(resolve));
				const rows = readOutOfTurnUsageRows(join(env.dir, "state")).rows;
				assert.equal(rows.length, ending === "no-usage" ? 0 : 1);
				if (ending !== "no-usage") {
					assert.equal(rows[0]?.sessionId, origin.id);
					assert.equal(rows[0]?.repoIdentity, origin.cwdHash);
					assert.equal(rows[0]?.target, "origin-target");
					assert.equal(rows[0]?.attributedModelId, "memory-model");
					assert.deepEqual(rows[0]?.usage, {
						input: 7,
						output: 3,
						cacheRead: 5,
						cacheWrite: 2,
						reasoning: 1,
						totalTokens: 17,
						costUsd: 0.375,
						costProvenance: "unknown",
					});
					assert.equal(rows[0]?.promptCache?.cachedTokens, 5);
				}
				assert.deepEqual(live, switched || ending === "no-usage" ? [] : [17]);
				const usable = ending === "stop" && !switched;
				assert.equal(bank.snapshot().knowledge.length, usable ? 1 : 0);
				assert.equal(reminders.length, usable ? 1 : 0);
				assert.equal(proposals.length, usable ? 1 : 0);
				assert.equal(faux.state.callCount, 1);
			} finally {
				release();
				dispose();
				await session.close();
			}
		});
	}
}

test("engine text callers still reject failures rather than returning their content", async () => {
	const faux = registerEngineFauxProvider();
	try {
		faux.setResponses([
			() => {
				throw new Error("fixture engine failure");
			},
		]);
		await assert.rejects(
			completeEngineText({
				model: faux.getModel(),
				systemPrompt: "fixture",
				userPrompt: "fixture",
				maxTokens: 10,
				thinkingLevel: "off",
				signal: new AbortController().signal,
				timeoutMs: 1000,
			}),
			/fixture engine failure/u,
		);
	} finally {
		faux.unregister();
	}
});
