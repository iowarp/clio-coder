import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createAdmissionQueue } from "../../src/domains/dispatch/admission-queue.js";
import {
	budgetLimitWords,
	cloneRunToolBudgetEnvelope,
	formatBudgetPolicy,
	formatBudgetReasons,
	formatBudgetRequest,
	formatEffectiveBudget,
	readRecordedBudgetEnvelope,
	resolveToolBudgetEnvelope,
	workerBudgetFromEnvelope,
} from "../../src/domains/dispatch/budget-envelope.js";
import { resolveRunWall, runWallCapMs, wallClockMessage } from "../../src/domains/dispatch/run-limits.js";
import type { RunNodeIdentity } from "../../src/domains/dispatch/types.js";
import anthropic from "../../src/domains/providers/runtimes/cloud/anthropic.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { createClaudeWorkerBudgetGate } from "../../src/engine/claude/sdk-runtime.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { finishedRun, PRODUCER_INTEGRITY, runEvidenceLabels } from "../../src/tools/worker-evidence.js";
import { parseWorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const base = {
	recipeId: "fixture",
	policy: { toolCalls: 2, synthesis: false },
	hardCap: 3,
	retry: false,
	revision: false,
};

it("main overrides recipe recommendations and baseline, with truthful immutable round trips", () => {
	const envelope = resolveToolBudgetEnvelope({
		...base,
		hardCap: 300,
		request: { toolCalls: 100, retryRevision: { toolCalls: 200 } },
	});
	equal(envelope.effective.mode, "advisory");
	equal(envelope.effective.toolCalls, 100);
	equal(envelope.effective.hardCap, 300);
	equal(envelope.enforcement.perTool, "advisory");
	deepStrictEqual(cloneRunToolBudgetEnvelope(JSON.parse(JSON.stringify(envelope))), envelope);
	ok(Object.isFrozen(envelope.effective));
	equal(cloneRunToolBudgetEnvelope({ ...envelope, effective: { ...envelope.effective, mode: "enforced" } }), undefined);
	throws(
		() =>
			resolveToolBudgetEnvelope({
				...base,
				request: { toolCalls: 10, retryRevision: { toolCalls: 9 } },
			}),
		/ceiling-below-request/u,
	);
	// An enforced envelope (the retired name-keyed research budget, M12) no longer reads.
	const enforced = {
		...resolveToolBudgetEnvelope(base),
		enforcement: {
			classification: "native-per-tool",
			perTool: "enforced",
			clioControls: ["tool-calls", "read-reserve", "synthesis", "attempt-cap"],
		},
		effective: { toolCalls: 2, synthesis: false, hardCap: 3 },
	};
	equal(cloneRunToolBudgetEnvelope(enforced), undefined);
	// A pre-M12a scout envelope as its journal and receipt recorded it: live input refuses it, run history reads it as
	// recorded and shows its budget block in the words it ran under.
	const recorded = JSON.parse(
		'{"version":1,"enforcement":{"classification":"native-per-tool","perTool":"enforced","clioControls":["tool-calls","read-reserve","synthesis","attempt-cap"]},"policy":{"recipeId":"scout","default":{"toolCalls":18,"readReserve":4,"synthesis":true},"maximum":{"toolCalls":18,"readReserve":4},"exact":true},"request":null,"effective":{"mode":"enforced","toolCalls":36,"readReserve":4,"synthesis":true,"hardCap":300},"reasons":[{"code":"read-only-research-synthesis","detail":"native read-only research enters final synthesis after 36 observed tool calls"}]}',
	);
	equal(cloneRunToolBudgetEnvelope(recorded), undefined);
	const history = readRecordedBudgetEnvelope(recorded);
	ok(history !== undefined);
	deepStrictEqual(history, recorded);
	deepStrictEqual(
		[
			formatBudgetPolicy(history),
			formatBudgetRequest(history),
			formatEffectiveBudget(history),
			formatBudgetReasons(history),
			budgetLimitWords(history),
		],
		[
			"scout recipe default 18/4; read-only research allowance 36/4, synthesis=on",
			"recipe default",
			"36/4, lifetime cap 300, synthesis=on; native per-tool enforced",
			"read-only-research-synthesis",
			"answers after 36 tool calls; CLIO Coder stops it at 300",
		],
	);
});

for (const synthesis of [false, true]) {
	it(`native advisory work crosses phase and baseline without lockout (synthesis=${synthesis})`, () => {
		let boundaries = 0;
		const guard = createLoopGuardRegistration({
			safety: createWorkerSafety(),
			toolCallCap: 3,
			toolCallSoftLimit: 2,
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
	it(`SDK advisory calls stop at the admitted ceiling with delivery tools (synthesis=${synthesis})`, () => {
		let boundaries = 0;
		let hardCaps = 0;
		const gate = createClaudeWorkerBudgetGate(
			{ toolCalls: 10, synthesis, hardCap: 120, mode: "advisory", ceiling: 10 },
			() => boundaries++,
			() => hardCaps++,
			["edit"],
		);
		for (let call = 0; call < 10; call++) {
			equal(gate.attempt("edit").kind, "allow");
			equal(gate.admit("edit").kind, "allow");
		}
		equal(gate.phaseReached(), true);
		const eleventh = gate.attempt("edit");
		ok(eleventh.kind === "deny");
		match(eleventh.reason, /ceiling reached \(10\)/u);
		equal(gate.admit("edit").kind, "deny", "execution admission also closes calls attempted in parallel");
		equal(boundaries, 1);
		equal(hardCaps, 0);
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

it("queue waits without a deadline never expire and explicit deadlines are not shortened", async () => {
	let clock = 0;
	const queue = createAdmissionQueue<string>({ maxSize: 3, now: () => clock });
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
		budget: { toolCalls: 1000 },
	};
	it("denies paid dispatch above session spend and still honors an explicit routing cost bound", async () => {
		let starts = 0;
		const bundle = makeDispatchBundle(
			dispatchStubContext({
				scheduling: { preflight: () => ({ verdict: "over", currentUsd: 100, ceilingUsd: 1 }) },
			}),
			{
				spawnWorker: (spec) => {
					starts++;
					equal(parseWorkerSpec(JSON.parse(JSON.stringify(spec))).budget.mode, "enforced");
					throw new Error("fixture launch reached");
				},
			},
		);
		await bundle.extension.start();
		try {
			await rejects(bundle.contract.dispatch(request), /budget_ceiling/u);
			equal(starts, 0);
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
			equal(starts, 0);
		} finally {
			await bundle.extension.stop?.();
		}
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [{ id: "api", runtime: "anthropic", defaultModel: "claude-haiku-5-5" }];
		settings.fleet.default = { ...settings.fleet.default, target: "api", model: "claude-haiku-5-5" };
		settings.chat.maxOutputTokens = 100;
		const priced = makeDispatchBundle(dispatchStubContext({ settings, runtime: anthropic }), {
			spawnWorker: () => {
				starts++;
				throw new Error("fixture launch reached");
			},
		});
		await priced.extension.start();
		try {
			const bounded = {
				...request,
				routingIntent: {
					posture: "balanced" as const,
					maxCostUsd: 0.02,
					deadlineMs: null,
					minimumQuality: null,
					locality: "any" as const,
					requiredCapabilities: [],
					failover: "none" as const,
				},
			};
			await rejects(priced.contract.dispatch(bounded), /fixture launch/u);
			equal(starts, 1);
			await rejects(
				priced.contract.dispatch({ ...bounded, task: "Inspect the worker evidence.\n".repeat(15_000) }),
				/budget ceiling crossed/u,
			);
			equal(starts, 1);
			const reservedRequest = {
				...bounded,
				task: "Inspect the worker evidence.\n".repeat(15_000),
				routingIntent: { ...bounded.routingIntent, maxCostUsd: 1 },
			};
			const preview = priced.contract.preview?.(reservedRequest);
			const reservations = priced.contract.reservations;
			ok(preview && reservations);
			const reserved = reservations.prepare({
				topology: "pipeline",
				tasks: [{ memberId: "priced", wave: 0, resolution: preview }],
			});
			await rejects(
				priced.contract.dispatch({ ...reservedRequest, reservation: { ownerId: reserved.ownerId, memberId: "priced" } }),
				/fixture launch/u,
			);
			equal(starts, 2);
			const reconciled = reservations.get(reserved.ownerId)?.members[0]?.costUpperBoundUsd;
			ok(reconciled !== undefined && reconciled > preview.costUpperBoundUsd);
		} finally {
			await priced.extension.stop?.();
		}
	});
	it("prices a route's admission estimate at its output bound, never at one token (M6)", async () => {
		const estimate = async (maxOutputTokens: number) => {
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.targets = [{ id: "api", runtime: "anthropic", defaultModel: "claude-haiku-5-5" }];
			settings.fleet.default = { ...settings.fleet.default, target: "api", model: "claude-haiku-5-5" };
			settings.chat.maxOutputTokens = maxOutputTokens;
			const bundle = makeDispatchBundle(dispatchStubContext({ settings, runtime: anthropic }));
			await bundle.extension.start();
			try {
				const preview = bundle.contract.preview?.({ ...request, agentId: "coder", executionRole: "builder" });
				ok(preview?.costUpperBoundKnown);
				return preview.costUpperBoundUsd;
			} finally {
				await bundle.extension.stop?.();
			}
		};
		const [unset, small, larger] = [await estimate(0), await estimate(100), await estimate(200)];
		ok(larger > small, `${larger} > ${small}`);
		ok(unset > larger, `an unset budget prices the model's own output cap: ${unset} > ${larger}`);
	});
	it("previews the run's store-grant, budget, remote-node and outside-read admission (FL-13)", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "fl13-preview-")));
		let node: RunNodeIdentity = { id: "local", kind: "local" };
		const bundle = makeDispatchBundle(dispatchStubContext(), { previewNode: () => ({ node }) });
		await bundle.extension.start();
		try {
			const preview = bundle.contract.preview;
			ok(preview);
			const writer = { ...request, agentId: "coder", executionRole: "builder" as const, cwd, storeTags: ["results"] };
			throws(() => preview(writer), /store tag 'results' does not exist/u);
			await (await openStoreBackend(cwd)).getOrCreateTag("results");
			equal(preview(writer).checkedAtRun, undefined);
			node = { id: "gpu", kind: "ssh", host: "gpu.example" };
			throws(() => preview(writer), /node 'gpu' is remote and a worker there cannot reach this host's store/u);
			node = { id: "local", kind: "local" };
			const bounded = {
				posture: "balanced" as const,
				maxCostUsd: 0.000001,
				deadlineMs: null,
				minimumQuality: null,
				locality: "any" as const,
				requiredCapabilities: [],
				failover: "none" as const,
			};
			throws(() => preview({ ...request, cwd, routingIntent: bounded }), /budget ceiling crossed/u);
			const outside = { ...request, cwd, readOnly: true, externalReadRoot: cwd };
			deepStrictEqual(preview(outside).checkedAtRun, [`outside read root ${cwd}: approval is asked at run`]);
			throws(() => preview({ ...outside, cwd: tmpdir() }), /external_read_approval_required/u);
		} finally {
			await bundle.extension.stop?.();
			rmSync(cwd, { recursive: true, force: true });
		}
		const over = makeDispatchBundle(
			dispatchStubContext({ scheduling: { preflight: () => ({ verdict: "over", currentUsd: 100, ceilingUsd: 1 }) } }),
		);
		await over.extension.start();
		try {
			throws(() => over.contract.preview?.(request), /budget_ceiling/u);
		} finally {
			await over.extension.stop?.();
		}
	});
	it("gives an advisory worker a hard ceiling at the recipe maximum and refuses one on an enforced budget", async () => {
		const policy = { toolCalls: 20, synthesis: false, maximum: { toolCalls: 40 } };
		const advisory = { ...base, policy, hardCap: 150 };
		equal(workerBudgetFromEnvelope(resolveToolBudgetEnvelope(advisory)).ceiling, 40);
		equal(workerBudgetFromEnvelope(resolveToolBudgetEnvelope({ ...advisory, hardCap: 30 })).ceiling, 30);
		const admitted = resolveToolBudgetEnvelope({ ...advisory, request: { toolCalls: 50 } });
		equal(workerBudgetFromEnvelope(admitted).ceiling, 50);
		const noMaximum = { ...base, policy: { toolCalls: 50, synthesis: false }, hardCap: 400 };
		equal(workerBudgetFromEnvelope(resolveToolBudgetEnvelope(noMaximum)).ceiling, 400);
		// The operator's cap holds against the recipe's own estimate and a request alike (M6).
		equal(workerBudgetFromEnvelope(resolveToolBudgetEnvelope({ ...noMaximum, hardCap: 30 })).ceiling, 30);
		const raised = resolveToolBudgetEnvelope({ ...advisory, request: { toolCalls: 1000 } });
		equal(workerBudgetFromEnvelope(raised).ceiling, 150);
		ok(raised.reasons.some((reason) => reason.code === "global-cap-clamp"));
		deepStrictEqual(cloneRunToolBudgetEnvelope(JSON.parse(JSON.stringify(raised))), raised);
		// The card's growth note follows the revision left after the cap: none when the cap folded it away.
		const growth = (hardCap: number) =>
			budgetLimitWords(
				resolveToolBudgetEnvelope({
					...advisory,
					hardCap,
					request: { toolCalls: 50, retryRevision: { toolCalls: 200 } },
				}),
			);
		equal(
			growth(150),
			"planned for about 50 tool calls; CLIO Coder stops it at 150 (lowered to CLIO Coder's overall limit; about 150 if it has to redo its answer)",
		);
		equal(growth(50), "CLIO Coder stops it at 50 tool calls (lowered to CLIO Coder's overall limit)");
		ok(
			!resolveToolBudgetEnvelope({
				...advisory,
				hardCap: 50,
				request: { toolCalls: 50, retryRevision: { toolCalls: 200 } },
			}).reasons.some((reason) => reason.code === "revision-growth-authorized"),
		);

		let observed: unknown;
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: (spec) => {
				observed = JSON.parse(JSON.stringify(spec));
				throw new Error("fixture launch reached");
			},
		});
		await bundle.extension.start();
		try {
			await rejects(
				bundle.contract.dispatch({
					agentId: "coder",
					task: "Edit fixture.",
					executionRole: "builder",
					requestOrigin: "internal",
					budget: { toolCalls: 1000 },
				}),
				/fixture launch/u,
			);
		} finally {
			await bundle.extension.stop?.();
		}
		const spec = observed as { budget: Record<string, unknown> };
		equal(spec.budget.mode, "advisory");
		equal(parseWorkerSpec(spec).budget.ceiling, DEFAULT_SETTINGS.fleet.limits.toolCallsPerRun);
		throws(
			() => parseWorkerSpec({ ...spec, budget: { ...spec.budget, mode: "enforced" } }),
			/ceiling applies only to advisory budgets/u,
		);
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
			// A deadline is a bound, not an operator action: it seals timed_out (DESIGN 4.5, M8).
			equal(receipt.outcome, "timed_out");
			match(receipt.outcomeDetail ?? "", /explicit assignment deadline/u);
			const envelope = bundle.contract.getRun(run.runId);
			ok(envelope);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

describe("the run wall clock (DESIGN 4.5, fleet M8)", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());
	const checkout = (): string => {
		const repo = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "clio-coder-wall-")));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
		git("init", "-q");
		git("config", "user.name", "Contract");
		git("config", "user.email", "contract@example.invalid");
		writeFileSync(join(repo, "base.txt"), "base\n");
		git("add", ".");
		git("commit", "-qm", "base");
		return repo;
	};
	const coder = (cwd: string) => ({
		agentId: "coder",
		task: "Port every module in src/ to the new API.",
		executionRole: "builder" as const,
		requestOrigin: "internal" as const,
		cwd,
	});
	const partial = (cwd: string): void => {
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "partial.ts"), "export const ported = 1;\n");
	};

	it("the wall clock only lowers, and a spec without agreeing sealed limits is refused", async () => {
		// The cap is the operator's; a recipe or an earlier deadline lowers it, nothing raises it.
		deepStrictEqual(resolveRunWall({ capMs: 1_800_000, startedAt: 1000 }), { wallMs: 1_800_000, deadlineAt: 1_801_000 });
		deepStrictEqual(resolveRunWall({ capMs: 1_800_000, recipeMs: 60_000, startedAt: 1000 }), {
			wallMs: 60_000,
			deadlineAt: 61_000,
		});
		deepStrictEqual(resolveRunWall({ capMs: 60_000, recipeMs: 600_000, startedAt: 1000, deadlineAt: 11_000 }), {
			wallMs: 10_000,
			deadlineAt: 11_000,
		});
		equal(runWallCapMs(DEFAULT_SETTINGS.fleet.limits, "internal"), DEFAULT_SETTINGS.fleet.limits.internalRunTimeoutMs);
		equal(runWallCapMs(DEFAULT_SETTINGS.fleet.limits, "user"), 1_800_000);
		// The worker keeps working and the host's 85% handback asks for the report; a quit cue made coders stop at 13 s.
		const wallLine = wallClockMessage(120_000);
		match(wallLine, /Keep working/u);
		match(wallLine, /At 85% the host withdraws your tools and asks for your report/u);
		ok(!/stops as timed out/u.test(wallLine), wallLine);
		let observed: unknown;
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: (spec) => {
				observed = JSON.parse(JSON.stringify(spec));
				throw new Error("fixture launch reached");
			},
		});
		await bundle.extension.start();
		try {
			await rejects(bundle.contract.dispatch(coder(process.cwd())), /fixture launch/u);
		} finally {
			await bundle.extension.stop?.();
		}
		const spec = observed as { limits: Record<string, unknown> & { time: { deadlineAt: number } } };
		const parsed = parseWorkerSpec(spec);
		ok(parsed.limits.time.handbackAt < parsed.limits.time.deadlineAt);
		equal(parsed.limits.tools.ceiling, parsed.budget.ceiling ?? parsed.budget.hardCap);
		const { limits: _limits, ...withoutLimits } = spec;
		throws(() => parseWorkerSpec(withoutLimits), /limits/u);
		throws(() => parseWorkerSpec({ ...spec, limits: { ...spec.limits, tools: { ceiling: 1 } } }), /ceiling/u);
		throws(
			() =>
				parseWorkerSpec({
					...spec,
					limits: { ...spec.limits, time: { ...spec.limits.time, handbackAt: spec.limits.time.deadlineAt + 1 } },
				}),
			/handbackAt must not be after deadlineAt/u,
		);
	});

	it("a coder the wall clock moved to handback seals timed_out with its report and the paths it changed", {
		timeout: 20_000,
	}, async () => {
		const repo = checkout();
		const report = "PARTIAL REPORT: ported src/partial.ts; 11 modules remain.";
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => {
				partial(repo);
				return {
					pid: null,
					heartbeatAt: { current: Date.now(), monotonic: performance.now() },
					promise: Promise.resolve({ exitCode: 0, signal: null }),
					events: (async function* () {
						yield {
							type: "clio_coder_run_outcome",
							payload: {
								outcomeCode: "worker_run_timeout",
								detail: "worker_run_timeout: the run reached 85% of its 1800 s wall clock and handed back its report",
							},
						};
						yield { type: "message_end", message: { role: "assistant", stopReason: "stop", content: report } };
					})(),
					abort() {},
				};
			},
		});
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch(coder(repo));
			const receipt = await run.finalPromise;
			equal(receipt.outcome, "timed_out");
			deepStrictEqual(receipt.checkoutChanges?.changedPaths, ["src/partial.ts"]);
			ok(JSON.stringify(receipt).includes("11 modules remain"), "the receipt keeps the handback report");
			match(receipt.outcomeDetail ?? "", /wall clock/u);
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("a run stopped at the wall with a tool call in flight after handback says it wrote no report", {
		timeout: 20_000,
	}, async () => {
		// The host's deadline abort is a stop; a worker that exits on its own after the handback is described by its exit.
		for (const shape of ["host-timeout", "crash"] as const) {
			const repo = checkout();
			let stopped: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void = () => {};
			const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
				stopped = resolve;
			});
			let handedBack: () => void = () => {};
			const atHandback = new Promise<void>((resolve) => {
				handedBack = resolve;
			});
			const bundle = makeDispatchBundle(dispatchStubContext(), {
				spawnWorker: () => {
					partial(repo);
					return {
						pid: null,
						heartbeatAt: { current: Date.now(), monotonic: performance.now() },
						promise: shape === "crash" ? Promise.resolve({ exitCode: 1, signal: "SIGTERM" as const }) : exited,
						events: (async function* () {
							yield { type: "clio_coder_tool_start", payload: { tool: "bash", toolCallId: "call-sleep" } };
							yield {
								type: "clio_coder_run_outcome",
								payload: {
									outcomeCode: "worker_run_timeout",
									detail: "worker_run_timeout: the run reached 85% of its 120 s wall clock and handed back its report",
								},
							};
							if (shape === "host-timeout") {
								handedBack();
								await exited;
								return;
							}
							yield {
								type: "clio_coder_run_outcome",
								payload: {
									outcomeCode: "worker_final_output_missing",
									detail: "worker loop ended without a final assistant output (stopReason=aborted)",
								},
							};
						})(),
						abort() {
							stopped({ exitCode: null, signal: "SIGTERM" });
						},
					};
				},
			});
			await bundle.extension.start();
			try {
				const run = await bundle.contract.dispatch(coder(repo));
				if (shape === "host-timeout") {
					await atHandback;
					bundle.contract.abort(run.runId, { cause: "timeout", detail: "timed out: run wall clock reached" });
				}
				const receipt = await run.finalPromise;
				equal(receipt.outcome, "timed_out", shape);
				const detail = receipt.outcomeDetail ?? "";
				ok(!/handed back its report/u.test(detail), `the detail claims a report that never came: ${detail}`);
				ok(!/conflicting trusted outcome codes/u.test(detail), `handback then no report is one story: ${detail}`);
				if (shape === "host-timeout") {
					match(detail, /reached the wall clock with 1 tool call \(bash\) still running before it wrote a report/u);
					match(detail, /the host stopped it with SIGTERM, so it handed back no report/u);
				} else {
					match(detail, /it exited \(exit code 1, signal SIGTERM\) before it wrote a report, so it handed back no report/u);
					ok(!/host stopped|reached the wall clock/u.test(detail), `the host never stopped this run: ${detail}`);
				}
			} finally {
				await bundle.extension.stop?.();
				rmSync(repo, { recursive: true, force: true });
			}
		}
	});

	it("a timed-out worktree coder names the host's changed paths and the unmerged branch that holds them", {
		timeout: 20_000,
	}, async () => {
		const repo = checkout();
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: (spec) => {
				const tree = (spec as { taskWorktree?: { path: string } }).taskWorktree?.path;
				if (tree !== undefined) partial(tree);
				return {
					pid: null,
					heartbeatAt: { current: Date.now(), monotonic: performance.now() },
					promise: Promise.resolve({ exitCode: 0, signal: null }),
					events: (async function* () {
						yield { type: "tool_execution_start", toolCallId: "w", toolName: "write", args: { path: "src/partial.ts" } };
						yield { type: "tool_execution_end", toolCallId: "w", toolName: "write", isError: false };
						yield { type: "clio_coder_tool_finish", payload: { tool: "write", outcome: "ok", durationMs: 1 } };
						yield {
							type: "clio_coder_run_outcome",
							payload: { outcomeCode: "worker_run_timeout", detail: "worker_run_timeout: the run reached 85%" },
						};
						yield {
							type: "message_end",
							message: { role: "assistant", stopReason: "stop", content: "Ported src/claimed.ts; 11 remain." },
						};
					})(),
					abort() {},
				};
			},
		});
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch({ ...coder(repo), worktree: true });
			const receipt = await run.finalPromise;
			equal(receipt.outcome, "timed_out");
			const branch = `clio-coder/task/${receipt.runId}`;
			equal(receipt.worktree?.branch, branch);
			equal(receipt.worktree?.applied, false);
			deepStrictEqual(receipt.worktree?.changedPaths, ["src/partial.ts"]);
			equal(
				execFileSync("git", ["show", `${branch}:src/partial.ts`], { cwd: repo, encoding: "utf8" }),
				"export const ported = 1;\n",
			);
			const detail = receipt.outcomeDetail ?? "";
			ok(detail.includes(`unmerged on ${branch}`), detail);
			ok(detail.includes(`clio-coder fleet land ${branch} --yes`), detail);
			const labels = runEvidenceLabels(finishedRun(receipt), PRODUCER_INTEGRITY).join(" ");
			ok(labels.includes('changed=1["src/partial.ts"]'), labels);
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("a coder the host stops at fleet.limits.runTimeoutMs seals timed_out with the paths it changed", {
		timeout: 20_000,
	}, async () => {
		const repo = checkout();
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.limits.runTimeoutMs = 400;
		settings.fleet.limits.internalRunTimeoutMs = 400;
		let aborts = 0;
		let wallMs: number | undefined;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			spawnWorker: (spec) => {
				wallMs = (spec as { limits?: { time: { wallMs: number } } }).limits?.time.wallMs;
				partial(repo);
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
			const run = await bundle.contract.dispatch(coder(repo));
			const receipt = await run.finalPromise;
			ok(wallMs !== undefined && wallMs <= 400, `the sealed wall clock is the setting's: ${wallMs}`);
			equal(aborts, 1);
			equal(receipt.outcome, "timed_out");
			deepStrictEqual(receipt.checkoutChanges?.changedPaths, ["src/partial.ts"]);
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
