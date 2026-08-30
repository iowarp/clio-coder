import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { claimAssignmentVerdict, getStoredAssignment } from "../../src/domains/dispatch/assignment-store.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { EMPTY_CAPABILITIES, type RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { mutationReport } from "../harness/gate-fabric.js";

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
	throw new Error(message);
}

function worker(exitCode: number, text?: string): SpawnedWorker {
	const events = (async function* () {
		if (text !== undefined) {
			yield {
				type: "message_end",
				message: {
					role: "assistant",
					content: exitCode === 0 ? mutationReport(text) : text,
					usage: { input: 1, output: 1 },
				},
			};
		}
	})();
	return {
		pid: 8000 + exitCode,
		promise: Promise.resolve({ exitCode, signal: null }),
		events,
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

function failedMutatingWorker(): SpawnedWorker {
	return {
		pid: 8099,
		promise: Promise.resolve({ exitCode: 1, signal: null }),
		events: (async function* () {
			yield {
				type: "clio_tool_finish",
				payload: { tool: "edit", durationMs: 1, outcome: "error", decision: "allowed" },
			};
		})(),
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

function failedWithUnfinishedEdit(): SpawnedWorker {
	return {
		pid: 8100,
		promise: Promise.resolve({ exitCode: 1, signal: null }),
		events: (async function* () {
			yield { type: "clio_tool_start", payload: { tool: "edit", posture: "operating", startedAt: Date.now() } };
		})(),
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

function failedWithUndrainedEvents(): SpawnedWorker {
	return {
		pid: 8101,
		promise: Promise.resolve({ exitCode: 1, signal: null }),
		events: (async function* () {
			await new Promise<never>(() => {
				// Model a worker event source that remains open after process exit.
			});
			yield undefined;
		})(),
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

function failedWithMalformedTelemetry(): SpawnedWorker {
	return {
		pid: 8102,
		promise: Promise.resolve({ exitCode: 1, signal: null, malformedStdoutLines: 1 }),
		events: (async function* () {})(),
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

const CLAUDE_CODE_RUNTIME: RuntimeDescriptor = {
	id: "claude-code",
	displayName: "Claude Code",
	kind: "subprocess",
	apiFamily: "claude-code-subprocess",
	auth: "claude-cli",
	defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
	synthesizeModel: () => ({ id: "claude-sonnet", provider: "claude-code" }) as never,
};

describe("dispatch assignments", () => {
	beforeEach(() => isolateDispatchState());
	after(() => restoreDispatchState());

	it("resolves attached dispatch with the successful terminal retry while retaining attempt one", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => (++spawns === 1 ? worker(1) : worker(0, "recovered")),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "recover once" });
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "succeeded");
			ok(terminal.lineage);
			strictEqual(terminal.lineage.rootRunId, handle.runId);
			strictEqual(terminal.lineage.attempt, 1);
			strictEqual(spawns, 2);

			const first = bundle.contract.getRun(handle.runId);
			strictEqual(first?.outcome, "failed");
			ok(first?.receiptPath);
			if (first?.receiptPath) {
				const receipt = JSON.parse(readFileSync(first.receiptPath, "utf8")) as RunReceipt;
				deepStrictEqual(verifyReceiptIntegrity(receipt, first), { ok: true });
			}
			const assignment = bundle.contract.assignments?.get(handle.runId);
			strictEqual(assignment?.status, "succeeded");
			deepStrictEqual(
				assignment?.attempts.map((attempt) => attempt.runId),
				[handle.runId, terminal.runId],
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("settles exhausted retries with the last failure and complete history", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => worker(1),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "always fail" });
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "failed");
			ok(terminal.lineage);
			strictEqual(terminal.lineage.attempt, 1);
			const assignment = bundle.contract.assignments?.get(handle.runId);
			strictEqual(assignment?.status, "failed");
			strictEqual(assignment?.terminalReceipt?.runId, terminal.runId);
			strictEqual(assignment?.attempts.length, 2);
			ok(assignment?.attempts.every((attempt) => attempt.receiptDigest.length === 64));
			ok(assignment?.attempts.every((attempt) => bundle.contract.getRun(attempt.runId) !== null));
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("does not retry a failed mutating tool that may have partially changed the workspace", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => {
				spawns += 1;
				return failedMutatingWorker();
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "fail after editing",
			});
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "failed");
			deepStrictEqual(terminal.toolStats, [{ tool: "edit", count: 1, ok: 0, errors: 1, blocked: 0, totalDurationMs: 1 }]);
			strictEqual(spawns, 1);
			strictEqual(bundle.contract.snapshot().retrying.length, 0);
			ok(bundle.contract.assignments?.get(handle.runId)?.outcomeDetail?.includes("retry suppressed"));
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("does not retry a mutation-capable subprocess whose tool telemetry is unavailable", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		settings.targets = [{ id: "claude-cli", runtime: "claude-code", defaultModel: "claude-sonnet" }];
		settings.workers.default = { target: "claude-cli", model: "claude-sonnet", thinkingLevel: "off" };
		const workspace = mkdtempSync(join(tmpdir(), "clio-opaque-retry-"));
		let spawns = 0;
		const bundle = makeDispatchBundle(
			dispatchStubContext({
				settings,
				runtime: CLAUDE_CODE_RUNTIME,
				agentTools: [ToolNames.Read, ToolNames.Edit],
				useRuntimeDefaultAgentBudget: true,
			}),
			{
				resilienceCooldownMs: 0,
				spawnWorker: () => {
					spawns += 1;
					writeFileSync(join(workspace, "partial-edit.txt"), "changed before failure");
					return worker(1);
				},
			},
		);
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "fail after opaque editing",
				cwd: workspace,
			});
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "failed");
			deepStrictEqual(terminal.safety?.toolTelemetry, {
				coverage: "unavailable",
				ingestionErrors: 0,
				unfinished: [],
				workspaceMutationPossible: true,
			});
			strictEqual(readFileSync(join(workspace, "partial-edit.txt"), "utf8"), "changed before failure");
			strictEqual(spawns, 1);
			ok(bundle.contract.assignments?.get(handle.runId)?.outcomeDetail?.includes("incomplete tool telemetry"));
		} finally {
			await bundle.extension.stop?.();
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("retains retries for a Claude subprocess constrained to read-only tools", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.autonomy = "read-only";
		settings.workers.maxRetries = 1;
		settings.targets = [{ id: "claude-cli", runtime: "claude-code", defaultModel: "claude-sonnet" }];
		settings.workers.default = { target: "claude-cli", model: "claude-sonnet", thinkingLevel: "off" };
		let spawns = 0;
		const bundle = makeDispatchBundle(
			dispatchStubContext({
				settings,
				runtime: CLAUDE_CODE_RUNTIME,
				agentTools: [ToolNames.Read],
				useRuntimeDefaultAgentBudget: true,
			}),
			{
				resilienceCooldownMs: 0,
				spawnWorker: () => (++spawns === 1 ? worker(1) : worker(0, "read-only recovery")),
			},
		);
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "retry read-only reconnaissance",
			});
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "succeeded");
			strictEqual(terminal.lineage?.attempt, 1);
			strictEqual(terminal.safety?.toolTelemetry?.coverage, "unavailable");
			strictEqual(terminal.safety?.toolTelemetry?.workspaceMutationPossible, false);
			strictEqual(spawns, 2);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("does not retry a mediated worker that crashes with a mutating call in flight", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => {
				spawns += 1;
				return failedWithUnfinishedEdit();
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "crash while editing",
			});
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "failed");
			deepStrictEqual(terminal.safety?.toolTelemetry, {
				coverage: "partial",
				ingestionErrors: 0,
				unfinished: [{ tool: "edit", count: 1 }],
				workspaceMutationPossible: true,
			});
			strictEqual(spawns, 1);
			ok(bundle.contract.assignments?.get(handle.runId)?.outcomeDetail?.includes("incomplete tool telemetry"));
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("marks telemetry partial when the worker event stream misses the finalization deadline", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			spawnWorker: failedWithUndrainedEvents,
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "fail with an event source that never closes",
			});
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "failed");
			strictEqual(terminal.safety?.toolTelemetry?.coverage, "partial");
			strictEqual(terminal.safety?.toolTelemetry?.ingestionErrors, 1);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("does not retry when malformed worker frames could conceal a workspace mutation", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings, agentTools: [ToolNames.Read, ToolNames.Edit] }), {
			spawnWorker: () => {
				spawns += 1;
				return failedWithMalformedTelemetry();
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "fail after emitting unusable tool telemetry",
			});
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "failed");
			deepStrictEqual(terminal.safety?.toolTelemetry, {
				coverage: "partial",
				ingestionErrors: 1,
				unfinished: [],
				workspaceMutationPossible: true,
			});
			strictEqual(spawns, 1);
			ok(bundle.contract.assignments?.get(handle.runId)?.outcomeDetail?.includes("incomplete tool telemetry"));
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("settles a queued retry deterministically when the extension stops", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => {
				spawns += 1;
				return worker(1);
			},
		});
		await bundle.extension.start();
		const handle = await bundle.contract.dispatch({
			agentId: "coder",
			executionRole: "builder",
			task: "queue then stop",
		});
		// The first attempt fails and its retry is queued behind a backoff timer.
		await waitFor(() => bundle.contract.snapshot().retrying.length === 1, "retry queued");
		await bundle.extension.stop?.();
		// finalPromise resolves (never hangs) to the last immutable attempt receipt,
		// and the durable record is terminal rather than stuck running.
		const terminal = await handle.finalPromise;
		strictEqual(terminal.outcome, "failed");
		strictEqual(bundle.contract.assignments?.getStored(handle.runId)?.status, "canceled");
		strictEqual(spawns, 1, "the queued retry never spawned after shutdown");
	});

	it("starting a sibling extension leaves a live claimed assignment untouched", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 0;
		const first = makeDispatchBundle(dispatchStubContext({ settings }));
		const second = makeDispatchBundle(dispatchStubContext({ settings }));

		await first.extension.start();
		try {
			const before = await claimAssignmentVerdict("fleet-live", "fleet");
			ok(before.processOwner, "the fleet claim persists its process owner");

			await second.extension.start();
			try {
				const after = getStoredAssignment("fleet-live");
				deepStrictEqual(after, before);
				strictEqual(after?.status, "running");
				strictEqual(after?.terminalRunId, null);
			} finally {
				await second.extension.stop?.();
			}
		} finally {
			await first.extension.stop?.();
		}
	});

	it("reconciles an orphaned running assignment against ledger state on restart", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 0;
		const bundleA = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => worker(0, "done"),
		});
		await bundleA.extension.start();
		const handle = await bundleA.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "orphan me" });
		const terminal = await handle.finalPromise;
		strictEqual(terminal.outcome, "succeeded");
		await bundleA.extension.stop?.();

		// Simulate a crash that persisted the attempt ledger/receipt but not the
		// assignment settle: flip the durable record back to running.
		const storePath = join(clioStateDir(), "assignments.json");
		const store = JSON.parse(readFileSync(storePath, "utf8")) as {
			assignments: Array<{ status: string; terminalRunId: string | null }>;
		};
		for (const record of store.assignments) {
			record.status = "running";
			record.terminalRunId = null;
		}
		writeFileSync(storePath, JSON.stringify(store));

		// A fresh bundle over the same state dir reconciles the orphan on start.
		const bundleB = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => worker(0),
		});
		await bundleB.extension.start();
		try {
			const stored = bundleB.contract.assignments?.getStored(handle.runId);
			strictEqual(stored?.status, "succeeded");
			strictEqual(stored?.terminalRunId, terminal.runId);
		} finally {
			await bundleB.extension.stop?.();
		}
	});

	it("canceling the root attempt starts no retry", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let resolveExit!: (result: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
		const exit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			resolveExit = resolve;
		});
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => {
				spawns += 1;
				return {
					pid: 8100,
					promise: exit,
					events: (async function* (): AsyncIterableIterator<unknown> {})(),
					abort: () => resolveExit({ exitCode: 1, signal: "SIGTERM" }),
					heartbeatAt: { current: Date.now() },
				};
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "cancel assignment",
			});
			bundle.contract.abort(handle.runId);
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "canceled");
			strictEqual(bundle.contract.assignments?.get(handle.runId)?.status, "canceled");
			// Real time, deliberately: proving no retry fires means outliving the
			// 500ms first-attempt backoff (extension.ts:2553), and that timer takes
			// no injected clock.
			await new Promise((resolve) => setTimeout(resolve, 600));
			strictEqual(spawns, 1);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
