import { BusChannels } from "../src/core/bus-events.js";
import type { SafeEventBus, SafeEventListener } from "../src/core/event-bus.js";
import { createDispatchBoardStore, formatDispatchBoardLines } from "../src/interactive/dispatch-board.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-dispatch-board] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-dispatch-board] FAIL ${label}${detail ? ` - ${detail}` : ""}\n`);
}

function createFakeBus(): SafeEventBus {
	const listenersByChannel = new Map<string, Set<SafeEventListener>>();
	return {
		emit(channel, payload) {
			for (const listener of [...(listenersByChannel.get(channel) ?? [])]) {
				void listener(payload);
			}
		},
		on(channel, listener) {
			const listeners = listenersByChannel.get(channel) ?? new Set<SafeEventListener>();
			listeners.add(listener);
			listenersByChannel.set(channel, listeners);
			return () => {
				const current = listenersByChannel.get(channel);
				if (!current) return;
				current.delete(listener);
				if (current.size === 0) listenersByChannel.delete(channel);
			};
		},
		listeners(channel) {
			return [...(listenersByChannel.get(channel) ?? [])];
		},
		clear() {
			listenersByChannel.clear();
		},
	};
}

function withNow<T>(value: number, fn: () => T): T {
	const original = Date.now;
	Date.now = () => value;
	try {
		return fn();
	} finally {
		Date.now = original;
	}
}

async function main(): Promise<void> {
	const rendered = formatDispatchBoardLines([
		{
			runId: "run-1",
			agentId: "reviewer-alpha",
			runtime: "sdk",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6-long-name",
			status: "running",
			elapsedMs: 1234,
			tokenCount: 0,
			costUsd: 0,
		},
		{
			runId: "run-2",
			agentId: "scout",
			runtime: "cli",
			providerId: "openai",
			modelId: "gpt-5",
			status: "completed",
			elapsedMs: 9876,
			tokenCount: 42,
			costUsd: 0.012345,
		},
	]);
	const lineLengths = [...new Set(rendered.map((line) => line.length))];
	check("format:stable-width", lineLengths.length === 1, JSON.stringify(lineLengths));
	check(
		"format:header-columns",
		rendered[1]?.includes("agent") &&
			rendered[1]?.includes("runtime") &&
			rendered[1]?.includes("provider/model") &&
			rendered[1]?.includes("status"),
		rendered[1],
	);
	const runningLine = rendered.find((line) => line.includes("running"));
	const completedLine = rendered.find((line) => line.includes("completed"));
	check(
		"format:status-aligned",
		typeof runningLine === "string" &&
			typeof completedLine === "string" &&
			runningLine.indexOf("running") === completedLine.indexOf("completed"),
		JSON.stringify({ runningLine, completedLine }),
	);
	check(
		"format:provider-model-truncated",
		rendered.some((line) => line.includes("anthropic/claude-sonn...")),
		JSON.stringify(rendered),
	);
	check(
		"format:close-hint",
		rendered.some((line) => line.includes("[Esc] close")),
		JSON.stringify(rendered),
	);

	const bus = createFakeBus();
	const store = createDispatchBoardStore(bus);

	withNow(1_000, () => {
		bus.emit(BusChannels.DispatchEnqueued, {
			runId: "run-enqueued",
			agentId: "scout",
			providerId: "openai",
			modelId: "gpt-5",
			runtime: "sdk",
		});
	});
	let rows = withNow(1_000, () => store.rows());
	let enqueued = rows.find((row) => row.runId === "run-enqueued");
	check(
		"store:enqueued-row-appears",
		rows.length === 1 &&
			enqueued?.status === "enqueued" &&
			enqueued?.runtime === "sdk" &&
			enqueued?.providerId === "openai" &&
			enqueued?.modelId === "gpt-5",
		JSON.stringify(rows),
	);

	withNow(1_200, () => {
		bus.emit(BusChannels.DispatchStarted, {
			runId: "run-enqueued",
			agentId: "scout",
			providerId: "openai",
			modelId: "gpt-5",
			runtime: "sdk",
		});
	});
	rows = withNow(1_450, () => store.rows());
	enqueued = rows.find((row) => row.runId === "run-enqueued");
	check(
		"store:started-row-shows-running",
		enqueued?.status === "running" && enqueued.elapsedMs === 250,
		JSON.stringify(enqueued),
	);

	withNow(1_500, () => {
		bus.emit(BusChannels.DispatchProgress, {
			runId: "run-enqueued",
			event: {
				type: "message_end",
				message: {
					role: "assistant",
					usage: {
						input: 7,
						output: 13,
						cacheRead: 5,
						cacheWrite: 3,
					},
				},
			},
		});
	});
	rows = withNow(1_500, () => store.rows());
	enqueued = rows.find((row) => row.runId === "run-enqueued");
	check(
		"store:progress-message-end-includes-cache-tokens",
		enqueued?.status === "running" && enqueued?.tokenCount === 28,
		JSON.stringify(enqueued),
	);

	withNow(1_550, () => {
		bus.emit(BusChannels.DispatchProgress, {
			runId: "run-enqueued",
			event: {
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "stop" }],
			},
		});
	});
	rows = withNow(1_550, () => store.rows());
	enqueued = rows.find((row) => row.runId === "run-enqueued");
	check(
		"store:agent-end-stop-marks-completed-before-receipt",
		enqueued?.status === "completed" && enqueued?.tokenCount === 28,
		JSON.stringify(enqueued),
	);

	withNow(1_600, () => {
		bus.emit(BusChannels.DispatchCompleted, {
			runId: "run-enqueued",
			agentId: "scout",
			providerId: "openai",
			modelId: "gpt-5",
			runtime: "sdk",
			tokenCount: 77,
			costUsd: 0.00123,
			durationMs: 345,
		});
	});
	rows = withNow(1_900, () => store.rows());
	const completed = rows.find((row) => row.runId === "run-enqueued");
	check(
		"store:completed-row-has-final-totals",
		completed?.status === "completed" &&
			completed.elapsedMs === 345 &&
			completed.tokenCount === 77 &&
			completed.costUsd === 0.00123,
		JSON.stringify(completed),
	);

	withNow(2_000, () => {
		bus.emit(BusChannels.DispatchEnqueued, {
			runId: "run-failed",
			agentId: "reviewer",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			runtime: "cli",
		});
	});
	withNow(2_100, () => {
		bus.emit(BusChannels.DispatchFailed, {
			runId: "run-failed",
			agentId: "reviewer",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			runtime: "cli",
			tokenCount: 13,
			costUsd: 0.222,
			durationMs: 55,
		});
	});
	rows = withNow(2_200, () => store.rows());
	const failed = rows.find((row) => row.runId === "run-failed");
	check(
		"store:failed-row-shows-failed",
		failed?.status === "failed" && failed?.tokenCount === 13 && failed?.costUsd === 0.222 && failed?.runtime === "cli",
		JSON.stringify(failed),
	);

	withNow(2_300, () => {
		bus.emit(BusChannels.DispatchEnqueued, {
			runId: "run-aborted",
			agentId: "reviewer",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			runtime: "cli",
		});
	});
	withNow(2_350, () => {
		bus.emit(BusChannels.DispatchStarted, {
			runId: "run-aborted",
			agentId: "reviewer",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			runtime: "cli",
		});
	});
	withNow(2_375, () => {
		bus.emit(BusChannels.DispatchProgress, {
			runId: "run-aborted",
			event: {
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "aborted" }],
			},
		});
	});
	rows = withNow(2_375, () => store.rows());
	const abortedBeforeReceipt = rows.find((row) => row.runId === "run-aborted");
	check(
		"store:agent-end-aborted-marks-row-before-receipt",
		abortedBeforeReceipt?.status === "aborted",
		JSON.stringify(abortedBeforeReceipt),
	);
	withNow(2_400, () => {
		bus.emit(BusChannels.DispatchFailed, {
			runId: "run-aborted",
			agentId: "reviewer",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			runtime: "cli",
			tokenCount: 9,
			costUsd: 0,
			durationMs: 25,
			reason: "interrupted",
		});
	});
	rows = withNow(2_450, () => store.rows());
	const aborted = rows.find((row) => row.runId === "run-aborted");
	check(
		"store:dispatch-failed-interrupted-stays-aborted",
		aborted?.status === "aborted" && aborted?.tokenCount === 9,
		JSON.stringify(aborted),
	);

	for (let index = 0; index < 55; index += 1) {
		withNow(3_000 + index, () => {
			bus.emit(BusChannels.DispatchEnqueued, {
				runId: `run-cap-${index}`,
				agentId: `agent-${index}`,
				providerId: "openai",
				modelId: "gpt-5",
				runtime: "native",
			});
		});
		withNow(3_100 + index, () => {
			bus.emit(BusChannels.DispatchCompleted, {
				runId: `run-cap-${index}`,
				agentId: `agent-${index}`,
				providerId: "openai",
				modelId: "gpt-5",
				runtime: "native",
				tokenCount: index,
				costUsd: 0,
				durationMs: 10,
			});
		});
	}
	rows = withNow(3_200, () => store.rows());
	const rowIds = new Set(rows.map((row) => row.runId));
	check("store:retains-at-most-50-rows", rows.length === 50, String(rows.length));
	check(
		"store:evicts-oldest-terminal-rows-first",
		!rowIds.has("run-cap-0") &&
			!rowIds.has("run-cap-1") &&
			!rowIds.has("run-cap-2") &&
			!rowIds.has("run-cap-3") &&
			!rowIds.has("run-cap-4") &&
			rowIds.has("run-cap-54"),
		JSON.stringify([...rowIds].sort()),
	);

	store.unsubscribe();
	const countAfterUnsubscribe = store.rows().length;
	withNow(3_000, () => {
		bus.emit(BusChannels.DispatchEnqueued, {
			runId: "run-ignored",
			agentId: "late",
			providerId: "openai",
			modelId: "gpt-5",
			runtime: "native",
		});
	});
	check("store:unsubscribe-stops-updates", store.rows().length === countAfterUnsubscribe, JSON.stringify(store.rows()));

	if (failures.length > 0) {
		process.stderr.write(`[diag-dispatch-board] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-dispatch-board] PASS\n");
}

main().catch((err: unknown) => {
	process.stderr.write(`[diag-dispatch-board] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
