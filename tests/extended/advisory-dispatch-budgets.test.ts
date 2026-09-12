import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createAdmissionQueue } from "../../src/domains/dispatch/admission-queue.js";
import { cloneRunToolBudgetEnvelope, resolveToolBudgetEnvelope } from "../../src/domains/dispatch/budget-envelope.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { createClaudeWorkerBudgetGate } from "../../src/engine/claude/sdk-runtime.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { parseWorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const base = {
	recipeId: "fixture",
	policy: { toolCalls: 2, readReserve: 1, synthesis: false },
	hardCap: 3,
	hasReadTool: true,
	retry: false,
	revision: false,
};

it("main overrides recipe recommendations and baseline, with truthful immutable round trips", () => {
	const envelope = resolveToolBudgetEnvelope({
		...base,
		request: { toolCalls: 100, readReserve: 10, retryRevision: { toolCalls: 200, readReserve: 20 } },
	});
	equal(envelope.effective.mode, "advisory");
	equal(envelope.effective.toolCalls, 100);
	equal(envelope.effective.hardCap, 3);
	equal(envelope.enforcement.perTool, "advisory");
	deepStrictEqual(cloneRunToolBudgetEnvelope(JSON.parse(JSON.stringify(envelope))), envelope);
	ok(Object.isFrozen(envelope.effective));
	equal(cloneRunToolBudgetEnvelope({ ...envelope, effective: { ...envelope.effective, mode: "enforced" } }), undefined);
	throws(
		() =>
			resolveToolBudgetEnvelope({
				...base,
				request: { toolCalls: 10, readReserve: 0, retryRevision: { toolCalls: 9, readReserve: 0 } },
			}),
		/ceiling-below-request/u,
	);
	const legacy = {
		...resolveToolBudgetEnvelope(base),
		enforcement: {
			classification: "native-per-tool",
			perTool: "enforced",
			clioControls: ["tool-calls", "read-reserve", "synthesis", "attempt-cap"],
		},
		effective: { toolCalls: 2, readReserve: 1, synthesis: false, hardCap: 3 },
	};
	deepStrictEqual(cloneRunToolBudgetEnvelope(legacy), legacy);
});

for (const synthesis of [false, true]) {
	it(`native advisory work crosses reserve, phase and baseline without lockout (synthesis=${synthesis})`, () => {
		let boundaries = 0;
		const guard = createLoopGuardRegistration({
			safety: createWorkerSafety(),
			toolCallCap: 3,
			toolCallSoftLimit: 2,
			toolCallSoftReadReserve: 1,
			toolBudgetAdvisory: true,
			turnSynthesisLockout: synthesis,
			onSynthesisLockout: () => boundaries++,
			onSoftLimitFinalCallAdmitted: () => boundaries++,
		});
		let notices = 0;
		for (let i = 0; i < 8; i++) {
			const common = {
				turnId: "work",
				toolName: ToolNames.Bash,
				toolArgs: { command: `inspect-${i}` },
				metadata: { callFingerprint: `unique-${i}` },
			};
			const before = guard.evaluate({ ...common, hook: "before_tool" });
			ok(!before.some((e) => e.kind === "block_tool" || e.kind === "require_tool"), JSON.stringify(before));
			notices += guard
				.evaluate({ ...common, hook: "after_tool" })
				.filter((e) => e.kind === "annotate_tool_result" && e.message.includes("Advisory tool estimate")).length;
		}
		equal(boundaries, 0);
		equal(notices, 1);
	});
	it(`SDK advisory calls remain admitted beyond estimates (synthesis=${synthesis})`, () => {
		let boundaries = 0;
		const gate = createClaudeWorkerBudgetGate(
			{ ...base.policy, synthesis, hardCap: 3, mode: "advisory" },
			() => boundaries++,
			() => boundaries++,
		);
		for (let i = 0; i < 8; i++) {
			equal(gate.attempt("bash").kind, "allow");
			equal(gate.admit("bash").kind, "allow");
		}
		equal(gate.phaseReached(), false);
		equal(boundaries, 0);
	});
}

it("advisory mode retains identical-call fault detection and legacy SDK enforcement", () => {
	const guard = createLoopGuardRegistration({
		safety: createWorkerSafety(),
		toolCallCap: 3,
		toolCallSoftLimit: 2,
		toolBudgetAdvisory: true,
	});
	const input = {
		hook: "before_tool" as const,
		turnId: "loop",
		toolName: ToolNames.Bash,
		toolArgs: { command: "same" },
		metadata: { callFingerprint: "same" },
	};
	guard.evaluate(input);
	guard.evaluate(input);
	ok(guard.evaluate(input).some((e) => e.kind === "block_tool"));
	const gate = createClaudeWorkerBudgetGate(
		{ ...base.policy, hardCap: 3 },
		() => {},
		() => {},
	);
	equal(gate.admit("read").kind, "allow");
	equal(gate.admit("read").kind, "allow");
	equal(gate.attempt("read").kind, "deny");
});

it("queue estimates neither expire healthy waits nor shorten explicit deadlines", async () => {
	let clock = 0;
	const queue = createAdmissionQueue<string>({ maxSize: 3, finiteCeilingMs: 1, now: () => clock });
	const request = {
		requestId: "ordinary",
		assignmentId: "ordinary",
		queuedAt: 0,
		priority: 0,
		planId: null,
		planOrder: null,
		value: "work",
	};
	const ordinary = queue.enqueue(request);
	const explicit = queue.enqueue({
		...request,
		requestId: "explicit",
		assignmentId: "explicit",
		queuedAt: 1,
		deadlineAt: 100,
	});
	clock = 50;
	equal(queue.admitNext()?.requestId, "ordinary");
	equal((await ordinary).state, "admitted");
	equal(queue.admitNext()?.requestId, "explicit");
	equal((await explicit).state, "admitted");
	const expired = queue.enqueue({ ...request, requestId: "expired", deadlineAt: 100 });
	clock = 100;
	equal(queue.admitNext(), null);
	equal((await expired).state, "timed_out");
	const canceled = queue.enqueue(request);
	equal(queue.cancel("ordinary"), true);
	equal((await canceled).state, "canceled");
});

it("ACP defaults to no elapsed turn deadline, preserves explicit positive settings, and bounds connection/permission", () => {
	equal(DEFAULT_SETTINGS.integrations.externalAgents.defaults.turnTimeoutMs, 0);
	for (const turnTimeoutMs of [0, 300_000]) {
		const parsed = validateSettings({
			version: 2,
			integrations: { externalAgents: { defaults: { turnTimeoutMs }, entries: [{ id: "peer", command: "fixture" }] } },
		});
		deepStrictEqual(parsed.issues, []);
		equal(parsed.settings.integrations.externalAgents.entries[0]?.turnTimeoutMs, turnTimeoutMs);
	}
	for (const key of ["connectTimeoutMs", "permissionTimeoutMs"]) {
		const parsed = validateSettings({ version: 2, integrations: { externalAgents: { defaults: { [key]: 0 } } } });
		ok(parsed.issues.some((issue) => issue.path.endsWith(key)));
	}
});

describe("dispatch advisory admission and explicit authority", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());
	const request = {
		agentId: "scout",
		task: "Inspect fixture.",
		executionRole: "researcher" as const,
		requestOrigin: "internal" as const,
		budget: { toolCalls: 1000, readReserve: 10 },
	};
	it("admits above session spend but still denies an explicit routing cost bound before launch", async () => {
		let starts = 0;
		const bundle = makeDispatchBundle(
			dispatchStubContext({
				scheduling: { preflight: () => ({ verdict: "over", currentUsd: 100, ceilingUsd: 1 }), checkCeiling: () => "over" },
			}),
			{
				spawnWorker: (spec) => {
					starts++;
					equal(parseWorkerSpec(JSON.parse(JSON.stringify(spec))).budget.mode, "advisory");
					throw new Error("fixture launch reached");
				},
			},
		);
		await bundle.extension.start();
		try {
			await rejects(bundle.contract.dispatch(request), /fixture launch reached/u);
			equal(starts, 1);
			await rejects(
				bundle.contract.dispatch({
					...request,
					routingIntent: {
						posture: "balanced",
						maxCostUsd: 0.000001,
						deadlineMs: null,
						minimumQuality: null,
						locality: "any",
						requiredCapabilities: [],
						failover: "none",
					},
				}),
				/budget ceiling crossed/u,
			);
			equal(starts, 1);
		} finally {
			await bundle.extension.stop?.();
		}
	});
	it("an explicit assignment deadline stops a healthy worker with a truthful timeout receipt", {
		timeout: 10_000,
	}, async () => {
		let aborts = 0;
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => {
				let finish!: (value: { exitCode: number; signal: null }) => void;
				return {
					pid: null,
					heartbeatAt: { current: Date.now(), monotonic: performance.now() },
					promise: new Promise((resolve) => {
						finish = resolve;
					}),
					events: (async function* () {})(),
					abort() {
						aborts++;
						finish({ exitCode: 1, signal: null });
					},
				};
			},
		});
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch({ ...request, assignmentDeadlineAt: Date.now() + 500 });
			const receipt = await run.finalPromise;
			equal(aborts, 1);
			equal(receipt.outcome, "canceled");
			match(receipt.outcomeDetail ?? "", /explicit assignment deadline/u);
			const envelope = bundle.contract.getRun(run.runId);
			ok(envelope);
			ok(verifyReceiptIntegrity(receipt, envelope).ok);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
