import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { parseAgentRecipeSchema } from "../../src/domains/agents/recipe-schema.js";
import { parseCodeReport } from "../../src/domains/agents/result-contract.js";
import { normalizeAgentSpec, resolveAgentToolCompatibility } from "../../src/domains/agents/spec.js";
import {
	approvedIdentityForSpec,
	CONTROL_FRAME_PREFIX,
	computeSettingsFingerprint,
	createBoundedEventQueue,
	isControlLine,
	parseControlFrame,
	verifyWorkerAttestation,
	type WorkerAttestation,
} from "../../src/domains/dispatch/worker-protocol.js";
import {
	type SpawnedWorker,
	type SpawnedWorkerResult,
	spawnWorkerProcess,
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
		strictEqual(toolSignatureOf(["write", "read"]), sha256("clio-coder.tools:read,write"));
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

describe("worker admission", () => {
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
