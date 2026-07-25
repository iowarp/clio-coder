import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { JUDGE_GATE_PROMPT, REVIEWER_GATE_PROMPT } from "../../src/domains/dispatch/gate-role-prompts.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import type { AcpDelegationRunHandle, AcpDelegationRunInput } from "../../src/engine/acp/adapter.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

type ToolRunResult =
	| { kind: "ok"; output: string; details?: Record<string, unknown> }
	| { kind: "error"; message: string; details?: Record<string, unknown> };

function acpHandle(text: string, index: number): AcpDelegationRunHandle {
	return {
		pid: 5000 + index,
		heartbeatAt: { current: Date.now() },
		abort: () => {},
		kill: () => {},
		toolCallLog: () => [],
		events: (async function* () {
			yield {
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text }],
					timestamp: Date.now(),
					stopReason: "stop",
					usage: { input: 1, output: 1 },
				},
			} as unknown as Awaited<ReturnType<AcpDelegationRunHandle["events"]["next"]>>["value"];
		})() as AcpDelegationRunHandle["events"],
		promise: Promise.resolve({
			messages: [],
			exitCode: 0,
			stopReason: "end_turn",
			usage: {
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
			},
			delegation: {
				acpSessionId: `gate-session-${index}`,
				initialize: null,
				toolCallsRequested: 0,
				toolCallsApproved: 0,
				toolCallsDenied: 0,
			},
		}),
	};
}

function pendingAcpHandle(heartbeatAt: number): {
	handle: AcpDelegationRunHandle;
	kills: () => number;
	aborts: () => number;
} {
	let settle: ((value: Awaited<AcpDelegationRunHandle["promise"]>) => void) | undefined;
	let kills = 0;
	let aborts = 0;
	const promise = new Promise<Awaited<AcpDelegationRunHandle["promise"]>>((resolve) => {
		settle = resolve;
	});
	const finish = (): void => {
		settle?.({
			messages: [],
			exitCode: 1,
			stopReason: "terminated",
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
			},
			delegation: {
				acpSessionId: "pending-acp",
				initialize: null,
				toolCallsRequested: 0,
				toolCallsApproved: 0,
				toolCallsDenied: 0,
			},
		});
		settle = undefined;
	};
	return {
		handle: {
			pid: 7001,
			heartbeatAt: { current: heartbeatAt },
			abort: () => {
				aborts += 1;
				finish();
			},
			kill: () => {
				kills += 1;
				finish();
			},
			toolCallLog: () => [],
			events: (async function* () {})() as AcpDelegationRunHandle["events"],
			promise,
		},
		kills: () => kills,
		aborts: () => aborts,
	};
}

function nativeFabric(): {
	spawn: (spec: WorkerSpec, opts?: { cwd?: string }) => SpawnedWorker;
	spawns: Array<{ spec: WorkerSpec; cwd: string | undefined }>;
} {
	const spawns: Array<{ spec: WorkerSpec; cwd: string | undefined }> = [];
	return {
		spawns,
		spawn(spec, opts) {
			spawns.push({ spec, cwd: opts?.cwd });
			const cwd = opts?.cwd;
			if (cwd?.includes(join(".clio", "worktrees"))) {
				const candidate = /candidate-(\d+)$/.exec(cwd)?.[1] ?? String(spawns.length);
				writeFileSync(join(cwd, `candidate-${candidate}.txt`), `candidate ${candidate}\n`);
			}
			return {
				pid: 6000 + spawns.length,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				events: (async function* () {
					yield {
						type: "message_end",
						message: { role: "assistant", content: "native done", usage: { input: 1, output: 1 } },
					};
				})(),
				abort: () => {},
				heartbeatAt: { current: Date.now() },
			};
		},
	};
}

function settingsWithAcp(governance: "clio-policy" | "agent-managed", autonomy: "auto-edit" | "full-auto") {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.autonomy = autonomy;
	settings.delegation.agents = [{ id: "acp-gate", command: "mock-acp", args: [], toolGovernance: governance }];
	return settings;
}

function capturingContract(contract: DispatchContract, requests: DispatchRequest[]): DispatchContract {
	return new Proxy(contract, {
		get(target, property, receiver) {
			if (property === "dispatch") {
				return (request: DispatchRequest) => {
					requests.push(structuredClone(request));
					return target.dispatch(request);
				};
			}
			return Reflect.get(target, property, receiver) as unknown;
		},
	});
}

function receipts(details: Record<string, unknown> | undefined, contract: DispatchContract): RunReceipt[] {
	return ((details?.runs ?? []) as Array<{ runId: string }>).map(({ runId }) => {
		const envelope = contract.getRun(runId);
		ok(envelope?.receiptPath);
		const receipt = JSON.parse(readFileSync(envelope?.receiptPath ?? "", "utf8")) as RunReceipt;
		if (envelope) deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
		return receipt;
	});
}

function approvalOptions(level: "auto-edit" | "full-auto") {
	return level === "full-auto"
		? {}
		: {
				approval: {
					requestId: "apr-acp-review",
					requestedBy: "integration-operator",
					actionClass: "dispatch" as const,
				},
			};
}

/** Gate deciders answer their typed contract, not a trailing prose line. */
const REVIEW_PASS_REPORT = JSON.stringify({
	verdict: "pass",
	checks: [{ name: "review", passed: true, evidence: "inspected the workspace" }],
});
const JUDGE_WINNER_1_REPORT = JSON.stringify({
	winner: 1,
	checks: [{ name: "ranking", passed: true, evidence: "compared the candidate branches" }],
});

describe("ACP gate role authority", () => {
	beforeEach(() => {
		isolateDispatchState();
	});
	afterEach(() => {
		restoreDispatchState();
	});

	it("runs an ACP builder and bounded ACP reviewer under auto-edit and full-auto session ceilings", async () => {
		for (const autonomy of ["auto-edit", "full-auto"] as const) {
			const settings = settingsWithAcp("clio-policy", autonomy);
			const context = dispatchStubContext({ settings });
			const inputs: AcpDelegationRunInput[] = [];
			const requests: DispatchRequest[] = [];
			const bundle = makeDispatchBundle(context, {
				startAcpDelegationRun: (input) => {
					inputs.push(input);
					return acpHandle(input.task.startsWith("Review the work") ? REVIEW_PASS_REPORT : "builder done", inputs.length);
				},
			});
			await bundle.extension.start();
			try {
				const contract = capturingContract(bundle.contract, requests);
				const tool = createDispatchTool({ dispatch: contract, getAutonomy: () => autonomy });
				const result = (await tool.run(
					// The reviewer now defaults to the builtin Verifier, so an ACP reviewer
					// is an explicit operator pin rather than an inherited builder agent.
					{ agent: "acp-gate", tasks: ["build the change"], review: { reviewer: "acp-gate", max_cycles: 2 } },
					approvalOptions(autonomy),
				)) as ToolRunResult;
				strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
				strictEqual(inputs.length, 2, "early pass executes the first builder/reviewer prefix");
				strictEqual(requests[0]?.gate?.role, "builder");
				strictEqual(requests[1]?.gate?.role, "reviewer");
				strictEqual(requests[1]?.systemPrompt, REVIEWER_GATE_PROMPT);
				strictEqual(requests[1]?.autonomy, "read-only");
				ok(inputs[1]?.systemPrompt?.includes(REVIEWER_GATE_PROMPT));
				strictEqual(inputs[1]?.autonomy, "read-only");
				match(
					inputs[1]?.dynamicPromptMessages?.find((message) => message.body.startsWith("Safety posture:"))?.body ?? "",
					/^Safety posture: autonomy read-only\./,
				);

				const runReceipts = receipts(result.details, contract);
				const builder = runReceipts.find((receipt) => receipt.gate?.role === "builder");
				const reviewer = runReceipts.find((receipt) => receipt.gate?.role === "reviewer");
				ok(builder && reviewer);
				deepStrictEqual(reviewer?.gate?.subjects, [{ runId: builder?.runId, digest: builder?.integrity.digest }]);
				deepStrictEqual(reviewer?.autonomyEnforcement, {
					grade: "mediated",
					autonomy: "read-only",
					requestedAutonomy: "read-only",
					sessionAutonomy: autonomy,
					externalMode: "clio-policy",
				});
				strictEqual(reviewer?.plan?.taskCount, 4, "approval discloses the bounded two-cycle maximum");
			} finally {
				await bundle.extension.stop?.();
			}
		}
	});

	it("runs native candidates with a read-only ACP judge and integrity-linked winner", async () => {
		const repo = mkdtempSync(join(tmpdir(), "clio-acp-judge-"));
		execFileSync("git", ["-C", repo, "init", "-q"]);
		execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
		execFileSync("git", ["-C", repo, "config", "user.name", "Clio Test"]);
		writeFileSync(join(repo, "README.md"), "base\n");
		execFileSync("git", ["-C", repo, "add", "README.md"]);
		execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
		const settings = settingsWithAcp("clio-policy", "full-auto");
		const fabric = nativeFabric();
		const inputs: AcpDelegationRunInput[] = [];
		const requests: DispatchRequest[] = [];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			spawnWorker: fabric.spawn,
			startAcpDelegationRun: (input) => {
				inputs.push(input);
				return acpHandle(JUDGE_WINNER_1_REPORT, inputs.length);
			},
		});
		await bundle.extension.start();
		try {
			const contract = capturingContract(bundle.contract, requests);
			const tool = createDispatchTool({ dispatch: contract, getAutonomy: () => "full-auto" });
			const result = (await tool.run(
				{
					tasks: [{ agent: "coder", task: "build the best change", cwd: repo }],
					mode: "compete",
					candidates: 2,
					judge: { agent: "acp-gate" },
				},
				{},
			)) as ToolRunResult;
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			strictEqual(fabric.spawns.length, 2);
			strictEqual(inputs.length, 1);
			const judgeRequest = requests.find((request) => request.gate?.role === "judge");
			strictEqual(judgeRequest?.systemPrompt, JUDGE_GATE_PROMPT);
			strictEqual(judgeRequest?.autonomy, "read-only");
			strictEqual(inputs[0]?.autonomy, "read-only");
			ok(inputs[0]?.systemPrompt?.includes(JUDGE_GATE_PROMPT));
			const runReceipts = receipts(result.details, contract);
			const candidates = runReceipts.filter((receipt) => receipt.gate?.role === "candidate");
			const judge = runReceipts.find((receipt) => receipt.gate?.role === "judge");
			strictEqual(candidates.length, 2);
			ok(judge);
			deepStrictEqual(
				judge?.gate?.subjects,
				candidates.map((candidate) => ({ runId: candidate.runId, digest: candidate.integrity.digest })),
			);
			deepStrictEqual(judge?.autonomyEnforcement, {
				grade: "mediated",
				autonomy: "read-only",
				requestedAutonomy: "read-only",
				sessionAutonomy: "full-auto",
				externalMode: "clio-policy",
			});
			strictEqual(judge?.plan?.taskCount, 3);
			match(result.kind === "ok" ? result.output : "", /winner candidate 1 applied/);
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("rejects agent-managed ACP reviewer and judge capabilities before any builder or worktree starts", async () => {
		for (const topology of ["review", "compete"] as const) {
			const repo = topology === "compete" ? mkdtempSync(join(tmpdir(), "clio-acp-preflight-")) : null;
			if (repo !== null) {
				execFileSync("git", ["-C", repo, "init", "-q"]);
				execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
				execFileSync("git", ["-C", repo, "config", "user.name", "Clio Test"]);
				writeFileSync(join(repo, "README.md"), "base\n");
				execFileSync("git", ["-C", repo, "add", "README.md"]);
				execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
			}
			const settings = settingsWithAcp("agent-managed", "full-auto");
			const fabric = nativeFabric();
			let acpStarts = 0;
			const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
				spawnWorker: fabric.spawn,
				startAcpDelegationRun: () => {
					acpStarts += 1;
					return acpHandle("should not start", acpStarts);
				},
			});
			await bundle.extension.start();
			try {
				const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
				const args =
					topology === "review"
						? { tasks: ["build first"], review: { reviewer: "acp-gate" } }
						: {
								tasks: [{ task: "build first", cwd: repo ?? undefined }],
								mode: "compete",
								candidates: 2,
								judge: { agent: "acp-gate" },
							};
				const result = (await tool.run(args, {})) as ToolRunResult;
				strictEqual(result.kind, "error");
				if (result.kind === "error") match(result.message, /agent-managed.*cannot enforce request autonomy narrowing/);
				strictEqual(fabric.spawns.length, 0);
				strictEqual(acpStarts, 0);
				strictEqual(bundle.contract.listRuns().length, 0);
				if (repo !== null) {
					strictEqual(existsSync(join(repo, ".clio", "worktrees")), false);
				}
			} finally {
				await bundle.extension.stop?.();
				if (repo !== null) rmSync(repo, { recursive: true, force: true });
			}
		}
	});

	it("rejects ACP before launch when the parent has a protected artifact boundary", async () => {
		const settings = settingsWithAcp("clio-policy", "full-auto");
		let starts = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			getProtectedArtifactState: () => ({
				artifacts: [
					{
						path: join(process.cwd(), "PLAN.md"),
						protectedAt: "2026-07-10T00:00:00.000Z",
						reason: "validated plan",
						source: "validation",
					},
				],
			}),
			startAcpDelegationRun: () => {
				starts += 1;
				return acpHandle("should not start", starts);
			},
		});
		await bundle.extension.start();
		try {
			await rejects(
				bundle.contract.dispatch({
					agentId: "acp-gate",
					delegationAgentId: "acp-gate",
					executionRole: "builder",
					task: "bypass protection",
				}),
				/cannot enforce 1 protected artifact hard block/,
			);
			strictEqual(starts, 0);
			strictEqual(bundle.contract.listRuns().length, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("wires ACP stall reconciliation to hard kill and shutdown drain to bounded abort", async () => {
		const stalledSettings = settingsWithAcp("clio-policy", "full-auto");
		const stalledAgent = stalledSettings.delegation.agents[0];
		if (stalledAgent === undefined) throw new Error("ACP fixture missing");
		stalledAgent.stallTimeoutMs = 1;
		stalledSettings.workers.maxRetries = 0;
		const stalled = pendingAcpHandle(0);
		const stalledBundle = makeDispatchBundle(dispatchStubContext({ settings: stalledSettings }), {
			now: () => 1_000,
			heartbeatIntervalMs: 5,
			startAcpDelegationRun: () => stalled.handle,
		});
		await stalledBundle.extension.start();
		try {
			const handle = await stalledBundle.contract.dispatch({
				executionRole: "builder",
				agentId: "acp-gate",
				delegationAgentId: "acp-gate",
				task: "stall",
			});
			const receipt = await handle.finalPromise;
			strictEqual(stalled.kills(), 1);
			strictEqual(receipt.outcome, "stalled");
		} finally {
			await stalledBundle.extension.stop?.();
		}

		const drainSettings = settingsWithAcp("clio-policy", "full-auto");
		const draining = pendingAcpHandle(Date.now());
		const drainBundle = makeDispatchBundle(dispatchStubContext({ settings: drainSettings }), {
			startAcpDelegationRun: () => draining.handle,
		});
		await drainBundle.extension.start();
		const handle = await drainBundle.contract.dispatch({
			executionRole: "builder",
			agentId: "acp-gate",
			delegationAgentId: "acp-gate",
			task: "drain",
		});
		await drainBundle.extension.stop?.();
		await handle.finalPromise;
		strictEqual(draining.aborts(), 1);
	});
});
