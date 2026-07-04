import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { spawnNativeWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import type { ProvidersContract, RuntimeDescriptor, TargetStatus } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../src/engine/ai.js";
import { startWorkerRun, type WorkerRunHandle, type WorkerRunInput } from "../../src/engine/worker-runtime.js";
import { WORKER_RUNTIME_DESCRIPTOR_VERSION, WORKER_SPEC_VERSION } from "../../src/worker/spec-contract.js";
import { createWorkerStdinDemux } from "../../src/worker/stdin-demux.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function emptyEvents(): AsyncIterableIterator<unknown> {
	return (async function* () {})();
}

async function waitFor<T>(read: () => T | undefined, message: string, timeoutMs = 1000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(message);
}

async function expectPending<T>(promise: Promise<T>, label: string, delayMs = 25): Promise<void> {
	const marker = Symbol(label);
	const result = await Promise.race([
		promise,
		new Promise<typeof marker>((resolve) => setTimeout(() => resolve(marker), delayMs)),
	]);
	strictEqual(result, marker, `${label} resolved before permission decision`);
}

const MINIMAL_SPEC_LINE = `${JSON.stringify({
	specVersion: WORKER_SPEC_VERSION,
	runtime: {
		version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
		id: "x",
		kind: "http",
		apiFamily: "openai-responses",
		auth: "none",
	},
	runtimeId: "x",
	systemPrompt: "",
	agentId: "coder",
	task: "t",
	target: { id: "e", runtime: "x" },
	wireModelId: "m",
	allowedTools: ["bash"],
})}\n`;

type PermissionDecision = "approve" | "deny";

type PermissionCapableDemux = ReturnType<typeof createWorkerStdinDemux> & {
	onPermissionDecision(handler: (decision: { requestId: string; decision: PermissionDecision }) => void): void;
};

type PermissionCapableRunHandle = WorkerRunHandle & {
	resolvePermission(requestId: string, decision: PermissionDecision): void;
};

function permissionHandle(handle: WorkerRunHandle): PermissionCapableRunHandle {
	return handle as PermissionCapableRunHandle;
}

function permissionEvent(
	events: ReadonlyArray<unknown>,
	type: "clio_permission_escalated" | "clio_permission_resolved",
): { type: string; payload?: Record<string, unknown> } | undefined {
	return events.find(
		(event): event is { type: string; payload?: Record<string, unknown> } =>
			typeof event === "object" &&
			event !== null &&
			(event as { type?: unknown }).type === type &&
			typeof (event as { payload?: unknown }).payload === "object" &&
			(event as { payload?: unknown }).payload !== null,
	);
}

function permissionEvents(
	events: ReadonlyArray<unknown>,
	type: "clio_permission_escalated" | "clio_permission_resolved",
): Array<{ type: string; payload?: Record<string, unknown> }> {
	return events.filter(
		(event): event is { type: string; payload?: Record<string, unknown> } =>
			typeof event === "object" &&
			event !== null &&
			(event as { type?: unknown }).type === type &&
			typeof (event as { payload?: unknown }).payload === "object" &&
			(event as { payload?: unknown }).payload !== null,
	);
}

function toolFinish(events: ReadonlyArray<unknown>): Record<string, unknown> | undefined {
	return events.find(
		(event): event is { type: string; payload: Record<string, unknown> } =>
			typeof event === "object" &&
			event !== null &&
			(event as { type?: unknown }).type === "clio_tool_finish" &&
			typeof (event as { payload?: unknown }).payload === "object" &&
			(event as { payload?: unknown }).payload !== null,
	)?.payload;
}

function toolFinishes(events: ReadonlyArray<unknown>): Record<string, unknown>[] {
	return events
		.filter(
			(event): event is { type: string; payload: Record<string, unknown> } =>
				typeof event === "object" &&
				event !== null &&
				(event as { type?: unknown }).type === "clio_tool_finish" &&
				typeof (event as { payload?: unknown }).payload === "object" &&
				(event as { payload?: unknown }).payload !== null,
		)
		.map((event) => event.payload);
}

function fauxRuntimeInput(
	responses: Parameters<ReturnType<typeof registerFauxProvider>["setResponses"]>[0],
	overrides: Record<string, unknown> = {},
): { input: WorkerRunInput; unregister(): void } {
	const provider = `faux-worker-permission-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const faux = registerFauxProvider({
		provider,
		models: [{ id: "faux-worker-permission" }],
		tokensPerSecond: 0,
	});
	faux.setResponses(responses);
	const runtime: RuntimeDescriptor = {
		id: provider,
		displayName: "Faux Worker Permission",
		kind: "http",
		apiFamily: "openai-responses",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		synthesizeModel: () => faux.getModel("faux-worker-permission") as never,
	};
	const target: TargetDescriptor = {
		id: "faux-worker-permission",
		runtime: runtime.id,
		defaultModel: "faux-worker-permission",
	};
	return {
		input: {
			systemPrompt: "",
			agentId: "coder",
			task: "run the requested bash command",
			target,
			runtime,
			wireModelId: "faux-worker-permission",
			allowedTools: [ToolNames.Bash],
			autonomy: "suggest",
			...overrides,
		} as unknown as WorkerRunInput,
		unregister: () => faux.unregister(),
	};
}

function stubContext(): DomainContext {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const target: TargetDescriptor = { id: "default", runtime: "openai", defaultModel: "gpt-4o" };
	settings.targets = [target];
	settings.workers.default.target = target.id;
	settings.workers.default.model = "gpt-4o";

	const runtime: RuntimeDescriptor = {
		id: target.runtime,
		displayName: "OpenAI",
		kind: "http",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		synthesizeModel: () => ({ id: target.defaultModel, provider: target.runtime }) as never,
	};
	const status: TargetStatus = {
		target,
		runtime,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities },
		discoveredModels: [],
	};
	const providers: ProvidersContract = {
		list: () => [status],
		getTarget: (id) => (id === target.id ? target : null),
		getRuntime: (id) => (id === runtime.id ? runtime : null),
		probeAll: async () => {},
		probeAllLive: async () => {},
		probeTarget: async () => status,
		disconnectTarget: () => status,
		auth: {
			statusForTarget: () => ({
				providerId: runtime.id,
				available: true,
				credentialType: null,
				source: "none",
				detail: null,
			}),
			resolveForTarget: async () => ({
				providerId: runtime.id,
				available: true,
				credentialType: null,
				source: "none",
				detail: null,
			}),
			getStored: () => null,
			listStored: () => [],
			setApiKey: () => {},
			remove: () => {},
			login: async () => {},
			logout: () => {},
			getOAuthProviders: () => [],
			setRuntimeOverrideForTarget: () => {},
			clearRuntimeOverrideForTarget: () => {},
		},
		credentials: {
			hasKey: () => false,
			get: () => null,
			set: () => {},
			remove: () => {},
		},
		getDetectedReasoning: () => null,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
	};

	const config: ConfigContract = {
		get: () => settings,
		onChange: () => () => {},
	};

	const safety: SafetyContract = {
		classify: () => ({ actionClass: "read", reasons: [] }),
		evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: {
			readonly: READONLY_SCOPE,
			workspace: WORKSPACE_SCOPE,
			confirmed: CONFIRMED_SCOPE,
		},
		isSubset,
		audit: { recordCount: () => 0 },
	};

	const recipes: ReadonlyArray<AgentRecipe> = [
		{
			id: "coder",
			name: "coder",
			description: "test recipe",
			source: "builtin" as const,
			filepath: "/test/coder.md",
			body: "# Test Recipe",
		},
	];
	const agents: AgentsContract = {
		list: () => recipes,
		get: (id) => recipes.find((recipe) => recipe.id === id) ?? null,
		listSpecs: () => recipes.map(normalizeAgentSpec),
		getSpec: (id) => {
			const recipe = recipes.find((entry) => entry.id === id);
			return recipe ? normalizeAgentSpec(recipe) : null;
		},
		reload: () => {},
		parseFleet: () => ({ steps: [] }),
	};

	const middleware = createMiddlewareBundle().contract;
	const bus = createSafeEventBus();
	const getContract = ((name: string) => {
		if (name === "config") return config;
		if (name === "safety") return safety;
		if (name === "agents") return agents;
		if (name === "scheduling")
			return {
				ceilingUsd: () => 5,
				checkCeiling: () => "under",
				raiseCeiling: () => {},
				preflight: () => ({ verdict: "under", currentUsd: 0, ceilingUsd: 5 }),
				activeWorkers: () => 0,
				tryAcquireWorker: () => true,
				releaseWorker: () => {},
				listNodes: () => [],
			};
		if (name === "providers") return providers;
		if (name === "middleware") return middleware;
		return undefined;
	}) as DomainContext["getContract"];

	return { bus, getContract };
}

describe("contracts/worker-steer", () => {
	describe("stdin demux", () => {
		it("dispatches a post-spec steer line to the registered handler", async () => {
			const demux = createWorkerStdinDemux();
			const received: string[] = [];
			demux.onSteer((text) => received.push(text));
			demux.feed(MINIMAL_SPEC_LINE);
			demux.feed(`${JSON.stringify({ type: "steer", text: "focus on tests/" })}\n`);
			const spec = await demux.readSpec();
			strictEqual(spec.agentId, "coder");
			deepStrictEqual(received, ["focus on tests/"]);
			strictEqual(demux.droppedLineCount(), 0);
		});

		it("buffers steers that arrive before the handler registers and flushes them in order", () => {
			const demux = createWorkerStdinDemux();
			demux.feed(MINIMAL_SPEC_LINE);
			demux.feed(`${JSON.stringify({ type: "steer", text: "first" })}\n`);
			demux.feed(`${JSON.stringify({ type: "steer", text: "second" })}\n`);
			const received: string[] = [];
			demux.onSteer((text) => received.push(text));
			deepStrictEqual(received, ["first", "second"]);
			demux.feed(`${JSON.stringify({ type: "steer", text: "third" })}\n`);
			deepStrictEqual(received, ["first", "second", "third"]);
		});

		it("counts and drops malformed, unknown, and empty post-spec lines without losing later steers", () => {
			const demux = createWorkerStdinDemux();
			const received: string[] = [];
			demux.onSteer((text) => received.push(text));
			demux.feed(MINIMAL_SPEC_LINE);
			demux.feed("not json at all\n");
			demux.feed(`${JSON.stringify({ type: "mystery" })}\n`);
			demux.feed(`${JSON.stringify({ type: "steer", text: "   " })}\n`);
			demux.feed(`${JSON.stringify({ type: "steer", text: 42 })}\n`);
			demux.feed(`${JSON.stringify({ type: "steer", text: "still works" })}\n`);
			deepStrictEqual(received, ["still works"]);
			strictEqual(demux.droppedLineCount(), 4);
		});

		it("handles spec and steer arriving in one chunk and split steer lines across chunks", async () => {
			const demux = createWorkerStdinDemux();
			const received: string[] = [];
			demux.onSteer((text) => received.push(text));
			const steerLine = `${JSON.stringify({ type: "steer", text: "split delivery" })}\n`;
			const combined = MINIMAL_SPEC_LINE + steerLine;
			demux.feed(combined.slice(0, MINIMAL_SPEC_LINE.length + 5));
			demux.feed(combined.slice(MINIMAL_SPEC_LINE.length + 5));
			await demux.readSpec();
			deepStrictEqual(received, ["split delivery"]);
		});

		it("dispatches permission_decision lines without treating them as steers", async () => {
			const demux = createWorkerStdinDemux() as PermissionCapableDemux;
			const steers: string[] = [];
			const decisions: Array<{ requestId: string; decision: PermissionDecision }> = [];
			demux.onSteer((text) => steers.push(text));
			demux.onPermissionDecision((decision) => decisions.push(decision));

			demux.feed(MINIMAL_SPEC_LINE);
			demux.feed(`${JSON.stringify({ type: "permission_decision", requestId: "perm-1", decision: "approve" })}\n`);
			demux.feed(`${JSON.stringify({ type: "steer", text: "keep going" })}\n`);
			const spec = await demux.readSpec();

			strictEqual(spec.agentId, "coder");
			deepStrictEqual(decisions, [{ requestId: "perm-1", decision: "approve" }]);
			deepStrictEqual(steers, ["keep going"]);
			strictEqual(demux.droppedLineCount(), 0);
		});

		it("drops malformed permission_decision lines without losing later valid control lines", () => {
			const demux = createWorkerStdinDemux() as PermissionCapableDemux;
			const decisions: Array<{ requestId: string; decision: PermissionDecision }> = [];
			const steers: string[] = [];
			demux.onPermissionDecision((decision) => decisions.push(decision));
			demux.onSteer((text) => steers.push(text));

			demux.feed(MINIMAL_SPEC_LINE);
			demux.feed(`${JSON.stringify({ type: "permission_decision", requestId: "", decision: "approve" })}\n`);
			demux.feed(`${JSON.stringify({ type: "permission_decision", requestId: "perm-2", decision: "maybe" })}\n`);
			demux.feed(`${JSON.stringify({ type: "permission_decision", requestId: "perm-3", decision: "deny" })}\n`);
			demux.feed(`${JSON.stringify({ type: "steer", text: "still alive" })}\n`);

			deepStrictEqual(decisions, [{ requestId: "perm-3", decision: "deny" }]);
			deepStrictEqual(steers, ["still alive"]);
			strictEqual(demux.droppedLineCount(), 2);
		});
	});

	describe("worker runtime permission escalation", () => {
		it("escalate posture parks the call and emits clio_permission_escalated with requestId", async () => {
			const events: unknown[] = [];
			const { input, unregister } = fauxRuntimeInput(
				[
					fauxAssistantMessage([fauxToolCall("bash", { command: "printf worker-ok" }, { id: "call-escalate" })], {
						stopReason: "toolUse",
					}),
				],
				{ onPermission: "escalate", escalation: { timeoutMs: 5_000, fallback: "deny" } },
			);
			try {
				const handle = startWorkerRun(input, (event) => events.push(event));
				const escalated = await waitFor(
					() => permissionEvent(events, "clio_permission_escalated"),
					"worker did not emit clio_permission_escalated",
				);
				await expectPending(handle.promise, "worker run");

				strictEqual(typeof escalated.payload?.requestId, "string");
				ok((escalated.payload?.requestId as string).length > 0);
				strictEqual(escalated.payload?.tool, "bash");
				strictEqual(typeof escalated.payload?.summary, "string");
				ok((escalated.payload?.summary as string).includes("bash"));
				strictEqual(typeof escalated.payload?.decision, "object");
				strictEqual(escalated.payload?.timeoutMs, 5_000);

				handle.abort();
				await handle.promise;
			} finally {
				unregister();
			}
		});

		it("abort mid-escalation emits a denied resolution for the active request", async () => {
			const events: unknown[] = [];
			const { input, unregister } = fauxRuntimeInput(
				[
					fauxAssistantMessage([fauxToolCall("bash", { command: "printf worker-ok" }, { id: "call-abort" })], {
						stopReason: "toolUse",
					}),
				],
				{ onPermission: "escalate", escalation: { timeoutMs: 5_000, fallback: "deny" } },
			);
			try {
				const handle = startWorkerRun(input, (event) => events.push(event));
				const escalated = await waitFor(
					() => permissionEvent(events, "clio_permission_escalated"),
					"worker did not emit clio_permission_escalated",
				);
				await expectPending(handle.promise, "worker run");

				handle.abort();
				await handle.promise;
				const resolved = permissionEvent(events, "clio_permission_resolved");

				strictEqual(resolved?.payload?.requestId, escalated.payload?.requestId);
				strictEqual(resolved?.payload?.source, "operator");
				strictEqual(resolved?.payload?.decision, "denied");
				strictEqual(resolved?.payload?.mode, "escalate");
				ok(String(resolved?.payload?.reason ?? "").includes("run aborted"));
			} finally {
				unregister();
			}
		});

		it("system_modify escalation carries the builtin confirm rail axis", async () => {
			const events: unknown[] = [];
			const { input, unregister } = fauxRuntimeInput(
				[
					fauxAssistantMessage([fauxToolCall("bash", { command: "sudo whoami" }, { id: "call-system-modify" })], {
						stopReason: "toolUse",
					}),
				],
				{ autonomy: "full-auto", onPermission: "escalate", escalation: { timeoutMs: 5_000, fallback: "deny" } },
			);
			try {
				const handle = startWorkerRun(input, (event) => events.push(event));
				const escalated = await waitFor(
					() => permissionEvent(events, "clio_permission_escalated"),
					"worker did not emit clio_permission_escalated",
				);
				await expectPending(handle.promise, "worker run");

				strictEqual(escalated.payload?.axis, "net:system-modify-confirm");
				strictEqual(escalated.payload?.tool, "bash");
				const decision = escalated.payload?.decision as Record<string, unknown> | undefined;
				strictEqual(decision?.actionClass, "system_modify");
				strictEqual(decision?.reasonCode, "system-modify-confirm");
				strictEqual(decision?.ruleId, "system-modify-confirm");
				strictEqual(decision?.policySource, "builtin-classifier");

				handle.abort();
				await handle.promise;
			} finally {
				unregister();
			}
		});

		it("approve decision releases the parked call and the worker run continues", async () => {
			const events: unknown[] = [];
			const { input, unregister } = fauxRuntimeInput(
				[
					fauxAssistantMessage([fauxToolCall("bash", { command: "printf worker-ok" }, { id: "call-approve" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("approved and continued"),
				],
				{ onPermission: "escalate", escalation: { timeoutMs: 5_000, fallback: "deny" } },
			);
			try {
				const handle = permissionHandle(startWorkerRun(input, (event) => events.push(event)));
				const escalated = await waitFor(
					() => permissionEvent(events, "clio_permission_escalated"),
					"worker did not emit clio_permission_escalated",
				);
				const requestId = escalated.payload?.requestId;
				strictEqual(typeof requestId, "string");

				handle.resolvePermission(requestId as string, "approve");
				const result = await handle.promise;
				const resolved = permissionEvent(events, "clio_permission_resolved");

				strictEqual(result.exitCode, 0);
				strictEqual(resolved?.payload?.requestId, requestId);
				strictEqual(resolved?.payload?.source, "operator");
				strictEqual(resolved?.payload?.decision, "approved");
				strictEqual(toolFinish(events)?.outcome, "ok");
			} finally {
				unregister();
			}
		});

		it("deny decision resolves with the same structured denial shape as posture deny", async () => {
			const baselineEvents: unknown[] = [];
			const baseline = fauxRuntimeInput(
				[
					fauxAssistantMessage([fauxToolCall("bash", { command: "printf worker-ok" }, { id: "call-deny-baseline" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("baseline continued"),
				],
				{ onPermission: "deny" },
			);
			try {
				await startWorkerRun(baseline.input, (event) => baselineEvents.push(event)).promise;
			} finally {
				baseline.unregister();
			}

			const escalatedEvents: unknown[] = [];
			const escalated = fauxRuntimeInput(
				[
					fauxAssistantMessage([fauxToolCall("bash", { command: "printf worker-ok" }, { id: "call-deny" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("denied and continued"),
				],
				{ onPermission: "escalate", escalation: { timeoutMs: 5_000, fallback: "deny" } },
			);
			try {
				const handle = permissionHandle(startWorkerRun(escalated.input, (event) => escalatedEvents.push(event)));
				const request = await waitFor(
					() => permissionEvent(escalatedEvents, "clio_permission_escalated"),
					"worker did not emit clio_permission_escalated",
				);
				const requestId = request.payload?.requestId;
				strictEqual(typeof requestId, "string");
				handle.resolvePermission(requestId as string, "deny");
				const result = await handle.promise;

				const baselineFinish = toolFinish(baselineEvents);
				const escalatedFinish = toolFinish(escalatedEvents);
				strictEqual(result.exitCode, 0);
				strictEqual(escalatedFinish?.outcome, "blocked");
				strictEqual(escalatedFinish?.decision, baselineFinish?.decision);
				strictEqual(escalatedFinish?.actionClass, baselineFinish?.actionClass);
				ok(String(escalatedFinish?.reason ?? "").includes("permission denied"));
				const resolved = permissionEvent(escalatedEvents, "clio_permission_resolved");
				strictEqual(resolved?.payload?.requestId, requestId);
				strictEqual(resolved?.payload?.source, "operator");
			} finally {
				escalated.unregister();
			}
		});

		it("operator deny resolves one escalation and lets the next request escalate", async () => {
			const events: unknown[] = [];
			const { input, unregister } = fauxRuntimeInput(
				[
					fauxAssistantMessage(
						[
							fauxToolCall("bash", { command: "printf worker-one" }, { id: "call-deny-one" }),
							fauxToolCall("bash", { command: "printf worker-two" }, { id: "call-deny-two" }),
						],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("queued decisions continued"),
				],
				{ onPermission: "escalate", escalation: { timeoutMs: 5_000, fallback: "deny" } },
			);
			try {
				const handle = permissionHandle(startWorkerRun(input, (event) => events.push(event)));
				const first = await waitFor(
					() => permissionEvents(events, "clio_permission_escalated")[0],
					"worker did not emit first clio_permission_escalated",
				);
				const firstRequestId = first.payload?.requestId;
				strictEqual(typeof firstRequestId, "string");

				handle.resolvePermission(firstRequestId as string, "deny");
				const second = await waitFor(
					() =>
						permissionEvents(events, "clio_permission_escalated").find(
							(event) => event.payload?.requestId !== firstRequestId,
						),
					"worker did not emit second clio_permission_escalated",
				);
				const secondRequestId = second.payload?.requestId;
				strictEqual(typeof secondRequestId, "string");
				handle.resolvePermission(secondRequestId as string, "approve");
				const result = await handle.promise;
				const resolved = permissionEvents(events, "clio_permission_resolved");
				const finishes = toolFinishes(events);

				strictEqual(result.exitCode, 0);
				strictEqual(resolved.length, 2);
				strictEqual(resolved[0]?.payload?.requestId, firstRequestId);
				strictEqual(resolved[0]?.payload?.decision, "denied");
				strictEqual(resolved[0]?.payload?.source, "operator");
				strictEqual(resolved[1]?.payload?.requestId, secondRequestId);
				strictEqual(resolved[1]?.payload?.decision, "approved");
				strictEqual(resolved[1]?.payload?.source, "operator");
				strictEqual(finishes.map((finish) => finish.outcome).join(","), "blocked,ok");
			} finally {
				unregister();
			}
		});

		it("timeout applies the configured fail fallback and reports source timeout", async () => {
			const events: unknown[] = [];
			const { input, unregister } = fauxRuntimeInput(
				[
					fauxAssistantMessage([fauxToolCall("bash", { command: "printf worker-ok" }, { id: "call-timeout" })], {
						stopReason: "toolUse",
					}),
				],
				{ onPermission: "escalate", escalation: { timeoutMs: 25, fallback: "fail" } },
			);
			try {
				const handle = startWorkerRun(input, (event) => events.push(event));
				const escalated = await waitFor(
					() => permissionEvent(events, "clio_permission_escalated"),
					"worker did not emit clio_permission_escalated",
				);
				const result = await handle.promise;
				const resolved = permissionEvent(events, "clio_permission_resolved");

				strictEqual(result.exitCode, 3);
				strictEqual(resolved?.payload?.requestId, escalated.payload?.requestId);
				strictEqual(resolved?.payload?.source, "timeout");
				strictEqual(resolved?.payload?.mode, "fail");
			} finally {
				unregister();
			}
		});

		it("drops unknown and duplicate permission decisions without crashing the worker", async () => {
			const events: unknown[] = [];
			const { input, unregister } = fauxRuntimeInput(
				[
					fauxAssistantMessage([fauxToolCall("bash", { command: "printf worker-ok" }, { id: "call-duplicates" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("duplicate decisions ignored"),
				],
				{ onPermission: "escalate", escalation: { timeoutMs: 5_000, fallback: "deny" } },
			);
			try {
				const handle = permissionHandle(startWorkerRun(input, (event) => events.push(event)));
				const escalated = await waitFor(
					() => permissionEvent(events, "clio_permission_escalated"),
					"worker did not emit clio_permission_escalated",
				);
				const requestId = escalated.payload?.requestId;
				strictEqual(typeof requestId, "string");

				handle.resolvePermission("unknown-request", "approve");
				handle.resolvePermission(requestId as string, "approve");
				handle.resolvePermission(requestId as string, "deny");
				const result = await handle.promise;

				strictEqual(result.exitCode, 0);
				strictEqual(events.filter((event) => (event as { type?: unknown }).type === "clio_permission_resolved").length, 1);
			} finally {
				unregister();
			}
		});
	});

	describe("spawned worker send", () => {
		it("delivers a steer line to the child stdin and reports false after exit", async () => {
			const scratch = mkdtempSync(join(tmpdir(), "clio-steer-transport-"));
			const stubEntry = join(scratch, "stub-entry.js");
			// Reads the spec line, echoes the next stdin line back as an event,
			// then exits. Models a worker consuming a steer mid-run.
			writeFileSync(
				stubEntry,
				`
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
let sawSpec = false;
rl.on("line", (line) => {
	if (!sawSpec) { sawSpec = true; return; }
	process.stdout.write(JSON.stringify({ type: "stub_echo", line: JSON.parse(line) }) + "\\n");
	process.exit(0);
});
`,
			);
			chmodSync(stubEntry, 0o755);
			try {
				const worker = spawnNativeWorker(
					{
						specVersion: WORKER_SPEC_VERSION,
						systemPrompt: "",
						agentId: "coder",
						task: "t",
						target: { id: "e", runtime: "x" } as never,
						runtime: {
							version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
							id: "x",
							kind: "http",
							apiFamily: "openai-responses",
							auth: "none",
						},
						runtimeId: "x",
						wireModelId: "m",
						allowedTools: ["bash"],
					} as never,
					{ workerEntryPath: stubEntry },
				);

				ok(worker.send, "spawnNativeWorker must expose send");
				strictEqual(worker.send?.({ type: "steer", text: "pivot now" }), true);

				const events: unknown[] = [];
				for await (const ev of worker.events) events.push(ev);
				const exit = await worker.promise;
				strictEqual(exit.exitCode, 0);
				const echo = events.find(
					(ev) => !!ev && typeof ev === "object" && (ev as { type?: unknown }).type === "stub_echo",
				) as { line?: unknown } | undefined;
				deepStrictEqual(echo?.line, { type: "steer", text: "pivot now" });

				strictEqual(worker.send?.({ type: "steer", text: "too late" }), false);
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		});
	});

	describe("dispatch contract steer", () => {
		beforeEach(isolateDispatchState);
		afterEach(restoreDispatchState);

		it("forwards a trimmed steer line to the active native worker", async () => {
			const context = stubContext();
			const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
			const sent: unknown[] = [];

			const bundle = makeDispatchBundle(context, {
				spawnWorker: () => ({
					pid: 9999,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
					send: (value: unknown) => {
						sent.push(value);
						return true;
					},
				}),
			});

			await bundle.extension.start();
			try {
				const handle = await bundle.contract.dispatch({ agentId: "coder", task: "steerable" });
				bundle.contract.steer(handle.runId, "  focus on tests/  ");
				deepStrictEqual(sent, [{ type: "steer", text: "focus on tests/" }]);
				exit.resolve({ exitCode: 0, signal: null });
				await handle.finalPromise;
			} finally {
				await bundle.extension.stop?.();
			}
		});

		it("rejects steers for unknown runs, finished runs, empty text, and dead stdin", async () => {
			const context = stubContext();
			const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
			let sendAlive = true;

			const bundle = makeDispatchBundle(context, {
				spawnWorker: () => ({
					pid: 9999,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
					send: () => sendAlive,
				}),
			});

			await bundle.extension.start();
			try {
				throws(() => bundle.contract.steer("no-such-run", "hello"), /not active/);

				const handle = await bundle.contract.dispatch({ agentId: "coder", task: "lifecycle" });
				throws(() => bundle.contract.steer(handle.runId, "   "), /empty message/);

				sendAlive = false;
				throws(() => bundle.contract.steer(handle.runId, "hello"), /no longer accepts input/);

				exit.resolve({ exitCode: 0, signal: null });
				await handle.finalPromise;
				throws(() => bundle.contract.steer(handle.runId, "hello"), /not active/);
			} finally {
				await bundle.extension.stop?.();
			}
		});

		it("rejects steers for runs whose handle has no input channel", async () => {
			const context = stubContext();
			const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();

			const bundle = makeDispatchBundle(context, {
				spawnWorker: () => ({
					pid: 9999,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				}),
			});

			await bundle.extension.start();
			try {
				const handle = await bundle.contract.dispatch({ agentId: "coder", task: "channel-less" });
				throws(() => bundle.contract.steer(handle.runId, "hello"), /no input channel/);
				exit.resolve({ exitCode: 0, signal: null });
				await handle.finalPromise;
			} finally {
				await bundle.extension.stop?.();
			}
		});
	});
});
