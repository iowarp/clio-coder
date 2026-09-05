import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import {
	acquireCapacityLease,
	endpointCapacityUsage,
	releaseCapacityLease,
} from "../../src/domains/dispatch/capacity-lease.js";
import { createDispatchReservation, releaseDispatchReservation } from "../../src/domains/dispatch/reservation-store.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { TaskMemoryStepUsage } from "../../src/domains/memory/task-memory-policy.js";
import { createMemoryInterventionRegistration } from "../../src/domains/middleware/memory-intervention.js";
import { readOutOfTurnUsageRows } from "../../src/domains/observability/out-of-turn-usage.js";
import { canonicalEndpointKey, registerForegroundStream } from "../../src/domains/providers/endpoint-capacity.js";
import { EMPTY_CAPABILITIES, type ProvidersContract } from "../../src/domains/providers/index.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { completeEngineText } from "../../src/engine/ai.js";
import {
	createEngineFauxCore,
	registerEngineApiProvider,
	registerEngineFauxProvider,
} from "../../src/engine/api-registry.js";
import { createBackgroundMemoryModelClient, createBackgroundMemoryRouting } from "../../src/entry/orchestrator.js";
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

for (const unavailable of ["available", "down", "missing-model", "unloaded"] as const) {
	test(`production memory route prefers dedicated then chat for ${unavailable}`, async (t) => {
		const env = await isolateClioEnv("clio-memory-route-");
		t.after(() => env.restore());
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{ id: "memory", runtime: "openai-compat", url: "http://gateway.invalid:4000", defaultModel: "memory-model" },
			{ id: "chat", runtime: "openai-compat", url: "http://gateway.invalid:4000", defaultModel: "chat-model" },
		];
		settings.context.memory.target = "memory";
		settings.context.memory.model = "memory-model";
		settings.chat.target = "chat";
		settings.chat.model = "chat-model";
		const faux = createEngineFauxCore({ models: [{ id: "memory-model" }, { id: "chat-model", reasoning: true }] });
		const providers = dispatchStubContext({
			settings,
			runtime: {
				id: "openai-compat",
				displayName: "fixture",
				kind: "http",
				apiFamily: "openai-completions",
				auth: "none",
				defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, reasoning: true, contextWindow: 32768, maxTokens: 4096 },
				synthesizeModel: (_target, wireModelId) => {
					const model = faux.getModel(wireModelId);
					assert.ok(model);
					return model;
				},
			},
		}).getContract<ProvidersContract>("providers");
		assert.ok(providers);
		const status = providers.list()[0];
		assert.ok(status);
		if (unavailable === "down") status.health.status = "down";
		if (unavailable === "missing-model") {
			status.discoveredModelsSource = "probe";
			status.discoveredModels = ["other"];
		}
		if (unavailable === "unloaded") status.discoveredModelStates = { "memory-model": { state: "unloaded" } };
		const route = createBackgroundMemoryModelClient(providers, settings, 1000, null);
		assert.ok(route);
		assert.equal(route.targetId, unavailable === "available" ? "memory" : "chat");
		settings.context.memory.target = "chat";
		settings.context.memory.model = "chat-model";
		assert.ok(
			createBackgroundMemoryModelClient(providers, settings, 1000, null),
			"shared reasoning chat model can serve memory with capacity",
		);
		settings.context.memory.target = null;
		settings.context.memory.model = null;
		assert.equal(createBackgroundMemoryModelClient(providers, settings, 1000, null), null, "unset role stays rules-only");
	});
}

function routingFixture() {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "memory", runtime: "litellm", url: "http://gateway.invalid:4000", defaultModel: "memory-model" },
		{ id: "chat", runtime: "litellm", url: "http://gateway.invalid:4000", defaultModel: "chat-model" },
	];
	settings.chat.target = "chat";
	settings.chat.model = "chat-model";
	settings.context.memory.target = "memory";
	settings.context.memory.model = "memory-model";
	const faux = createEngineFauxCore({
		api: "memory-fallback-fixture",
		models: [{ id: "memory-model" }, { id: "chat-model", reasoning: true }],
	});
	const providers = dispatchStubContext({
		settings,
		runtime: {
			id: "litellm",
			displayName: "fixture",
			tier: "protocol",
			kind: "http",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, reasoning: true, contextWindow: 32768, maxTokens: 4096 },
			synthesizeModel: (_target, id) => {
				const model = faux.getModel(id);
				assert.ok(model);
				return model;
			},
		},
	}).getContract<ProvidersContract>("providers");
	assert.ok(providers);
	return { settings, providers, faux };
}

test("production callbacks use gateway capacity evidence and count foreground, leases and reservations", async (t) => {
	const env = await isolateClioEnv("clio-memory-capacity-");
	t.after(() => env.restore());
	const { settings, providers } = routingFixture();
	const callbacks = createBackgroundMemoryRouting(providers, () => settings, null);
	const target = settings.targets[0];
	const status = providers.list()[0];
	assert.ok(target);
	assert.ok(status);
	const key = canonicalEndpointKey(target);
	assert.ok(key);
	const release = registerForegroundStream(key);
	t.after(release);
	assert.ok(callbacks.getModelClient());
	assert.equal(callbacks.backgroundEndpointBusy(), false, "a gateway URL alone does not declare one slot");
	for (const slots of [1, 2, 4]) {
		target.maxConcurrentRequests = slots;
		assert.ok(callbacks.getModelClient());
		assert.equal(callbacks.backgroundEndpointBusy(), slots === 1, `one active chat request with ${slots} slots`);
	}
	target.maxConcurrentRequests = 2;
	callbacks.getModelClient();
	const reservation = createDispatchReservation({
		topology: "parallel",
		tasks: [{ memberId: "held", wave: 0, nodeId: "node", endpointKey: key, costUpperBoundUsd: 0 }],
		capacity: {
			global: { active: 0, limit: 10 },
			nodes: {},
			endpoints: { [key]: { active: 1, limit: 2 } },
			budget: { currentUsd: 0, ceilingUsd: 10 },
		},
	});
	assert.equal(endpointCapacityUsage()[key], 2);
	assert.equal(callbacks.backgroundEndpointBusy(), true, "held reservations use capacity");
	releaseDispatchReservation(reservation.ownerId);
	assert.equal(callbacks.backgroundEndpointBusy(), false);
	const lease = acquireCapacityLease({
		assignmentId: "worker",
		nodeId: "node",
		endpointKey: key,
		limits: { global: 10, nodes: {}, endpoints: { [key]: 2 } },
	});
	assert.equal(callbacks.backgroundEndpointBusy(), true, "active workers use capacity");
	releaseCapacityLease(lease.leaseId);
	assert.equal(callbacks.backgroundEndpointBusy(), false);
	delete target.maxConcurrentRequests;
	status.probeCapabilities = { parallelSlots: 1 };
	callbacks.getModelClient();
	assert.equal(callbacks.backgroundEndpointBusy(), true, "current discovery is authoritative");
	status.probeCapabilities = { parallelSlots: 4 };
	callbacks.getModelClient();
	assert.equal(callbacks.backgroundEndpointBusy(), false);
});

test("production runtime fallback calls chat once and keeps failed and fallback spend with their routes", async (t) => {
	const env = await isolateClioEnv("clio-memory-fallback-");
	t.after(() => env.restore());
	const { settings, providers, faux } = routingFixture();
	t.after(() => registerEngineFauxProvider({ api: "memory-fallback-fixture" }).unregister());
	faux.setResponses([
		() => {
			throw new Error("dedicated transport unavailable");
		},
		() => {
			const model = faux.getModel("chat-model");
			assert.ok(model);
			return {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				content: [{ type: "text", text: TEXT }],
				usage: USAGE,
				stopReason: "stop",
			};
		},
	]);
	const calls: string[] = [];
	registerEngineApiProvider({
		...faux,
		streamSimple: (model, context, options) => {
			calls.push(model.id);
			const stream = faux.streamSimple(model, context, options);
			const result = stream.result.bind(stream);
			stream.result = async () => ({ ...(await result()), usage: USAGE });
			return stream;
		},
	});
	const bus = createSafeEventBus();
	const notices: string[] = [];
	const ended: string[] = [];
	bus.on(BusChannels.RuntimeNotice, (event) => {
		notices.push(event.message);
	});
	bus.on(BusChannels.MemoryStepCompleted, (event) => {
		ended.push(event.targetId);
	});
	const callbacks = createBackgroundMemoryRouting(providers, () => settings, bus);
	const bank = new TaskMemoryBank();
	const usage: TaskMemoryStepUsage[] = [];
	const reasons: string[] = [];
	const registration = createMemoryInterventionRegistration({
		bank,
		...callbacks,
		captureStepUsage: () => (row, current) => {
			assert.equal(current, true);
			usage.push(row);
		},
		telemetry: { record: (row) => reasons.push(row.reason) },
	});
	const result = await registration.runPromptedStep({ deterministicTrigger: true, task: "preserve the origin fact" });
	assert.equal(result.decision, "injected", JSON.stringify({ result, calls, reasons, notices }));
	assert.deepEqual(calls, ["memory-model", "chat-model"]);
	assert.deepEqual(
		usage.map((row) => [row.targetId, row.attributedModelId, row.totalTokens]),
		[
			["memory", "memory-model", 17],
			["chat", "chat-model", 17],
		],
	);
	assert.deepEqual(reasons, ["client_error", "intervened"]);
	assert.deepEqual(ended, ["memory", "chat"]);
	assert.equal(endpointCapacityUsage()["http://gateway.invalid:4000"], undefined, "both per-call holds released");
	assert.equal(bank.snapshot().knowledge.length, 1);
	assert.match(notices[0] ?? "", /chat fallback chat\/chat-model/);
	assert.equal(result.usage?.targetId, "chat", "final result does not merge provider identities");
	assert.equal(callbacks.getFallbackModelClient(), null, "a fallback never falls back again");
});

for (const ending of ["silent", "malformed", "abort", "deadline", "scope-change", "fallback-fails"] as const) {
	test(`memory fallback stays bounded for ${ending}`, async () => {
		const bank = new TaskMemoryBank();
		let attempts = 0;
		let fallbackAttempts = 0;
		const registration = createMemoryInterventionRegistration({
			bank,
			timeoutMs: 20,
			getModelClient: () => ({
				complete: async () => {
					attempts += 1;
					if (ending === "deadline") return new Promise(() => {});
					if (ending === "scope-change") {
						registration.reset();
						throw new Error("old route failed");
					}
					if (ending === "abort") throw new DOMException("transport aborted", "AbortError");
					if (ending === "fallback-fails") throw new Error("route failed");
					return { text: ending === "silent" ? "<operations>[]</operations><no_intervention/>" : "broken envelope" };
				},
			}),
			getFallbackModelClient: () => ({
				complete: async () => {
					fallbackAttempts += 1;
					throw new Error("fallback failed");
				},
			}),
		});
		await registration.runPromptedStep({ deterministicTrigger: true });
		assert.equal(attempts, 1);
		assert.equal(fallbackAttempts, ending === "fallback-fails" ? 1 : 0);
		assert.equal(bank.snapshot().knowledge.length, 0);
	});
}

test("fallback shares the original deadline and cancellation discards its late content but retains origin spend", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let clockNs = 0n;
	t.mock.method(process.hrtime, "bigint", () => clockNs);
	let release!: (value: { text: string; usage: TaskMemoryStepUsage }) => void;
	const response = new Promise<{ text: string; usage: TaskMemoryStepUsage }>((resolve) => {
		release = resolve;
	});
	let fallbackSignal: AbortSignal | undefined;
	const bank = new TaskMemoryBank();
	const usage: Array<{ row: TaskMemoryStepUsage; current: boolean }> = [];
	const registration = createMemoryInterventionRegistration({
		bank,
		timeoutMs: 50,
		getModelClient: () => ({
			complete: async () => {
				clockNs = 35_000_000n;
				throw new Error("route unavailable");
			},
		}),
		getFallbackModelClient: () => ({
			complete: (input) => {
				fallbackSignal = input.signal;
				return response;
			},
		}),
		captureStepUsage: () => (row, current) => {
			usage.push({ row, current });
		},
	});
	const result = registration.runPromptedStep({ deterministicTrigger: true });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(fallbackSignal);
	assert.equal(fallbackSignal.aborted, false);
	t.mock.timers.tick(14);
	await Promise.resolve();
	assert.equal(fallbackSignal.aborted, false);
	t.mock.timers.tick(1);
	assert.equal((await result).reason, "deadline", "fallback gets 15 remaining milliseconds, not a new 50");
	assert.equal(fallbackSignal.aborted, true);
	registration.reset();
	const known: TaskMemoryStepUsage = {
		targetId: "chat",
		attributedModelId: "chat-model",
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 10,
		costUsd: 0,
		costProvenance: "unknown",
		durationMs: 15,
		backend: null,
	};
	release({ text: TEXT, usage: known });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(usage, [{ row: known, current: false }]);
	assert.equal(bank.snapshot().knowledge.length, 0);
});

test("a failed fallback capacity read preserves the dedicated call's result and known usage", async () => {
	let choosingFallback = false;
	let fallbackCalls = 0;
	const known: TaskMemoryStepUsage = {
		targetId: "dedicated",
		attributedModelId: "memory",
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 10,
		costUsd: 0,
		costProvenance: "unknown",
		durationMs: 1,
		backend: null,
	};
	const registration = createMemoryInterventionRegistration({
		bank: new TaskMemoryBank(),
		getModelClient: () => ({
			complete: async (request) => {
				request.onUsage?.(known);
				throw new Error("dedicated transport failed");
			},
		}),
		getFallbackModelClient: () => {
			choosingFallback = true;
			return {
				complete: async () => {
					fallbackCalls += 1;
					return { text: TEXT };
				},
			};
		},
		backgroundEndpointBusy: () => {
			if (choosingFallback) throw new Error("capacity store unreadable");
			return false;
		},
	});
	const result = await registration.runPromptedStep({ deterministicTrigger: true });
	assert.equal(result.reason, "client_error");
	assert.equal(result.usage, known);
	assert.equal(result.inputTokens, 7);
	assert.equal(fallbackCalls, 0);
});
