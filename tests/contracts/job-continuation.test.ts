import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type JobOwner, type JobRecord, TURN_CONTINUATION_CAP } from "../../src/core/job-types.js";
import { createJobController } from "../../src/domains/scheduling/job-controller.js";
import { JOB_MAIN_TIMEOUT_DEFAULT_MS } from "../../src/domains/scheduling/job-model.js";
import type {
	JobController,
	JobExecutionContext,
	JobRunnerPorts,
	JobRunResult,
	JobStore,
} from "../../src/domains/scheduling/job-types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createJobRuntime } from "../../src/entry/job-runtime.js";
import type { ChatLoop } from "../../src/session-control/chat-loop.js";
import type { MachineTurnRequest } from "../../src/session-control/job-turn-types.js";
import type { IsolatedClioEnv } from "../harness/scratch-env.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const settle = async (): Promise<void> => {
	await new Promise<void>((resolve) => setImmediate(resolve));
};

function memoryStore(): JobStore {
	const records = new Map<string, JobRecord>();
	return {
		list: (owner) =>
			[...records.values()]
				.filter((row) => row.owner.sessionId === owner.sessionId && row.owner.cwd === owner.cwd)
				.map((row) => structuredClone(row)),
		write(record, revision) {
			strictEqual(records.get(record.id)?.revision ?? null, revision);
			records.set(record.id, structuredClone(record));
		},
	};
}

const BUDGET: JobRunResult = { outcome: "succeeded", summary: "stopped", stoppedBy: "tool_budget" };
const GUARD: JobRunResult = { outcome: "succeeded", summary: "stopped", stoppedBy: "loop_guard" };
const FAILED: JobRunResult = { outcome: "failed", summary: "provider down", errorClass: "infrastructure" };
const DONE: JobRunResult = { outcome: "succeeded", summary: "done" };

describe("job continuation at yolo (#445)", () => {
	let scratch: IsolatedClioEnv;
	let controller: JobController | undefined;
	let clock: number;
	let owner: JobOwner;
	let yolo: boolean;
	let resumed: Array<{ cause: string; attempt: number }>;
	let boundsSeen: number[];
	let releases: Array<() => void>;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-job-continuation-");
		clock = 100_000;
		yolo = true;
		resumed = [];
		boundsSeen = [];
		releases = [];
		owner = { sessionId: "job-session", cwd: scratch.dir, generation: "generation-a" };
	});
	afterEach(async () => {
		for (const release of releases) release();
		await controller?.close();
		controller = undefined;
		scratch.restore();
	});

	function make(ports: Partial<JobRunnerPorts>): JobController {
		controller = createJobController({
			automatic: false,
			now: () => clock,
			store: memoryStore(),
			ports: {
				isCurrent: () => true,
				admit: async () => ({ status: "ready" }),
				run: async (context) => {
					context.start();
					return DONE;
				},
				deliver: async (context) => {
					context.start();
					return DONE;
				},
				...ports,
			},
			continuation: {
				allowed: () => yolo,
				resumed(job, boundMs, cause) {
					boundsSeen.push(boundMs);
					resumed.push({ cause, attempt: job.clockResumes ?? 0 });
				},
			},
		});
		return controller;
	}

	/** Every execution, occurrence or delivery alike, takes the next scripted result; the last one repeats. */
	function scripted(results: readonly JobRunResult[]): { host: JobController; executions: JobExecutionContext[] } {
		const executions: JobExecutionContext[] = [];
		const next = async (context: JobExecutionContext): Promise<JobRunResult> => {
			context.start();
			executions.push(
				structuredClone({ ...context, signal: undefined, start: undefined }) as unknown as JobExecutionContext,
			);
			return results[Math.min(executions.length - 1, results.length - 1)] ?? DONE;
		};
		return { host: make({ run: next, deliver: next }), executions };
	}

	/** The controller polls a job no sooner than 250 ms after its last execution, so the default step clears that. */
	async function advance(host: JobController, ms = 250): Promise<void> {
		clock += ms;
		host.tick();
		await settle();
		await settle();
	}

	const finalMainJob = { intervalMs: 1000, count: 1, runner: { kind: "main" as const, prompt: "poll CI" } };

	it("does not spend the cap on a tool budget crossing, however many there are", async () => {
		const crossings = TURN_CONTINUATION_CAP * 3;
		const { host, executions } = scripted([...Array.from({ length: crossings }, () => BUDGET), DONE]);
		const job = await host.create(finalMainJob, owner);
		for (let i = 0; i <= crossings + 1; i++) await advance(host);
		strictEqual(executions.length, crossings + 1);
		strictEqual(resumed.length, crossings);
		ok(resumed.every((row) => row.cause === "tool_budget" && row.attempt === 0));
		const ids = executions.flatMap((row) => row.job.delivery?.id ?? []);
		strictEqual(new Set(ids).size, ids.length, "each crossing gets its own delivery");
		const final = host.get(job.id, owner);
		strictEqual(final?.clockResumes, undefined);
		strictEqual(final?.delivery?.state, "delivered");
	});

	it("waits 1, 5 and 15 minutes on failures and stops at the cap", async () => {
		const { host, executions } = scripted([FAILED]);
		const job = await host.create(finalMainJob, owner);
		await advance(host, 0);
		strictEqual(executions.length, 1);
		for (const [index, delayMs] of [60_000, 300_000, 900_000].entries()) {
			await advance(host, delayMs - 1);
			strictEqual(executions.length, index + 1, `still waiting before continuation ${index + 1}`);
			await advance(host, 1);
			strictEqual(executions.length, index + 2, `continuation ${index + 1} ran`);
		}
		deepStrictEqual(
			resumed.map((row) => [row.cause, row.attempt]),
			[
				["failure", 1],
				["failure", 2],
				["failure", 3],
			],
		);
		await advance(host, 3_600_000);
		strictEqual(executions.length, 4, "the cap ends it");
		const final = host.get(job.id, owner);
		strictEqual(final?.clockResumes, TURN_CONTINUATION_CAP);
		strictEqual(final?.delivery?.state, "failed");
	});

	it("waits the provider's Retry-After when it is longer", async () => {
		const { host, executions } = scripted([{ ...FAILED, retryAfterMs: 600_000 }, DONE]);
		await host.create(finalMainJob, owner);
		await advance(host, 0);
		await advance(host, 599_999);
		strictEqual(executions.length, 1);
		await advance(host, 1);
		strictEqual(executions.length, 2);
	});

	it("keeps continuing on budget crossings after the cap, and a loop stop still ends it", async () => {
		const { host, executions } = scripted([GUARD, GUARD, GUARD, BUDGET, BUDGET, GUARD, DONE]);
		const job = await host.create(finalMainJob, owner);
		for (let i = 0; i < 10; i++) await advance(host);
		strictEqual(executions.length, 6);
		deepStrictEqual(
			resumed.map((row) => [row.cause, row.attempt]),
			[
				["loop_guard", 1],
				["loop_guard", 2],
				["loop_guard", 3],
				["tool_budget", 3],
				["tool_budget", 3],
			],
		);
		strictEqual(host.get(job.id, owner)?.clockResumes, TURN_CONTINUATION_CAP);
	});

	function hanging(onAbort: JobRunResult, counts: { runs: number }): Partial<JobRunnerPorts> {
		const hang = async (context: JobExecutionContext): Promise<JobRunResult> => {
			context.start();
			counts.runs++;
			if (counts.runs > 1) return DONE;
			await new Promise<void>((resolve) => {
				releases.push(resolve);
				context.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return onAbort;
		};
		return { run: hang, deliver: hang };
	}

	it("counts the default clock against the cap", async () => {
		const counts = { runs: 0 };
		const host = make(hanging({ outcome: "failed", summary: "aborted" }, counts));
		const job = await host.create(finalMainJob, owner);
		await advance(host, 0);
		await advance(host, JOB_MAIN_TIMEOUT_DEFAULT_MS + 1);
		await advance(host);
		deepStrictEqual(resumed, [{ cause: "clock", attempt: 1 }]);
		deepStrictEqual(boundsSeen, [JOB_MAIN_TIMEOUT_DEFAULT_MS]);
		await advance(host);
		strictEqual(counts.runs, 2);
		strictEqual(host.get(job.id, owner)?.clockResumes, 1);
	});

	it("never resumes an explicit timeout", async () => {
		const counts = { runs: 0 };
		const host = make(hanging({ outcome: "failed", summary: "aborted" }, counts));
		const job = await host.create({ ...finalMainJob, timeoutMs: 5000 }, owner);
		await advance(host, 0);
		await advance(host, 5001);
		await advance(host);
		await advance(host);
		deepStrictEqual(resumed, []);
		strictEqual(counts.runs, 1);
		strictEqual(host.get(job.id, owner)?.delivery, null);
	});

	it("never continues a turn a person canceled, even one that crossed the budget", async () => {
		const counts = { runs: 0 };
		const host = make(hanging(BUDGET, counts));
		const job = await host.create(finalMainJob, owner);
		await advance(host);
		await host.control(job.id, "cancel", owner);
		await advance(host);
		deepStrictEqual(resumed, []);
		strictEqual(counts.runs, 1);
	});

	it("does nothing below yolo: no continuation, and three infrastructure failures pause the job", async () => {
		yolo = false;
		const { host, executions } = scripted([BUDGET, FAILED]);
		const final = await host.create(finalMainJob, owner);
		await advance(host);
		await advance(host);
		strictEqual(executions.length, 1);
		deepStrictEqual(resumed, []);
		strictEqual(host.get(final.id, owner)?.delivery, null);
		await controller?.close();

		const failing = scripted([FAILED]);
		const recurring = await failing.host.create(
			{ intervalMs: 1000, count: 10, runner: { kind: "main", prompt: "poll CI" } },
			owner,
		);
		for (let i = 0; i < 3; i++) await advance(failing.host, 600_000);
		const paused = failing.host.get(recurring.id, owner);
		strictEqual(paused?.state, "paused");
		match(paused?.pendingReason ?? "", /three consecutive infrastructure failures; last: provider down/u);
	});

	it("keeps a failing recurring job running at yolo until its count ends it", async () => {
		const { host, executions } = scripted([FAILED]);
		const job = await host.create({ intervalMs: 1000, count: 6, runner: { kind: "main", prompt: "poll CI" } }, owner);
		for (let i = 0; i < 5; i++) {
			await advance(host, 600_000);
			strictEqual(host.get(job.id, owner)?.state, "active", `still running after ${i + 1} failures`);
		}
		strictEqual(executions.length, 5);
		deepStrictEqual(resumed, []);
		await advance(host, 600_000);
		strictEqual(executions.length, 6);
		strictEqual(host.get(job.id, owner)?.reason, "count");
	});

	it("leaves a stopped occurrence to the next one when the job has more to run", async () => {
		const { host, executions } = scripted([BUDGET, DONE]);
		const job = await host.create({ intervalMs: 1000, count: 2, runner: { kind: "main", prompt: "poll CI" } }, owner);
		await advance(host);
		deepStrictEqual(resumed, []);
		strictEqual(host.get(job.id, owner)?.delivery, null);
		await advance(host, 1000);
		strictEqual(executions.length, 2);
	});

	function runtimePorts(results: readonly Partial<ReturnType<typeof machineResult>>[]) {
		const requests: MachineTurnRequest[] = [];
		const chat = {
			machineTurnAvailable: () => true,
			async submitMachineTurn(request: MachineTurnRequest) {
				ok(request.onStarting());
				requests.push(request);
				return {
					...machineResult(request),
					...(results[Math.min(requests.length - 1, results.length - 1)] ?? {}),
				};
			},
		} as unknown as ChatLoop;
		const ports = createJobRuntime({
			chat: () => chat,
			isCurrent: () => true,
			constraints: () => undefined,
			safety: createWorkerSafety({ cwd: scratch.dir }),
			autonomy: () => "yolo",
			hostRefusal: () => null,
			trustRefusal: () => null,
			permissionPending: () => false,
			runCommand: async () => {
				throw new Error("unexpected command job");
			},
			notice: () => {},
		});
		return { ports, requests };
	}
	function machineResult(request: MachineTurnRequest) {
		return {
			status: "succeeded" as "succeeded" | "failed",
			turnId: request.executionId,
			text: "polled",
			stoppedBy: undefined as "tool_budget" | "loop_guard" | undefined,
		};
	}

	it("tells the model what stopped it and counts only what spends the cap", async () => {
		const { ports, requests } = runtimePorts([
			{ stoppedBy: "tool_budget" },
			{ stoppedBy: "loop_guard" },
			{ stoppedBy: "tool_budget" },
			{},
		]);
		const host = make(ports);
		await host.create(finalMainJob, owner);
		for (let i = 0; i < 6; i++) await advance(host);
		strictEqual(requests.length, 4);
		const [first, afterBudget, afterGuard, afterSecondBudget] = requests;
		strictEqual(first?.notice, undefined);
		ok(!first?.text.includes("[Clio Coder]"));
		match(afterBudget?.text ?? "", /stopped: it reached the per-turn tool budget/u);
		ok(!afterBudget?.text.includes("This is continuation"));
		ok(!afterBudget?.notice?.includes(" of 3"));
		match(afterGuard?.text ?? "", /stopped: the loop guard locked its tools.*This is continuation 1 of 3/u);
		match(afterGuard?.notice ?? "", /\(1 of 3\)/u);
		ok(!afterSecondBudget?.text.includes("This is continuation"));
		for (const request of requests) match(request.text, /poll CI/u);
	});

	it("gives an ordinary follow-up no continuation preamble", async () => {
		const { ports, requests } = runtimePorts([{}]);
		let polls = 0;
		const host = make({
			...ports,
			admit: async () => ({ status: "ready" }),
			run: async (context) => {
				context.start();
				polls++;
				return { outcome: "succeeded", json: { ready: true } };
			},
		});
		await host.create(
			{
				intervalMs: 1000,
				count: 2,
				runner: { kind: "command", argv: ["node", "--version"] },
				until: { path: ["ready"], op: "eq", value: true },
				onMatch: { kind: "main_turn", prompt: "ship it" },
			},
			owner,
		);
		await advance(host);
		await advance(host);
		strictEqual(polls, 1);
		strictEqual(requests.length, 1);
		ok(!requests[0]?.text.includes("The previous turn of this job stopped"));
		strictEqual(requests[0]?.notice, undefined);
	});
});
