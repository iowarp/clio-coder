import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { listCapacityLeases } from "../../src/domains/dispatch/capacity-lease.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import {
	buildRemoteWorkerCommand,
	buildSshArgs,
	createLocalWorkerTransport,
	createSshWorkerTransport,
	shellQuote,
} from "../../src/domains/dispatch/transport.js";
import type { RunNodeIdentity } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker, SpawnedWorkerResult, WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import type { ProvidersContract, RuntimeDescriptor, TargetStatus } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { WORKER_SPEC_VERSION } from "../../src/worker/spec-contract.js";
import { agentRecipeFixture } from "../harness/agent-recipe.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { type FakeSsh, installFakeSsh } from "../harness/fake-ssh.js";

const TEST_SPEC = {
	specVersion: WORKER_SPEC_VERSION,
	systemPrompt: "",
	agentId: "coder",
	executionRole: "builder",
	task: "transport test",
	target: { id: "default", runtime: "openai", defaultModel: "gpt-4o" },
	runtime: { version: 2, id: "openai", kind: "http", apiFamily: "openai-completions", auth: "api-key" },
	runtimeId: "openai",
	wireModelId: "gpt-4o",
	allowedTools: ["read"],
	budget: { toolCalls: 18, readReserve: 4, synthesis: true, hardCap: 50 },
} as unknown as WorkerSpec;

const SSH_NODE = {
	id: "blade",
	host: "blade.lan",
	user: "ops",
	port: 2222,
	identityFile: "/home/ops/.ssh/id_fleet",
};

async function drain(events: AsyncIterableIterator<unknown>): Promise<unknown[]> {
	const out: unknown[] = [];
	for await (const event of events) out.push(event);
	return out;
}

function eventTypes(events: ReadonlyArray<unknown>): string[] {
	return events.map((event) =>
		typeof event === "object" && event !== null ? String((event as { type?: unknown }).type) : "unknown",
	);
}

describe("ssh argv and remote command construction", () => {
	it("quotes shell words against injection", () => {
		strictEqual(shellQuote("/plain/path"), "'/plain/path'");
		strictEqual(shellQuote("has 'quote'"), `'has '\\''quote'\\'''`);
	});

	it("builds the remote worker command with cwd, env whitelist, and default entry", () => {
		const command = buildRemoteWorkerCommand(SSH_NODE, "/shared/projects/app");
		strictEqual(
			command,
			"cd '/shared/projects/app' && exec env CLIO_RESIDENCY=observe CLIO_WORKER_ANNOUNCE=1 clio worker",
		);
	});

	it("honors per-node residency and clioEntry overrides", () => {
		const command = buildRemoteWorkerCommand(
			{ ...SSH_NODE, residency: "manage", clioEntry: "/opt/clio/bin/clio worker" },
			"/w",
		);
		strictEqual(command, "cd '/w' && exec env CLIO_RESIDENCY=manage CLIO_WORKER_ANNOUNCE=1 /opt/clio/bin/clio worker");
	});

	it("builds non-interactive ssh args with port, identity, and user", () => {
		const args = buildSshArgs(SSH_NODE, "remote-cmd");
		deepStrictEqual(args, [
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			"-T",
			"-p",
			"2222",
			"-i",
			"/home/ops/.ssh/id_fleet",
			"-l",
			"ops",
			"blade.lan",
			"--",
			"remote-cmd",
		]);
	});
});

describe("ssh worker transport channel contract", () => {
	let fake: FakeSsh;

	before(() => {
		fake = installFakeSsh();
	});
	after(() => {
		rmSync(fake.dir, { recursive: true, force: true });
	});
	beforeEach(() => {
		process.env.FAKE_SSH_ARGV_LOG = fake.argvLog;
	});

	function transport(scenario: string, shutdownGraceMs = 500) {
		process.env.FAKE_SSH_SCENARIO = scenario;
		return createSshWorkerTransport(SSH_NODE, { sshBinary: fake.binary, shutdownGraceMs });
	}

	it("spawns, writes the spec, streams events, and filters the announce", async () => {
		const worker = transport("ok").spawn(TEST_SPEC, { cwd: "/shared/projects/app" });
		const before = Date.now();
		const events = await drain(worker.events);
		const result = await worker.promise;
		strictEqual(result.exitCode, 0);
		deepStrictEqual(eventTypes(events), ["message_end"]);
		ok(worker.heartbeatAt.current >= before, "events bump the heartbeat");
		const argvLines = readFileSync(fake.argvLog, "utf8").trim().split("\n");
		const argv = JSON.parse(argvLines[argvLines.length - 1] ?? "[]") as string[];
		ok(argv.includes("-T"));
		ok(argv.includes("blade.lan"));
		match(argv[argv.length - 1] ?? "", /cd '\/shared\/projects\/app' && exec env CLIO_RESIDENCY=observe/);
	});

	it("passes remote exit codes through: 1, 3 (permission required), 2 with stderr tail", async () => {
		const one = transport("exit1").spawn(TEST_SPEC, { cwd: "/w" });
		await drain(one.events);
		strictEqual((await one.promise).exitCode, 1);

		const three = transport("exit3").spawn(TEST_SPEC, { cwd: "/w" });
		await drain(three.events);
		strictEqual((await three.promise).exitCode, 3);

		const two = transport("exit2").spawn(TEST_SPEC, { cwd: "/w" });
		await drain(two.events);
		const result: SpawnedWorkerResult = await two.promise;
		strictEqual(result.exitCode, 2);
		match(result.stderrTail ?? "", /fake runtime exploded/);
	});

	it("fails remote WorkerSpec version skew before accepting execution events", async () => {
		const worker = transport("version-skew").spawn(TEST_SPEC, { cwd: "/w" });
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(result.stderrTail ?? "", /WorkerSpec version mismatch: dispatched 2, worker announced 1/);
	});

	it("rejects a worker announce with no specVersion", async () => {
		const worker = transport("missing-announce-version").spawn(TEST_SPEC, { cwd: "/w" });
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(result.stderrTail ?? "", /WorkerSpec version mismatch: dispatched 2, worker announced undefined/);
	});

	it("fails closed when the first remote protocol event is not an announce", async () => {
		const worker = transport("no-announce-event").spawn(TEST_SPEC, { cwd: "/w" });
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(result.stderrTail ?? "", /Missing worker_announce handshake: first protocol event was message_end/);
	});

	it("fails closed when the remote peer exits cleanly without an announce", async () => {
		const worker = transport("no-announce-exit0").spawn(TEST_SPEC, { cwd: "/w" });
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, null);
		match(result.stderrTail ?? "", /Missing worker_announce handshake: peer exited before announcing specVersion 2/);
	});

	it("round-trips a steer line over the channel", async () => {
		const worker = transport("steer").spawn(TEST_SPEC, { cwd: "/w" });
		ok(worker.send, "ssh transport exposes the stdin line channel");
		strictEqual(worker.send?.({ type: "steer", text: "focus on the tests" }), true);
		const events = await drain(worker.events);
		strictEqual((await worker.promise).exitCode, 0);
		deepStrictEqual(eventTypes(events), ["clio_steer_received", "message_end"]);
		const steer = events[0] as { payload?: { text?: string } };
		strictEqual(steer.payload?.text, "focus on the tests");
	});

	it("round-trips a permission escalation decision", async () => {
		const worker = transport("permission").spawn(TEST_SPEC, { cwd: "/w" });
		const events: unknown[] = [];
		for await (const event of worker.events) {
			events.push(event);
			const type = (event as { type?: unknown }).type;
			if (type === "clio_permission_escalated") {
				strictEqual(worker.send?.({ type: "permission_decision", requestId: "pr-1", decision: "approve" }), true);
			}
		}
		strictEqual((await worker.promise).exitCode, 0);
		deepStrictEqual(eventTypes(events), ["clio_permission_escalated", "clio_permission_resolved"]);
		const resolved = events[1] as { payload?: { requestId?: string; decision?: string } };
		strictEqual(resolved.payload?.requestId, "pr-1");
		strictEqual(resolved.payload?.decision, "approved");
	});

	it("abort closes the channel and the remote parent-monitor exits", async () => {
		const worker = transport("hang").spawn(TEST_SPEC, { cwd: "/w" });
		// Wait for the spec to be consumed (announce is filtered, so poll pid liveness via a short delay).
		await new Promise((resolve) => setTimeout(resolve, 150));
		worker.abort();
		const result = await worker.promise;
		ok(result.exitCode === 0 || result.signal === "SIGTERM", `worker settled (${result.exitCode}/${result.signal})`);
		const events = await drain(worker.events);
		deepStrictEqual(eventTypes(events), []);
	});

	it("escalates a stuck channel to SIGKILL plus a remote kill fallback", async () => {
		const worker = transport("hang-hard", 60).spawn(TEST_SPEC, { cwd: "/w" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		worker.abort();
		const result = await worker.promise;
		strictEqual(result.signal, "SIGKILL");
		// The fallback rides a second ssh invocation carrying a kill command.
		const deadline = Date.now() + 1000;
		let killCommand = "";
		while (Date.now() < deadline && killCommand === "") {
			const lines = readFileSync(fake.argvLog, "utf8").trim().split("\n").filter(Boolean);
			for (const line of lines) {
				const argv = JSON.parse(line) as string[];
				const command = argv[argv.length - 1] ?? "";
				if (command.startsWith("kill -TERM ")) killCommand = command;
			}
			if (killCommand === "") await new Promise((resolve) => setTimeout(resolve, 25));
		}
		ok(killCommand !== "", "remote kill fallback invoked over a second channel");
		match(killCommand, /^kill -TERM \d+/);
	});
});

describe("local worker transport", () => {
	let fake: FakeSsh;

	before(() => {
		fake = installFakeSsh();
	});
	after(() => {
		rmSync(fake.dir, { recursive: true, force: true });
	});

	function localWorker(scenario: string, env: NodeJS.ProcessEnv = process.env): SpawnedWorker {
		return createLocalWorkerTransport({
			workerEntryPath: fake.binary,
			env: {
				...env,
				FAKE_SSH_SCENARIO: scenario,
				FAKE_SSH_ARGV_LOG: fake.argvLog,
			},
		}).spawn(TEST_SPEC, { cwd: fake.dir });
	}

	it("requires and consumes a correct announce before yielding ordinary events", async () => {
		const worker = localWorker("ok");
		const events = await drain(worker.events);
		strictEqual((await worker.promise).exitCode, 0);
		deepStrictEqual(eventTypes(events), ["message_end"]);
		strictEqual(
			events.some((event) => (event as { type?: unknown }).type === "worker_announce"),
			false,
		);
	});

	it("forces CLIO_WORKER_ANNOUNCE=1 over a caller-supplied disabling value", async () => {
		const worker = localWorker("require-announce-env", { ...process.env, CLIO_WORKER_ANNOUNCE: "0" });
		const events = await drain(worker.events);
		strictEqual((await worker.promise).exitCode, 0);
		deepStrictEqual(eventTypes(events), ["message_end"]);
	});

	it("fails closed when the first local protocol event is not announce", async () => {
		const worker = localWorker("no-announce-event");
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(result.stderrTail ?? "", /Missing worker_announce handshake: first protocol event was message_end/);
	});

	it("fails closed when the first local protocol event is malformed JSON", async () => {
		const worker = localWorker("malformed-first-event");
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(result.stderrTail ?? "", /first protocol event was malformed JSON/);
		strictEqual(result.malformedStdoutLines, 1);
	});

	it("fails closed on local announce version mismatch", async () => {
		const worker = localWorker("version-skew");
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(result.stderrTail ?? "", /WorkerSpec version mismatch: dispatched 2, worker announced 1/);
	});

	it("fails closed when the local announce omits specVersion", async () => {
		const worker = localWorker("missing-announce-version");
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(result.stderrTail ?? "", /WorkerSpec version mismatch: dispatched 2, worker announced undefined/);
	});

	it("fails closed when a local worker exits before announce", async () => {
		const worker = localWorker("no-announce-exit0");
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, null);
		match(result.stderrTail ?? "", /Missing worker_announce handshake: peer exited before announcing specVersion 2/);
	});

	it("keeps local stdin steering operational after announce", async () => {
		const worker = localWorker("steer");
		strictEqual(worker.send?.({ type: "steer", text: "focus on local tests" }), true);
		const events = await drain(worker.events);
		strictEqual((await worker.promise).exitCode, 0);
		deepStrictEqual(eventTypes(events), ["clio_steer_received", "message_end"]);
		const steer = events[0] as { payload?: { text?: string } };
		strictEqual(steer.payload?.text, "focus on local tests");
	});

	it("keeps the local transport identity unchanged", () => {
		const transport = createLocalWorkerTransport({ workerEntryPath: fake.binary });
		strictEqual(transport.kind, "local");
		deepStrictEqual(transport.node, { id: "local", kind: "local" });
	});

	it("does not weaken the existing SSH announce contract", async () => {
		const fake = installFakeSsh();
		try {
			process.env.FAKE_SSH_SCENARIO = "ok";
			process.env.FAKE_SSH_ARGV_LOG = fake.argvLog;
			const worker = createSshWorkerTransport(SSH_NODE, { sshBinary: fake.binary }).spawn(TEST_SPEC, { cwd: "/w" });
			const events = await drain(worker.events);
			strictEqual((await worker.promise).exitCode, 0);
			deepStrictEqual(eventTypes(events), ["message_end"]);
		} finally {
			rmSync(fake.dir, { recursive: true, force: true });
		}
	});
});

function fakeSpawnedWorker(events: ReadonlyArray<unknown>, exitCode = 0): SpawnedWorker {
	let settle!: (result: SpawnedWorkerResult) => void;
	const promise = new Promise<SpawnedWorkerResult>((resolve) => {
		settle = resolve;
	});
	const iterator = (async function* () {
		for (const event of events) yield event;
		settle({ exitCode, signal: null });
	})();
	return {
		pid: 4242,
		promise,
		events: iterator,
		abort: () => settle({ exitCode: null, signal: "SIGTERM" }),
		heartbeatAt: { current: Date.now() },
	};
}

function stubContext(): DomainContext {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const target: TargetDescriptor = { id: "default", runtime: "openai", defaultModel: "gpt-4o" };
	settings.targets = [target];
	settings.workers.default.target = target.id;
	settings.workers.default.model = "gpt-4o";
	const runtime: RuntimeDescriptor = {
		id: "openai",
		displayName: "OpenAI",
		kind: "http",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		synthesizeModel: () => ({ id: "gpt-4o", provider: "openai" }) as never,
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
	const providers = {
		list: () => [status],
		getTarget: (id: string) => (id === target.id ? target : null),
		getRuntime: (id: string) => (id === runtime.id ? runtime : null),
		probeAll: async () => {},
		probeAllLive: async () => {},
		probeTarget: async () => status,
		disconnectTarget: () => status,
		auth: {
			statusForTarget: () => ({
				providerId: "openai",
				available: true,
				credentialType: null,
				source: "none",
				detail: null,
			}),
			resolveForTarget: async () => ({
				providerId: "openai",
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
		credentials: { hasKey: () => false, get: () => null, set: () => {}, remove: () => {} },
		getDetectedReasoning: () => null,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
	} satisfies ProvidersContract;
	const config: ConfigContract = { get: () => settings, onChange: () => () => {} };
	const safety: SafetyContract = {
		classify: () => ({ actionClass: "read", reasons: [] }),
		evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset,
		audit: { recordCount: () => 0 },
	};
	const recipes: ReadonlyArray<AgentRecipe> = [
		{
			...agentRecipeFixture(),
			toolRequirements: { required: [], optional: [] },
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
		diagnostics: () => [],
		listSpecs: () => recipes.map(normalizeAgentSpec),
		getSpec: (id) => {
			const recipe = recipes.find((entry) => entry.id === id);
			return recipe ? normalizeAgentSpec(recipe) : null;
		},
		reload: () => {},
	};
	const middleware = createMiddlewareBundle().contract;
	const bus = createSafeEventBus();
	const getContract = ((name: string) => {
		if (name === "config") return config;
		if (name === "safety") return safety;
		if (name === "agents") return agents;
		if (name === "providers") return providers;
		if (name === "middleware") return middleware;
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
		return undefined;
	}) as DomainContext["getContract"];
	return { bus, getContract };
}

describe("dispatch records fleet placement", () => {
	beforeEach(() => {
		isolateDispatchState();
	});
	after(() => {
		restoreDispatchState();
	});

	const NODE: RunNodeIdentity = { id: "blade", kind: "ssh", host: "blade.lan" };

	it("seals node identity and reroute lineage into a verifying receipt", async () => {
		let released = 0;
		const placement: DispatchNodePlacement = {
			node: NODE,
			spawn: () =>
				fakeSpawnedWorker([
					{ type: "message_end", message: { role: "assistant", content: "done", usage: { input: 1, output: 1 } } },
				]),
			release: () => {
				released += 1;
			},
			reroutes: [{ attempt: 1, fromNode: "mini", toNode: "blade", reason: "node mini classified dead" }],
		};
		const bundle = makeDispatchBundle(stubContext(), { resolveNode: () => placement });
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "record node" });
			await drain(handle.events);
			const receipt = await handle.finalPromise;
			deepStrictEqual(receipt.node, NODE);
			deepStrictEqual(receipt.reroutes, [
				{ attempt: 1, fromNode: "mini", toNode: "blade", reason: "node mini classified dead" },
			]);
			const envelope = bundle.contract.getRun(receipt.runId);
			ok(envelope, "ledger row exists");
			deepStrictEqual(envelope?.node, NODE);
			if (envelope) {
				deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
			}
			strictEqual(released, 1, "node capacity released exactly once");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("omits node fields entirely when no placement seam is configured", async () => {
		const bundle = makeDispatchBundle(stubContext(), {
			spawnWorker: () =>
				fakeSpawnedWorker([
					{ type: "message_end", message: { role: "assistant", content: "done", usage: { input: 1, output: 1 } } },
				]),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "no node" });
			await drain(handle.events);
			const receipt = await handle.finalPromise;
			strictEqual("node" in receipt, false);
			strictEqual("reroutes" in receipt, false);
			const envelope = bundle.contract.getRun(receipt.runId);
			if (envelope) deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("releases the durable lease when worker spawn fails after admission", async () => {
		const context = stubContext();
		const baseGet = context.getContract.bind(context);
		const blockedContext: DomainContext = {
			bus: context.bus,
			getContract: ((name: string) => {
				if (name === "scheduling")
					return {
						ceilingUsd: () => 5,
						checkCeiling: () => "under",
						raiseCeiling: () => {},
						preflight: () => ({ verdict: "under", currentUsd: 0, ceilingUsd: 5 }),
						maxWorkers: () => 1,
					};
				return baseGet(name);
			}) as DomainContext["getContract"],
		};
		const bundle = makeDispatchBundle(blockedContext, {
			resolveNode: () => ({
				node: NODE,
				spawn: () => {
					throw new Error("spawn failed");
				},
			}),
		});
		await bundle.extension.start();
		try {
			await rejects(
				bundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "blocked" }),
				/spawn failed/,
			);
			strictEqual(listCapacityLeases().length, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
