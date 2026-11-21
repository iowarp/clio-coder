import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainName } from "../../src/core/domain-loader.js";
import type { AgentSpec } from "../../src/domains/agents/spec.js";
import {
	admit,
	createCapacityAdmissionController,
	foregroundEndpointBlock,
} from "../../src/domains/dispatch/admission.js";
import { AdmissionCanceledError, AdmissionTimedOutError } from "../../src/domains/dispatch/admission-error.js";
import type { AdmissionQueueRequest } from "../../src/domains/dispatch/admission-queue.js";
import { createAdmissionQueue, orderAdmissionRequests } from "../../src/domains/dispatch/admission-queue.js";
import { assessCapabilityMismatch } from "../../src/domains/dispatch/capability-match.js";
import type { CapacityLease, LeaseOwnerProbe } from "../../src/domains/dispatch/capacity-lease.js";
import {
	acquireCapacityLease,
	capacityLeaseUsage,
	capacityStateLockPath,
	claimLeaseCacheLane,
	claimMainCacheLane,
	processBirthToken,
	readCapacityStateUnsafe,
	releaseMainCacheLanes,
} from "../../src/domains/dispatch/capacity-lease.js";
import { admissionWriteBoundaries } from "../../src/domains/dispatch/extension.js";
import { isBoundedGateRolePrompt, REVIEWER_GATE_PROMPT } from "../../src/domains/dispatch/gate-role-prompts.js";
import { normalizeDispatchIntent } from "../../src/domains/dispatch/intent.js";
import {
	architectPlanOutsideWriteRoots,
	classifyDispatchIntentCompatibility,
} from "../../src/domains/dispatch/intent-compatibility.js";
import {
	declaredScopeReplacementNotice,
	inferredScopeParentTokenNotice,
	resolveDispatchPathScope,
} from "../../src/domains/dispatch/path-scope.js";
import {
	DISPATCH_BRIEFING_MAX_BYTES,
	INTERNAL_DISPATCH_BRIEFING_MAX_BYTES,
	validateJobSpec,
} from "../../src/domains/dispatch/validation.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { writerSetConflict } from "../../src/domains/dispatch/writer-set.js";
import { endpointCapacityFor } from "../../src/domains/providers/endpoint-capacity.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import claudeCodeRuntime from "../../src/domains/providers/runtimes/claude/claude-code.js";
import anthropic from "../../src/domains/providers/runtimes/cloud/anthropic.js";
import copilotSdkRuntime from "../../src/domains/providers/runtimes/copilot/copilot-sdk.js";
import { isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { planFacts, readDispatchPlan } from "../../src/interactive/dispatch-plan-summary.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { createDispatchAdmissionController } from "../../src/tools/dispatch-admission.js";
import { dispatchRequestsFromArgs } from "../../src/tools/dispatch-arguments.js";
import { normalizeDispatchAdmission } from "../../src/tools/dispatch-normalize.js";
import { DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT, describeDispatchPlan } from "../../src/tools/dispatch-plan.js";
import type { DispatchToolDeps } from "../../src/tools/dispatch-types.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

function queued(id: string, priority = 0): AdmissionQueueRequest<string> {
	return {
		requestId: id,
		assignmentId: id,
		priority,
		queuedAt: 10,
		deadlineAt: 1_000,
		planId: null,
		planOrder: null,
		value: id,
	};
}

function agent(id: string, capabilityClass: AgentSpec["capabilityClass"]): AgentSpec {
	return { id, capabilityClass } as AgentSpec;
}

/**
 * Stand in for another live Clio process holding the shared admission lock:
 * this host, a live pid that is not ours, no birth token to contradict it.
 */
function holdCapacityLockAsPeer(): () => void {
	const lockPath = `${capacityStateLockPath()}.lock`;
	mkdirSync(dirname(lockPath), { recursive: true });
	writeFileSync(lockPath, `${JSON.stringify({ host: hostname(), pid: process.ppid, at: new Date().toISOString() })}\n`);
	return () => rmSync(lockPath, { force: true });
}

async function settledWithin<T>(promise: Promise<T>, turns: number): Promise<boolean> {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let turn = 0; turn < turns && !settled; turn += 1) await sleep(5);
	return settled;
}

function capacityLimit(capacity: ReturnType<typeof endpointCapacityFor>): number {
	if (capacity === null) throw new TypeError("expected endpoint capacity");
	return capacity.limit;
}

describe("dispatch admission boundary", () => {
	it("validates harness origin only with an explicit read-only request and the internal briefing ceiling", () => {
		const request = { agentId: "scout", task: "Inspect the source", requestOrigin: "harness" };
		for (const candidate of [request, { ...request, readOnly: false }]) {
			deepStrictEqual(validateJobSpec(candidate), {
				ok: false,
				errors: ["requestOrigin harness requires readOnly true"],
			});
		}
		const validated = validateJobSpec({ ...request, readOnly: true });
		ok(validated.ok);
		strictEqual(validated.spec.requestOrigin, "harness");
		strictEqual(validated.spec.readOnly, true);
		ok(validateJobSpec({ ...request, readOnly: true, briefing: "x".repeat(DISPATCH_BRIEFING_MAX_BYTES + 1) }).ok);
		deepStrictEqual(
			validateJobSpec({ ...request, readOnly: true, briefing: "x".repeat(INTERNAL_DISPATCH_BRIEFING_MAX_BYTES + 1) }),
			{ ok: false, errors: [`briefing must be ${INTERNAL_DISPATCH_BRIEFING_MAX_BYTES} UTF-8 bytes or fewer`] },
		);
		deepStrictEqual(validateJobSpec({ ...request, requestOrigin: "unknown" }), {
			ok: false,
			errors: ["requestOrigin must be one of: user|agent|internal|harness"],
		});
	});

	it("refuses a harness-origin coder in dispatch and preview and admits shadow Scout to worker creation", async () => {
		let starts = 0;
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => {
				starts += 1;
				throw new Error("fixture: Scout passed harness admission");
			},
		});
		await bundle.extension.start();
		try {
			const request = {
				task: "Inspect the source without editing files",
				executionRole: "builder" as const,
				requestOrigin: "harness" as const,
				readOnly: true,
			};
			await rejects(bundle.contract.dispatch({ ...request, agentId: "coder" }), {
				message: "dispatch: harness-origin runs require a read-only recipe; 'coder' is workspace-edit",
			});
			// A plan preview refuses what dispatch refuses, so no approved plan carries a run admission will reject.
			throws(() => bundle.contract.preview?.({ ...request, agentId: "coder" }), {
				message: "dispatch: harness-origin runs require a read-only recipe; 'coder' is workspace-edit",
			});
			strictEqual(starts, 0);
			await rejects(bundle.contract.dispatch({ ...request, agentId: "scout" }), {
				message: "fixture: Scout passed harness admission",
			});
			strictEqual(starts, 1);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("admits a harness Scout task mentioning test only when empty typed intent is declared", async () => {
		let starts = 0;
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => {
				starts += 1;
				throw new Error("fixture: typed harness Scout passed admission");
			},
		});
		await bundle.extension.start();
		try {
			const request = {
				agentId: "scout",
				task: "Add a test that runs this repository's build commands.",
				executionRole: "researcher" as const,
				requestOrigin: "harness" as const,
				readOnly: true,
			};
			await rejects(bundle.contract.dispatch(request), /read-only recipe.*task classifies as test/u);
			throws(() => bundle.contract.preview?.(request), /read-only recipe.*task classifies as test/u);
			strictEqual(starts, 0);
			const declared = normalizeDispatchIntent(
				{ read_roots: [], write_roots: [], relevant_paths: [], expected_outputs: [], verification: [] },
				new Map(),
			);
			ok(declared.ok);
			await rejects(bundle.contract.dispatch({ ...request, intent: declared.intent }), {
				message: "fixture: typed harness Scout passed admission",
			});
			strictEqual(starts, 1);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("refuses a same-endpoint foreground deadlock without spending the queue timeout", () => {
		const detail = foregroundEndpointBlock({
			endpointKey: "http://127.0.0.1:1234/v1",
			limits: { global: 4, nodes: {}, endpoints: { "http://127.0.0.1:1234/v1": 1 } },
			usage: {
				endpoints: { "http://127.0.0.1:1234/v1": 1 },
				endpointHolders: {
					"http://127.0.0.1:1234/v1": { leases: 0, reservations: 0, foregroundStreams: 1 },
				},
			},
		});
		match(detail ?? "", /cannot release its slot.*deadlock/u);
	});

	it("keeps ordinary worker saturation queueable", () => {
		strictEqual(
			foregroundEndpointBlock({
				endpointKey: "endpoint",
				limits: { global: 4, nodes: {}, endpoints: { endpoint: 1 } },
				usage: {
					endpoints: { endpoint: 1 },
					endpointHolders: { endpoint: { leases: 1, reservations: 0, foregroundStreams: 0 } },
				},
			}),
			null,
		);
	});

	it("queues behind a worker lease sharing a full endpoint with a foreground stream, and refuses only when foreground streams fill it", () => {
		const check = (holders: { leases: number; reservations: number; foregroundStreams: number }) =>
			foregroundEndpointBlock({
				endpointKey: "endpoint",
				limits: { global: 4, nodes: {}, endpoints: { endpoint: 2 } },
				usage: { endpoints: { endpoint: 2 }, endpointHolders: { endpoint: holders } },
			});
		strictEqual(check({ leases: 1, reservations: 0, foregroundStreams: 1 }), null);
		match(check({ leases: 0, reservations: 0, foregroundStreams: 2 }) ?? "", /cannot release its slot.*deadlock/u);
	});

	beforeEach(async () => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("hands out prompt cache lanes across processes: workers on their lease, main sessions beside it, both freed with their owner (M-11)", () => {
		const peer = { pid: 999_001, token: "peer-birth" };
		let peerAlive = true;
		const probe: LeaseOwnerProbe = {
			birthToken: (pid) => (pid === peer.pid ? (peerAlive ? peer.token : null) : processBirthToken(pid)),
			tokenProvesDeath: true,
		};
		const limits = { global: 4, nodes: { local: 4 }, endpoints: {} };
		const asPeer = { ownerPid: peer.pid, processBirthToken: peer.token, probe };
		// Another process's main session holds lane 0; this process's sessions take the next lanes and keep them.
		strictEqual(claimMainCacheLane({ key: "head", conversation: "peer-session", ...asPeer }), 0);
		strictEqual(claimMainCacheLane({ key: "head", conversation: "ours", probe }), 1);
		strictEqual(claimMainCacheLane({ key: "head", conversation: "ours", probe }), 1, "a held lane is kept");
		strictEqual(claimMainCacheLane({ key: "other head", conversation: "elsewhere", probe }), 0);
		// Workers take lanes on their leases, and no capacity reader counts a main session's lane.
		const peerLease = acquireCapacityLease({ assignmentId: "peer-worker", nodeId: "local", limits, ...asPeer });
		const ownLease = acquireCapacityLease({ assignmentId: "own-worker", nodeId: "local", limits, probe });
		strictEqual(claimLeaseCacheLane(peerLease.leaseId, "worker head", { probe }), 0);
		strictEqual(claimLeaseCacheLane(ownLease.leaseId, "worker head", { probe }), 1);
		deepStrictEqual(readCapacityStateUnsafe().leases.find((lease) => lease.leaseId === ownLease.leaseId)?.cacheLane, {
			key: "worker head",
			lane: 1,
		});
		strictEqual(capacityLeaseUsage({ probe }).global, 2);
		// The peer dies: its lease and its main lane are reaped by owner pid and birth token, and both lanes free.
		peerAlive = false;
		strictEqual(claimMainCacheLane({ key: "head", conversation: "next", probe }), 0);
		const later = acquireCapacityLease({ assignmentId: "later-worker", nodeId: "local", limits, probe });
		strictEqual(claimLeaseCacheLane(later.leaseId, "worker head", { probe }), 0);
		// A released conversation resumed in another process takes its old lane back while it is free.
		releaseMainCacheLanes(undefined);
		strictEqual(claimMainCacheLane({ key: "head", conversation: "ours", probe }), 1);
		strictEqual(claimMainCacheLane({ key: "head", conversation: "fresh", probe }), 0);
	});

	it("states each run's bounds on the plan card: a priced estimate at the output bound, else only the timers and tool ceiling it has (M6)", async () => {
		const planText = async (
			runtime: RuntimeDescriptor,
			model: string,
			maxOutputTokens = 0,
			extra: Record<string, unknown> = {},
		) => {
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.targets = [
				{
					id: "api",
					runtime: runtime.id,
					defaultModel: model,
					...(runtime.kind === "subprocess" ? { trustedUnmediated: true } : {}),
				},
			];
			settings.fleet.default = { ...settings.fleet.default, target: "api", model };
			settings.chat.maxOutputTokens = maxOutputTokens;
			const context = dispatchStubContext({ settings, runtime });
			const bundle = makeDispatchBundle(context);
			await bundle.extension.start();
			try {
				const tool = createDispatchTool({
					dispatch: bundle.contract,
					getAgentSpecs: () => context.getContract("agents")?.listSpecs() ?? [],
					getAutonomy: () => "yolo",
				});
				const prepared = tool.prepareAdmissionArguments?.({
					agent: "coder",
					mode: "sequential",
					budget: { toolCalls: 1000 },
					tasks: [{ task: "Rename the helper." }, { task: "Update its callers." }],
					...extra,
				});
				ok(prepared);
				strictEqual(prepared[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT], undefined);
				const text = tool.describeDispatchPlan?.(prepared).text ?? "";
				tool.disposeAdmissionArguments?.(prepared);
				return text;
			} finally {
				await bundle.extension.stop?.();
			}
		};
		// A Copilot subscription route has no rates: its card names only the bounds that do stop it.
		const unpriced = await planText(copilotSdkRuntime, "gpt-6-luna");
		match(
			unpriced,
			/limits: unpriced route: each response stops at 600 s, and the run stops at its 1800000 ms wall clock; CLIO Coder stops it at 300 tool calls/u,
		);
		// The approval card's Plan rows carry the same limits text the plan signs, once when both workers share it.
		const card = readDispatchPlan(unpriced);
		ok(card);
		const cardLimits = planFacts(card).filter((fact) => fact.label === "limits");
		strictEqual(cardLimits.length, 1, unpriced);
		ok(unpriced.split("\n").includes(`    limits: ${cardLimits[0]?.value}`), unpriced);
		match(cardLimits[0]?.value ?? "", /CLIO Coder stops it at 300 tool calls/u);
		match(
			await planText(copilotSdkRuntime, "gpt-6-luna", 0, { timeout_ms: 120000 }),
			/limits: unpriced route: each response stops at 600 s, and the call's timeout_ms stops the run within 120000 ms; CLIO Coder stops it at 300 tool calls/u,
		);
		// An external one-shot worker's tool calls are not counted, so no tool ceiling is promised.
		const external = await planText(claudeCodeRuntime, "claude-haiku-5-5");
		match(external, /limits: .*one launch whose tool calls CLIO Coder cannot count, so no tool ceiling applies/u);
		ok(!/CLIO Coder stops it at/u.test(external), external);
		const priced = (maxOutputTokens: number) => planText(anthropic, "claude-haiku-5-5", maxOutputTokens);
		const estimate = (text: string) => /limits: cost (~\S+ est) per model call at a (\d+)-token output bound/u.exec(text);
		const [small, large] = [estimate(await priced(100)), estimate(await priced(4000))];
		strictEqual(small?.[2], "100");
		strictEqual(large?.[2], "4000");
		ok(small?.[1] !== large?.[1], `${small?.[1]} moves with the output bound to ${large?.[1]}`);
	});

	it("runs a 6-task plan on a 4-slot endpoint as two waves with a notice, not a refusal (M8)", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{ id: "local", runtime: "openai", defaultModel: "gpt-4o", url: "http://127.0.0.1:9/v1", maxConcurrentRequests: 4 },
		];
		settings.fleet.default = { ...settings.fleet.default, target: "local", model: "gpt-4o" };
		const context = dispatchStubContext({ settings });
		const bundle = makeDispatchBundle(context);
		await bundle.extension.start();
		try {
			const admission = createDispatchAdmissionController({
				dispatch: bundle.contract,
				getAgentSpecs: () => context.getContract("agents")?.listSpecs() ?? [],
				getAutonomy: () => "yolo",
			} as DispatchToolDeps);
			const prepared = admission.prepareAdmissionArguments({
				agent: "scout",
				mode: "parallel",
				tasks: [1, 2, 3, 4, 5, 6].map((n) => ({ task: `Inspect module ${n} of the fixture.` })),
			});
			ok(prepared);
			strictEqual(prepared[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT], undefined, JSON.stringify(prepared));
			const snapshot = admission.state.trustedExecutionSnapshots.get(prepared);
			const notices = snapshot?.kind === "dispatch" ? (snapshot.notices ?? []) : [];
			match(notices.join("\n"), /^dispatch waves: the 6 tasks run as 2 waves of at most 4,/mu, JSON.stringify(notices));
			admission.disposeAdmissionArguments(prepared);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("preserves declared intent through admission when briefing quotes an absolute workspace", async () => {
		const context = dispatchStubContext();
		const agents = context.getContract("agents");
		ok(agents);
		const bundle = makeDispatchBundle(context, {
			spawnWorker: () => {
				throw new Error("preparation must not spawn a worker");
			},
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({
				dispatch: bundle.contract,
				getAgentSpecs: () => agents.listSpecs(),
				getAutonomy: () => "yolo",
			});
			ok(tool.prepareAdmissionArguments);
			for (const workspace of ["/tmp/source-repository.", "C:\\work\\source-repository."]) {
				for (const count of [1, 2]) {
					const prepared = tool.prepareAdmissionArguments({
						agent: "coder",
						mode: "pipeline",
						briefing: `The inspected workspace is ${workspace}`,
						intent: { read_roots: ["slugify/slugify.py", "test.py"], expected_outputs: [] },
						tasks: Array.from({ length: count }, () => ({
							task: "Explain smart_truncate from the declared source; do not edit files.",
						})),
					});
					strictEqual(prepared[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT], undefined);
					const plan = tool.describeDispatchPlan?.(prepared);
					ok(plan);
					strictEqual(plan.topology, "pipeline");
					strictEqual(plan.taskCount, count);
					for (const task of plan.tasks) {
						deepStrictEqual(task.intent?.readRoots, ["slugify/slugify.py", "test.py"]);
						deepStrictEqual(task.intent?.writeRoots, []);
					}
					ok(!plan.text.includes("scope mode=legacy-inferred"));
					tool.disposeAdmissionArguments?.(prepared);
				}
			}
			const legacy = tool.prepareAdmissionArguments({
				task: "Explain the source",
				briefing: "Workspace /tmp/source-repository.",
				agent: "coder",
			});
			match(String(legacy[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT]), /legacy_scope_path_absolute/u);
			// A home path names no repository path, and is not read as the absolute path after its tilde (bt-11 r).
			const home = tool.prepareAdmissionArguments({
				task: "Explain the source",
				briefing: "My notes are in ~/notes/plan.md.",
				agent: "coder",
			});
			strictEqual(home[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT], undefined);
			tool.disposeAdmissionArguments?.(home);
			const invalid = tool.prepareAdmissionArguments({
				task: "Explain the source",
				agent: "coder",
				intent: { read_roots: ["../outside"] },
			});
			ok(typeof invalid[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT] === "string");
			strictEqual(bundle.contract.listRuns().length, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("refuses a pinned read-only recipe for a mutation and admits sound capability pairings", () => {
		const specs = [agent("verifier", "verification"), agent("coder", "workspace-edit")];
		const mismatch = assessCapabilityMismatch({
			agentId: "verifier",
			capabilityClass: "verification",
			task: "Fix the off-by-one bug in src/sum.ts",
			autoSelected: false,
			resultContractKind: "verifier-report",
			specs,
		});
		strictEqual(mismatch?.verdict, "refuse");
		strictEqual(mismatch?.suggestedAgentId, "coder");
		strictEqual(
			assessCapabilityMismatch({
				agentId: "coder",
				capabilityClass: "workspace-edit",
				task: "Fix the off-by-one bug in src/sum.ts",
				autoSelected: false,
				resultContractKind: "mutation-report",
				specs,
			}),
			null,
		);
	});

	it("admits Scout investigation wording without authorizing configuration writes", () => {
		const specs = [agent("scout", "read-only"), agent("coder", "workspace-edit")];
		const assess = (task: string) =>
			assessCapabilityMismatch({
				agentId: "scout",
				capabilityClass: "read-only",
				task,
				autoSelected: false,
				resultContractKind: "scout-report",
				specs,
			});
		for (const task of [
			'Find where clio-coder captures or could capture environment awareness (machine name, user name) during init/configure/context bootstrap. Look at: src/domains/context/bootstrap.ts, src/cli/configure.ts, src/cli/context.ts, and any settings/state files that store environment info. Report the relevant code paths, existing patterns for storing config, and where a new "environment" field would fit naturally.',
			"Find where to add environment awareness",
			"Find where the config loader stores settings",
			"Look at the config loader and identify extension points",
		]) {
			const mismatch = assess(task);
			ok(mismatch === null || mismatch.verdict === "flag", task);
		}
		for (const task of [
			"Add environment awareness to the config loader",
			"Write the report to disk",
			"Find and fix the bug",
		]) {
			strictEqual(assess(task)?.verdict, "refuse", task);
		}
	});

	it("admits verification work and read-only inspection of test files", () => {
		const specs = [agent("verifier", "verification"), agent("scout", "read-only"), agent("coder", "workspace-edit")];
		const assess = (agentId: string, capabilityClass: "verification" | "read-only", task: string) =>
			assessCapabilityMismatch({
				agentId,
				capabilityClass,
				task,
				autoSelected: false,
				resultContractKind: agentId === "verifier" ? "verifier-report" : "scout-report",
				specs,
			});
		strictEqual(assess("verifier", "verification", "Check whether the retry tests pass"), null);
		strictEqual(assess("verifier", "verification", "Verify that npm test succeeds"), null);
		strictEqual(assess("scout", "read-only", "Inspect tests/retry.test.ts and report what it covers"), null);
		strictEqual(assess("scout", "read-only", "Read src/retry.test.ts and summarize it"), null);
		strictEqual(assess("verifier", "verification", "Write new retry tests")?.verdict, "refuse");
	});

	it("reads 'change nothing' and 'leave X unchanged' as prohibitions, not mutation requests", () => {
		const specs = [agent("verifier", "verification"), agent("coder", "workspace-edit")];
		const verdict = (task: string) =>
			assessCapabilityMismatch({
				agentId: "verifier",
				capabilityClass: "verification",
				task,
				autoSelected: false,
				resultContractKind: "verifier-report",
				specs,
			})?.verdict ?? null;
		const table: ReadonlyArray<[string, "refuse" | "flag" | null]> = [
			[
				"Run `python3 bench/heat_check.py --plain` against ref/heat-reference.json and `python3 -m pytest -q tests`, and report each gate as pass or fail. Change nothing.",
				null,
			],
			["Run bench/heat_check.py and pytest, and report each gate as pass or fail. Change nothing.", null],
			["Run the test suite and report each gate as pass or fail. Edit nothing, modify no files.", null],
			["Run the tests and report the result; write nothing to disk.", null],
			["Run the tests and report failures. Leave the source tree unchanged.", null],
			["Run the tests and report failures, then change nothing else.", null],
			["Run the tests and report; do not change anything.", null],
			["Run the tests. Change the retry limit to 5.", "refuse"],
			["Run the tests. Change anything that fails.", "refuse"],
			["Run the tests, fix the failures and change nothing else.", "refuse"],
			["Leave the docs untouched. Run the tests and update the failing snapshot tests.", "refuse"],
			["Run the tests. Change nothing, then write new retry tests.", "refuse"],
			["Run the tests. Change nothing except the retry limit to 5.", "refuse"],
			["Run the tests. Edit nothing else but the retry limit.", "refuse"],
			["Run the tests. Change nothing in src/config.ts except the retry limit to 5.", "refuse"],
			["Run the tests. Leave docs untouched but also update tests to keep rows intact.", "refuse"],
		];
		for (const [task, expected] of table) strictEqual(verdict(task), expected, task);
	});

	it("lets a typed intent that declares no writes outrank the prose classifier for a read-only recipe", () => {
		const specs = [agent("scout", "read-only"), agent("coder", "workspace-edit")];
		const task = "Reconnaissance question: find every caller of shouldCompact; then write the failing test first.";
		strictEqual(
			assessCapabilityMismatch({
				agentId: "scout",
				capabilityClass: "read-only",
				task,
				autoSelected: false,
				resultContractKind: "scout-report",
				specs,
			})?.verdict,
			"refuse",
		);
		strictEqual(
			assessCapabilityMismatch({
				agentId: "scout",
				capabilityClass: "read-only",
				task,
				autoSelected: false,
				resultContractKind: "scout-report",
				specs,
				intent: { writeRoots: [], expectedOutputs: [] },
			}),
			null,
		);
		strictEqual(
			assessCapabilityMismatch({
				agentId: "scout",
				capabilityClass: "read-only",
				task,
				autoSelected: false,
				resultContractKind: "scout-report",
				specs,
				intent: { writeRoots: ["src/"], expectedOutputs: [] },
			})?.verdict,
			"refuse",
		);
	});

	it("orders capacity requests deterministically and fails closed at the queue bound", async () => {
		deepStrictEqual(
			orderAdmissionRequests([queued("b"), queued("a"), queued("urgent", 1)]).map((entry) => entry.requestId),
			["urgent", "a", "b"],
		);
		const queue = createAdmissionQueue<string>({ maxSize: 1, now: () => 10 });
		const first = queue.enqueue(queued("first"));
		await rejects(queue.enqueue(queued("second")), /queue full/u);
		queue.cancel("first");
		strictEqual((await first).state, "canceled");
	});

	it("keeps queue spans monotonic while admission timestamps and deadlines remain epoch", async (t) => {
		let wallClock = Date.now();
		let elapsed = 0;
		t.mock.method(performance, "now", () => elapsed);
		const queue = createAdmissionQueue<string>({ maxSize: 1, now: () => wallClock });
		for (const jump of [-60_000, 120_000]) {
			const request = { ...queued("first"), queuedAt: wallClock, deadlineAt: wallClock + 300_000 };
			const pending = queue.enqueue(request);
			wallClock += jump;
			elapsed += 25;
			strictEqual(queue.admitNext()?.requestId, request.requestId);
			const admitted = await pending;
			ok(admitted.state === "admitted");
			strictEqual(admitted.queueWaitMs, 25);
			strictEqual(admitted.admittedAt, wallClock);
			deepStrictEqual(admitted.request, request);
		}
		const canceled = queue.enqueue({ ...queued("first"), queuedAt: wallClock, deadlineAt: wallClock + 1000 });
		elapsed += 10;
		queue.cancel("first");
		strictEqual((await canceled).state, "canceled");
		const retry = queue.enqueue({ ...queued("first"), queuedAt: wallClock, deadlineAt: wallClock + 1000 });
		elapsed += 5;
		queue.admitNext();
		const admitted = await retry;
		ok(admitted.state === "admitted");
		strictEqual(admitted.queueWaitMs, 5);
		const expired = queue.enqueue({ ...queued("expired"), queuedAt: wallClock, deadlineAt: wallClock - 1 });
		strictEqual(queue.admitNext(), null);
		strictEqual((await expired).state, "timed_out");
	});

	it("uses operator capacity, then discovered capacity, then the conservative local default", () => {
		const target = { id: "local", runtime: "llamacpp", url: "http://localhost:8080/v1" };
		const runtime = { id: "llamacpp", tier: "local-native" as const };
		strictEqual(
			capacityLimit(
				endpointCapacityFor({ target: { ...target, maxConcurrentRequests: 3 }, runtime, discoveredSlots: 2 }, {}),
			),
			3,
		);
		strictEqual(capacityLimit(endpointCapacityFor({ target, runtime, discoveredSlots: 2 }, {})), 2);
		strictEqual(capacityLimit(endpointCapacityFor({ target, runtime }, {})), 1);
	});

	it("names the root or action that exceeds the orchestrator scope in a subset denial", () => {
		const verdict = admit(
			{
				requestedScope: { ...WORKSPACE_SCOPE, allowedWriteRoots: ["/elsewhere/src/a.js"] },
				orchestratorScope: WORKSPACE_SCOPE,
				requestedActions: [],
				agentId: "git-master",
			},
			isSubset,
		);
		strictEqual(verdict.admitted, false);
		match(
			verdict.reason,
			/^scope git-master is not a subset of the orchestrator scope: write root \/elsewhere\/src\/a\.js lies outside/,
		);
		match(verdict.reason, /leave write_roots empty/);
		const actions = admit(
			{
				requestedScope: WORKSPACE_SCOPE,
				orchestratorScope: READONLY_SCOPE,
				requestedActions: [],
				agentId: "coder",
			},
			isSubset,
		);
		match(actions.reason, /needs action class dispatch, execute, write/);
	});

	it("maps a task worktree's write boundaries back onto the checkout for the subset check", () => {
		const root = process.cwd();
		const worktree = { root, path: "/dev/shm/clio-test-worktrees/run1" };
		const mapped = admissionWriteBoundaries({ taskWorktree: worktree as never }, [
			"/dev/shm/clio-test-worktrees/run1/src/a.js",
			"/dev/shm/clio-test-worktrees/run1/test/",
			"/unrelated/place.js",
		]);
		deepStrictEqual(mapped, [join(root, "src/a.js"), `${join(root, "test")}/`, "/unrelated/place.js"]);
		const admitted = admit(
			{
				requestedScope: { ...WORKSPACE_SCOPE, allowedWriteRoots: mapped.slice(0, 2) },
				orchestratorScope: WORKSPACE_SCOPE,
				requestedActions: [],
				agentId: "git-master",
			},
			isSubset,
		);
		strictEqual(admitted.admitted, true);
		deepStrictEqual(admissionWriteBoundaries({}, ["/x/y.js"]), ["/x/y.js"]);
	});

	it("reads a dot scope entry as the repository root instead of refusing the declaration", () => {
		// Local models write read_roots: ["."] to say "the whole repository" and
		// then spend a round on the rejection; the root is what an empty scope
		// already means, so the entry is dropped rather than refused. An output
		// path still has to name a file.
		const scoped = normalizeDispatchIntent({ version: 2, read_roots: [".", "src/"], write_roots: ["./"] }, new Map());
		ok(scoped.ok);
		deepStrictEqual(scoped.intent.readRoots, ["src/"]);
		deepStrictEqual(scoped.intent.writeRoots, []);
		const output = normalizeDispatchIntent({ version: 2, expected_outputs: ["."] }, new Map());
		strictEqual(output.ok, false);
		if (!output.ok) {
			match(output.message, /repository-relative file paths/);
			match(output.message, /host commits worktree tasks/);
		}
		const commit = normalizeDispatchIntent(
			{ version: 2, write_roots: ["src/duration.js"], expected_outputs: ["commit"] },
			new Map(),
		);
		ok(commit.ok);
		const findings = classifyDispatchIntentCompatibility({ intent: commit.intent });
		const refusal = findings.find((finding) => finding.code === "intent_outputs_outside_write_roots");
		ok(refusal);
		match(refusal.message, /actual file paths within the authorized write_roots/);
		match(refusal.message, /host commits worktree tasks/);
	});

	it("refuses an architect whose write_roots exclude its plan's contract path before any worker runs", () => {
		const contract = { kind: "architect-plan", path: ".clio-coder/artifacts/PLAN.md" };
		const refusal = architectPlanOutsideWriteRoots("architect", contract, { writeRoots: ["PLAN.md"] });
		match(
			refusal ?? "",
			/writes its plan only to \.clio-coder\/artifacts\/PLAN\.md, which intent\.write_roots \[PLAN\.md\] exclude/,
		);
		strictEqual(
			architectPlanOutsideWriteRoots("architect", contract, { writeRoots: ["PLAN.md", ".clio-coder/artifacts"] }),
			null,
		);
		strictEqual(architectPlanOutsideWriteRoots("architect", contract, { writeRoots: [] }), null);
		strictEqual(architectPlanOutsideWriteRoots("coder", { kind: "mutation-report" }, { writeRoots: ["src"] }), null);
	});

	it("bounds admission errors and escapes control characters from declared paths", () => {
		const normalized = normalizeDispatchIntent(
			{ version: 2, write_roots: ["src"], expected_outputs: ["bad\u001b[2Jname\u009b31m"] },
			new Map(),
		);
		ok(normalized.ok);
		const findings = classifyDispatchIntentCompatibility({
			intent: normalized.intent,
			writeRoots: [`\u001b[2J${"x".repeat(20_000)}`],
		});
		for (const finding of findings) {
			ok(!finding.message.includes("\u001b") && !finding.message.includes("\u009b"));
			ok(Buffer.byteLength(finding.message, "utf8") <= 4096);
		}
		const outside = findings.find((finding) => finding.code === "intent_outputs_outside_write_roots");
		ok(outside);
		ok(outside.message.includes("\\u{1b}"));
		const malformed = normalizeDispatchIntent({ [`\u001b[2J${"x".repeat(20_000)}`]: true }, new Map());
		ok(!malformed.ok);
		ok(!malformed.message.includes("\u001b"));
		ok(Buffer.byteLength(malformed.message, "utf8") <= 4096);
	});

	it("infers a path from a briefing that quotes an import specifier instead of refusing the dispatch", () => {
		// "./parser.js" in prose is the same repository path without the prefix;
		// a live orchestrator lost two dispatch rounds to the dot-segment refusal.
		const scope = resolveDispatchPathScope({
			task: "Make parseLine trim trailing whitespace",
			briefing: "tests/round-trip.test.ts imports ./parser.js and index.ts re-exports it",
		} as Parameters<typeof resolveDispatchPathScope>[0]);
		strictEqual(scope.source, "inferred");
		ok(scope.workingContextPaths.includes("parser.js"));
	});

	it("anchors a quoted ../ specifier that names a real file, drops one that does not, and names both rewrites", () => {
		// Round-5 run 3: a coder briefing quoted `import { Store } from "../src/store.js"`
		// out of test/store.test.ts and admission failed the whole dispatch with
		// legacy_scope_path_malformed. Inference never sees the quote's origin, so
		// the remainder is probed against the dispatch root instead of refused.
		const root = mkdtempSync(join(tmpdir(), "clio-coder-path-scope-"));
		try {
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "store.js"), "export const store = 1;\n", "utf8");
			const scope = resolveDispatchPathScope({
				cwd: root,
				task: "Make the store durable",
				briefing: 'test/store.test.ts has import { Store } from "../src/store.js" and ../src/absent.js',
			} as Parameters<typeof resolveDispatchPathScope>[0]);
			strictEqual(scope.source, "inferred");
			ok(scope.workingContextPaths.includes("src/store.js"), scope.workingContextPaths.join(","));
			ok(!scope.workingContextPaths.includes("../src/absent.js"), scope.workingContextPaths.join(","));
			deepStrictEqual(scope.parentTokens, [
				{ token: "../src/store.js", resolved: "src/store.js", source: "briefing" },
				{ token: "../src/absent.js", resolved: null, source: "briefing" },
			]);
			// Neither half of the reinterpretation is silent: the anchored token is
			// the one that put a path in working context the prose never spelled.
			const notice = inferredScopeParentTokenNotice(scope);
			ok(notice, "a reinterpreted prose token is named in the scope notice");
			ok(notice.message.startsWith("[dispatch scope] "), notice.message);
			strictEqual(
				notice.message,
				"[dispatch scope] Paths outside the workspace were not granted: ../src/absent.js. Read from the workspace root: ../src/store.js as src/store.js.",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("names a ../ token once when the task and the briefing both quote it", () => {
		// An orchestrator restating the file it is asking about quotes the same
		// specifier twice; two of the notice's twelve slots must not go to one token.
		const root = mkdtempSync(join(tmpdir(), "clio-coder-path-scope-"));
		try {
			const scope = resolveDispatchPathScope({
				cwd: root,
				task: "check ../src/absent.js now",
				briefing: "also ../src/absent.js here",
			} as Parameters<typeof resolveDispatchPathScope>[0]);
			deepStrictEqual(scope.parentTokens, [{ token: "../src/absent.js", resolved: null, source: "task" }]);
			const notice = inferredScopeParentTokenNotice(scope);
			ok(notice, "the token is still named once");
			strictEqual(notice.message.split("../src/absent.js").length - 1, 1, notice.message);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("drops a leading ../ run that names nothing and lets neither outcome widen authority", () => {
		// The deliberate reading of issue #266, pinned so a later edit cannot flip
		// it silently: a leading run's origin never reaches prose inference, so
		// criterion 1 (never reject) decides and criterion 2 (refuse an escape)
		// cannot. Both outcomes stay off the write boundary, which is what makes
		// the leniency safe.
		const root = mkdtempSync(join(tmpdir(), "clio-coder-path-scope-"));
		try {
			const leaves = resolveDispatchPathScope({
				cwd: root,
				task: "read ../../../etc/passwd now",
			} as Parameters<typeof resolveDispatchPathScope>[0]);
			deepStrictEqual(leaves.workingContextPaths, []);
			deepStrictEqual(leaves.writeBoundaries, []);
			deepStrictEqual(leaves.parentTokens, [{ token: "../../../etc/passwd", resolved: null, source: "task" }]);
			// The same token in a checkout that happens to carry etc/passwd anchors
			// under the root instead, which cannot escape it and is never silent.
			mkdirSync(join(root, "etc"), { recursive: true });
			writeFileSync(join(root, "etc", "passwd"), "root:x:0:0\n", "utf8");
			const collides = resolveDispatchPathScope({
				cwd: root,
				task: "read ../../../etc/passwd now",
			} as Parameters<typeof resolveDispatchPathScope>[0]);
			deepStrictEqual(collides.workingContextPaths, ["etc/passwd"]);
			deepStrictEqual(collides.writeBoundaries, []);
			deepStrictEqual(collides.parentTokens, [{ token: "../../../etc/passwd", resolved: "etc/passwd", source: "task" }]);
			ok(
				inferredScopeParentTokenNotice(collides)?.message.includes("../../../etc/passwd as etc/passwd"),
				"the rewrite the operator would otherwise never see is named",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a ../ token whose remaining segments walk back out of what it anchored", () => {
		// The guard the leniency rests on. Each of these enters the leading-run
		// branch and must leave it refused: a later "..", a later ".", and a run
		// with no remainder to probe at all. The fourth token never reaches that
		// branch and is here to pin the pre-existing refusal it keeps.
		const root = mkdtempSync(join(tmpdir(), "clio-coder-path-scope-"));
		try {
			for (const task of [
				"read ../src/../../etc/passwd now",
				"read ../src/./store.js now",
				"read ../.. now",
				"read src/../../etc/passwd now",
			]) {
				throws(
					() => resolveDispatchPathScope({ cwd: root, task } as Parameters<typeof resolveDispatchPathScope>[0]),
					/legacy_scope_path_malformed/u,
					task,
				);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("normalizes absolute workspace paths before inference and leaves one outside the workspace to refuse (XR-60, M2)", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-path-scope-"));
		type Request = Parameters<typeof resolveDispatchPathScope>[0];
		const normalized = (task: string) => {
			const requests = [{ agentId: "scout", cwd: root, task }] as unknown as Request[];
			const notices = normalizeDispatchAdmission({
				args: { tasks: [{ agent: "scout", task }] },
				requests,
				positions: [1],
				mode: "parallel",
				specs: [],
			});
			return { request: requests[0] as Request, notices };
		};
		try {
			mkdirSync(join(root, "paper", "background"), { recursive: true });
			mkdirSync(`${root}.`);
			for (const [task, paths] of [
				[`audit ${root} for leaks`, []],
				[`audit the tree at ${root}.`, []],
				[`read ${root}/paper/method.md and report`, ["paper/method.md"]],
				["summarize /paper/background now", ["paper/background"]],
			] as const) {
				const { request, notices } = normalized(task);
				strictEqual(notices.length, 1, task);
				match(
					notices[0] ?? "",
					/^\[dispatch normalize\] task 1 \(scout\): read absolute workspace paths as workspace-relative/u,
				);
				deepStrictEqual(resolveDispatchPathScope(request).workingContextPaths, paths, task);
				deepStrictEqual(resolveDispatchPathScope(request).writeBoundaries, [], task);
			}
			// A backticked or quoted token that closes right after the path is a whole token.
			for (const [task, paths] of [
				[`Read \`${root}/paper/method.md\` and report`, ["paper/method.md"]],
				[`Read "${root}/paper/method.md" and report`, ["paper/method.md"]],
				[`List "${root}/paper/background/" and report`, ["paper/background"]],
			] as const) {
				const { request, notices } = normalized(task);
				strictEqual(notices.length, 1, task);
				deepStrictEqual(resolveDispatchPathScope(request).workingContextPaths, paths, task);
			}
			// A quoted path that runs on past the workspace root names a sibling: left as written, still refused.
			for (const task of [
				"read /etc/passwd now",
				`read ${dirname(root)}/elsewhere/a.md now`,
				`Read "${root} archive/paper/method.md" now`,
				`Read \`${root} archive/paper/method.md\` now`,
				// A closed quote is literal: "<root>." names the sibling directory, not the workspace and a period.
				`List "${root}."`,
			]) {
				const { request, notices } = normalized(task);
				deepStrictEqual(notices, [], task);
				throws(() => resolveDispatchPathScope(request), /legacy_scope_path_absolute/u);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(`${root}.`, { recursive: true, force: true });
		}
	});

	it("normalizes write_roots: [] and undeclared builders in a parallel batch to read-only runs with notices (XR-60, row 146, M2)", () => {
		const auto = { approvedAuthorities: ["read-only" as const], authorityBasis: "yolo-policy" as const };
		const resolveIntent = (raw: unknown) => {
			const declared = raw as { write_roots?: string[]; verification?: Array<{ check: string }> } | undefined;
			// As intent resolution does, "." names the whole workspace and resolves to no root.
			const roots = (declared?.write_roots ?? []).filter((root) => !/^\.\/?$/u.test(root));
			const checks = (declared?.verification ?? []).map(({ check }) => ({ check, timeoutMs: 1_000 }));
			return {
				ok: true as const,
				intent: {
					writeRoots: roots,
					readRoots: [],
					relevantPaths: [],
					expectedOutputs: [],
					verification: checks,
				} as unknown as NonNullable<Parameters<typeof resolveDispatchPathScope>[0]["intent"]>,
				resolvedVerification: checks.map((entry) => ({ ...entry, argv: ["true"], cwd: process.cwd() })),
			};
		};
		const specs = [
			{ id: "coder", capabilityClass: "workspace-edit" },
			{ id: "debugger", capabilityClass: "verification" },
			{ id: "scout", capabilityClass: "read-only" },
		] as unknown as AgentSpec[];
		const normalized = (args: Record<string, unknown>, named: string[] = []) => {
			const parsed = dispatchRequestsFromArgs(args, {
				auto,
				resolveIntent,
				workspaceRoot: process.cwd(),
				operatorNamedChecks: () => named,
			});
			ok(parsed.ok, JSON.stringify(parsed));
			const requests = [...parsed.requests];
			const notices = normalizeDispatchAdmission({ args, requests, positions: parsed.positions, mode: "parallel", specs });
			return { requests, notices };
		};
		const empty = { agent: "coder", task: "Map the cache split", intent: { write_roots: [] } };
		const declared = normalized({ mode: "parallel", tasks: [empty, empty, empty] });
		deepStrictEqual(
			declared.requests.map((request) => request.readOnly),
			[true, true, true],
		);
		strictEqual(writerSetConflict(declared.requests, specs), null);
		strictEqual(declared.notices.length, 3);
		match(
			declared.notices[0] ?? "",
			/task 1 \(coder\) runs read-only: its intent\.write_roots: \[\] declares no writes/u,
		);
		// verification: [] asks for no checks, so it does not keep a write_roots: [] task writable.
		const noChecks = normalized({
			mode: "parallel",
			tasks: [{ agent: "coder", task: "Inspect src", intent: { write_roots: [], verification: [] } }],
		});
		strictEqual(noChecks.requests[0]?.readOnly, true);
		// An explicit batch-level write_roots: [] is a no-write ceiling a member may not widen.
		const widened = dispatchRequestsFromArgs(
			{
				mode: "parallel",
				intent: { write_roots: [] },
				tasks: [{ agent: "coder", task: "Update src", intent: { write_roots: ["src/"] } }],
			},
			{ auto, resolveIntent, workspaceRoot: process.cwd() },
		);
		ok(!widened.ok);
		match(widened.message, /task 1: intent_scope_widening: .*'src\/'.*write_roots: \[\] \(no writes\)/u);
		const inherited = normalized({
			mode: "parallel",
			intent: { write_roots: [] },
			tasks: [{ agent: "coder", task: "Update src", intent: { relevant_paths: ["src/"] } }],
		});
		strictEqual(inherited.requests[0]?.readOnly, true);
		// Row 146: builders with nothing declared run as inspection (explorer role) in a parallel batch.
		const builders = normalized({
			mode: "parallel",
			tasks: [
				{ agent: "coder", task: "Explain the cache split" },
				{ agent: "debugger", task: "Diagnose the flaky collect" },
				{ agent: "coder", task: "Fix a", intent: { write_roots: ["src/a/"] } },
			],
		});
		deepStrictEqual(
			builders.requests.map((request) => [request.readOnly === true, request.executionRole]),
			[
				[true, "researcher"],
				[true, "researcher"],
				[false, "builder"],
			],
		);
		strictEqual(writerSetConflict(builders.requests, specs), null);
		match(
			builders.notices.join("\n"),
			/task 2 \(debugger\) runs read-only as an explorer: a builder in a parallel batch with no intent\.write_roots/u,
		);
		// One unscoped coder beside a scout is no writer conflict, and still runs as inspection (DESIGN 4.7).
		const beside = normalized({
			mode: "parallel",
			tasks: [
				{ agent: "coder", task: "Explain the cache" },
				{ agent: "scout", task: "Map the tests" },
			],
		});
		deepStrictEqual(
			beside.requests.map((request) => request.readOnly === true),
			[true, false],
		);
		strictEqual(beside.requests[0]?.executionRole, "researcher");
		// Evidence of a write keeps the builder: an explicit "." write root, or a check the operator named in the turn.
		const coderBesideScout = (intent?: Record<string, unknown>) => ({
			mode: "parallel",
			tasks: [
				{ agent: "coder", task: "Fix the cache", ...(intent !== undefined ? { intent } : {}) },
				{ agent: "scout", task: "Map the tests" },
			],
		});
		const dotted = normalized(coderBesideScout({ write_roots: ["."] }));
		const checked = normalized(coderBesideScout(), ["test"]);
		const declaredNone = normalized(coderBesideScout({ write_roots: [] }), ["test"]);
		deepStrictEqual(
			[dotted, checked, declaredNone].map(({ requests }) => [
				requests[0]?.readOnly === true,
				requests[0]?.executionRole,
				(requests[0]?.resolvedVerification ?? []).map((entry) => entry.check),
			]),
			[
				[false, "builder", []],
				[false, "builder", ["test"]],
				[false, "builder", ["test"]],
			],
		);
		// Normalization never removes an operator-required check: write_roots: [] with one is left for admission.
		deepStrictEqual([dotted.notices, checked.notices, declaredNone.notices], [[], [], []]);
		// A single task is not a batch, and writers: 1 asks for serialized writers: both left alone.
		const serialized = normalized({
			mode: "parallel",
			writers: 1,
			tasks: [
				{ agent: "coder", task: "Fix a" },
				{ agent: "coder", task: "Fix b" },
			],
		});
		deepStrictEqual(serialized.notices, []);
		const lone = normalized({ mode: "parallel", tasks: [{ agent: "coder", task: "Fix b" }] });
		deepStrictEqual([lone.requests[0]?.readOnly, lone.notices], [undefined, []]);
		const writers = dispatchRequestsFromArgs(
			{ mode: "parallel", tasks: ["Fix a", "Fix b"].map((text) => ({ agent: "coder", task: text })) },
			{ auto, resolveIntent },
		);
		ok(writers.ok);
		match(String(writerSetConflict(writers.requests, specs)), /withhold bash and verify .* worktree: true/u);
	});

	it("resolves the plan artifact's legacy scope against the dispatch cwd, not the process cwd", () => {
		// The approval artifact is the surface an operator acts on, so it has to
		// probe the root the run will probe. Rendered against process.cwd() it
		// showed no line at all for a token the dispatch anchors into working
		// context.
		const root = mkdtempSync(join(tmpdir(), "clio-coder-plan-scope-"));
		try {
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "store-probe.js"), "export const store = 1;\n", "utf8");
			const args = {
				agent: "coder",
				tasks: [
					{ task: "Make the store durable", briefing: 'test/store.test.ts imports "../src/store-probe.js"' },
					{ task: "Review the change" },
				],
			};
			const anchored = describeDispatchPlan({ ...args, cwd: root });
			ok(anchored.text.includes('scope working_context path="src/store-probe.js"'), anchored.text);
			ok(
				anchored.text.includes('scope parent_token raw="../src/store-probe.js" resolved="src/store-probe.js"'),
				anchored.text,
			);
			// No cwd: the same call resolves against this process, where the probed
			// file does not exist, and the token is named as dropped rather than
			// vanishing from the artifact.
			const dropped = describeDispatchPlan(args);
			ok(!dropped.text.includes('scope working_context path="src/store-probe.js"'), dropped.text);
			ok(dropped.text.includes('scope parent_token raw="../src/store-probe.js" resolved=dropped'), dropped.text);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps typed scope entries refusing a parent segment that prose inference now anchors", () => {
		// The prose leniency stops at the request text. A declared scope entry has
		// a known root and an escape there is decidable, so it stays a refusal.
		const relevant = normalizeDispatchIntent({ version: 2, relevant_paths: ["../src/store.js"] }, new Map());
		ok(!relevant.ok);
		strictEqual(relevant.reason, "intent_path_escapes_root");
		const read = normalizeDispatchIntent({ version: 2, read_roots: ["../src/store.js"] }, new Map());
		ok(!read.ok);
		strictEqual(read.reason, "intent_path_escapes_root");
		const outputs = normalizeDispatchIntent({ version: 2, expected_outputs: ["../src/store.js"] }, new Map());
		ok(!outputs.ok);
		strictEqual(outputs.reason, "intent_path_escapes_root");
	});

	it("leaves a declared scope with no parent-token notice of its own", () => {
		// A declaration is the scope, so no "../" token changed what the worker
		// sees and the legacy notice has nothing to add. The dropped token still
		// reaches the replacement notice through inferredOnlyPaths.
		const root = mkdtempSync(join(tmpdir(), "clio-coder-path-scope-"));
		try {
			const scope = resolveDispatchPathScope({
				cwd: root,
				task: "Make the store durable",
				briefing: "see ../src/absent.js",
				intent: {
					version: 2,
					readRoots: [],
					writeRoots: ["src/"],
					relevantPaths: [],
					pathProvenance: [],
					expectedOutputs: [],
					verification: [],
				},
			} as unknown as Parameters<typeof resolveDispatchPathScope>[0]);
			strictEqual(scope.source, "declared");
			deepStrictEqual(scope.parentTokens, []);
			strictEqual(inferredScopeParentTokenNotice(scope), null);
			ok(scope.inferredOnlyPaths.includes("../src/absent.js"), scope.inferredOnlyPaths.join(","));
			ok(declaredScopeReplacementNotice(scope)?.message.includes("../src/absent.js"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports only path-looking tokens when a typed intent replaces prose inference", () => {
		const scope = resolveDispatchPathScope({
			task:
				"Fix #15 in src/compaction.ts: dead/raw > 0.5 at ratio 0.5, e.g. 4/10 lines on node v24.9 with tsc 6.0; Store.fromText and store.set stay; pin it in tests/compaction.test.ts",
			intent: {
				version: 2,
				readRoots: [],
				writeRoots: ["src/compaction.ts"],
				relevantPaths: [],
				pathProvenance: [],
				expectedOutputs: ["src/compaction.ts"],
				verification: [],
			},
		} as unknown as Parameters<typeof resolveDispatchPathScope>[0]);
		strictEqual(scope.source, "declared");
		const notice = declaredScopeReplacementNotice(scope);
		ok(notice, "the omitted test file is worth a notice");
		ok(notice.omittedPaths.includes("tests/compaction.test.ts"), notice.omittedPaths.join(","));
		for (const token of ["0.5", "4/10", "v24.9", "6.0", "e.g", "dead/raw", "Store.fromText", "store.set"]) {
			ok(!notice.omittedPaths.includes(token), `${token} is not a path`);
		}
	});

	it("reads a verification check of none as the empty declaration unless a project declared that id", () => {
		// The word every model reaches for to say "no verification". Refusing it
		// as undeclared cost a dispatch round each time; it is not a check.
		const none = normalizeDispatchIntent(
			{ version: 2, write_roots: ["src/"], verification: [{ check: "none" }] },
			new Map([["typecheck", { id: "typecheck", timeoutMs: 30_000 }]]),
		);
		ok(none.ok);
		deepStrictEqual(none.intent.verification, []);
		const declared = normalizeDispatchIntent(
			{ version: 2, verification: [{ check: "none" }] },
			new Map([["none", { id: "none", timeoutMs: 5_000 }]]),
		);
		ok(declared.ok);
		deepStrictEqual(declared.intent.verification, [{ check: "none", timeoutMs: 5_000 }]);
		const still = normalizeDispatchIntent({ version: 2, verification: [{ check: "git diff" }] }, new Map());
		strictEqual(still.ok, false);
	});

	it("probes an endpoint still at the blind slot default once when the domain starts", async () => {
		// A fresh home has no slot record, so admission bound llama.cpp targets
		// to one slot and refused a two-task batch until `targets --probe` ran.
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{ id: "mini", runtime: "llama.cpp", url: "http://127.0.0.1:8080", defaultModel: "m" },
			{
				id: "mini-pinned",
				runtime: "llama.cpp",
				url: "http://127.0.0.1:8081",
				defaultModel: "m",
				maxConcurrentRequests: 2,
			},
		];
		settings.fleet.default.target = "mini";
		settings.fleet.default.model = "m";
		const runtime: RuntimeDescriptor = {
			id: "llama.cpp",
			displayName: "llama.cpp",
			kind: "http",
			tier: "local-native",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
			synthesizeModel: () => ({ id: "m", provider: "llama.cpp" }) as never,
		};
		const stub = dispatchStubContext({ settings, runtime });
		const providers = stub.getContract("providers");
		if (!providers) throw new Error("stub providers missing");
		const probed: Array<[string, unknown]> = [];
		const wrapped: ProvidersContract = {
			...providers,
			probeTarget: async (id, options) => {
				probed.push([id, options]);
				return providers.probeTarget(id, options);
			},
		};
		const bundle = makeDispatchBundle({
			bus: stub.bus,
			getContract: ((name: DomainName) =>
				name === "providers" ? wrapped : stub.getContract(name)) as typeof stub.getContract,
		});
		await bundle.extension.start?.();
		try {
			deepStrictEqual(probed, [["mini", { reasoning: false }]]);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("refuses write authority on a read-only request without widening or dropping it", () => {
		const normalized = normalizeDispatchIntent(
			{
				version: 2,
				read_roots: ["src/"],
				write_roots: ["src/generated/"],
				expected_outputs: ["src/generated/index.ts"],
				verification: [{ check: "typecheck" }],
			},
			new Map([["typecheck", { id: "typecheck", timeoutMs: 30_000 }]]),
		);
		ok(normalized.ok);
		const findings = classifyDispatchIntentCompatibility({ intent: normalized.intent, readOnly: true });
		deepStrictEqual(
			findings.filter((finding) => finding.decision === "refuse").map((finding) => finding.code),
			["intent_write_without_authority"],
		);
	});

	it("admits only coordinator-bounded ACP gate prompts under read-only authority", () => {
		strictEqual(isBoundedGateRolePrompt({ role: "reviewer", readOnly: true, systemPrompt: REVIEWER_GATE_PROMPT }), true);
		strictEqual(
			isBoundedGateRolePrompt({ role: "reviewer", readOnly: false, systemPrompt: REVIEWER_GATE_PROMPT }),
			false,
		);
		strictEqual(isBoundedGateRolePrompt({ role: "reviewer", readOnly: true, systemPrompt: "caller persona" }), false);
	});

	it("admits a budget-declaring recipe on a Claude CLI target as an external one-shot budget", async (t) => {
		// A Claude CLI run judges the CLAUDE.md files of its cwd against that tree, which indexes every source file of
		// a real checkout; an empty scratch cwd keeps this budget check off the developer's tree.
		const cwd = mkdtempSync(join(tmpdir(), "clio-coder-claude-budget-"));
		t.after(() => rmSync(cwd, { recursive: true, force: true }));
		const settings = structuredClone(DEFAULT_SETTINGS);
		// An artifact-write run on an unmediated CLI needs the operator's trust (Q6).
		settings.targets = [{ id: "claude-worker", runtime: "claude-code", defaultModel: "sonnet", trustedUnmediated: true }];
		settings.fleet.default.target = "claude-worker";
		settings.fleet.default.model = "sonnet";
		const spawn = (runtime: RuntimeDescriptor) => {
			let spawned = 0;
			const specs: WorkerSpec[] = [];
			const bundle = makeDispatchBundle(dispatchStubContext({ settings, runtime }), {
				spawnWorker: (spec): SpawnedWorker => {
					spawned += 1;
					specs.push(spec);
					return {
						pid: null,
						promise: Promise.resolve({ exitCode: 0, signal: null }),
						heartbeatAt: { current: Date.now(), monotonic: 0 },
						events: (async function* () {
							yield { type: "message_end", message: { role: "assistant", stopReason: "stop", content: "done" } };
						})(),
						abort() {},
					};
				},
			});
			return { bundle, specs, spawned: () => spawned };
		};
		// architect requires the canonical `context` tool and binds a skill through
		// it. A subprocess runtime never receives Clio's tool surface, so admission
		// must compile without promising either.
		const request = {
			agentId: "architect",
			task: "Draft a design note for splitting the dispatch ledger into two files.",
			executionRole: "builder" as const,
			target: "claude-worker",
			model: "sonnet",
			cwd,
		};

		const declared = spawn(claudeCodeRuntime);
		await declared.bundle.extension.start();
		try {
			const handle = await declared.bundle.contract.dispatch(request);
			strictEqual(declared.spawned(), 1);
			await handle.finalPromise.catch(() => undefined);
			const envelope = declared.bundle.contract.getRun(handle.runId);
			ok(envelope);
			strictEqual(envelope.runtimeId, "claude-code");
			strictEqual(envelope.budget?.enforcement.classification, "external-one-shot");
			strictEqual(envelope.budget?.enforcement.perTool, "unobserved-not-enforced");
			const spec = declared.specs[0];
			ok(spec);
			strictEqual(spec.envelope.skills.discovery, "off");
			ok(!spec.systemPrompt.includes("# Agent-Bound Skills"), "no bound-skill block without an attached context tool");
		} finally {
			await declared.bundle.extension.stop?.();
		}

		const { externalAgentLoop: _loop, ...undeclaredRuntime } = claudeCodeRuntime;
		const undeclared = spawn(undeclaredRuntime);
		await undeclared.bundle.extension.start();
		try {
			const run = await undeclared.bundle.contract.dispatch({ ...request, budget: { toolCalls: 1000 } });
			await run.finalPromise;
			strictEqual(undeclared.spawned(), 1);
			strictEqual(undeclared.specs[0]?.budget.mode, "advisory");
			strictEqual(undeclared.specs[0]?.budget.toolCalls, 1000);
		} finally {
			await undeclared.bundle.extension.stop?.();
		}
	});

	it("a task that forbids writing files is refused for an artifact-writing agent and admitted for a read-only one (D-C)", () => {
		const auto = { approvedAuthorities: ["read-only" as const], authorityBasis: "yolo-policy" as const };
		const writesArtifact = (id: string) => id === "architect";
		const parse = (agent: string, task: string) =>
			dispatchRequestsFromArgs({ agent, tasks: [task] }, { auto, writesArtifact });
		const refused = parse("architect", "Design the cache split. Do not write any files.");
		ok(!refused.ok && refused.message.includes("task_forbids_writes:"), JSON.stringify(refused));
		ok(!refused.ok && refused.message.includes("read-only agent"));
		ok(parse("scout", "Map the cache split. Do not write any files.").ok);
		ok(parse("architect", "Design the cache split. Do not modify files outside src/.").ok);
	});

	it("rejects an ACP read-only dispatch before any worker starts, clio-coder-policy governance included", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.safety.autonomy = "yolo";
		settings.integrations.externalAgents.entries = [
			{ id: "external-reviewer", command: "mock-acp", args: [], toolGovernance: "clio-coder-policy" },
		];
		let starts = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			spawnWorker: () => {
				starts += 1;
				throw new Error("native worker must not start");
			},
			startAcpDelegationRun: () => {
				starts += 1;
				throw new Error("ACP worker must not start");
			},
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({
				getAgentSpecs: () => [],
				dispatch: bundle.contract,
				getAutonomy: () => "yolo",
			});
			const result = (await tool.run({ tasks: ["build first"], review: { reviewer: "external-reviewer" } }, {})) as {
				kind: string;
				message?: string;
			};
			strictEqual(result.kind, "error");
			match(result.message ?? "", /external-reviewer' cannot run read-only work/u);
			strictEqual(starts, 0);
			strictEqual(bundle.contract.listRuns().length, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("starts a dispatch-tool ACP delegation with only the caller's model, never the delegation's agent id", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.safety.autonomy = "yolo";
		settings.fleet.retry.maxRetries = 0;
		settings.integrations.externalAgents.entries = [
			{ id: "models-peer", command: "mock-acp", args: [], toolGovernance: "clio-coder-policy" },
		];
		const started: Array<{ model?: string }> = [];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			startAcpDelegationRun: (input) => {
				started.push({ ...(input.model !== undefined ? { model: input.model } : {}) });
				throw new Error("captured ACP start");
			},
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({
				getAgentSpecs: () => [],
				dispatch: bundle.contract,
				getAutonomy: () => "yolo",
			});
			const intent = { read_roots: ["README.md"], expected_outputs: [] };
			const calls: Array<Record<string, unknown>> = [
				{ agent: "models-peer", task: "Create pong.txt containing PONG", intent },
				{ agent: "models-peer", task: "Create pong.txt containing PONG", intent, model: "gemini-3.8-flash" },
			];
			ok(tool.prepareAdmissionArguments);
			for (const args of calls) {
				// Production admission seals the resolved plan before the run; the plan pins its route onto the request.
				const prepared = tool.prepareAdmissionArguments(args);
				strictEqual(prepared[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT], undefined);
				await tool.run(prepared, {});
				tool.disposeAdmissionArguments?.(prepared);
			}
			// A peer offering a configOptions model list refuses any id it does not offer, the agent id included.
			deepStrictEqual(started, [{}, { model: "gemini-3.8-flash" }]);
		} finally {
			await bundle.extension.stop?.();
		}
	});
	it("hands a slot to the next queued assignment when the holder is released early, and a second release is a no-op", async () => {
		// A merge card waits on the operator after its worker exited; it releases the
		// slot before waiting so other dispatches are not queued behind it.
		const controller = createCapacityAdmissionController({
			limits: () => ({ global: 1, nodes: { local: 1 }, endpoints: {} }),
		});
		try {
			await controller.admit({ assignmentId: "holder", nodeId: "local" });
			const next = controller.admit({ assignmentId: "next", nodeId: "local" });
			strictEqual(controller.releaseAssignment("holder"), true);
			const admitted = await next;
			strictEqual(admitted.lease.assignmentId, "next");
			strictEqual(controller.releaseAssignment("holder"), false);
			strictEqual(controller.releaseAssignment("next"), true);
		} finally {
			controller.stop();
		}
	});

	it("ends a wait at its epoch deadline and reports monotonic elapsed time across wall-clock jumps", async (t) => {
		let wallClock = Date.now();
		let elapsed = 0;
		t.mock.method(performance, "now", () => elapsed);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const controller = createCapacityAdmissionController({
			limits: () => ({ global: 1, nodes: { local: 1 }, endpoints: {} }),
			now: () => wallClock,
		});
		try {
			const holder = await controller.admit({ assignmentId: "holder", nodeId: "local" });
			strictEqual(holder.queuedAt, wallClock);
			strictEqual(holder.admittedAt, wallClock);
			for (const jump of [-60_000, 120_000]) {
				const deadlineAt = wallClock + 1000;
				const pending = controller.admit({ assignmentId: "late", nodeId: "local", deadlineAt });
				const rejected = rejects(pending, (error: unknown) => {
					ok(error instanceof AdmissionTimedOutError);
					strictEqual(error.code, "admission_timed_out");
					match(error.message, /after 75ms waiting for a worker slot/u);
					return true;
				});
				wallClock += jump;
				elapsed += 25;
				if (jump < 0) {
					t.mock.timers.tick(20);
					wallClock = deadlineAt;
				}
				elapsed += 50;
				t.mock.timers.tick(1000);
				await rejected;
			}
			await rejects(
				controller.admit({ assignmentId: "overdue", nodeId: "local", deadlineAt: wallClock - 1000 }),
				(error: unknown) => error instanceof AdmissionTimedOutError && error.code === "admission_timed_out",
			);
		} finally {
			controller.stop();
		}
	});
	it("keeps the event loop running while admission and lease renewal wait on a peer's capacity lock", async () => {
		const controller = createCapacityAdmissionController({
			limits: () => ({ global: 1, nodes: { local: 1 }, endpoints: {} }),
			heartbeatMs: 5,
		});
		const releasePeer = holdCapacityLockAsPeer();
		try {
			// A synchronous wait would hold this loop until the 20 s acquisition
			// budget expired; these timers could not fire and the peer could not let go.
			const waiting = controller.admit({ assignmentId: "behind-peer", nodeId: "local" });
			let turns = 0;
			for (; turns < 10; turns += 1) await sleep(5);
			strictEqual(turns, 10);
			strictEqual(await settledWithin(waiting, 1), false, "nothing is granted while the peer holds the lock");
			releasePeer();
			const { lease } = await waiting;
			strictEqual(lease.assignmentId, "behind-peer");

			const releaseAgain = holdCapacityLockAsPeer();
			for (turns = 0; turns < 10; turns += 1) await sleep(5);
			strictEqual(turns, 10, "the heartbeat waits for the peer without stalling timers");
			releaseAgain();
			let renewed: CapacityLease | undefined;
			for (let attempt = 0; attempt < 400 && renewed === undefined; attempt += 1) {
				await sleep(5);
				renewed = readCapacityStateUnsafe().leases.find(
					(entry) => entry.leaseId === lease.leaseId && entry.heartbeatAt !== lease.heartbeatAt,
				);
			}
			ok(renewed, "the waiting heartbeat renews once the peer lets go");
			strictEqual(controller.release(lease.leaseId), true);
		} finally {
			releasePeer();
			await controller.stop();
		}
	});

	it("never grants or leaks a lease for requests canceled, signaled or drained behind a peer's lock", async () => {
		const controller = createCapacityAdmissionController({
			limits: () => ({ global: 4, nodes: { local: 4 }, endpoints: {} }),
		});
		const releasePeer = holdCapacityLockAsPeer();
		try {
			const canceled = controller.admit({ assignmentId: "cancel-me", nodeId: "local" });
			const abort = new AbortController();
			// Fleet members share their root's assignment and wait together.
			const signaled = controller.admit({ assignmentId: "shared", nodeId: "local", signal: abort.signal });
			const siblings = [
				controller.admit({ assignmentId: "shared", nodeId: "local" }),
				controller.admit({ assignmentId: "shared", nodeId: "local" }),
			];
			strictEqual(controller.cancel("cancel-me"), true);
			await rejects(canceled, AdmissionCanceledError);
			abort.abort();
			await rejects(signaled, AdmissionCanceledError);
			for (const sibling of siblings)
				strictEqual(await settledWithin(sibling, 2), false, "one member's signal leaves its siblings waiting");

			// The peer lets go: the owned pump wakes and grants only what is still queued.
			releasePeer();
			const granted = await Promise.all(siblings);
			strictEqual(granted[0]?.lease.leaseId, granted[1]?.lease.leaseId, "siblings share the assignment's lease");
			strictEqual(capacityLeaseUsage().global, 1, "the canceled and signaled requests hold nothing");
			strictEqual(controller.releaseAssignment("shared"), true);

			const releaseAgain = holdCapacityLockAsPeer();
			const drained = [
				controller.admit({ assignmentId: "drained", nodeId: "local" }),
				controller.admit({ assignmentId: "drained", nodeId: "local" }),
				controller.admit({ assignmentId: "other", nodeId: "local" }),
			];
			// Stop settles every queued request, repeated assignments included, and
			// joins the pump's lock wait before it resolves.
			await controller.stop();
			for (const request of drained) await rejects(request, AdmissionCanceledError);
			releaseAgain();
			strictEqual(capacityLeaseUsage().global, 0);
		} finally {
			releasePeer();
			await controller.stop();
		}
	});

	it("renews every owned lease in one committed write per heartbeat", async (context) => {
		// A period no test waits out, so the only heartbeat is the one fired below.
		const HEARTBEAT_MS = 60_000;
		const beats: Array<() => void> = [];
		const realSetInterval = globalThis.setInterval;
		context.mock.method(
			globalThis,
			"setInterval",
			(callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
				if (delay === HEARTBEAT_MS) beats.push(() => callback(...args));
				return realSetInterval(callback, delay, ...args);
			},
		);
		// Every clock read is distinct, so leases renewed in separate transactions
		// could never share a heartbeat timestamp.
		let clock = Date.now();
		const controller = createCapacityAdmissionController({
			limits: () => ({ global: 3, nodes: { local: 3 }, endpoints: {} }),
			now: () => {
				clock += 1;
				return clock;
			},
			heartbeatMs: HEARTBEAT_MS,
		});
		const statePath = capacityStateLockPath();
		const realRename = fs.renameSync;
		try {
			const held: CapacityLease[] = [];
			for (const assignmentId of ["a", "b", "c"])
				held.push((await controller.admit({ assignmentId, nodeId: "local" })).lease);
			strictEqual(new Set(held.map((lease) => lease.heartbeatAt)).size, 3);
			strictEqual(beats.length, 1);
			// safeResourceWrite commits the state file with one rename onto its path;
			// count those commits while exactly one heartbeat runs.
			let commits = 0;
			let renewed: CapacityLease[] = [];
			fs.renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
				if (String(to) === statePath) commits += 1;
				realRename(from, to);
			};
			syncBuiltinESMExports();
			try {
				beats[0]?.();
				for (let attempt = 0; attempt < 400; attempt += 1) {
					renewed = readCapacityStateUnsafe().leases;
					if (renewed.every((lease) => !held.some((before) => before.heartbeatAt === lease.heartbeatAt))) break;
					await sleep(5);
				}
			} finally {
				fs.renameSync = realRename;
				syncBuiltinESMExports();
			}
			strictEqual(commits, 1, "one committed write renews all three leases");
			strictEqual(renewed.length, 3);
			strictEqual(new Set(renewed.map((lease) => lease.heartbeatAt)).size, 1, "one timestamp, one transaction");
			strictEqual(new Set(renewed.map((lease) => lease.expiresAt)).size, 1);
			ok(renewed.every((lease) => !held.some((before) => before.heartbeatAt === lease.heartbeatAt)));
			for (const lease of held) controller.release(lease.leaseId);
		} finally {
			fs.renameSync = realRename;
			syncBuiltinESMExports();
			await controller.stop();
		}
	});
});
