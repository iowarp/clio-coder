import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeRetryDelayMs,
	createRetryCountdown,
	DEFAULT_RETRY_SETTINGS,
	isRetryableErrorMessage,
	type RetryCountdownState,
	type RetrySettings,
} from "../../src/domains/session/retry.js";

describe("session/retry isRetryableErrorMessage", () => {
	// Transient provider errors must classify as retryable so the chat-loop
	// schedules a backoff instead of surfacing the error to the user. Matches
	// pi-mono coding-agent's regex so sessions migrated from pi-mono behave
	// the same after classification.
	it("matches the transient errors the regex covers", () => {
		const samples = [
			"overloaded_error",
			"provider returned error",
			"rate_limited",
			"too many requests",
			"HTTP 429",
			"500 Internal Server Error",
			"service unavailable",
			"server error: 502 Bad Gateway",
			"internal error",
			"network error",
			"Connection error",
			"connection refused",
			"Connection lost",
			"fetch failed",
			"upstream connect error",
			"socket hang up",
			"ended without sending chunks",
			"request timed out",
			"timeout",
			"terminated",
			"retry delay exceeded",
		];
		for (const sample of samples) {
			ok(isRetryableErrorMessage(sample), `expected retryable: ${sample}`);
		}
	});

	it("rejects empty and unrelated errors", () => {
		strictEqual(isRetryableErrorMessage(""), false);
		strictEqual(isRetryableErrorMessage(null), false);
		strictEqual(isRetryableErrorMessage(undefined), false);
		strictEqual(isRetryableErrorMessage("invalid api key"), false);
		strictEqual(isRetryableErrorMessage("model not found"), false);
		strictEqual(isRetryableErrorMessage("context length exceeded"), false);
	});
});

describe("session/retry computeRetryDelayMs", () => {
	// Exponential backoff: attempt 1 uses baseDelayMs, attempt N uses
	// baseDelayMs * 2 ** (N-1), capped at maxDelayMs. Matches pi-mono's
	// formula so a user migrating sees identical waits.
	it("doubles the delay per attempt until the cap", () => {
		const settings: RetrySettings = { enabled: true, maxRetries: 10, baseDelayMs: 1000, maxDelayMs: 30_000 };
		strictEqual(computeRetryDelayMs(1, settings), 1000);
		strictEqual(computeRetryDelayMs(2, settings), 2000);
		strictEqual(computeRetryDelayMs(3, settings), 4000);
		strictEqual(computeRetryDelayMs(4, settings), 8000);
		strictEqual(computeRetryDelayMs(5, settings), 16_000);
		strictEqual(computeRetryDelayMs(6, settings), 30_000);
		strictEqual(computeRetryDelayMs(10, settings), 30_000);
	});

	it("normalizes attempt < 1 to the first delay", () => {
		strictEqual(computeRetryDelayMs(0), DEFAULT_RETRY_SETTINGS.baseDelayMs);
		strictEqual(computeRetryDelayMs(-3), DEFAULT_RETRY_SETTINGS.baseDelayMs);
	});

	it("uses DEFAULT_RETRY_SETTINGS when no settings are supplied", () => {
		const base = DEFAULT_RETRY_SETTINGS.baseDelayMs;
		strictEqual(computeRetryDelayMs(1), base);
		strictEqual(computeRetryDelayMs(2), base * 2);
	});
});

describe("session/retry createRetryCountdown", () => {
	// Deterministic clock + scheduler so the countdown progress can be
	// observed without wall-clock waits. Each scheduled task carries an
	// absolute deadline on the shared clock; `advance()` fires every task
	// whose deadline lands at or before the new `clock.now`. Tasks
	// scheduled inside a callback land with a strictly later deadline and
	// stay queued until the next advance, which prevents the infinite
	// "reschedule at same ms" loop a relative-delay design would have.
	interface Clock {
		now: number;
		tasks: Array<{ id: number; deadline: number; cb: () => void }>;
	}

	function makeClock(): Clock {
		return { now: 0, tasks: [] };
	}

	function makeTimer(clock: Clock): {
		setTimer: (cb: () => void, ms: number) => unknown;
		clearTimer: (id: unknown) => void;
	} {
		let nextId = 1;
		return {
			setTimer(cb, ms) {
				const id = nextId++;
				clock.tasks.push({ id, deadline: clock.now + ms, cb });
				return id;
			},
			clearTimer(id) {
				clock.tasks = clock.tasks.filter((task) => task.id !== id);
			},
		};
	}

	function advance(clock: Clock, ms: number): void {
		clock.now += ms;
		while (clock.tasks.length > 0) {
			const head = clock.tasks[0];
			if (!head || head.deadline > clock.now) break;
			clock.tasks.shift();
			head.cb();
		}
	}

	it("emits ticks each second and fires onDone at the deadline", () => {
		const clock = makeClock();
		const { setTimer, clearTimer } = makeTimer(clock);
		const ticks: RetryCountdownState[] = [];
		let done = 0;

		createRetryCountdown({
			attempt: 1,
			maxAttempts: 3,
			delayMs: 3000,
			setTimer,
			clearTimer,
			now: () => clock.now,
			onTick: (state) => ticks.push(state),
			onDone: () => {
				done++;
			},
		});

		// Synchronous initial tick.
		strictEqual(ticks.length, 1);
		strictEqual(ticks[0]?.seconds, 3);
		strictEqual(ticks[0]?.attempt, 1);
		strictEqual(ticks[0]?.maxAttempts, 3);
		strictEqual(ticks[0]?.done, false);

		advance(clock, 1000);
		strictEqual(ticks.length, 2);
		strictEqual(ticks[1]?.seconds, 2);

		advance(clock, 1000);
		strictEqual(ticks.length, 3);
		strictEqual(ticks[2]?.seconds, 1);

		advance(clock, 1000);
		strictEqual(done, 1);
		const last = ticks[ticks.length - 1];
		strictEqual(last?.seconds, 0);
		strictEqual(last?.done, true);
	});

	it("fires onCancel and stops ticking when cancelled mid-wait", () => {
		const clock = makeClock();
		const { setTimer, clearTimer } = makeTimer(clock);
		const ticks: RetryCountdownState[] = [];
		let cancels = 0;
		let dones = 0;

		const handle = createRetryCountdown({
			attempt: 2,
			maxAttempts: 3,
			delayMs: 4000,
			setTimer,
			clearTimer,
			now: () => clock.now,
			onTick: (state) => ticks.push(state),
			onDone: () => {
				dones++;
			},
			onCancel: () => {
				cancels++;
			},
		});

		advance(clock, 1000);
		handle.cancel();
		strictEqual(cancels, 1);
		strictEqual(dones, 0);
		const finalState = handle.getState();
		strictEqual(finalState.cancelled, true);
		strictEqual(finalState.done, false);
		strictEqual(finalState.seconds, 0);

		// Further clock advances must not fire additional ticks or the
		// onDone handler; cancellation is terminal.
		advance(clock, 10_000);
		strictEqual(dones, 0);
	});

	it("fires exactly once when the deadline has already passed at construction", () => {
		const clock = makeClock();
		const { setTimer, clearTimer } = makeTimer(clock);
		const ticks: RetryCountdownState[] = [];
		let done = 0;

		createRetryCountdown({
			attempt: 3,
			maxAttempts: 3,
			delayMs: 0,
			setTimer,
			clearTimer,
			now: () => clock.now,
			onTick: (state) => ticks.push(state),
			onDone: () => {
				done++;
			},
		});

		strictEqual(done, 1);
		strictEqual(ticks.length, 1);
		strictEqual(ticks[0]?.done, true);
		strictEqual(ticks[0]?.seconds, 0);
	});

	it("cancel() after onDone is a no-op", () => {
		const clock = makeClock();
		const { setTimer, clearTimer } = makeTimer(clock);
		let cancels = 0;
		let done = 0;

		const handle = createRetryCountdown({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 0,
			setTimer,
			clearTimer,
			now: () => clock.now,
			onTick: () => {},
			onDone: () => {
				done++;
			},
			onCancel: () => {
				cancels++;
			},
		});

		handle.cancel();
		strictEqual(done, 1);
		strictEqual(cancels, 0);
	});
});
