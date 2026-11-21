import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { type HeadlessShutdownHooks, runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { withTelemetryContext } from "../../src/core/telemetry/context.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { DispatchPreparationOptions, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { readGateDecisionArtifacts } from "../../src/domains/dispatch/gate-decisions.js";
import { readRunResultFacts } from "../../src/domains/dispatch/run-result-facts.js";
import type { RunLineage } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker, SpawnedWorkerResult, WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import { telemetryRunDirectory } from "../../src/domains/telemetry/paths.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import { createRegistry, type ToolInvokeOptions } from "../../src/tools/registry.js";
import { makeDispatchBundle, observedCheckEvents, observedReadEvents } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { readRunJournal } from "../harness/run-journal.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
let previousCwd: string;
/** The packet ids the stub reviewer's and judge's checks cite; null for a verdict that cites none (M10). */
const verdictCites: { value: string[] | null } = { value: ["s1.handback"] };
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
async function fixture(
	transientFailure = false,
	spawn?: (spec: WorkerSpec) => SpawnedWorker,
	journalRunEvents = false,
) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = "fixture";
	settings.chat.model = "fixture-model";
	settings.safety.autonomy = "yolo";
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
	context.bus.subscribe("run.completed", (event) => {
		completed.set(event.runId, event.lineage);
	});
	let starts = 0;
	const bundle = makeDispatchBundle(context, {
		journalRunEvents,
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
					const checks = [
						{
							name: "npm test",
							passed: true,
							evidence: "exit 0",
							...(verdictCites.value !== null ? { cites: verdictCites.value } : {}),
						},
					];
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
					// A review gate only counts a pass from a reviewer that inspected something, and a
					// read-scoped scout that executed no tool seals failed (FX-19).
					if (spec.agentId === "verifier" || spec.agentId === "scout") {
						for (const event of observedReadEvents("input.txt")) yield event;
					}
					// A reviewer's claimed check must be one it ran (cited-evidence, fleet design 4.8).
					if (spec.agentId === "verifier") for (const event of observedCheckEvents()) yield event;
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
		getAgentSpecs: () => context.getContract("agents")?.listSpecs() ?? [],
		getAutonomy: () => "yolo",
	});
	const safety = context.getContract("safety");
	ok(safety);
	const registry = createRegistry({ safety, autonomy: () => "yolo" });
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
		providers: f.context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set(["fixture"]),
		toolRegistry: f.registry,
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			const handle = createEngineAgent(options);
			const state = handle.agent.state;
			let listener: ((event: AgentEvent, signal: AbortSignal) => void | Promise<void>) | undefined;
			handle.agent.subscribe = (callback) => {
				listener = callback;
				return () => {};
			};
			handle.agent.prompt = async () => {
				// The engine opens every prompt with agent_start before any tool runs.
				await listener?.({ type: "agent_start" } as AgentEvent, new AbortController().signal);
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
				await listener?.({ type: "message_end", message }, new AbortController().signal);
			};
			return handle;
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	try {
		const ids: string[] = [];
		const workerIds: string[] = [];
		let runningPids: Array<number | null> = [];
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
				: async () => {
						const rows = [...(readRunJournal(join(env.dir, "state"))?.envelopes.values() ?? [])];
						runningPids = rows
							.filter((run) => run.agentId === "main-agent" && run.status === "running")
							.map((run) => run.pid);
					};
			const code = await runHeadlessMainAgent(loop, { prompt: `Inspect ${interrupted}`, shutdown });
			await drain?.();
			strictEqual(code, interrupted ? 143 : 0);
			// C-13: while its settled child pointed at it, the parent had a running row with this process's pid.
			if (!interrupted) deepStrictEqual(runningPids, [process.pid]);
			const journal = readRunJournal(join(env.dir, "state"));
			ok(journal);
			const mains = [...journal.envelopes.values()].filter((run) => run.agentId === "main-agent");
			strictEqual(mains.length, ids.length + 1, "drain and completion seal the same identity once");
			const main = mains.find((receipt) => !ids.includes(receipt.id));
			ok(main);
			const worker = journal.runs.find(
				(receipt) => receipt.settled.agentId === "scout" && !workerIds.includes(receipt.row.runId),
			);
			ok(worker);
			deepStrictEqual(journal.envelopes.get(worker.row.runId)?.lineage, {
				parentRunId: main.id,
				rootRunId: main.id,
				depth: 1,
				attempt: 0,
			});
			ids.push(main.id);
			workerIds.push(worker.row.runId);
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
			const result = await withTelemetryContext(
				{ sessionId: "lineage-test", agent: { role: "main", id: "lineage-test" } },
				() => f.tool.run(args, { hostRun, toolCallId: "call-trusted" } as ToolInvokeOptions),
			);
			strictEqual(result.kind, "ok", JSON.stringify(result).slice(0, 1200));
			strictEqual(f.captured.length, mode === "single" ? 1 : mode === "parallel" || mode === "review" ? 2 : 3);
			for (const request of f.captured)
				strictEqual(request.lineage, undefined, "host ancestry cannot change assignment admission");
			if (mode === "council") {
				const synthesis = f.captured.find((request) => request.gate?.role === "synthesis");
				strictEqual(synthesis?.agentId, "oracle", "an unpinned council judge is never the seated agent");
			}
			for (const preparation of f.preparations) deepStrictEqual(preparation?.hostRun, hostRun);
			const journal = readRunJournal(join(env.dir, "state"));
			ok(journal);
			for (const receipt of journal.runs) {
				const envelope = journal.envelopes.get(receipt.row.runId);
				ok(envelope);

				deepStrictEqual(journal.envelopes.get(receipt.row.runId)?.lineage, childLineage, receipt.settled.agentId);
				deepStrictEqual(f.completed.get(receipt.row.runId), childLineage, receipt.settled.agentId);
			}
		} finally {
			await f.bundle.extension.stop?.();
		}
	});
}

for (const cites of [true, false]) {
	it(`a reviewer receives the builder's evidence packet with ids, and a verdict ${cites ? "citing it passes" : "citing none is exhausted"} (M10)`, {
		timeout: 30_000,
	}, async () => {
		verdictCites.value = cites ? ["s1.handback", "s1.diff"] : null;
		const f = await fixture();
		try {
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
					"base",
				],
			])
				execFileSync("git", args, { stdio: "pipe" });
			writeFileSync("input.txt", "fixture evidence, edited\n");
			const result = await withTelemetryContext(
				{ sessionId: "packet-test", agent: { role: "main", id: "packet-test" } },
				() =>
					f.tool.run({
						agent: "scout",
						task: "Inspect input.txt",
						cwd: process.cwd(),
						review: { reviewer: "verifier", maxCycles: 1 },
					}),
			);
			const reviewer = f.captured.find((request) => request.gate?.role === "reviewer");
			deepStrictEqual(reviewer?.gate?.packet?.ids, ["s1.handback", "s1.diff"]);
			match(reviewer?.task ?? "", /Packet ids: s1\.handback, s1\.diff/u);
			const subject = JSON.parse((reviewer?.task ?? "").split("\n\n").at(-1) ?? "{}");
			// The builder's closed write record names no path, so the operator's own edit is not its diff.
			strictEqual(subject.diff.scope, "attributed-paths");
			strictEqual(subject.diff.stat, "no changes");
			strictEqual(subject.diff.patch, "");
			const decision = readGateDecisionArtifacts().find(({ artifact }) => artifact.topology === "review")?.artifact;
			strictEqual(decision?.outcome, cites ? "pass" : "exhausted", JSON.stringify(result).slice(0, 1500));
			match(
				decision?.detail ?? "",
				cites ? /cites=s1\.handback,s1\.diff/u : /obligation cited-evidence unmet: the verdict cites no item/u,
			);
		} finally {
			verdictCites.value = ["s1.handback"];
			await f.bundle.extension.stop?.();
		}
	});
}

it("a terminal event's readers find the run sealed, with its closing feed rows inside the seal", {
	timeout: 30_000,
}, async () => {
	const f = await fixture(false, undefined, true);
	try {
		const seen: Array<{ runId: string; integrity: string | undefined }> = [];
		f.context.bus.subscribe("run.completed", (event) => {
			seen.push({ runId: event.runId, integrity: readRunResultFacts(event.runId)?.trust?.artifactIntegrity.state });
		});
		const result = await f.tool.run({ agent: "scout", task: "Inspect input.txt", cwd: process.cwd() });
		strictEqual(result.kind, "ok");
		strictEqual(seen.length, 1);
		strictEqual(seen[0]?.integrity, "verified");
		const journal = readFileSync(
			join(telemetryRunDirectory(clioStateDir(), seen[0]?.runId ?? ""), "journal.jsonl"),
			"utf8",
		);
		const terminalRow = journal.search(/"k":"run\.feed_appended"[^\n]*"kind":"terminal"/u);
		ok(terminalRow >= 0 && terminalRow < journal.indexOf('"k":"run.sealed"'));
	} finally {
		await f.bundle.extension.stop?.();
	}
});

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
			const attempts = journal.runs
				.filter((receipt) => receipt.settled.agentId === "scout")
				.sort(
					(a, b) =>
						(journal.envelopes.get(a.row.runId)?.lineage?.attempt ?? 0) -
						(journal.envelopes.get(b.row.runId)?.lineage?.attempt ?? 0),
				);
			strictEqual(attempts.length, 2, "the tool waits for both attempts");
			strictEqual(attempts[0]?.settled.outcome, "failed");
			strictEqual(attempts[1]?.settled.outcome, "succeeded");
			const first = attempts[0];
			ok(first);
			const secondAttempt = attempts[1];
			ok(secondAttempt);
			deepStrictEqual(journal.envelopes.get(secondAttempt.row.runId)?.lineage, {
				parentRunId: first.row.runId,
				rootRunId: hosted ? hostRun.lineage.rootRunId : first.row.runId,
				depth: hosted ? 4 : 0,
				attempt: 1,
			});
		} finally {
			await f.bundle.extension.stop?.();
		}
	});
}

function killedWorker(onSpawn: () => void): SpawnedWorker {
	onSpawn();
	return {
		pid: null,
		promise: Promise.resolve({
			exitCode: null,
			signal: "SIGKILL",
			evidenceIncomplete: "the worker was killed before its event stream ended",
		}),
		heartbeatAt: { current: Date.now(), monotonic: performance.now() },
		abort() {},
		events: (async function* () {
			yield { type: "clio_coder_tool_start", payload: { tool: "bash", toolCallId: "call-killed" } };
		})(),
	};
}

function timedOutWorker(onSpawn: () => void): SpawnedWorker {
	onSpawn();
	return {
		pid: null,
		promise: Promise.resolve({ exitCode: 1, signal: null }),
		heartbeatAt: { current: Date.now(), monotonic: performance.now() },
		abort() {},
		events: (async function* () {
			yield { type: "clio_coder_run_outcome", payload: { outcomeCode: "worker_turn_timeout" } };
		})(),
	};
}

function notRetriedRunId(result: { details?: unknown }): string {
	const runId = (result.details as { runs?: Array<{ runId?: string }> } | undefined)?.runs?.[0]?.runId;
	ok(typeof runId === "string", JSON.stringify(result.details).slice(0, 400));
	return runId;
}

// A hosted call is the headless `run` path: the worker's published lineage root names the main run, not the
// assignment, and the not_retried line must still resolve the assignment (bt-45 D3-c).
for (const hosted of [false, true]) {
	const label = hosted ? "hosted" : "direct";
	const invoke = hosted ? ({ hostRun } as ToolInvokeOptions) : undefined;

	it(`a ${label} killed worker whose retry is suppressed says why it was not retried (D3-c)`, {
		timeout: 15_000,
	}, async () => {
		let spawns = 0;
		const f = await fixture(true, () => killedWorker(() => spawns++));
		try {
			const result = await f.tool.run({ agent: "coder", task: "Fix input.txt", cwd: process.cwd() }, invoke);
			ok(result.kind === "error");
			strictEqual(spawns, 1, "the retry is suppressed");
			const runId = notRetriedRunId(result);
			ok(
				result.message.includes(
					`not_retried ${runId}: automatic retry suppressed because incomplete tool telemetry cannot prove`,
				),
				result.message.slice(0, 1500),
			);
			match(result.message, /work=calls:0 .* unfinished:1/u);
		} finally {
			await f.bundle.extension.stop?.();
		}
	});

	it(`a ${label} worker that timed out with no detail names the retry policy (D3-c)`, { timeout: 15_000 }, async () => {
		let spawns = 0;
		const f = await fixture(true, () => timedOutWorker(() => spawns++));
		try {
			const result = await f.tool.run({ agent: "coder", task: "Fix input.txt", cwd: process.cwd() }, invoke);
			ok(result.kind === "error");
			strictEqual(spawns, 1, "a timeout is not retried");
			const runId = notRetriedRunId(result);
			ok(
				result.message.includes(
					`not_retried ${runId}: the host did not retry this failed run (worker_turn_timeout); 0 of maxRetries`,
				),
				result.message.slice(0, 1500),
			);
		} finally {
			await f.bundle.extension.stop?.();
		}
	});

	for (const path of ["review", "pipeline"] as const) {
		it(`a ${label} ${path === "review" ? "review gate" : "pipeline halt"} says why its failed run was not retried (D3-c)`, {
			timeout: 15_000,
		}, async () => {
			let spawns = 0;
			const f = await fixture(true, () => killedWorker(() => spawns++));
			try {
				const result = await withTelemetryContext(
					{ sessionId: "not-retried-test", agent: { role: "main", id: "not-retried-test" } },
					() =>
						f.tool.run(
							{
								agent: "coder",
								cwd: process.cwd(),
								...(path === "review"
									? { task: "Fix input.txt", review: { reviewer: "verifier", maxCycles: 1 } }
									: { mode: "pipeline", tasks: ["Fix input.txt", "Check input.txt"] }),
							},
							invoke,
						),
				);
				ok(result.kind === "error");
				ok(
					result.message.includes(path === "review" ? "review gate needs an operator decision" : "pipeline dispatch halted"),
					result.message.slice(0, 800),
				);
				strictEqual(spawns, 1, "the retry is suppressed and nothing runs after the failure");
				const runId = notRetriedRunId(result);
				ok(
					result.message.includes(
						`not_retried ${runId}: automatic retry suppressed because incomplete tool telemetry cannot prove`,
					),
					result.message.slice(0, 1500),
				);
			} finally {
				await f.bundle.extension.stop?.();
			}
		});
	}

	it(`a ${label} failure the host never retries still says why it was not retried (D3-c)`, {
		timeout: 15_000,
	}, async () => {
		let spawns = 0;
		const f = await fixture(true, () => {
			spawns++;
			return {
				pid: null,
				promise: Promise.resolve({ exitCode: 1, signal: null, stderrTail: "[worker] fatal: workerspec rejected" }),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort() {},
				events: (async function* () {})(),
			};
		});
		try {
			const result = await f.tool.run({ agent: "scout", task: "Inspect input.txt", cwd: process.cwd() }, invoke);
			ok(result.kind === "error");
			strictEqual(spawns, 1, "a deterministic failure is not retried");
			const runId = notRetriedRunId(result);
			ok(
				result.message.includes(`not_retried ${runId}: the host did not retry this failed run`),
				result.message.slice(0, 1500),
			);
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
			if (result.exitCode === 0) for (const event of observedReadEvents("input.txt")) yield event;
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
		// A background collect shows the failed attempt behind the retry, as a foreground result does (FL-9).
		if (collected.kind === "ok") {
			match(collected.output, /^collect complete .* recovered=1$/mu);
			match(collected.output, new RegExp(`^recovered ${retry.runId} after attempt 0 ${first} failed: `, "mu"));
		}
		strictEqual(collected.details?.recoveredCount, 1);
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
	settings.safety.autonomy = "yolo";
	settings.fleet.retry.maxRetries = 0;
	settings.integrations.externalAgents.entries = [
		{ id: "lineage-fixture", command: process.execPath, args: ["-e", ACP_PEER], toolGovernance: "clio-coder-policy" },
	];
	const context = dispatchStubContext({ settings });
	let completed: RunLineage | undefined;
	context.bus.subscribe("run.completed", (event) => {
		completed = event.lineage;
	});
	const bundle = makeDispatchBundle(context);
	await bundle.extension.start();
	try {
		const tool = createDispatchTool({
			dispatch: bundle.contract,
			getAgentSpecs: () => context.getContract("agents")?.listSpecs() ?? [],
			getAutonomy: () => "yolo",
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
		strictEqual(journal.runs.length, 1);
		const receipt = journal.runs[0];
		ok(receipt);
		strictEqual(receipt.settled.route.runtimeKind, "acp-delegation");
		// Clio cannot hold a peer to a permit, so the sealed one is marked record-only.
		deepStrictEqual(journal.envelopes.get(receipt.row.runId)?.lineage, childLineage);
		deepStrictEqual(journal.envelopes.get(receipt.row.runId)?.lineage, childLineage);
		deepStrictEqual(completed, childLineage);
		strictEqual(bundle.contract.assignments?.getStored(receipt.row.runId)?.assignmentId, receipt.row.runId);
	} finally {
		await bundle.extension.stop?.();
	}
});
