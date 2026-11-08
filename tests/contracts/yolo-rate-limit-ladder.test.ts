import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { setImmediate as nextLoop } from "node:timers/promises";
import { DEFAULT_RETRY_SETTINGS, RATE_LIMIT_WAIT_BUDGET_MS } from "../../src/domains/session/retry.js";
import type { RetryStatusPayload, TurnRecoveryDeps } from "../../src/session-control/turn-recovery.js";
import { createTurnRecovery } from "../../src/session-control/turn-recovery.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";

const RATE_LIMITED = "429 rate_limit_error: This request would exceed your rate limit";

async function run(
	c: TestContext,
	input: {
		yolo: boolean;
		errorMessage?: string;
		runtimeId?: string;
		retryAfterSeconds?: number;
		failingContinues: number;
	},
) {
	c.mock.timers.enable({ apis: ["setTimeout"] });
	let clock = 0;
	c.mock.method(performance, "now", () => clock);
	const errorMessage = input.errorMessage ?? RATE_LIMITED;
	const failure = (): Record<string, unknown> => ({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
		...(input.retryAfterSeconds === undefined
			? {}
			: { anthropicResponse: { retryAfterSeconds: input.retryAfterSeconds } }),
	});
	let continues = 0;
	const runtime = {
		runtimeId: input.runtimeId ?? "anthropic-max",
		runtimeResolution: { contextWindowDetails: { effectiveContextWindow: 131072 } },
		agent: {
			state: { messages: [] as unknown[], errorMessage: undefined as string | undefined },
			async continue() {
				continues++;
				this.state.messages.push(
					continues <= input.failingContinues
						? failure()
						: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: Date.now() },
				);
			},
		},
	} as unknown as AgentRuntime;
	const state = createTurnState();
	const statuses: RetryStatusPayload[] = [];
	const recovery = createTurnRecovery({
		state,
		isYolo: () => input.yolo,
		turnIdentity: () => state,
		persistence: { appendRetryStatus() {}, wasPersisted: () => true } as unknown as TurnRecoveryDeps["persistence"],
		context: {} as unknown as TurnRecoveryDeps["context"],
		retrySettings: () => DEFAULT_RETRY_SETTINGS,
		markPersistedUserEcho: async (_text, prompt) => prompt(),
		emitRetryStatus: (status) => {
			statuses.push(status);
		},
		emitFailureMessage() {},
		emitNotice() {},
	});
	let done = false;
	let handled: boolean | undefined;
	void recovery
		.runTransientRetryChain(runtime, "request", {
			stopReason: "error",
			errorMessage,
			message: failure() as never,
		})
		.then((value) => {
			handled = value;
			done = true;
		});
	for (let tick = 0; !done && tick < 10_000; tick++) {
		await nextLoop();
		clock += 1000;
		c.mock.timers.tick(1000);
	}
	ok(done, "the ladder settled");
	const delays = statuses.filter((status) => status.phase === "scheduled").map((status) => status.delayMs ?? 0);
	return { continues, delays, state, handled, phases: statuses.map((status) => status.phase) };
}

describe("rate limit ladder at yolo (#445)", () => {
	it("keeps retrying a rate limit past maxRetries until an hour of waiting is spent", async (c) => {
		const { continues, delays, state, phases } = await run(c, { yolo: true, failingContinues: 1000 });
		strictEqual(
			delays.reduce((sum, delay) => sum + delay, 0),
			RATE_LIMIT_WAIT_BUDGET_MS,
		);
		ok(continues > DEFAULT_RETRY_SETTINGS.maxRetries);
		strictEqual(phases.at(-1), "exhausted");
		strictEqual(state.continuation.stop?.cause, "retries_exhausted");
	});

	it("waits the provider's Retry-After instead of its own backoff", async (c) => {
		const { continues, delays, phases } = await run(c, { yolo: true, retryAfterSeconds: 120, failingContinues: 0 });
		deepStrictEqual(delays, [120_000]);
		strictEqual(continues, 1);
		strictEqual(phases.at(-1), "recovered");
	});

	it("stops without another attempt on a Retry-After past the budget", async (c) => {
		const { continues, delays, state } = await run(c, { yolo: true, retryAfterSeconds: 7200, failingContinues: 1000 });
		deepStrictEqual(delays, []);
		strictEqual(continues, 0);
		strictEqual(state.continuation.stop?.cause, "wait_past_budget");
	});

	it("leaves other autonomy levels on the short ladder", async (c) => {
		const { continues, delays } = await run(c, { yolo: false, failingContinues: 1000 });
		deepStrictEqual(delays, [2000, 4000, 8000]);
		strictEqual(continues, 3);
	});

	it("keeps quota terminal at yolo", async (c) => {
		const { continues, delays, state } = await run(c, {
			yolo: true,
			errorMessage: "429 insufficient_quota: You exceeded your current quota",
			failingContinues: 1000,
		});
		strictEqual(continues, 0);
		deepStrictEqual(delays, []);
		strictEqual(state.continuation.stop, null);
	});

	it("waits out a litellm rate limit only at yolo", async (c) => {
		const atYolo = await run(c, { yolo: true, runtimeId: "litellm", retryAfterSeconds: 60, failingContinues: 0 });
		strictEqual(atYolo.continues, 1);
		c.mock.timers.reset();
		c.mock.restoreAll();
		const attended = await run(c, { yolo: false, runtimeId: "litellm", failingContinues: 0 });
		strictEqual(attended.continues, 0);
	});

	it("does not wait on a transient failure that is not a rate limit", async (c) => {
		const { delays, state } = await run(c, {
			yolo: true,
			errorMessage: "503 service unavailable",
			failingContinues: 1000,
		});
		deepStrictEqual(delays, [2000, 4000, 8000]);
		strictEqual(state.continuation.stop?.cause, "retries_exhausted");
	});
});
