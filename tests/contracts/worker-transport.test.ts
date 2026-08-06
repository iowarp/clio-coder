import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { shellQuote } from "../../src/core/shell-quote.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { listCapacityLeases } from "../../src/domains/dispatch/capacity-lease.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import { classifyFailure } from "../../src/domains/dispatch/failure-classification.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import {
	buildRemoteWorkerCommand,
	buildSshArgs,
	createLocalWorkerTransport,
	createSshWorkerTransport,
} from "../../src/domains/dispatch/transport.js";
import type { RunNodeIdentity } from "../../src/domains/dispatch/types.js";
import {
	approvedIdentityForSpec,
	createBoundedEventQueue,
	endpointIdentityHash,
	verifyWorkerAttestation,
	WORKER_STDIN_FRAME_MAX_BYTES,
	WorkerChannelFailure,
	workerSpecDigest,
} from "../../src/domains/dispatch/worker-protocol.js";
import {
	type SpawnedWorker,
	type SpawnedWorkerResult,
	spawnWorkerProcess,
	type WorkerSpec,
} from "../../src/domains/dispatch/worker-spawn.js";
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
import { fixtureSettingsFingerprint } from "../harness/worker-attestation.js";

const TEST_SPEC = {
	specVersion: WORKER_SPEC_VERSION,
	settingsFingerprint: fixtureSettingsFingerprint(),
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

/** Liveness by signal 0: it probes without delivering anything. */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
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
		strictEqual(command, "cd '/shared/projects/app' && exec env CLIO_RESIDENCY=observe CLIO_WORKER_PGID=$$ clio worker");
	});

	it("honors per-node residency and clioEntry overrides", () => {
		const command = buildRemoteWorkerCommand(
			{ ...SSH_NODE, residency: "manage", clioEntry: "/opt/clio/bin/clio worker" },
			"/w",
		);
		strictEqual(command, "cd '/w' && exec env CLIO_RESIDENCY=manage CLIO_WORKER_PGID=$$ /opt/clio/bin/clio worker");
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
		match(result.stderrTail ?? "", /WorkerSpec version drift: dispatched 3, worker announced 2/);
	});

	it("rejects a worker announce with no specVersion", async () => {
		const worker = transport("missing-announce-version").spawn(TEST_SPEC, { cwd: "/w" });
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(result.stderrTail ?? "", /announce specVersion must be a finite number/);
	});

	it("fails closed when the first remote protocol event is not an announce", async () => {
		const worker = transport("no-announce-event").spawn(TEST_SPEC, { cwd: "/w" });
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(
			result.stderrTail ?? "",
			/Missing worker attestation: the peer produced output without announcing its route identity/,
		);
	});

	it("fails closed when the remote peer exits cleanly without an announce", async () => {
		const worker = transport("no-announce-exit0").spawn(TEST_SPEC, { cwd: "/w" });
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, null);
		match(result.stderrTail ?? "", /Missing worker attestation: peer exited before announcing its route identity/);
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
		// The negative pid is the whole remote process group, so a runtime's own
		// children die with it; the single pid stays as the fallback's fallback.
		match(killCommand, /^kill -TERM -\d+ 2>\/dev\/null \|\| kill -TERM \d+/);
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

	it("fails closed when the first local protocol event is not announce", async () => {
		const worker = localWorker("no-announce-event");
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(
			result.stderrTail ?? "",
			/Missing worker attestation: the peer produced output without announcing its route identity/,
		);
	});

	it("fails closed when the first local protocol event is malformed JSON", async () => {
		const worker = localWorker("malformed-first-event");
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(result.stderrTail ?? "", /Invalid worker attestation: control frame is not JSON/);
	});

	it("fails closed on local announce version mismatch", async () => {
		const worker = localWorker("version-skew");
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(result.stderrTail ?? "", /WorkerSpec version drift: dispatched 3, worker announced 2/);
	});

	it("fails closed when the local announce omits specVersion", async () => {
		const worker = localWorker("missing-announce-version");
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, "SIGKILL");
		match(result.stderrTail ?? "", /announce specVersion must be a finite number/);
	});

	it("fails closed when a local worker exits before announce", async () => {
		const worker = localWorker("no-announce-exit0");
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, []);
		strictEqual(result.exitCode, 1);
		strictEqual(result.signal, null);
		match(result.stderrTail ?? "", /Missing worker attestation: peer exited before announcing its route identity/);
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

describe("worker attestation and transport bounds", () => {
	let fake: FakeSsh;

	before(() => {
		fake = installFakeSsh();
	});
	after(() => {
		rmSync(fake.dir, { recursive: true, force: true });
	});

	function localWorker(scenario: string, extraEnv: NodeJS.ProcessEnv = {}): SpawnedWorker {
		return createLocalWorkerTransport({
			workerEntryPath: fake.binary,
			env: {
				...process.env,
				FAKE_SSH_SCENARIO: scenario,
				FAKE_SSH_ARGV_LOG: fake.argvLog,
				FAKE_SSH_DESCENDANT_LOG: fake.descendantLog,
				...extraEnv,
			},
		}).spawn(TEST_SPEC, { cwd: fake.dir });
	}

	it("worker attestation matches the approved settings and spec fingerprints", async () => {
		const worker = localWorker("ok");
		await drain(worker.events);
		strictEqual((await worker.promise).exitCode, 0);
		const attestation = worker.attestation?.();
		ok(attestation, "the worker attested before executing");
		if (!attestation) return;
		const approved = approvedIdentityForSpec(TEST_SPEC);
		strictEqual(attestation.settingsFingerprint, approved.settingsFingerprint);
		// The peer recomputed the digest from the bytes it received, so equality
		// here proves it parsed the document that was actually dispatched.
		strictEqual(attestation.specDigest, approved.specDigest);
		strictEqual(attestation.specDigest, workerSpecDigest(TEST_SPEC));
		strictEqual(attestation.targetId, "default");
		strictEqual(attestation.runtimeId, "openai");
		strictEqual(attestation.wireModelId, "gpt-4o");
		strictEqual(attestation.endpointIdentityHash, endpointIdentityHash(undefined));
		deepStrictEqual(verifyWorkerAttestation(attestation, approved), { ok: true });
		// Unknown is explicit, never an optimistic zero.
		deepStrictEqual(attestation.resources.gpuCount, { known: false });
		deepStrictEqual(attestation.resources.vramBytes, { known: false });
		deepStrictEqual(attestation.resources.residentModels, { known: false });
	});

	it("settings fingerprint drift kills the worker before model execution", async () => {
		const worker = localWorker("settings-drift");
		const events = await drain(worker.events);
		const result = await worker.promise;
		deepStrictEqual(events, [], "no bulk frame is accepted from a drifting peer");
		strictEqual(result.signal, "SIGKILL");
		match(result.stderrTail ?? "", /Worker attestation rejected: settings fingerprint drift/);
		strictEqual(worker.attestation?.(), null);
	});

	it("spec digest and target drift are refused with the same fail-closed rule", async () => {
		for (const [scenario, pattern] of [
			["spec-drift", /WorkerSpec digest drift/],
			["target-drift", /target drift/],
		] as const) {
			const worker = localWorker(scenario);
			const events = await drain(worker.events);
			const result = await worker.promise;
			deepStrictEqual(events, [], `${scenario} produced no executable events`);
			strictEqual(result.signal, "SIGKILL");
			match(result.stderrTail ?? "", pattern);
		}
	});

	it("oversized bulk and control frames fail within fixed memory bounds", async () => {
		const bulk = localWorker("oversized-bulk");
		const bulkEvents = await drain(bulk.events);
		const bulkResult = await bulk.promise;
		// The oversized line is discarded before parsing; the next frame still
		// arrives, so one bad frame does not poison the stream.
		deepStrictEqual(eventTypes(bulkEvents), ["message_end"]);
		ok((bulkResult.malformedStdoutLines ?? 0) >= 1, "the oversized bulk frame was counted and dropped");
		match(bulkResult.stderrTail ?? "", /dropped a bulk frame over the \d+ byte lane limit/);

		const control = localWorker("oversized-control");
		const controlEvents = await drain(control.events);
		const controlResult = await control.promise;
		deepStrictEqual(controlEvents, []);
		match(controlResult.stderrTail ?? "", /control frame exceeds \d+ bytes/);
		strictEqual(control.attestation?.(), null);
	});

	it("bulk backpressure does not block heartbeat or cancellation acknowledgement", async () => {
		const controlFrames: string[] = [];
		const worker = spawnWorkerProcess(process.execPath, [fake.binary], TEST_SPEC, {
			cwd: fake.dir,
			env: { ...process.env, FAKE_SSH_SCENARIO: "bulk-flood", FAKE_SSH_ARGV_LOG: fake.argvLog },
			onControl: (frame) => controlFrames.push(frame.kind),
		});
		// Deliberately do not consume the bulk stream until the worker settles, so
		// every flooded frame is sitting in the bounded queue while the control
		// lane is expected to keep answering.
		const result = await worker.promise;
		strictEqual(result.exitCode, 0);
		ok(controlFrames.includes("heartbeat"), `heartbeat crossed the saturated channel: ${controlFrames.join(",")}`);
		ok(controlFrames.includes("cancel_ack"), `cancel ack crossed the saturated channel: ${controlFrames.join(",")}`);
	});

	it("receipt-bearing frames are never dropped with display frames", async () => {
		const worker = localWorker("display-flood");
		// Settle first, so every frame is queued at once and the ceiling is
		// actually reached; a concurrent consumer would drain it as it fills.
		const result = await worker.promise;
		const events = await drain(worker.events);
		strictEqual(result.exitCode, 0);
		const types = eventTypes(events);
		ok((result.droppedDisplayFrames ?? 0) > 0, "the queue shed display frames under pressure");
		ok(types.includes("clio_run_outcome"), "the outcome frame survived the drop policy");
		ok(types.includes("message_end"), "the terminal message survived the drop policy");
		ok(types.filter((type) => type === "message_update").length < 6000, "display frames were the ones actually dropped");
	});

	it("stdin backpressure is bounded and reports node-channel failure", async () => {
		const worker = localWorker("deaf-stdin");
		try {
			// One frame past the per-frame ceiling is refused outright.
			strictEqual(worker.send?.({ type: "steer", text: "x".repeat(WORKER_STDIN_FRAME_MAX_BYTES + 16) }), false);
			const oversize = worker.lastChannelFailure?.();
			ok(oversize instanceof WorkerChannelFailure, "an oversized control write is a typed channel failure");
			strictEqual(oversize?.operation, "steer");
			strictEqual(oversize?.failureClass, "node-channel");
			match(oversize?.message ?? "", /exceeds the \d+ byte limit/);

			// A peer that stopped reading backs the queue up to its ceiling and no
			// further; the write is refused rather than buffered without bound.
			const chunk = { type: "steer", text: "y".repeat(512 * 1024) };
			let refusedAt = -1;
			for (let index = 0; index < 64 && refusedAt < 0; index += 1) {
				if (worker.send?.(chunk) === false) refusedAt = index;
			}
			ok(refusedAt >= 0, "the bounded stdin queue eventually refuses instead of growing");
			const full = worker.lastChannelFailure?.();
			strictEqual(full?.failureClass, "node-channel");
			match(full?.message ?? "", /stdin queue is full/);

			// The typed failure reaches classification as node evidence, not as a
			// target or model fault.
			strictEqual(
				classifyFailure(
					{
						abortedByOperator: false,
						policyDenied: null,
						permissionFailure: false,
						stallKilled: false,
						timedOut: false,
						exitCode: 1,
					} as never,
					{ exitCode: 1, signal: null, channelFailure: "steer" },
					"failed",
					null,
				),
				"node-channel",
			);
		} finally {
			worker.abort();
			await worker.promise;
		}
	});

	it("abort kills local and remote process-group descendants", async () => {
		writeFileSync(fake.descendantLog, "", "utf8");
		const worker = localWorker("group-descendant");
		await new Promise((resolve) => setTimeout(resolve, 250));
		const descendantPid = Number.parseInt(readFileSync(fake.descendantLog, "utf8").trim().split("\n")[0] ?? "", 10);
		ok(Number.isSafeInteger(descendantPid), "the stub spawned a descendant in the worker's group");
		ok(isProcessAlive(descendantPid), "the descendant is running before the abort");
		worker.abort();
		await worker.promise;
		// The descendant is not the immediate child, so it only dies if the signal
		// went to the whole process group.
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && isProcessAlive(descendantPid)) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		strictEqual(isProcessAlive(descendantPid), false, "the group descendant was terminated with its leader");

		// The remote half of the same rule: the fallback names the group.
		process.env.FAKE_SSH_SCENARIO = "hang-hard";
		process.env.FAKE_SSH_ARGV_LOG = fake.argvLog;
		writeFileSync(fake.argvLog, "", "utf8");
		const remote = createSshWorkerTransport(SSH_NODE, { sshBinary: fake.binary, shutdownGraceMs: 60 }).spawn(TEST_SPEC, {
			cwd: "/w",
		});
		await new Promise((resolve) => setTimeout(resolve, 250));
		remote.abort();
		await remote.promise;
		const killDeadline = Date.now() + 2000;
		let groupKill = "";
		while (Date.now() < killDeadline && groupKill === "") {
			for (const line of readFileSync(fake.argvLog, "utf8").trim().split("\n").filter(Boolean)) {
				const argv = JSON.parse(line) as string[];
				const command = argv[argv.length - 1] ?? "";
				if (command.startsWith("kill -TERM -")) groupKill = command;
			}
			if (groupKill === "") await new Promise((resolve) => setTimeout(resolve, 25));
		}
		match(groupKill, /^kill -TERM -\d+/);
	});
});

describe("bounded worker event queue", () => {
	it("drops the oldest display frame and never an evidence frame", () => {
		const queue = createBoundedEventQueue(3);
		strictEqual(queue.push({ type: "message_update", index: 0 }), true);
		strictEqual(queue.push({ type: "message_end" }), true);
		strictEqual(queue.push({ type: "message_update", index: 1 }), true);
		strictEqual(queue.push({ type: "clio_run_outcome" }), true);
		strictEqual(queue.size, 3);
		strictEqual(queue.stats().droppedDisplayFrames, 1);
		deepStrictEqual(
			[queue.shift(), queue.shift(), queue.shift()].map((frame) => (frame as { type: string }).type),
			["message_end", "message_update", "clio_run_outcome"],
		);
	});

	it("accepts an evidence frame even when the queue holds nothing droppable", () => {
		const queue = createBoundedEventQueue(2);
		queue.push({ type: "message_end" });
		queue.push({ type: "clio_run_outcome" });
		strictEqual(queue.push({ type: "tool_execution_end" }), true, "evidence outranks the ceiling");
		strictEqual(queue.push({ type: "message_update" }), false, "a display frame is refused instead");
		strictEqual(queue.stats().droppedDisplayFrames, 1);
		strictEqual(queue.size, 3);
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
		const placement: DispatchNodePlacement = {
			node: NODE,
			spawn: () =>
				fakeSpawnedWorker([
					{ type: "message_end", message: { role: "assistant", content: "done", usage: { input: 1, output: 1 } } },
				]),
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
