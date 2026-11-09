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
import { loopSegment } from "../../src/interactive/footer-panel.js";
import { formatCompactMs } from "../../src/interactive/theme/labels.js";
import type { ChatLoop } from "../../src/session-control/chat-loop.js";
import type { MachineTurnRequest } from "../../src/session-control/job-turn-types.js";
import { loopJobDetail } from "../../src/session-control/loop-command.js";
import { executeJobCommand, prepareJobCommand } from "../../src/tools/job-command.js";
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

	const pollJob = {
		intervalMs: 1000,
		count: 2,
		runner: { kind: "command" as const, argv: ["node", "--version"] },
		until: { path: ["state"], op: "ne" as const, value: "pending" },
		onMatch: { kind: "main_turn" as const, prompt: "CI settled, fix or report" },
	};
	const polls = (json: unknown[], delivered: string[]): Partial<JobRunnerPorts> => {
		let index = 0;
		return {
			run: async (context) => {
				context.start();
				const value = json[Math.min(index++, json.length - 1)];
				return value === null
					? { outcome: "failed", summary: "exit 1", errorClass: "execution" }
					: { outcome: "succeeded", summary: "polled", json: value };
			},
			deliver: async (context) => {
				context.start();
				delivered.push(context.job.delivery?.continuation ?? "match");
				return DONE;
			},
		};
	};

	it("wakes the main turn once when a poll job runs out of starts without a match", async () => {
		const delivered: string[] = [];
		const host = make(polls([{ state: "pending" }], delivered));
		const job = await host.create(pollJob, owner);
		for (let i = 0; i < 2; i++) await advance(host, 1000);
		deepStrictEqual(resumed, [{ cause: "job_exhausted", attempt: 0 }]);
		for (let i = 0; i < 3; i++) await advance(host, 1000);
		deepStrictEqual(delivered, ["job_exhausted"], "the wake runs once");
		const final = host.get(job.id, owner);
		strictEqual(final?.clockResumes, undefined);
		strictEqual(final?.reason, "count");
		strictEqual(final?.delivery?.state, "delivered");
	});

	it("wakes the main turn once when a poll job reaches its deadline without a match (#450)", async () => {
		const delivered: string[] = [];
		const host = make(polls([{ state: "pending" }], delivered));
		const { count: _count, ...unbounded } = pollJob;
		const job = await host.create({ ...unbounded, deadlineAt: clock + 2500 }, owner);
		for (let i = 0; i < 6; i++) await advance(host, 1000);
		deepStrictEqual(resumed, [{ cause: "job_deadline", attempt: 0 }]);
		deepStrictEqual(delivered, ["job_deadline"], "the wake runs once, after the deadline");
		const final = host.get(job.id, owner);
		strictEqual(final?.reason, "deadline");
		strictEqual(final?.delivery?.state, "delivered");
	});

	it("wakes it too when every poll failed, which is when the turn most needs to know", async () => {
		const delivered: string[] = [];
		const host = make(polls([null], delivered));
		await host.create(pollJob, owner);
		for (let i = 0; i < 4; i++) await advance(host, 1000);
		deepStrictEqual(delivered, ["job_exhausted"]);
	});

	it("delivers an ordinary follow-up when the last poll matches", async () => {
		const delivered: string[] = [];
		const host = make(polls([{ state: "pending" }, { state: "failure" }], delivered));
		await host.create(pollJob, owner);
		for (let i = 0; i < 4; i++) await advance(host, 1000);
		deepStrictEqual(delivered, ["match"]);
		deepStrictEqual(resumed, []);
	});

	it("leaves a poll job's end silent below yolo, without a follow-up, or with starts left", async () => {
		yolo = false;
		const delivered: string[] = [];
		const attended = make(polls([{ state: "pending" }], delivered));
		const job = await attended.create(pollJob, owner);
		for (let i = 0; i < 3; i++) await advance(attended, 1000);
		strictEqual(attended.get(job.id, owner)?.reason, "count");
		deepStrictEqual(delivered, []);
		await controller?.close();

		yolo = true;
		const noFollowUp = make(polls([{ state: "pending" }], delivered));
		const { onMatch: _onMatch, ...withoutFollowUp } = pollJob;
		await noFollowUp.create(withoutFollowUp, owner);
		for (let i = 0; i < 3; i++) await advance(noFollowUp, 1000);
		deepStrictEqual(delivered, []);
		deepStrictEqual(resumed, []);
		await controller?.close();

		const running = make(polls([{ state: "pending" }], delivered));
		await running.create({ ...pollJob, count: 5 }, owner);
		for (let i = 0; i < 3; i++) await advance(running, 1000);
		deepStrictEqual(resumed, []);
	});

	it("says the follow-up does not apply and hands over the last poll", async () => {
		const { ports, requests } = runtimePorts([{}]);
		const host = make({
			...ports,
			admit: async () => ({ status: "ready" }),
			run: async (context) => {
				context.start();
				return { outcome: "failed", summary: "KeyError: FAKE_CI_ARM", errorClass: "execution" };
			},
		});
		await host.create(pollJob, owner);
		for (let i = 0; i < 4; i++) await advance(host, 1000);
		strictEqual(requests.length, 1);
		const [wake] = requests;
		match(wake?.text ?? "", /ran out of its 2 starts and its condition never matched/u);
		match(wake?.text ?? "", /does not apply yet/u);
		match(wake?.text ?? "", /KeyError: FAKE_CI_ARM/u);
		ok(!wake?.text.includes("The previous turn of this job stopped"));
		match(wake?.notice ?? "", /Waking the main turn because autonomy is yolo; no new run is starting/u);
	});

	const failingJob = { ...pollJob, count: 20 };

	it("wakes the main turn once after 5 failed polls and keeps polling", async () => {
		const delivered: string[] = [];
		const host = make(polls([null], delivered));
		const job = await host.create(failingJob, owner);
		for (let i = 0; i < 4; i++) await advance(host, 1000);
		deepStrictEqual(delivered, []);
		strictEqual(host.get(job.id, owner)?.failedPolls, 4);
		await advance(host, 1000);
		deepStrictEqual(resumed, [{ cause: "polls_failing", attempt: 0 }]);
		for (let i = 0; i < 12; i++) await advance(host, 1000);
		deepStrictEqual(delivered, ["polls_failing"], "only one wake");
		const final = host.get(job.id, owner);
		strictEqual(final?.state, "active");
		ok((final?.settled ?? 0) >= 10, "polling went on after the wake");
		strictEqual(final?.clockResumes, undefined);
	});

	it("never runs a poll beside the follow-up, and coalesces what came due during it", async () => {
		let running = 0;
		let peak = 0;
		let pollCount = 0;
		let release: () => void = () => {};
		const track = async <T>(work: () => Promise<T>): Promise<T> => {
			running++;
			peak = Math.max(peak, running);
			try {
				return await work();
			} finally {
				running--;
			}
		};
		const host = make({
			run: (context) =>
				track(async () => {
					context.start();
					pollCount++;
					return { outcome: "failed", summary: "exit 1", errorClass: "execution" };
				}),
			deliver: (context) =>
				track(async () => {
					context.start();
					await new Promise<void>((resolve) => {
						release = resolve;
						releases.push(resolve);
					});
					return DONE;
				}),
		});
		const job = await host.create(failingJob, owner);
		for (let i = 0; i < 5; i++) await advance(host, 1000);
		await advance(host, 1000);
		strictEqual(host.get(job.id, owner)?.delivery?.state, "running");
		const atWake = pollCount;
		for (let i = 0; i < 8; i++) await advance(host, 1000);
		strictEqual(pollCount, atWake, "no poll starts while the follow-up runs");
		release();
		await advance(host, 1000);
		await advance(host, 1000);
		strictEqual(pollCount, atWake + 1, "the polls that came due collapse into one");
		strictEqual(peak, 1);
		strictEqual(host.get(job.id, owner)?.delivery?.state, "delivered");
	});

	it("resets the streak on a poll that works", async () => {
		const delivered: string[] = [];
		const ok1 = { state: "pending" };
		const host = make(polls([null, null, null, null, ok1, null, null, null, null, ok1], delivered));
		const job = await host.create(failingJob, owner);
		for (let i = 0; i < 10; i++) await advance(host, 1000);
		deepStrictEqual(delivered, []);
		strictEqual(host.get(job.id, owner)?.failedPolls, 0);
	});

	it("delivers the ordinary follow-up when a match comes after the wake", async () => {
		const delivered: string[] = [];
		const host = make(polls([null, null, null, null, null, { state: "success" }], delivered));
		const job = await host.create(failingJob, owner);
		for (let i = 0; i < 9; i++) await advance(host, 1000);
		deepStrictEqual(delivered, ["polls_failing", "match"]);
		strictEqual(host.get(job.id, owner)?.reason, "condition");
	});

	it("gives one wake when the fifth failure is also the last start, and two when it is not", async () => {
		const last: string[] = [];
		const host = make(polls([null], last));
		await host.create({ ...pollJob, count: 5 }, owner);
		for (let i = 0; i < 8; i++) await advance(host, 1000);
		deepStrictEqual(last, ["job_exhausted"]);
		await controller?.close();
		const later: string[] = [];
		const other = make(polls([null], later));
		await other.create({ ...pollJob, count: 7 }, owner);
		for (let i = 0; i < 11; i++) await advance(other, 1000);
		deepStrictEqual(later, ["polls_failing", "job_exhausted"]);
	});

	it("does not wake below yolo or without a follow-up, and still counts the streak", async () => {
		yolo = false;
		const delivered: string[] = [];
		const attended = make(polls([null], delivered));
		const job = await attended.create(failingJob, owner);
		for (let i = 0; i < 7; i++) await advance(attended, 1000);
		deepStrictEqual(delivered, []);
		strictEqual(attended.get(job.id, owner)?.failedPolls, 7);
		await controller?.close();
		yolo = true;
		const bare = make(polls([null], delivered));
		const { onMatch: _onMatch, ...withoutFollowUp } = failingJob;
		await bare.create(withoutFollowUp, owner);
		for (let i = 0; i < 7; i++) await advance(bare, 1000);
		deepStrictEqual(delivered, []);
	});

	it("drops the wake and stops polling when the job is canceled during it", async () => {
		let pollCount = 0;
		let wakes = 0;
		const host = make({
			run: async (context) => {
				context.start();
				pollCount++;
				return { outcome: "failed", summary: "exit 1", errorClass: "execution" };
			},
			deliver: async (context) => {
				context.start();
				wakes++;
				await new Promise<void>((resolve) => {
					releases.push(resolve);
					context.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return DONE;
			},
		});
		const job = await host.create(failingJob, owner);
		for (let i = 0; i < 6; i++) await advance(host, 1000);
		strictEqual(wakes, 1);
		const atCancel = pollCount;
		await host.control(job.id, "cancel", owner);
		for (let i = 0; i < 5; i++) await advance(host, 1000);
		strictEqual(pollCount, atCancel);
		strictEqual(wakes, 1);
		strictEqual(host.get(job.id, owner)?.state, "terminal");
	});

	it("tells the woken model the job is still polling and how to end it", async () => {
		const { ports, requests } = runtimePorts([{}]);
		const host = make({
			...ports,
			admit: async () => ({ status: "ready" }),
			run: async (context) => {
				context.start();
				return { outcome: "failed", summary: "KeyError: FAKE_CI_ARM", errorClass: "execution" };
			},
		});
		await host.create(failingJob, owner);
		for (let i = 0; i < 6; i++) await advance(host, 1000);
		strictEqual(requests.length, 1);
		match(requests[0]?.text ?? "", /failed 5 polls in a row and is still polling/u);
		match(requests[0]?.text ?? "", /KeyError: FAKE_CI_ARM/u);
		match(requests[0]?.text ?? "", /action stop/u);
		match(requests[0]?.notice ?? "", /Waking the main turn because autonomy is yolo/u);
	});

	it("shows a failing job in /loop status and the footer at every autonomy level", async () => {
		yolo = false;
		const host = make({
			run: async (context) => {
				context.start();
				return {
					outcome: "failed",
					summary: JSON.stringify({ exitCode: 3, stderr: "boom" }),
					errorClass: "execution",
				};
			},
		});
		const job = await host.create(failingJob, owner);
		for (let i = 0; i < 2; i++) await advance(host, 1000);
		const record = host.get(job.id, owner);
		ok(record);
		ok(
			loopJobDetail(record, clock).some((line) => line.includes("2 polls failed in a row · last poll exit 3")),
			loopJobDetail(record, clock).join("\n"),
		);
		const footer = loopSegment([record], 200, clock) ?? "";
		match(footer, /Loop failing/u);
		match(footer, /last poll exit 3/u);
	});

	it("rounds a job's footer countdown to whole seconds before splitting minutes from seconds", () => {
		strictEqual(formatCompactMs(10_799_600), "180m0s");
		strictEqual(formatCompactMs(59_600), "1m0s");
	});

	it("passes only GH_TOKEN and GITHUB_TOKEN to a job command, and only at yolo", async () => {
		const saved = { ...process.env };
		Object.assign(process.env, { GH_TOKEN: "gh-fixture", GITHUB_TOKEN: "github-fixture", SOME_OTHER_SECRET: "no" });
		try {
			const run = async (autonomy: "yolo" | "default"): Promise<Record<string, string>> => {
				const runner = prepareJobCommand(
					[process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
					scratch.dir,
				);
				const result = await executeJobCommand(
					{
						job: {
							spec: { runner, timeoutMs: 30_000 },
							owner,
						} as unknown as JobRecord,
						executionId: "fixture",
						signal: new AbortController().signal,
						start: () => true,
					},
					autonomy,
				);
				return result.json as Record<string, string>;
			};
			const atYolo = await run("yolo");
			strictEqual(atYolo.GH_TOKEN, "gh-fixture");
			strictEqual(atYolo.GITHUB_TOKEN, "github-fixture");
			strictEqual(atYolo.SOME_OTHER_SECRET, undefined);
			const below = await run("default");
			strictEqual(below.GH_TOKEN, undefined);
			strictEqual(below.GITHUB_TOKEN, undefined);
			strictEqual(below.SOME_OTHER_SECRET, undefined);
		} finally {
			for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "SOME_OTHER_SECRET"]) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
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
