import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { evaluateJudgedGrant, evaluateMainGrant } from "../../src/domains/dispatch/grant-authority.js";
import {
	createGrantBroker,
	type GrantDecision,
	type GrantRecord,
	type GrantRequestInput,
} from "../../src/domains/dispatch/grant-broker.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { SafetyJudgementInput } from "../../src/domains/safety/decision-events.js";
import { grantEffectDescriptor, grantEffectDigest } from "../../src/domains/safety/grant-effect.js";
import { createSafetyJudge, type SafetyJudgeConfig } from "../../src/domains/safety/safety-judge.js";
import type { AgentEvent } from "../../src/engine/types.js";
import type { ClioWorkerEvent } from "../../src/engine/worker-events.js";
import { startWorkerRun, type WorkerRunHandle, type WorkerRunInput } from "../../src/engine/worker-runtime.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import type { WorkerGrantRequestFrame } from "../../src/worker/protocol.js";
import { WORKER_EXIT_PERMISSION_REQUIRED } from "../../src/worker/spec-contract.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Phase D live grants (operator-approved test item 6): a decision is bound to
 * the request, attempt and argument digest; one grant executes at most once;
 * an identical new call needs a new grant; expiry, cancellation and worker
 * exit revoke; headless default denies; an operator rail is never main's to
 * grant. Commands here are policy data run only in a scratch directory.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";

function requestInput(overrides: Partial<GrantRequestInput> = {}): GrantRequestInput {
	const effect = grantEffectDescriptor("bash", { command: "./mark.sh" });
	return {
		workerRequestId: "perm-1",
		runId: "run-a1",
		rootRunId: "assign-a",
		attempt: 0,
		attemptToken: TOKEN,
		ownerSessionId: "session-1",
		agentId: "coder",
		tool: "bash",
		actionClass: "execute",
		approvalAuthority: "main",
		argDigest: grantEffectDigest(effect),
		effect,
		cwd: process.cwd(),
		permitTools: ["bash", "read"],
		summary: "bash requires execute confirmation",
		reasons: [],
		deadlineAt: Date.now() + 60_000,
		...overrides,
	};
}

function brokerWithLog() {
	const delivered: Array<{ requestId: string; decision: GrantDecision }> = [];
	const broker = createGrantBroker({
		deliver: (record: GrantRecord, decision: GrantDecision) => {
			delivered.push({ requestId: record.requestId, decision });
			return true;
		},
	});
	return { broker, delivered };
}

function opened(broker: ReturnType<typeof createGrantBroker>, overrides: Partial<GrantRequestInput> = {}): GrantRecord {
	const result = broker.open(requestInput(overrides));
	ok(result.ok, result.ok ? "" : result.reason);
	return result.record;
}

describe("grant broker", () => {
	it("binds a decision to its request, run, attempt, session and argument digest", () => {
		const { broker, delivered } = brokerWithLog();
		const refused = broker.open(requestInput({ argDigest: "f".repeat(64) }));
		strictEqual(refused.ok, false, "a digest that does not match the descriptor is refused");
		const record = opened(broker);
		strictEqual(
			broker.decide("grant-unknown", { decision: "approve", issuer: "main", sessionId: "session-1" }).ok,
			false,
		);
		for (const mismatch of [
			{ sessionId: "session-2" },
			{ sessionId: "session-1", runId: "run-other" },
			{ sessionId: "session-1", runId: "run-a1", attempt: 1 },
		]) {
			const result = broker.decide(record.requestId, { decision: "approve", issuer: "main", ...mismatch });
			strictEqual(result.ok, false, JSON.stringify(mismatch));
		}
		deepStrictEqual(delivered, [], "no mismatched decision reaches the worker");
		strictEqual(broker.get(record.requestId)?.state, "pending");
		const approved = broker.decide(record.requestId, {
			decision: "approve",
			issuer: "main",
			sessionId: "session-1",
			runId: "assign-a",
			attempt: 0,
		});
		ok(approved.ok);
		strictEqual(approved.record.state, "authorized");
		broker.dispose();
	});

	it("delivers a duplicate approval once and never runs a completed grant again", () => {
		const { broker, delivered } = brokerWithLog();
		const record = opened(broker);
		const first = broker.decide(record.requestId, { decision: "approve", issuer: "main", sessionId: "session-1" });
		const second = broker.decide(record.requestId, { decision: "approve", issuer: "main", sessionId: "session-1" });
		ok(first.ok && !first.duplicate);
		ok(second.ok && second.duplicate);
		strictEqual(delivered.length, 1);
		broker.markExecution("run-a1", "perm-1", "start");
		broker.markExecution("run-a1", "perm-1", "end");
		const settled = broker.get(record.requestId);
		strictEqual(settled?.state, "completed");
		strictEqual(settled?.execution, "executed");
		const third = broker.decide(record.requestId, { decision: "approve", issuer: "main", sessionId: "session-1" });
		strictEqual(third.ok, false, "a completed request cannot be approved again");
		strictEqual(delivered.length, 1);
		broker.dispose();
	});

	it("revokes on expiry, turn cancellation and worker exit", async () => {
		const { broker, delivered } = brokerWithLog();
		const expiring = opened(broker, { workerRequestId: "perm-exp", runId: "run-exp", deadlineAt: Date.now() + 20 });
		await new Promise((resolve) => setTimeout(resolve, 80));
		strictEqual(broker.get(expiring.requestId)?.state, "expired");
		strictEqual(
			broker.decide(expiring.requestId, { decision: "approve", issuer: "main", sessionId: "session-1" }).ok,
			false,
		);

		const canceled = opened(broker, { workerRequestId: "perm-cancel", runId: "run-cancel" });
		broker.revokeSession("session-1", "the owning main turn was canceled");
		strictEqual(broker.get(canceled.requestId)?.state, "canceled");

		const pending = opened(broker, { workerRequestId: "perm-p", runId: "run-exit" });
		broker.revokeRun("run-exit", "the worker exited", { final: true });
		strictEqual(broker.get(pending.requestId)?.state, "canceled");

		const started = opened(broker, { workerRequestId: "perm-s", runId: "run-crash" });
		ok(broker.decide(started.requestId, { decision: "approve", issuer: "main", sessionId: "session-1" }).ok);
		broker.markExecution("run-crash", "perm-s", "start");
		broker.revokeRun("run-crash", "the worker exited", { final: true });
		const crashed = broker.get(started.requestId);
		strictEqual(crashed?.state, "completed");
		strictEqual(crashed?.execution, "unknown", "a crash between side effect and report is unknown, never retried");

		const denials = delivered.filter((entry) => entry.decision === "deny").map((entry) => entry.requestId);
		deepStrictEqual(denials.sort(), [expiring.requestId, canceled.requestId, pending.requestId].sort());
		broker.dispose();
	});

	it("never lets the main agent grant an operator-authority rail", () => {
		const { broker, delivered } = brokerWithLog();
		const rail = opened(broker, { approvalAuthority: "operator" });
		const refused = broker.decide(rail.requestId, { decision: "approve", issuer: "main", sessionId: "session-1" });
		strictEqual(refused.ok, false);
		deepStrictEqual(delivered, []);
		const safety = createWorkerSafety();
		for (const attended of [true, false]) {
			const verdict = evaluateMainGrant({ record: rail, autonomy: "yolo", attended, safety });
			strictEqual(verdict.kind, attended ? "ask-operator" : "deny");
		}
		// A hard block stays blocked even for main at yolo.
		const effect = grantEffectDescriptor("bash", { command: "rm -rf /" });
		const blocked = opened(broker, {
			workerRequestId: "perm-rm",
			runId: "run-rm",
			effect,
			argDigest: grantEffectDigest(effect),
		});
		strictEqual(evaluateMainGrant({ record: blocked, autonomy: "yolo", attended: true, safety }).kind, "deny");
		broker.dispose();
	});

	it("denies at once when the main agent runs headless at default", () => {
		const { broker } = brokerWithLog();
		const record = opened(broker);
		const safety = createWorkerSafety();
		const headless = evaluateMainGrant({ record, autonomy: "default", attended: false, safety });
		strictEqual(headless.kind, "deny");
		ok(headless.kind === "deny" && /--autonomy yolo/u.test(headless.reason), JSON.stringify(headless));
		strictEqual(evaluateMainGrant({ record, autonomy: "default", attended: true, safety }).kind, "ask-operator");
		strictEqual(evaluateMainGrant({ record, autonomy: "yolo", attended: false, safety }).kind, "grant");
		broker.dispose();
	});
});

const JUDGE_CONFIG: SafetyJudgeConfig = {
	enabled: true,
	target: "local",
	model: "m",
	environment: [],
	allow: [],
	deny: [],
};

/** The main session's judge seat with a faked completion; the operator asked only to run the marker script. */
function fakeJudge(reply: () => string, config: SafetyJudgeConfig = JUDGE_CONFIG) {
	const prompts: string[] = [];
	const audits: SafetyJudgementInput[] = [];
	const judge = createSafetyJudge({
		config: () => config,
		complete: async (request) => {
			prompts.push(request.user);
			return { text: reply() };
		},
		operatorMessages: () => ["run the marker script"],
		session: () => "session-1",
		consequences: () => [],
		record: (input) => audits.push(input),
	});
	return { judge, prompts, audits };
}

const judgeAnswer = (verdict: "allow" | "block", rule: string, reason: string): string =>
	JSON.stringify({ verdict, rule, reason });

describe("safety judge worker grants (fleet.permissions.mode=judge)", () => {
	it("grants on allow, denies with the judge's reason on block, and denies on no verdict", async () => {
		const { broker } = brokerWithLog();
		const safety = createWorkerSafety();
		const record = opened(broker);
		const allow = fakeJudge(() => judgeAnswer("allow", "operator-named", "The operator asked to run the marker script."));
		deepStrictEqual(await evaluateJudgedGrant({ record, autonomy: "default", safety, judge: allow.judge }), {
			kind: "grant",
			reason: "the safety judge allowed it (rule operator-named): The operator asked to run the marker script",
		});
		const prompt = allow.prompts[0] ?? "";
		ok(prompt.includes("origin: a worker the agent dispatched (agent coder)"), prompt);
		ok(prompt.includes("command: ./mark.sh") && prompt.includes("run the marker script"), prompt);
		strictEqual(allow.audits[0]?.verdict, "allow");
		strictEqual(allow.audits[0]?.workerRunId, "run-a1", "the audit row names the worker attempt");

		const block = fakeJudge(() => judgeAnswer("block", "publish", "It publishes the build."));
		deepStrictEqual(await evaluateJudgedGrant({ record, autonomy: "default", safety, judge: block.judge }), {
			kind: "deny",
			reason: "the safety judge blocked it (rule publish): It publishes the build",
		});

		const silent = fakeJudge(() => "I am not sure.");
		const none = await evaluateJudgedGrant({ record, autonomy: "default", safety, judge: silent.judge });
		strictEqual(none.kind, "deny");
		ok(/gave no verdict \(unparsable\)/u.test(none.reason), none.reason);

		const off = fakeJudge(() => judgeAnswer("allow", "task-local", "Fine."), { ...JUDGE_CONFIG, enabled: false });
		strictEqual((await evaluateJudgedGrant({ record, autonomy: "default", safety, judge: off.judge })).kind, "deny");
		strictEqual(off.prompts.length, 0);
		// At yolo the worker inherits the main session's mode; the judge is not asked.
		strictEqual((await evaluateJudgedGrant({ record, autonomy: "yolo", safety, judge: block.judge })).kind, "grant");
		strictEqual(block.prompts.length, 1);
		broker.dispose();
	});

	it("never judges an operator-authority ask and shares the session's escalation count", async () => {
		const { broker } = brokerWithLog();
		const safety = createWorkerSafety();
		const block = fakeJudge(() => judgeAnswer("block", "publish", "It publishes the build."));
		const rail = opened(broker, { approvalAuthority: "operator" });
		strictEqual(
			(await evaluateJudgedGrant({ record: rail, autonomy: "default", safety, judge: block.judge })).kind,
			"deny",
		);
		strictEqual(block.prompts.length, 0, "an operator rail never reaches the judge");
		const record = opened(broker, { workerRequestId: "perm-2", runId: "run-b1" });
		for (let index = 0; index < 3; index += 1) {
			strictEqual((await evaluateJudgedGrant({ record, autonomy: "default", safety, judge: block.judge })).kind, "deny");
		}
		const escalated = await evaluateJudgedGrant({ record, autonomy: "default", safety, judge: block.judge });
		ok(escalated.kind === "deny" && /blocked repeatedly/u.test(escalated.reason), escalated.reason);
		strictEqual(block.prompts.length, 3, "after three blocks a worker ask is denied unjudged");
		broker.dispose();
	});
});

type WorkerEvent = AgentEvent | ClioWorkerEvent;
type Round = Array<{ name: string; arguments: string }> | { text: string };

async function runGrantWorker(
	rounds: Round[],
	onRequest: (frame: WorkerGrantRequestFrame, handle: WorkerRunHandle) => void,
	overrides: Partial<WorkerRunInput> = {},
) {
	const env = await isolateClioEnv("clio-worker-grant-");
	const previousCwd = process.cwd();
	process.chdir(env.dir);
	writeFileSync(join(env.dir, "mark.sh"), '#!/bin/sh\nprintf "x\\n" >> count.txt\n');
	chmodSync(join(env.dir, "mark.sh"), 0o755);
	const events: WorkerEvent[] = [];
	const frames: WorkerGrantRequestFrame[] = [];
	let requests = 0;
	let worker: WorkerRunHandle | undefined;
	const server = createServer(async (req, res) => {
		await readRequestBody(req);
		const round = rounds[requests] ?? rounds.at(-1) ?? { text: "done" };
		requests += 1;
		res.setHeader("content-type", "text/event-stream");
		const delta = Array.isArray(round)
			? {
					role: "assistant",
					tool_calls: round.map((call, index) => ({
						index,
						id: `call_${requests}_${index}`,
						type: "function",
						function: call,
					})),
				}
			: { role: "assistant", content: round.text };
		res.end(
			`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta, finish_reason: Array.isArray(round) ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
		);
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		worker = startWorkerRun(
			{
				agentId: "coder",
				systemPrompt: "Run the marker script when asked.",
				task: "Run ./mark.sh.",
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
				runtime: litellm,
				wireModelId: "fixture",
				apiKey: "fixture",
				thinkingLevel: "off",
				modelCapabilities: { contextWindow: 131072, maxTokens: 8192, tools: true },
				allowedTools: ["bash"],
				budget: { mode: "advisory", toolCalls: 18, readReserve: 0, synthesis: true, hardCap: 150 },
				noSkills: true,
				cwd: env.dir,
				onPermission: "escalate",
				permitAllowance: { git: "inspect", asks: "main", approvalAuthority: "main" },
				escalation: { timeoutMs: 15_000, fallback: "deny", grant: { attemptToken: TOKEN, attempt: 0 } },
				emitGrantRequest: (frame) => {
					frames.push(frame);
					const handle = worker;
					if (handle !== undefined) setImmediate(() => onRequest(frame, handle));
				},
				...overrides,
			},
			(event) => events.push(event),
		);
		const result = await worker.promise;
		const countFile = join(env.dir, "count.txt");
		const count = existsSync(countFile) ? readFileSync(countFile, "utf8") : "";
		return { result, events, frames, count };
	} finally {
		worker?.abort();
		await worker?.promise;
		await closeServer(server);
		process.chdir(previousCwd);
		env.restore();
	}
}

function resolutions(events: WorkerEvent[]) {
	return events.flatMap((event) => (event.type === "clio_coder_permission_resolved" ? [event.payload] : []));
}

describe("worker grant binding", () => {
	it("denies a mismatched decision, runs one approval once, and asks again for an identical call", {
		timeout: 30_000,
	}, async () => {
		const mark = { name: "bash", arguments: JSON.stringify({ command: "./mark.sh" }) };
		const answered: boolean[] = [];
		const run = await runGrantWorker([[mark], [mark], [mark], { text: "done" }], (frame, handle) => {
			const binding = { attemptToken: TOKEN, attempt: 0, argDigest: frame.argDigest, issuer: "main" as const };
			const index = answered.length;
			if (index === 0) {
				// Another call's digest: the worker denies instead of consuming it.
				answered.push(
					handle.resolvePermission?.(frame.requestId, "approve", { ...binding, argDigest: "0".repeat(64) }) ?? false,
				);
				answered.push(handle.resolvePermission?.(frame.requestId, "approve", binding) ?? false);
			} else if (index === 2) {
				// A duplicate delivery of the same approval is dropped, not run twice.
				answered.push(handle.resolvePermission?.(frame.requestId, "approve", binding) ?? false);
				answered.push(handle.resolvePermission?.(frame.requestId, "approve", binding) ?? false);
			} else {
				answered.push(handle.resolvePermission?.(frame.requestId, "deny", binding) ?? false);
			}
		});
		strictEqual(run.frames.length, 3, "each identical call opened its own request");
		strictEqual(new Set(run.frames.map((frame) => frame.requestId)).size, 3);
		strictEqual(new Set(run.frames.map((frame) => frame.argDigest)).size, 1, "identical calls share a digest");
		ok(run.frames.every((frame) => frame.authority === "main" && frame.effect?.tool === "bash"));
		deepStrictEqual(answered, [true, false, true, false, true]);
		strictEqual(run.count, "x\n", "the approved call ran exactly once");
		const sources = resolutions(run.events).map((payload) => `${payload.source}:${payload.decision}`);
		deepStrictEqual(sources, ["binding:denied", "main:approved", "main:denied"]);
		const executions = run.events.flatMap((event) =>
			event.type === "clio_coder_permission_grant_execution" ? [event.payload.phase] : [],
		);
		deepStrictEqual(executions, ["start", "end"]);
	});

	it("returns a host denial's reason to the model and counts it toward the refusal limit", {
		timeout: 30_000,
	}, async () => {
		const mark = (arg: string) => ({ name: "bash", arguments: JSON.stringify({ command: `./mark.sh ${arg}` }) });
		const reason = "the safety judge blocked it (rule publish): It publishes the build";
		const run = await runGrantWorker([[mark("one")], [mark("two")], [mark("three")], [mark("four")]], (frame, handle) => {
			handle.resolvePermission?.(frame.requestId, "deny", {
				attemptToken: TOKEN,
				attempt: 0,
				argDigest: frame.argDigest,
				issuer: "main",
				reason,
			});
		});
		strictEqual(run.result.exitCode, WORKER_EXIT_PERMISSION_REQUIRED);
		strictEqual(run.frames.length, 3, "the third denied ask ends the run");
		strictEqual(run.count, "");
		const resolved = resolutions(run.events).map((payload) => payload.reason ?? "");
		ok(resolved[0]?.startsWith(`permission denied: ${reason}; bash requires execute confirmation`), resolved[0]);
		ok(resolved.at(-1)?.startsWith("permission refusal limit reached"), resolved.at(-1));
	});

	it("denies at once when a headless default run has no one to grant", { timeout: 30_000 }, async () => {
		const mark = { name: "bash", arguments: JSON.stringify({ command: "./mark.sh" }) };
		const run = await runGrantWorker([[mark], { text: "done" }], () => {}, {
			escalation: {
				timeoutMs: 600_000,
				fallback: "deny",
				responder: "none",
				grant: { attemptToken: TOKEN, attempt: 0 },
			},
		});
		strictEqual(run.frames.length, 0);
		strictEqual(run.count, "");
		const resolved = resolutions(run.events);
		strictEqual(resolved.length, 1);
		ok(/no operator or granting main agent/u.test(resolved[0]?.reason ?? ""), resolved[0]?.reason);
	});
});
