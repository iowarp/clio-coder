import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createCliWorkerHooks, workerHookStartupFailure } from "../../src/cli/worker-extension-hooks.js";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { EventPayload } from "../../src/core/telemetry/events.js";
import { validPayload } from "../../src/core/telemetry/events.js";
import { parseAgentRecipeSchema } from "../../src/domains/agents/recipe-schema.js";
import { parseCodeReport } from "../../src/domains/agents/result-contract.js";
import { normalizeAgentSpec, resolveAgentToolCompatibility } from "../../src/domains/agents/spec.js";
import { isDeterministicOutcomeCode } from "../../src/domains/dispatch/backoff.js";
import {
	approvedIdentityForSpec,
	CONTROL_FRAME_PREFIX,
	computeSettingsFingerprint,
	createBoundedEventQueue,
	isControlLine,
	parseControlFrame,
	verifyWorkerAttestation,
	WORKER_BULK_FRAME_MAX_BYTES,
	WORKER_EVENT_QUEUE_HARD_FRAMES,
	WORKER_EVENT_QUEUE_MAX_FRAMES,
	WORKER_EVENT_QUEUE_SOFT_BYTES,
	type WorkerAttestation,
	type WorkerHookRequest,
} from "../../src/domains/dispatch/worker-protocol.js";
import {
	type SpawnedWorker,
	type SpawnedWorkerResult,
	spawnWorkerProcess,
	WORKER_PROCESS_CLEANUP_BOUND_MS,
	type WorkerSpec,
} from "../../src/domains/dispatch/worker-spawn.js";
import { mergeCapabilities } from "../../src/domains/providers/capabilities.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import { workerPermissionCacheKey } from "../../src/engine/worker-runtime.js";
import { projectWorkerEventForStdout } from "../../src/worker/event-projection.js";
import {
	canonicalJson,
	endpointIdentityHash,
	parseBulkFrame,
	toolSignatureOf,
	WORKER_PROTOCOL_VERSION,
	workerSpecDigest,
} from "../../src/worker/protocol.js";
import { createOrderedSteerHandler } from "../../src/worker/stdin-demux.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function recipe() {
	return parseAgentRecipeSchema({
		id: "reviewer",
		source: "project",
		filepath: "/repo/.clio-coder/agents/reviewer.md",
		body: "# Reviewer\nVerify the change.",
		frontmatter: {
			version: 1,
			name: "Reviewer",
			description: "Checks a change.",
			tools: { required: ["read", { anyOf: ["grep", "find"] }], optional: ["verify"] },
			skills: [],
			audience: "custom",
			category: "quality",
			capabilityClass: "verification",
			latencyClass: "fast",
			projectContextTier: "bounded",
			budget: { toolCalls: 8, readReserve: 2, synthesis: true },
			resultContract: { kind: "verifier-report" },
			tags: ["review"],
		},
	});
}

describe("worker boundary", () => {
	it("reuses permission answers only for the exact call and unchanged permission conditions", () => {
		const call = { tool: "bash", args: { command: "custom-check", cwd: "/repo" } };
		const decision: SafetyDecision = {
			kind: "ask",
			classification: { actionClass: "execute", reasons: [] },
			rejection: { short: "approval required", detail: "", hints: [] },
		};
		const key = workerPermissionCacheKey(call, decision, "autonomy:default");
		for (const answer of ["approve", "deny"] as const) {
			const remembered = new Map([[key, answer]]);
			strictEqual(
				remembered.get(
					workerPermissionCacheKey(
						{ tool: "bash", args: { cwd: "/repo", command: "custom-check" } },
						decision,
						"autonomy:default",
					),
				),
				answer,
			);
			for (const changed of [
				workerPermissionCacheKey(call, decision, "net:project-verifier-confirm"),
				workerPermissionCacheKey(call, decision, "autonomy:yolo"),
				workerPermissionCacheKey(
					call,
					{ ...decision, classification: { actionClass: "system_modify", reasons: [] } },
					"autonomy:default",
				),
				workerPermissionCacheKey({ ...call, args: { ...call.args, command: "other-check" } }, decision, "autonomy:default"),
				workerPermissionCacheKey({ ...call, args: { ...call.args, cwd: "/other" } }, decision, "autonomy:default"),
			])
				strictEqual(remembered.has(changed), false);
		}
	});

	it("parses a strict recipe and admits only a compatible tool envelope", () => {
		const spec = normalizeAgentSpec(recipe());
		strictEqual(spec.capabilityClass, "verification");
		deepStrictEqual(spec.tools, ["read", "grep", "find", "verify"]);
		deepStrictEqual(resolveAgentToolCompatibility(spec, ["read", "find"], { mediatesDispatch: true }), {
			compatible: true,
			missingRequired: [],
			lostOptional: ["verify"],
		});
		deepStrictEqual(resolveAgentToolCompatibility(spec, ["read"], { mediatesDispatch: true }), {
			compatible: false,
			missingRequired: ["anyOf(grep|find)"],
			lostOptional: ["verify"],
		});
		throws(
			() =>
				parseAgentRecipeSchema({
					...recipe(),
					frontmatter: { version: 1, forbiddenRoutingHint: "model-x" },
				} as never),
			/unknown key|is required/,
		);
	});

	it("keeps live capability probes authoritative over metadata and operator values", () => {
		const defaults = { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 8_192 };
		const probed = mergeCapabilities(defaults, { tools: true }, { tools: false, contextWindow: 32_768 }, null);
		strictEqual(probed.tools, false, "a reported false is a report that written model metadata does not repair");
		strictEqual(probed.contextWindow, 32_768, "the served window remains live authority");
		strictEqual(
			mergeCapabilities(defaults, { tools: true }, { tools: true }, { tools: false }).tools,
			false,
			"an operator false may lower a reported true",
		);
		strictEqual(
			mergeCapabilities(defaults, null, { tools: false }, { tools: true }).tools,
			false,
			"an operator true never raises a reported false",
		);
		strictEqual(mergeCapabilities(defaults, { tools: true }, null, { tools: false }).tools, false);
	});

	it("round-trips a typed worker result and rejects contradictory reports", () => {
		const report = {
			passed: true,
			exitCode: 0,
			checks: [{ name: "typecheck", passed: true, evidence: "clean" }],
			artifactPaths: ["src/index.ts"],
			outputExcerpt: "ok",
		};
		deepStrictEqual(parseCodeReport(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``), report);
		strictEqual(parseCodeReport(JSON.stringify({ ...report, exitCode: 1 })), null);
	});

	it("binds transport admission to the entire approved worker identity", () => {
		const workerSpec = {
			specVersion: 5,
			settingsFingerprint: "settings-digest",
			runtimeId: "openai",
			wireModelId: "gpt-5",
			target: { id: "frontier", url: "https://api.example/v1/" },
			allowedTools: ["read", "verify"],
		};
		const approved = approvedIdentityForSpec(workerSpec);
		const attestation = { protocolVersion: WORKER_PROTOCOL_VERSION, ...approved };
		deepStrictEqual(verifyWorkerAttestation(attestation as never, approved), { ok: true });
		const drift = verifyWorkerAttestation({ ...attestation, toolSignature: "changed" } as never, approved);
		strictEqual(drift.ok, false);
	});

	it("emits canonical hash domains and normalizes released event ids at the wire read boundary", () => {
		const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
		const settings = { version: 2, chat: { target: "local" } };
		const spec = { specVersion: 5, agentId: "coder" };
		deepStrictEqual(parseBulkFrame('{"type":"clio_tool_finish","payload":{"tool":"read","outcome":"ok"}}'), {
			ok: true,
			value: { type: "clio_coder_tool_finish", payload: { tool: "read", outcome: "ok" } },
		});
		strictEqual(computeSettingsFingerprint(settings), sha256(`clio-coder.settings:${canonicalJson(settings)}`));
		strictEqual(workerSpecDigest(spec), sha256(`clio-coder.workerSpec:${canonicalJson(spec)}`));
		strictEqual(toolSignatureOf(["write", "read"]), sha256(JSON.stringify(["read", "write"])));
		strictEqual(endpointIdentityHash(undefined), sha256("clio-coder.endpoint:none"));
		strictEqual(endpointIdentityHash("https://example.test/v1/"), sha256("clio-coder.endpoint:https://example.test:/v1"));
	});

	it("projects incremental events and preserves terminal evidence under backpressure", () => {
		const update = {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "cumulative" }] },
			assistantMessageEvent: { type: "text_delta", delta: "tail", partial: { role: "assistant" } },
		};
		deepStrictEqual(projectWorkerEventForStdout(update as never), {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "tail" },
		});
		const queue = createBoundedEventQueue(2);
		queue.push({ type: "message_update", delta: "old" });
		queue.push({ type: "message_end", message: { content: "sealed result" } });
		queue.push({ type: "message_update", delta: "new" });
		deepStrictEqual(queue.shift(), { type: "message_end", message: { content: "sealed result" } });
		strictEqual(queue.stats().droppedDisplayFrames, 1);
	});

	it("drain seals once after process cleanup and retains terminal frames under display backpressure", async (context) => {
		const scratch = await isolateClioEnv("clio-coder-worker-boundary-");
		context.mock.timers.enable({ apis: ["setInterval"] });
		let finishCleanup!: (result: SpawnedWorkerResult) => void;
		const cleanup = new Promise<SpawnedWorkerResult>((resolve) => {
			finishCleanup = resolve;
		});
		let finishEvents!: () => void;
		const eventsDone = new Promise<void>((resolve) => {
			finishEvents = resolve;
		});
		const queue = createBoundedEventQueue(2);
		const output = JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] });
		queue.push({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: output } });
		for (let i = 0; i < 32; i++) queue.push({ type: "message_update", delta: `display ${i}` });
		queue.push({ type: "agent_end" });
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		const ctx = dispatchStubContext({ settings });
		let aborts = 0;
		let seals = 0;
		let reentrantDrain: Promise<void> | undefined;
		const unsubscribe = ctx.bus.on(BusChannels.DispatchFailed, () => {
			seals += 1;
		});
		const bundle = makeDispatchBundle(ctx, {
			spawnWorker: (): SpawnedWorker => ({
				pid: null,
				promise: cleanup,
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort() {
					aborts += 1;
					reentrantDrain = bundle.contract.drain();
				},
				events: (async function* () {
					while (queue.size > 0) yield queue.shift();
					finishEvents();
				})(),
			}),
		});
		try {
			await bundle.extension.start();
			const run = await bundle.contract.dispatch({
				agentId: "scout",
				executionRole: "researcher",
				task: "Inspect isolated evidence.",
				cwd: scratch.dir,
				requestOrigin: "internal",
				resultContractOverride: { kind: "provenance-report" },
			});
			await eventsDone;
			const drain = bundle.contract.drain();
			strictEqual(bundle.contract.drain(), drain);
			strictEqual(reentrantDrain, drain);
			let drained = false;
			void drain.then(() => {
				drained = true;
			});
			await Promise.resolve();
			deepStrictEqual({ aborts, seals, drained }, { aborts: 1, seals: 0, drained: false });
			ok(queue.stats().droppedDisplayFrames > 0);
			finishCleanup({
				exitCode: null,
				signal: "SIGTERM",
				processCleanup: { descendantsCleaned: true, incomplete: false, pipeDrainIncomplete: false },
			});
			await drain;
			const receipt = await run.finalPromise;
			strictEqual(receipt.output?.text, output);
			strictEqual(receipt.outcome, "canceled");
			const frames: unknown[] = [];
			for await (const frame of run.events) frames.push(frame);
			ok(frames.some((frame) => (frame as { type?: string }).type === "message_end"));
			ok(frames.some((frame) => (frame as { type?: string }).type === "agent_end"));
			await bundle.contract.drain();
			deepStrictEqual({ aborts, seals, drained }, { aborts: 1, seals: 1, drained: true });
		} finally {
			finishCleanup({ exitCode: null, signal: "SIGTERM" });
			await bundle.extension.stop?.();
			unsubscribe();
			scratch.restore();
		}
	});

	it("serializes live steering and acknowledges exact accepted sequences", async () => {
		const delivered: string[] = [];
		const accepted: number[] = [];
		const rejected: string[] = [];
		const handle = createOrderedSteerHandler(
			async (text) => {
				delivered.push(text);
				return text !== "refuse";
			},
			(steer) => accepted.push(steer.sequence),
			(reason) => rejected.push(reason),
		);
		await Promise.all([
			handle({ text: "first", sequence: 1 }),
			handle({ text: "refuse", sequence: 2 }),
			handle({ text: "third", sequence: 3 }),
		]);
		deepStrictEqual(delivered, ["first", "refuse", "third"]);
		deepStrictEqual(accepted, [1, 3]);
		strictEqual(rejected.length, 1);
		ok(rejected[0]?.includes("does not accept"));
	});
});

const WORKER_ENTRY = fileURLToPath(new URL("../../src/worker/entry.ts", import.meta.url));

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await sleep(25);
	}
	return check();
}

/** One OpenAI-compatible endpoint that counts every request a worker sends it. */
async function withModelFixture(run: (url: string, requests: () => number) => Promise<void>): Promise<void> {
	let requests = 0;
	const server = createServer(async (req, res) => {
		await readRequestBody(req);
		requests += 1;
		res.setHeader("content-type", "text/event-stream");
		const chunk = {
			model: "fixture",
			choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }],
		};
		res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => requests);
	} finally {
		await closeServer(server);
	}
}

/** The spec production dispatch writes for a scout routed to the fixture endpoint. */
async function dispatchedWorkerSpec(url: string, cwd: string): Promise<WorkerSpec> {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	settings.targets = [{ id: "fixture", runtime: "litellm", url, defaultModel: "fixture" }];
	settings.fleet.default.target = "fixture";
	settings.fleet.default.model = "fixture";
	let captured: WorkerSpec | undefined;
	const bundle = makeDispatchBundle(dispatchStubContext({ settings, runtime: litellm }), {
		spawnWorker(spec) {
			captured = spec;
			throw new Error("worker spec captured");
		},
	});
	await bundle.extension.start();
	try {
		await rejects(
			bundle.contract.dispatch({
				agentId: "scout",
				executionRole: "researcher",
				task: "Inspect the fixture.",
				cwd,
				requestOrigin: "internal",
				resultContractOverride: { kind: "provenance-report" },
			}),
			/worker spec captured/u,
		);
	} finally {
		await bundle.extension.stop?.();
	}
	ok(captured);
	return captured;
}

/** The real worker entry, driven by the test instead of the orchestrator's channel. */
function startWorkerEntry(spec: WorkerSpec, cwd: string) {
	const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), WORKER_ENTRY], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const seen: { stdout: string; stderr: string; announce: WorkerAttestation | null } = {
		stdout: "",
		stderr: "",
		announce: null,
	};
	let pending = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		seen.stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		seen.stderr += chunk;
		pending += chunk;
		for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) {
			const line = pending.slice(0, index);
			pending = pending.slice(index + 1);
			if (!isControlLine(line)) continue;
			const frame = parseControlFrame(line);
			if (frame.ok && frame.value.kind === "announce") seen.announce = frame.value.attestation;
		}
	});
	const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	child.stdin.write(`${JSON.stringify(spec)}\n`);
	const stop = async (): Promise<void> => {
		child.stdin.end();
		const exited = await Promise.race([exit.then(() => true), sleep(10_000).then(() => false)]);
		if (!exited) child.kill("SIGKILL");
		await exit;
	};
	return { child, seen, exit, stop };
}

const bulkFixtureSpec = {
	specVersion: 1,
	settingsFingerprint: "b".repeat(64),
	runtimeId: "fixture",
	target: { id: "fixture", url: "http://127.0.0.1:1" },
	wireModelId: "fixture",
	allowedTools: [],
} as unknown as WorkerSpec;

/**
 * An attested peer that heartbeats every 20 ms and, once admitted, writes tool
 * results: `burst` writes `count` frames (every 1000th a 1 MiB multibyte
 * result) and exits through a drainStdout-like bound; `flood` never stops.
 */
function spawnBulkFixture(mode: "burst" | "flood", count: number, onHeartbeat: () => void = () => {}): SpawnedWorker {
	const child = `
const [prefix, identity, mode, count] = process.argv.slice(1);
setInterval(() => process.stderr.write(prefix + JSON.stringify({ kind: "heartbeat" }) + "\\n"), 20);
const big = "é𝄞x".repeat(1024 * 1024 / 8);
const frame = (i) => JSON.stringify({ type: "tool_execution_end", toolCallId: "call-" + i, toolName: "read",
  result: { text: i % 1000 === 0 ? big : "result " + i } }) + "\\n";
let lines = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  lines += 1;
  if (lines === 1) {
    const unknown = { known: false };
    const attestation = { ...JSON.parse(identity), protocolVersion: ${WORKER_PROTOCOL_VERSION}, pid: process.pid,
      processGroupId: process.pid, host: "fixture", resources: { labels: [], cpuCount: unknown,
      totalMemoryBytes: unknown, freeMemoryBytes: unknown, gpuCount: unknown, vramBytes: unknown, residentModels: unknown } };
    process.stderr.write(prefix + JSON.stringify({ kind: "announce", attestation }) + "\\n");
  } else if (lines === 2 && mode === "flood") {
    let i = 1;
    const pump = () => { for (let k = 0; k < 500; k++) process.stdout.write(frame(i++)); setImmediate(pump); };
    pump();
  } else if (lines === 2) {
    for (let i = 0; i < Number(count); i++) process.stdout.write(frame(i));
    const bound = setTimeout(() => process.exit(0), 2000);
    process.stdout.write("", () => { clearTimeout(bound); process.exit(0); });
  }
});
`;
	return spawnWorkerProcess(
		process.execPath,
		["-e", child, CONTROL_FRAME_PREFIX, JSON.stringify(approvedIdentityForSpec(bulkFixtureSpec)), mode, String(count)],
		bulkFixtureSpec,
		{ onControl: (frame) => (frame.kind === "heartbeat" ? onHeartbeat() : undefined) },
	);
}

describe("worker channel facts", () => {
	it("reports the frame actually written, its errno and the worker's typed stdout failure (#425)", {
		timeout: 15_000,
	}, async () => {
		const child = `
const [prefix, identity] = process.argv.slice(1);
require("node:readline").createInterface({ input: process.stdin }).once("line", () => {
  const unknown = { known: false };
  const attestation = { ...JSON.parse(identity), protocolVersion: ${WORKER_PROTOCOL_VERSION}, pid: process.pid,
    processGroupId: process.pid, host: "fixture", resources: { labels: [], cpuCount: unknown,
    totalMemoryBytes: unknown, freeMemoryBytes: unknown, gpuCount: unknown, vramBytes: unknown, residentModels: unknown } };
  process.stderr.write(prefix + JSON.stringify({ kind: "announce", attestation }) + "\\n");
  process.stderr.write('[worker] bulk lane failure {"failure":"backlog-full","errno":null,"frameType":"tool_execution_end"}\\n');
  process.stdin.destroy();
  setTimeout(() => process.exit(1), 400);
});
`;
		const facts: EventPayload<"worker.channel_failed">[] = [];
		const worker = spawnWorkerProcess(
			process.execPath,
			["-e", child, CONTROL_FRAME_PREFIX, JSON.stringify(approvedIdentityForSpec(bulkFixtureSpec))],
			bulkFixtureSpec,
			{ onChannelFailure: (fact) => facts.push(fact) },
		);
		const deadline = Date.now() + 5_000;
		while (!facts.some((fact) => fact.lane === "stdout") && Date.now() < deadline) await sleep(20);
		await sleep(50);
		for (let index = 0; index < 20 && !facts.some((fact) => fact.lane === "stdin"); index++) {
			worker.send?.({ type: "steer", text: "x".repeat(65_536) });
			await sleep(20);
		}
		await worker.promise;
		for (const fact of facts) ok(validPayload("worker.channel_failed", fact), JSON.stringify(fact));
		deepStrictEqual(
			facts.find((fact) => fact.lane === "stdout"),
			{
				lane: "stdout",
				frameType: "tool_execution_end",
				errno: null,
				afterExit: false,
				failure: "backlog-full",
			},
		);
		const stdin = facts.find((fact) => fact.lane === "stdin");
		ok(stdin, JSON.stringify(facts));
		strictEqual(stdin.frameType, "steer");
		strictEqual(stdin.failure, "write-failed");
		strictEqual(stdin.errno, "EPIPE");
	});
});

describe("bulk-lane backpressure", () => {
	it("delivers every tool result intact and in order through a paused lane", { timeout: 30_000 }, async () => {
		const count = 6000;
		const worker = spawnBulkFixture("burst", count);
		// A consumer that has not started yet backs the evidence up past the soft bound.
		ok(await waitFor(() => worker.bulkLaneStats?.().paused === true, 10_000), "the evidence backlog pauses the lane");
		const ids: string[] = [];
		let bigResults = 0;
		for await (const frame of worker.events) {
			const event = frame as { toolCallId: string; result: { text: string } };
			ids.push(event.toolCallId);
			if (event.result.text.length > 1000) {
				strictEqual(event.result.text, "é𝄞x".repeat((1024 * 1024) / 8));
				bigResults += 1;
			}
		}
		const result = await worker.promise;
		deepStrictEqual(
			ids,
			Array.from({ length: count }, (_, i) => `call-${i}`),
		);
		strictEqual(bigResults, count / 1000);
		strictEqual(result.exitCode, 0, result.stderrTail);
		strictEqual(result.evidenceIncomplete, undefined);
		strictEqual(result.droppedDisplayFrames, undefined);
		const stats = worker.bulkLaneStats?.();
		ok(stats && stats.pauses >= 1);
		ok(stats.peakFrames <= WORKER_EVENT_QUEUE_MAX_FRAMES, `peak ${stats.peakFrames} frames`);
		ok(stats.peakBytes <= WORKER_EVENT_QUEUE_SOFT_BYTES + WORKER_BULK_FRAME_MAX_BYTES, `peak ${stats.peakBytes} bytes`);
	});

	it("keeps output within its bound and Stop effective while nothing reads it", { timeout: 30_000 }, async () => {
		let heartbeats = 0;
		const worker = spawnBulkFixture("flood", 0, () => {
			heartbeats += 1;
		});
		ok(await waitFor(() => worker.bulkLaneStats?.().paused === true, 10_000), "the evidence backlog pauses the lane");
		const before = heartbeats;
		await sleep(300);
		const stalled = worker.bulkLaneStats?.();
		ok(stalled?.paused, "the lane stays paused while the consumer is stalled");
		ok(stalled.retainedFrames <= WORKER_EVENT_QUEUE_MAX_FRAMES, `${stalled.retainedFrames} frames retained`);
		ok(stalled.retainedBytes <= WORKER_EVENT_QUEUE_SOFT_BYTES + WORKER_BULK_FRAME_MAX_BYTES);
		ok(heartbeats - before >= 3, `${heartbeats - before} heartbeats while the bulk lane was paused`);
		const stopAt = performance.now();
		worker.abort();
		const result = await worker.promise;
		ok(performance.now() - stopAt < WORKER_PROCESS_CLEANUP_BOUND_MS, "Stop settles within the cleanup bound");
		strictEqual(result.processCleanup?.incomplete, false);
		throws(() => process.kill(-(worker.pid as number), 0), /ESRCH/u);
		ok((worker.bulkLaneStats?.().retainedFrames ?? 0) <= WORKER_EVENT_QUEUE_HARD_FRAMES);
	});

	it("stops the worker when its consumer leaves a live stream", { timeout: 30_000 }, async () => {
		const worker = spawnBulkFixture("flood", 0);
		let read = 0;
		for await (const _frame of worker.events) {
			read += 1;
			if (read === 10) break;
		}
		const stopAt = performance.now();
		const result = await worker.promise;
		ok(performance.now() - stopAt < WORKER_PROCESS_CLEANUP_BOUND_MS, "early exit settles within the cleanup bound");
		throws(() => process.kill(-(worker.pid as number), 0), /ESRCH/u);
		strictEqual(result.exitCode, 1);
		match(result.evidenceIncomplete ?? "", /consumer detached/u);
	});

	// #425: in 0.6.3 two detached coders finished while the orchestrator's main
	// thread was starved. Each gave up its stdout drain after 2 s and exited 0,
	// the final frames were lost, and dispatch sealed the clean exit as a
	// missing final result that was never retried. Blocking this process from
	// the admit until the worker exits reproduces that stall.
	it("fails a finished worker whose output the orchestrator could not drain", {
		timeout: 90_000,
		skip: process.platform !== "linux",
	}, async () => {
		const env = await isolateClioEnv("clio-worker-starved-drain-");
		try {
			process.env.CLIO_CODER_WORKER_FAUX = "1";
			// message_end and agent_end each carry the whole answer, more than a
			// stdio socket buffers, so the tail waits in the worker for a reader.
			process.env.CLIO_CODER_WORKER_FAUX_TEXT = "final answer ".repeat(9000);
			await withModelFixture(async (url, requests) => {
				const settings = structuredClone(DEFAULT_SETTINGS);
				settings.fleet.retry.maxRetries = 0;
				settings.targets = [{ id: "fixture", runtime: "litellm", url, defaultModel: "fixture" }];
				settings.fleet.default.target = "fixture";
				settings.fleet.default.model = "fixture";
				let exitedWhileStalled = false;
				const bundle = makeDispatchBundle(dispatchStubContext({ settings, runtime: litellm }), {
					spawnWorker: (spec, options) => {
						const worker = spawnWorkerProcess(
							process.execPath,
							["--import", import.meta.resolve("tsx"), WORKER_ENTRY],
							spec,
							{
								...options,
								onAnnounce: (attestation) => {
									options?.onAnnounce?.(attestation);
									// The admit is written in this tick; the stall starts in the next.
									setImmediate(() => {
										exitedWhileStalled = stallUntilExited(worker.pid as number, 12_000);
									});
								},
							},
						);
						return worker;
					},
				});
				try {
					await bundle.extension.start();
					const run = await bundle.contract.dispatch({
						agentId: "scout",
						executionRole: "researcher",
						task: "Reply with a short response.",
						cwd: env.dir,
						requestOrigin: "internal",
						resultContractOverride: { kind: "external-delegation" },
					});
					const receipt = await run.finalPromise;
					ok(exitedWhileStalled, "the worker exits on its own drain bound while nothing reads it");
					strictEqual(requests(), 0);
					strictEqual(receipt.outcome, "failed");
					strictEqual(receipt.exitCode, 1);
					match(receipt.outcomeDetail ?? "", /bulk output incomplete: stdout did not drain within 2000 ms/u);
					strictEqual(isDeterministicOutcomeCode(receipt.outcomeCode), false);
				} finally {
					await bundle.extension.stop?.();
				}
			});
		} finally {
			env.restore();
		}
	});
});

/**
 * Hold this thread the way a saturated orchestrator did, reading nothing,
 * until `pid` is a zombie. Returns false when `capMs` passes first.
 */
function stallUntilExited(pid: number, capMs: number): boolean {
	const startedAt = performance.now();
	const pause = new Int32Array(new SharedArrayBuffer(4));
	while (performance.now() - startedAt < capMs) {
		let state: string | undefined;
		try {
			state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0];
		} catch {
			return true;
		}
		if (state === "Z") return true;
		Atomics.wait(pause, 0, 0, 25);
	}
	return false;
}

describe("worker admission", () => {
	it("uses faux responses through dispatch only when the env flag is enabled", { timeout: 90_000 }, async () => {
		const env = await isolateClioEnv("clio-worker-faux-dispatch-");
		try {
			process.env.CLIO_CODER_WORKER_FAUX_TEXT = "faux dispatch response";
			await withModelFixture(async (url, requests) => {
				const settings = structuredClone(DEFAULT_SETTINGS);
				settings.fleet.retry.maxRetries = 0;
				settings.targets = [{ id: "fixture", runtime: "litellm", url, defaultModel: "fixture" }];
				settings.fleet.default.target = "fixture";
				settings.fleet.default.model = "fixture";
				const bundle = makeDispatchBundle(dispatchStubContext({ settings, runtime: litellm }), {
					spawnWorker: (spec, options) =>
						spawnWorkerProcess(process.execPath, ["--import", import.meta.resolve("tsx"), WORKER_ENTRY], spec, options),
				});
				try {
					await bundle.extension.start();
					for (const flag of [undefined, "1"]) {
						if (flag === undefined) delete process.env.CLIO_CODER_WORKER_FAUX;
						else process.env.CLIO_CODER_WORKER_FAUX = flag;
						const run = await bundle.contract.dispatch({
							agentId: "scout",
							executionRole: "researcher",
							task: "Reply with a short response.",
							cwd: env.dir,
							requestOrigin: "internal",
							resultContractOverride: { kind: "external-delegation" },
						});
						const receipt = await run.finalPromise;
						strictEqual(receipt.outcome, "succeeded", receipt.outcomeDetail ?? receipt.outcome);
						strictEqual(receipt.output?.text, flag === "1" ? "faux dispatch response" : "done");
						strictEqual(requests(), 1, "only the worker without the faux flag calls the provider fixture");
					}
				} finally {
					await bundle.extension.stop?.();
				}
			});
		} finally {
			env.restore();
		}
	});

	it("starts no model run until the orchestrator admits the attested digest", { timeout: 90_000 }, async () => {
		const env = await isolateClioEnv("clio-worker-admission-");
		try {
			await withModelFixture(async (url, requests) => {
				const spec = await dispatchedWorkerSpec(url, env.dir);
				const worker = startWorkerEntry(spec, env.dir);
				try {
					ok(await waitFor(() => worker.seen.announce !== null, 45_000), worker.seen.stderr);
					strictEqual(worker.seen.announce?.specDigest, approvedIdentityForSpec(spec).specDigest);
					// Without the gate the run starts in the announce's own tick.
					await sleep(500);
					deepStrictEqual({ stdout: worker.seen.stdout, requests: requests() }, { stdout: "", requests: 0 });
					worker.child.stdin.write(`${JSON.stringify({ type: "admit", specDigest: worker.seen.announce?.specDigest })}\n`);
					ok(await waitFor(() => worker.seen.stdout.length > 0 && requests() > 0, 30_000), worker.seen.stderr);
				} finally {
					await worker.stop();
				}
			});
		} finally {
			env.restore();
		}
	});

	it("exits unadmitted with code 2 on a wrong digest or a closed channel", { timeout: 90_000 }, async () => {
		const env = await isolateClioEnv("clio-worker-unadmitted-");
		try {
			await withModelFixture(async (url, requests) => {
				const spec = await dispatchedWorkerSpec(url, env.dir);
				await Promise.all(
					(["wrong digest", "closed channel"] as const).map(async (answer) => {
						const worker = startWorkerEntry(spec, env.dir);
						try {
							ok(await waitFor(() => worker.seen.announce !== null, 45_000), worker.seen.stderr);
							if (answer === "closed channel") worker.child.stdin.end();
							else worker.child.stdin.write(`${JSON.stringify({ type: "admit", specDigest: "0".repeat(64) })}\n`);
							strictEqual(await worker.exit, 2, `${answer}: ${worker.seen.stderr}`);
							match(worker.seen.stderr, /\[worker\] not admitted: /u, answer);
							strictEqual(worker.seen.stdout, "", answer);
						} finally {
							await worker.stop();
						}
					}),
				);
				strictEqual(requests(), 0);
			});
		} finally {
			env.restore();
		}
	});

	it("admits an accepted announce on stdin and refuses a peer that never announces", { timeout: 15_000 }, async () => {
		const spec = {
			specVersion: 1,
			settingsFingerprint: "a".repeat(64),
			runtimeId: "fixture",
			target: { id: "fixture", url: "http://127.0.0.1:1" },
			wireModelId: "fixture",
			allowedTools: [],
		} as unknown as WorkerSpec;
		const approved = approvedIdentityForSpec(spec);
		// Heartbeats on a fixed interval, announces only when told to, and echoes
		// the first stdin line after the spec before it exits.
		const child = `
const [prefix, identity, mode] = process.argv.slice(1);
setInterval(() => process.stderr.write(prefix + JSON.stringify({ kind: "heartbeat" }) + "\\n"), 25);
let lines = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  lines += 1;
  if (lines === 1 && mode === "announce") {
    const unknown = { known: false };
    const attestation = { ...JSON.parse(identity), protocolVersion: ${WORKER_PROTOCOL_VERSION}, pid: process.pid,
      processGroupId: process.pid, host: "fixture", resources: { labels: [], cpuCount: unknown,
      totalMemoryBytes: unknown, freeMemoryBytes: unknown, gpuCount: unknown, vramBytes: unknown, residentModels: unknown } };
    process.stderr.write(prefix + JSON.stringify({ kind: "announce", attestation }) + "\\n");
  } else if (lines === 2) {
    process.stderr.write("received " + line + "\\n", () => process.exit(0));
  }
});
`;
		const run = (mode: "announce" | "silent") =>
			spawnWorkerProcess(process.execPath, ["-e", child, CONTROL_FRAME_PREFIX, JSON.stringify(approved), mode], spec, {
				announceDeadlineMs: mode === "silent" ? 300 : 10_000,
			}).promise;
		const [admitted, silent] = await Promise.all([run("announce"), run("silent")]);
		strictEqual(admitted.exitCode, 0, admitted.stderrTail);
		ok(
			admitted.stderrTail?.includes(`received ${JSON.stringify({ type: "admit", specDigest: approved.specDigest })}`),
			admitted.stderrTail,
		);
		strictEqual(silent.exitCode, 1, silent.stderrTail);
		match(silent.stderrTail ?? "", /did not announce its route identity within 300 ms/u);
	});
});

describe("worker extension hooks", () => {
	it("counts a startup reload committed with errors as a failed host", () => {
		// operator-runtime-v2 answers this after retiring every process; it carries no degraded count.
		const withErrors = { status: "committed", generation: 1, message: "Extensions reloaded with errors: boom" } as const;
		strictEqual(workerHookStartupFailure(withErrors), withErrors.message);
		strictEqual(workerHookStartupFailure({ status: "committed", generation: 1, message: "ok", degraded: 0 }), null);
	});
	it("refuses a worker's hook query once the CLI hook host is disposed", async () => {
		const hooks = createCliWorkerHooks("fleet");
		await hooks.dispose();
		const effects = await hooks.workerHooks.evaluate(
			{ requestId: "r1", hookId: "extension:desk_guard:before_tool:0", point: "before_tool", tool: "bash" },
			{ runId: null, sessionId: null },
		);
		deepStrictEqual(effects, [
			{
				kind: "block_tool",
				reason: "the fleet extension host stopped; extension:desk_guard:before_tool:0 cannot run, so the call fails closed",
			},
		]);
	});
	it("holds a worker's matching call for the dispatching session's hook and applies its verdict", {
		timeout: 120_000,
	}, async () => {
		const env = await isolateClioEnv("clio-worker-extension-hook-");
		const bodies: string[] = [];
		const server = createServer(async (req, res) => {
			bodies.push(await readRequestBody(req));
			res.setHeader("content-type", "text/event-stream");
			const chunks =
				bodies.length === 1
					? [
							{
								model: "fixture",
								choices: [
									{
										index: 0,
										delta: {
											role: "assistant",
											tool_calls: [
												{
													index: 0,
													id: "call_1",
													type: "function",
													function: { name: "read", arguments: JSON.stringify({ path: "input.txt" }) },
												},
											],
										},
										finish_reason: null,
									},
								],
							},
							{ model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
						]
					: [
							{
								model: "fixture",
								choices: [
									{
										index: 0,
										delta: {
											role: "assistant",
											content: JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
										},
										finish_reason: "stop",
									},
								],
							},
						];
			res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		settings.targets = [{ id: "fixture", runtime: "litellm", url, defaultModel: "fixture" }];
		settings.fleet.default.target = "fixture";
		settings.fleet.default.model = "fixture";
		const requests: WorkerHookRequest[] = [];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings, runtime: litellm }), {
			spawnWorker: (spec, opts) =>
				spawnWorkerProcess(process.execPath, ["--import", import.meta.resolve("tsx"), WORKER_ENTRY], spec, {
					...opts,
					cwd: env.dir,
				}),
			workerHooks: {
				declarations: () => [
					{
						id: "extension:gate:before_tool:0",
						point: "before_tool",
						tools: ["read"],
						timeoutMs: 1000,
						onTimeout: "block",
						onError: "block",
					},
				],
				evaluate: async (request) => {
					requests.push(request);
					return [{ kind: "block_tool", reason: "gate closed by the dispatching session" }];
				},
			},
		});
		try {
			await bundle.extension.start();
			writeFileSync(join(env.dir, "input.txt"), "fixture\n");
			const run = await bundle.contract.dispatch({
				agentId: "scout",
				executionRole: "researcher",
				task: "Inspect the fixture.",
				cwd: env.dir,
				requestOrigin: "internal",
				resultContractOverride: { kind: "provenance-report" },
			});
			await run.finalPromise;
			strictEqual(requests.length, 1, bodies.join("\n"));
			const [request] = requests;
			deepStrictEqual(
				{ hookId: request?.hookId, tool: request?.tool, args: request?.args, landing: request?.landing },
				{
					hookId: "extension:gate:before_tool:0",
					tool: "read",
					args: { path: "input.txt" },
					landing: { path: { arg: "path", path: join(realpathSync(env.dir), "input.txt"), resolved: true } },
				},
			);
			// The model saw the session's verdict, not the file.
			match(bodies[1] ?? "", /gate closed by the dispatching session/u);
			ok(!(bodies[1] ?? "").includes("fixture\\n"));
		} finally {
			await bundle.extension.stop?.();
			await closeServer(server);
			env.restore();
		}
	});
	it("refuses a claude-sdk dispatch that a matching blocking hook could not reach", async () => {
		const env = await isolateClioEnv("clio-worker-unhooked-runtime-");
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		settings.targets = [{ id: "sdk", runtime: "claude-sdk", defaultModel: "claude-fixture" }];
		settings.fleet.default.target = "sdk";
		settings.fleet.default.model = "claude-fixture";
		const spawned: string[] = [];
		const bundle = makeDispatchBundle(
			dispatchStubContext({
				settings,
				runtime: {
					id: "claude-sdk",
					displayName: "Claude SDK",
					kind: "sdk",
					apiFamily: "anthropic-messages",
					auth: "api-key",
					defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
					synthesizeModel: () => ({ id: "claude-fixture", provider: "claude-sdk" }) as never,
				},
			}),
			{
				spawnWorker: (spec) => {
					spawned.push(spec.agentId);
					throw new Error("an unhooked worker must not start");
				},
				workerHooks: {
					declarations: () => [
						{
							id: "extension:desk_guard:before_tool:0",
							point: "before_tool",
							tools: ["read"],
							timeoutMs: 1000,
							onTimeout: "pass",
							onError: "block",
						},
					],
					evaluate: async () => [],
				},
			},
		);
		try {
			await bundle.extension.start();
			await rejects(async () => {
				const run = await bundle.contract.dispatch({
					agentId: "scout",
					executionRole: "researcher",
					task: "Inspect the fixture.",
					cwd: env.dir,
					requestOrigin: "internal",
				});
				await run.finalPromise;
			}, /claude-sdk runtime cannot carry extension tool hooks.*desk_guard/u);
			// Preview and failover candidates refuse the route dispatch refuses.
			throws(
				() =>
					bundle.contract.preview?.({
						agentId: "scout",
						executionRole: "researcher",
						task: "Inspect the fixture.",
						cwd: env.dir,
						requestOrigin: "internal",
					}),
				/claude-sdk runtime cannot carry extension tool hooks.*desk_guard/u,
			);
			deepStrictEqual(spawned, []);
		} finally {
			await bundle.extension.stop?.();
			env.restore();
		}
	});
	it("refuses a CLI or ACP dispatch under a blocking hook that names none of its tools", async () => {
		const env = await isolateClioEnv("clio-worker-unhooked-cli-");
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		settings.targets = [{ id: "codex", runtime: "codex-cli", defaultModel: "codex-fixture" }];
		settings.fleet.default.target = "codex";
		settings.fleet.default.model = "codex-fixture";
		settings.integrations.externalAgents.entries = [{ id: "acp-fixture", command: "acp-fixture", args: [] }];
		const spawned: string[] = [];
		const bundle = makeDispatchBundle(
			dispatchStubContext({
				settings,
				runtime: {
					id: "codex-cli",
					displayName: "Codex CLI",
					kind: "subprocess",
					apiFamily: "openai-responses",
					auth: "none",
					defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
					synthesizeModel: () => ({ id: "codex-fixture", provider: "codex-cli" }) as never,
				},
			}),
			{
				spawnWorker: (spec) => {
					spawned.push(spec.agentId);
					throw new Error("an unhooked worker must not start");
				},
				workerHooks: {
					declarations: () => [
						{
							id: "extension:desk_guard:before_tool:0",
							point: "before_tool",
							tools: ["music"],
							timeoutMs: 1000,
							onTimeout: "pass",
							onError: "block",
						},
					],
					evaluate: async () => [],
				},
			},
		);
		try {
			await bundle.extension.start();
			for (const [agentId, refusal] of [
				["scout", /codex-cli runtime runs its own tools.*desk_guard/u],
				["acp-fixture", /ACP agent acp-fixture runs its own tools.*desk_guard/u],
			] as const) {
				await rejects(async () => {
					const run = await bundle.contract.dispatch({
						agentId,
						executionRole: "researcher",
						task: "Inspect the fixture.",
						cwd: env.dir,
						requestOrigin: "internal",
					});
					await run.finalPromise;
				}, refusal);
			}
			// A plan must not preview the CLI route or the delegation dispatch refuses.
			throws(
				() =>
					bundle.contract.preview?.({
						agentId: "scout",
						executionRole: "researcher",
						task: "Inspect the fixture.",
						cwd: env.dir,
						requestOrigin: "internal",
					}),
				/codex-cli runtime runs its own tools.*desk_guard/u,
			);
			throws(
				() =>
					bundle.contract.preview?.({
						agentId: "acp-fixture",
						executionRole: "researcher",
						task: "Inspect the fixture.",
						cwd: env.dir,
						requestOrigin: "internal",
					}),
				/ACP agent acp-fixture runs its own tools.*desk_guard/u,
			);
			deepStrictEqual(spawned, []);
		} finally {
			await bundle.extension.stop?.();
			env.restore();
		}
	});
	it("refuses a dispatch whose tools match a blocking hook past the worker hook cap", async () => {
		const env = await isolateClioEnv("clio-worker-dropped-gate-");
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		settings.targets = [{ id: "fixture", runtime: "litellm", url: "http://127.0.0.1:9", defaultModel: "fixture" }];
		settings.fleet.default.target = "fixture";
		settings.fleet.default.model = "fixture";
		const spawned: string[] = [];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings, runtime: litellm }), {
			spawnWorker: (spec) => {
				spawned.push(spec.agentId);
				throw new Error("a worker past its gate must not start");
			},
			workerHooks: {
				declarations: () => [],
				dropped: () => [
					{
						id: "extension:desk_guard:before_tool:64",
						point: "before_tool",
						tools: ["read"],
						timeoutMs: 1000,
						onTimeout: "pass",
						onError: "block",
					},
				],
				evaluate: async () => [],
			},
		});
		try {
			await bundle.extension.start();
			await rejects(async () => {
				const run = await bundle.contract.dispatch({
					agentId: "scout",
					executionRole: "researcher",
					task: "Inspect the fixture.",
					cwd: env.dir,
					requestOrigin: "internal",
				});
				await run.finalPromise;
			}, /blocking tool hooks of desk_guard fall past the 64 hooks a worker carries/u);
			throws(
				() =>
					bundle.contract.preview?.({
						agentId: "scout",
						executionRole: "researcher",
						task: "Inspect the fixture.",
						cwd: env.dir,
						requestOrigin: "internal",
					}),
				/blocking tool hooks of desk_guard fall past the 64 hooks a worker carries/u,
			);
			deepStrictEqual(spawned, []);
		} finally {
			await bundle.extension.stop?.();
			env.restore();
		}
	});
});
