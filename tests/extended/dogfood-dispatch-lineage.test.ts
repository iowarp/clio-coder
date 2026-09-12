import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { type HeadlessShutdownHooks, runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { DispatchPreparationOptions, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { reduceRouteQuality } from "../../src/domains/dispatch/route-quality.js";
import type { RunLineage } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker, SpawnedWorkerResult, WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { readRunJournal } from "../../src/domains/eval/metrics/invariants.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/interactive/chat-loop.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import { createRegistry, type ToolInvokeOptions } from "../../src/tools/registry.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("dog-lineage-");
	previousCwd = process.cwd();
	const project = join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
	writeFileSync("input.txt", "fixture evidence\n");
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

// Both the main provider and worker process are deterministic seams. All chat
// submission, agent-tool adaptation, registry admission, dispatch planning,
// worker lifecycle and durable receipt code remain production implementations.
async function fixture(transientFailure = false, spawn?: (spec: WorkerSpec) => SpawnedWorker) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = "fixture";
	settings.chat.model = "fixture-model";
	settings.safety.autonomy = "full-auto";
	settings.fleet.retry.maxRetries = transientFailure ? 1 : 0;
	settings.targets = [{ id: "fixture", runtime: "fixture", defaultModel: "fixture-model" }];
	settings.fleet.default = { target: "fixture", model: "fixture-model", thinkingLevel: "off" };
	settings.fleet.profiles = {};
	const capabilities = { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 131072, maxTokens: 4096 };
	const runtime: RuntimeDescriptor = {
		id: "fixture",
		displayName: "Fixture",
		kind: "http",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: capabilities,
		synthesizeModel: () => ({
			id: "fixture-model",
			name: "Fixture",
			api: "openai-completions",
			provider: "fixture",
			baseUrl: "https://fixture.invalid",
			reasoning: false,
			input: ["text"],
			contextWindow: 131072,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}),
	};
	const context = dispatchStubContext({ settings, runtime });
	const captured: DispatchRequest[] = [];
	const preparations: Array<DispatchPreparationOptions | undefined> = [];
	const completed = new Map<string, RunLineage | undefined>();
	context.bus.on(BusChannels.DispatchCompleted, (event) => {
		completed.set(event.runId, event.lineage);
	});
	let starts = 0;
	const bundle = makeDispatchBundle(context, {
		spawnWorker: (spec): SpawnedWorker => {
			if (spawn !== undefined) return spawn(spec);
			const fail = transientFailure && starts++ === 0;
			return {
				pid: null,
				promise: Promise.resolve({
					exitCode: fail ? 1 : 0,
					signal: null,
					...(fail ? { stderrTail: "HTTP 503 Service Unavailable" } : {}),
				}),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort() {},
				events: (async function* () {
					if (fail) return;
					const checks = [{ name: "fixture", passed: true, evidence: "input.txt:1" }];
					const answer = spec.task.startsWith("Synthesize the council")
						? { verdict: "supported", text: "fixture synthesis" }
						: spec.agentId === "verifier"
							? spec.systemPrompt.includes("ranking candidate")
								? { winner: 1, checks }
								: { verdict: "pass", checks }
							: {
									findings: [{ claim: "fixture evidence", path: "input.txt", line: 1 }],
									needsSplit: false,
									proposedSubtasks: [],
								};
					yield { type: "message_end", message: { role: "assistant", stopReason: "stop", content: JSON.stringify(answer) } };
				})(),
			};
		},
	});
	await bundle.extension.start();
	const tool = createDispatchTool({
		dispatch: {
			...bundle.contract,
			dispatch: (request, ...args) => {
				captured.push(structuredClone(request));
				preparations.push(structuredClone(args[1]));
				return bundle.contract.dispatch(request, ...args);
			},
			dispatchBatch: (requests, ...args) => {
				captured.push(...structuredClone(requests));
				preparations.push(...requests.map(() => structuredClone(args[0])));
				return bundle.contract.dispatchBatch(requests, ...args);
			},
		},
		getAgentSpecs: () => context.getContract<AgentsContract>("agents")?.listSpecs() ?? [],
		getAutonomy: () => "full-auto",
	});
	const safety = context.getContract<SafetyContract>("safety");
	ok(safety);
	const registry = createRegistry({ safety, autonomy: () => "full-auto" });
	registry.register(tool);
	return { settings, context, bundle, tool, registry, captured, completed, preparations };
}

it("a worker admitted during main submit points to its eventual receipt; independent turns do not retain the host", {
	timeout: 30_000,
}, async (t) => {
	const reportWrite = process.stdout.write.bind(process.stdout);
	t.mock.method(process.stdout, "write", (chunk: string, callback?: () => void) => {
		if (typeof chunk !== "string") return reportWrite(chunk);
		callback?.();
		return true;
	});
	t.mock.method(process.stderr, "write", () => true);
	const f = await fixture();
	let duringSubmit: (() => Promise<void>) | undefined;
	const loop = createChatLoop({
		getSettings: () => f.settings,
		providers: f.context.getContract<ProvidersContract>("providers") as ProvidersContract,
		knownTargets: () => new Set(["fixture"]),
		toolRegistry: f.registry,
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			const state = options?.initialState;
			ok(state);
			let listener: ((event: AgentEvent) => void) | undefined;
			return {
				agent: {
					state,
					abort() {},
					subscribe: (callback: (event: AgentEvent) => void) => {
						listener = callback;
						return () => {};
					},
					prompt: async () => {
						const dispatch = state.tools?.find((entry) => entry.name === "dispatch");
						ok(dispatch, "the real chat loop must install the admitted dispatch tool");
						const result = await dispatch.execute("fixture-call", {
							agent: "scout",
							task: "Inspect input.txt",
							cwd: process.cwd(),
						});
						strictEqual(result.details.kind, "ok", JSON.stringify(result).slice(0, 1200));
						await duringSubmit?.();
						const message = {
							role: "assistant",
							content: [{ type: "text", text: "Complete" }],
							stopReason: "stop",
							timestamp: Date.now(),
						} as AgentMessage;
						state.messages?.push(message);
						listener?.({ type: "message_end", message });
					},
				},
			};
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	try {
		const ids: string[] = [];
		const workerIds: string[] = [];
		for (const interrupted of [false, true]) {
			let drain: (() => void | Promise<void>) | undefined;
			const shutdown: HeadlessShutdownHooks = {
				onDrain: (hook) => {
					drain = hook;
				},
				getExitCode: () => (interrupted ? 143 : 0),
				isShuttingDown: () => interrupted,
			};
			duringSubmit = interrupted
				? async () => {
						await drain?.();
					}
				: undefined;
			const code = await runHeadlessMainAgent(loop, { prompt: `Inspect ${interrupted}`, shutdown });
			await drain?.();
			strictEqual(code, interrupted ? 143 : 0);
			const journal = readRunJournal(join(env.dir, "state"));
			ok(journal);
			const mains = journal.receipts.filter((receipt) => receipt.agentId === "main-agent");
			strictEqual(mains.length, ids.length + 1, "drain and completion seal the same identity once");
			const main = mains.find((receipt) => !ids.includes(receipt.runId));
			ok(main);
			const worker = journal.receipts.find((receipt) => receipt.agentId === "scout" && !workerIds.includes(receipt.runId));
			ok(worker);
			deepStrictEqual(worker.lineage, { parentRunId: main.runId, rootRunId: main.runId, depth: 1, attempt: 0 });
			deepStrictEqual(journal.envelopes.get(worker.runId)?.lineage, worker.lineage);
			ids.push(main.runId);
			workerIds.push(worker.runId);
		}
		notStrictEqual(ids[0], ids[1]);
		duringSubmit = undefined;
		await loop.submit("An independent interactive turn");
		strictEqual(f.captured.at(-1)?.lineage, undefined);
		const direct = f.bundle.contract.listRuns().at(-1);
		ok(direct);
		deepStrictEqual(direct.lineage, { parentRunId: null, rootRunId: direct.id, depth: 0, attempt: 0 });
	} finally {
		loop.dispose();
		await f.bundle.extension.stop?.();
	}
});

const hostRun = {
	runId: "authoritative-parent",
	lineage: { parentRunId: "ancestor", rootRunId: "authoritative-root", depth: 3, attempt: 2 },
};
const childLineage: RunLineage = {
	parentRunId: hostRun.runId,
	rootRunId: hostRun.lineage.rootRunId,
	depth: 4,
	attempt: 0,
};
for (const mode of ["single", "parallel", "review", "compete", "council"] as const) {
	it(`${mode} stamps trusted lineage at admission, including fresh derived requests`, { timeout: 30_000 }, async () => {
		const f = await fixture();
		try {
			if (mode === "compete") {
				for (const args of [
					["init", "-q"],
					["add", "input.txt"],
					[
						"-c",
						"user.name=Fixture",
						"-c",
						"user.email=fixture@example.invalid",
						"-c",
						"core.hooksPath=/dev/null",
						"commit",
						"-qm",
						"fixture baseline",
					],
				])
					execFileSync("git", args, { stdio: "pipe" });
			}
			const args = {
				agent: "scout",
				cwd: process.cwd(),
				...(mode === "parallel" ? { tasks: ["Inspect input.txt", "Check input.txt"] } : { task: "Inspect input.txt" }),
				...(mode === "review" ? { review: { reviewer: "verifier", maxCycles: 1 } } : {}),
				...(mode === "compete" ? { mode, candidates: 2 } : {}),
				...(mode === "council"
					? {
							mode,
							members: [
								{ label: "a", target: "fixture" },
								{ label: "b", target: "fixture" },
							],
							synthesis: "judge",
						}
					: {}),
				lineage: { parentRunId: "forged", rootRunId: "forged", depth: 99, attempt: 99 },
			};
			// Tool options are supplied by the host, independently of model args.
			const result = await f.tool.run(args, { hostRun, toolCallId: "call-trusted" } as ToolInvokeOptions);
			strictEqual(result.kind, "ok", JSON.stringify(result).slice(0, 1200));
			strictEqual(f.captured.length, mode === "single" ? 1 : mode === "parallel" || mode === "review" ? 2 : 3);
			for (const request of f.captured)
				strictEqual(request.lineage, undefined, "host ancestry cannot change assignment admission");
			for (const preparation of f.preparations) deepStrictEqual(preparation?.hostRun, hostRun);
			const journal = readRunJournal(join(env.dir, "state"));
			ok(journal);
			for (const receipt of journal.receipts) {
				const envelope = journal.envelopes.get(receipt.runId);
				ok(envelope);
				strictEqual(verifyReceiptIntegrity(receipt, envelope).ok, true, receipt.agentId);
				deepStrictEqual(receipt.lineage, childLineage, receipt.agentId);
				deepStrictEqual(journal.envelopes.get(receipt.runId)?.lineage, childLineage, receipt.agentId);
				deepStrictEqual(f.completed.get(receipt.runId), childLineage, receipt.agentId);
			}
		} finally {
			await f.bundle.extension.stop?.();
		}
	});
}

it("model tool JSON cannot author lineage, while a trusted retry keeps its existing parent, root, depth and attempt", async () => {
	const f = await fixture();
	try {
		const result = await f.tool.run({
			agent: "scout",
			task: "Inspect input.txt",
			cwd: process.cwd(),
			lineage: childLineage,
			hostRun,
		});
		strictEqual(result.kind, "ok");
		strictEqual(f.captured[0]?.lineage, undefined, "model fields cannot become host authority");
		const retry = { ...childLineage, parentRunId: "previous-attempt", attempt: 1 };
		const run = await f.bundle.contract.dispatch({
			agentId: "scout",
			task: "Inspect input.txt",
			executionRole: "researcher",
			lineage: retry,
			cwd: process.cwd(),
		});
		const receipt = await run.finalPromise;
		deepStrictEqual(receipt.lineage, retry);
		deepStrictEqual(f.bundle.contract.getRun(run.runId)?.lineage, retry);
	} finally {
		await f.bundle.extension.stop?.();
	}
});

for (const hosted of [false, true]) {
	it(`a ${hosted ? "hosted" : "direct"} dispatch still waits for its successful retry`, {
		timeout: 15_000,
	}, async () => {
		const f = await fixture(true);
		try {
			const result = await f.tool.run(
				{ agent: "scout", task: "Inspect input.txt", cwd: process.cwd() },
				hosted ? ({ hostRun } as ToolInvokeOptions) : undefined,
			);
			strictEqual(result.kind, "ok", JSON.stringify(result).slice(0, 1000));
			const journal = readRunJournal(join(env.dir, "state"));
			ok(journal);
			const attempts = journal.receipts
				.filter((receipt) => receipt.agentId === "scout")
				.sort((a, b) => (a.lineage?.attempt ?? 0) - (b.lineage?.attempt ?? 0));
			strictEqual(attempts.length, 2, "the tool waits for both attempts");
			strictEqual(attempts[0]?.outcome, "failed");
			strictEqual(attempts[1]?.outcome, "succeeded");
			const first = attempts[0];
			ok(first);
			deepStrictEqual(attempts[1]?.lineage, {
				parentRunId: first.runId,
				rootRunId: hosted ? hostRun.lineage.rootRunId : first.runId,
				depth: hosted ? 4 : 0,
				attempt: 1,
			});
		} finally {
			await f.bundle.extension.stop?.();
		}
	});
}

function controlledWorker() {
	let finish!: (result: SpawnedWorkerResult) => void;
	let aborts = 0;
	const promise = new Promise<SpawnedWorkerResult>((resolve) => {
		finish = resolve;
	});
	const worker: SpawnedWorker = {
		pid: null,
		promise,
		heartbeatAt: { current: Date.now(), monotonic: performance.now() },
		abort() {
			aborts++;
			finish({ exitCode: null, signal: "SIGTERM" });
		},
		events: (async function* () {
			const result = await promise;
			if (result.exitCode === 0)
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: JSON.stringify({
							findings: [{ claim: "fixture", path: "input.txt", line: 1 }],
							needsSplit: false,
							proposedSubtasks: [],
						}),
					},
				};
		})(),
	};
	return { worker, finish, aborts: () => aborts };
}
async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		ok(Date.now() < deadline, "bounded lifecycle condition did not settle");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
it("detached siblings keep distinct assignments; canceling a completed first attempt cancels only its current retry", {
	timeout: 15000,
}, async () => {
	const workers: ReturnType<typeof controlledWorker>[] = [];
	const f = await fixture(true, () => {
		const worker = controlledWorker();
		workers.push(worker);
		return worker.worker;
	});
	try {
		const started = await f.tool.run(
			{ agent: "scout", tasks: ["Inspect first input.txt", "Inspect second input.txt"], cwd: process.cwd(), detach: true },
			{ hostRun },
		);
		strictEqual(started.kind, "ok", JSON.stringify(started).slice(0, 1000));
		const ids = started.details?.assignmentIds;
		ok(Array.isArray(ids));
		strictEqual(ids.length, 2);
		const [first, second] = ids;
		ok(typeof first === "string" && typeof second === "string");
		notStrictEqual(first, second);
		workers[0]?.finish({ exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" });
		await until(() => workers.length === 3);
		const retry = f.bundle.contract.snapshot().running.find((run) => run.lineage.attempt === 1);
		ok(retry);
		deepStrictEqual(retry.lineage, { ...childLineage, parentRunId: first, attempt: 1 });
		f.bundle.contract.abort(first);
		await until(() => workers[2]?.aborts() === 1);
		strictEqual(workers[1]?.aborts(), 0, "cancel does not affect the sibling sharing the main root");
		workers[1]?.finish({ exitCode: 0, signal: null });
		const monitor = createMonitorTool({ dispatch: f.bundle.contract });
		for (const id of [first, second])
			strictEqual((await monitor.run({ mode: "wait", run_id: id, timeout_ms: 5000 })).kind, "ok");
		await f.bundle.contract.assignments?.flushWrites?.();
		strictEqual(f.bundle.contract.assignments?.getStored(first)?.status, "canceled");
		strictEqual(f.bundle.contract.assignments?.getStored(second)?.status, "succeeded");
		strictEqual(f.bundle.contract.assignments?.getStored(retry.runId)?.assignmentId, first);
		const collected = await monitor.run({ mode: "collect", run_ids: [first, second] });
		strictEqual(collected.kind, "ok");
		const rows = collected.details?.runs;
		ok(Array.isArray(rows));
		deepStrictEqual(
			rows.map((row) => (row as { assignmentId: string }).assignmentId),
			[first, second],
		);
		// A fresh bundle has no ActiveRun or process-local attempt map. Durable
		// attempt records must still resolve the retry, not the shared main root.
		await f.bundle.extension.stop?.();
		const restarted = await fixture();
		try {
			strictEqual(restarted.bundle.contract.assignments?.getStored(retry.runId)?.assignmentId, first);
			const monitorAfterRestart = createMonitorTool({ dispatch: restarted.bundle.contract });
			for (const mode of ["status", "tools", "wait"]) {
				const result = await monitorAfterRestart.run({ mode, run_id: first, timeout_ms: 1000 });
				strictEqual(result.kind, "ok");
				if (result.kind === "ok") ok(result.output.includes(retry.runId), mode);
			}
		} finally {
			await restarted.bundle.extension.stop?.();
		}
	} finally {
		for (const worker of workers) worker.finish({ exitCode: 0, signal: null });
		await f.bundle.extension.stop?.();
	}
});

it("hosted sibling route-history rows retain their own logical assignment links", async () => {
	const f = await fixture();
	try {
		const result = await f.tool.run(
			{ agent: "scout", tasks: ["Inspect first input.txt", "Inspect second input.txt"], cwd: process.cwd() },
			{ hostRun },
		);
		strictEqual(result.kind, "ok");
		await f.bundle.contract.assignments?.flushWrites?.();
		const journal = readRunJournal(join(env.dir, "state"));
		ok(journal);
		const history = JSON.parse(readFileSync(join(env.dir, "state/route-history.json"), "utf8")) as {
			records: Array<{ receiptDigest: string; assignmentId: string }>;
		};
		strictEqual(history.records.length, 2, "digest upserts retain both sibling rows");
		for (const receipt of journal.receipts) {
			const row = history.records.find((row) => row.receiptDigest === receipt.integrity.digest);
			ok(row);
			strictEqual(row.assignmentId, f.bundle.contract.assignments?.getStored(receipt.runId)?.assignmentId);
		}
	} finally {
		await f.bundle.extension.stop?.();
	}
});

it("routing evaluation matches an authenticated hosted attempt to its logical assignment and digest", async () => {
	const f = await fixture();
	try {
		await f.tool.run({ agent: "scout", task: "Inspect input.txt", cwd: process.cwd() }, { hostRun });
		const journal = readRunJournal(join(env.dir, "state"));
		ok(journal);
		const receipt = journal.receipts[0];
		ok(receipt);
		const envelope = journal.envelopes.get(receipt.runId);
		ok(envelope);
		const assignmentId = f.bundle.contract.assignments?.getStored(receipt.runId)?.assignmentId;
		ok(assignmentId);
		for (const scenario of [
			{
				label: "matching assignment and digest",
				explicit: true,
				assignmentId,
				digest: receipt.integrity.digest,
				expected: 1,
			},
			{
				label: "wrong assignment",
				explicit: true,
				assignmentId: hostRun.lineage.rootRunId,
				digest: receipt.integrity.digest,
				expected: 0,
			},
			{ label: "wrong digest", explicit: true, assignmentId, digest: "f".repeat(64), expected: 0 },
			{
				label: "legacy caller retains ancestry fallback",
				explicit: false,
				assignmentId: receipt.lineage?.rootRunId ?? receipt.runId,
				digest: receipt.integrity.digest,
				expected: 1,
			},
		]) {
			const subject = { receipt, envelope, ...(scenario.explicit ? { assignmentId } : {}) };
			const quality = reduceRouteQuality({
				subject,
				receipts: [subject],
				evalArtifacts: [
					{
						digest: "e".repeat(64),
						artifact: {
							version: 4,
							evalId: "fixture",
							results: [{ assignmentId: scenario.assignmentId, terminalReceiptDigest: scenario.digest, pass: true }],
						},
					},
				],
			});
			strictEqual(quality.checks.filter((check) => check.kind === "evaluation").length, scenario.expected, scenario.label);
		}
	} finally {
		await f.bundle.extension.stop?.();
	}
});

// The real ACP adapter owns and closes this JSON-RPC peer on stdio. It never
// loads a provider or inherits a model-authored lineage field.
const ACP_PEER = `
const send = message => process.stdout.write(JSON.stringify({jsonrpc:"2.0",...message})+"\\n");
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
 const request=JSON.parse(line);
 if(request.method==="initialize")send({id:request.id,result:{protocolVersion:1}});
 if(request.method==="session/new")send({id:request.id,result:{sessionId:"lineage-fixture"}});
 if(request.method==="session/prompt"){
  send({method:"session/update",params:{sessionId:"lineage-fixture",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Fixture inspection complete."}}}});
  send({id:request.id,result:{stopReason:"end_turn"}});
 }
});
`;
it("ACP delegation publishes the same trusted host ancestry on its receipt, envelope and completion", {
	timeout: 15000,
}, async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.autonomy = "full-auto";
	settings.fleet.retry.maxRetries = 0;
	settings.integrations.externalAgents.entries = [
		{ id: "lineage-fixture", command: process.execPath, args: ["-e", ACP_PEER], toolGovernance: "clio-coder-policy" },
	];
	const context = dispatchStubContext({ settings });
	let completed: RunLineage | undefined;
	context.bus.on(BusChannels.DispatchCompleted, (event) => {
		completed = event.lineage;
	});
	const bundle = makeDispatchBundle(context);
	await bundle.extension.start();
	try {
		const tool = createDispatchTool({
			dispatch: bundle.contract,
			getAgentSpecs: () => context.getContract<AgentsContract>("agents")?.listSpecs() ?? [],
			getAutonomy: () => "full-auto",
		});
		const result = await tool.run(
			{
				agent: "lineage-fixture",
				task: "Inspect input.txt",
				cwd: process.cwd(),
				budget: { toolCalls: 1000, readReserve: 10 },
			},
			{ hostRun },
		);
		strictEqual(result.kind, "ok", JSON.stringify(result).slice(0, 1000));
		const journal = readRunJournal(join(env.dir, "state"));
		ok(journal);
		strictEqual(journal.receipts.length, 1);
		const receipt = journal.receipts[0];
		ok(receipt);
		strictEqual(receipt.runtimeKind, "acp-delegation");
		deepStrictEqual(receipt.lineage, childLineage);
		deepStrictEqual(journal.envelopes.get(receipt.runId)?.lineage, childLineage);
		deepStrictEqual(completed, childLineage);
		strictEqual(bundle.contract.assignments?.getStored(receipt.runId)?.assignmentId, receipt.runId);
	} finally {
		await bundle.extension.stop?.();
	}
});
