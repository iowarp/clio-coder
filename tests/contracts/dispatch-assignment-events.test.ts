import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createAssignmentEventStream } from "../../src/domains/dispatch/assignment-events.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { mutationReport } from "../harness/gate-fabric.js";

function events(text?: string): AsyncIterableIterator<unknown> {
	return (async function* () {
		yield { type: "agent_start" };
		if (text !== undefined) {
			yield { type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 1 } } };
		}
	})();
}

function worker(result: SpawnedWorkerResult, text?: string): SpawnedWorker {
	return {
		pid: 9100,
		promise: Promise.resolve(result),
		events: events(text),
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

function assistantText(event: unknown): string {
	if (typeof event !== "object" || event === null) return "";
	const record = event as { type?: unknown; message?: { role?: unknown; content?: unknown } };
	if (record.type !== "message_end" || record.message?.role !== "assistant") return "";
	return typeof record.message.content === "string" ? record.message.content : "";
}

function frameTypes(frames: ReadonlyArray<unknown>): string[] {
	return frames.map((frame) =>
		typeof frame === "object" && frame !== null && typeof (frame as { type?: unknown }).type === "string"
			? (frame as { type: string }).type
			: "unknown",
	);
}

describe("assignment event stream", () => {
	beforeEach(() => isolateDispatchState());
	after(() => restoreDispatchState());

	it("spans every attempt in order with one failover marker between them", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 1;
		let spawns = 0;
		const finalOutput = mutationReport("ATTEMPT-TWO-FINAL");
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => {
				spawns += 1;
				return spawns === 1
					? worker({ exitCode: 1, signal: null, stderrTail: "provider queue full" }, "ATTEMPT-ONE-PARTIAL")
					: worker({ exitCode: 0, signal: null }, finalOutput);
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "assignment stream",
			});
			const frames: unknown[] = [];
			for await (const frame of handle.events) frames.push(frame);
			const receipt = await handle.finalPromise;

			strictEqual(spawns, 2);
			strictEqual(receipt.outcome, "succeeded");

			const markers = frames.filter((frame) => (frame as { type?: unknown } | null)?.type === "attempt_start") as Array<{
				attempt: number;
				runId: string;
				previousRunId: string;
				reason: string;
			}>;
			strictEqual(markers.length, 1);
			const marker = markers[0];
			ok(marker);
			strictEqual(marker.attempt, 1);
			strictEqual(marker.previousRunId, handle.runId);
			strictEqual(marker.runId, receipt.runId);
			ok(marker.reason.length > 0);

			const markerIndex = frames.indexOf(marker);
			const firstTexts = frames.slice(0, markerIndex).map(assistantText).filter(Boolean);
			const secondTexts = frames
				.slice(markerIndex + 1)
				.map(assistantText)
				.filter(Boolean);
			deepStrictEqual(firstTexts, ["ATTEMPT-ONE-PARTIAL"]);
			deepStrictEqual(secondTexts, [finalOutput]);
			// Both attempts' frames are present, in attempt order, and the stream
			// completed on its own rather than being abandoned.
			ok(frameTypes(frames).filter((type) => type === "agent_start").length >= 2);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("ends with the terminal attempt's answer, matching the terminal receipt", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 1;
		let spawns = 0;
		const finalOutput = mutationReport("ANSWER-VISIBILITY-PROBE");
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => {
				spawns += 1;
				return spawns === 1
					? worker({ exitCode: 1, signal: null, stderrTail: "provider queue full" }, "STALE-ANSWER")
					: worker({ exitCode: 0, signal: null }, finalOutput);
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "answer visibility",
			});
			let lastAssistantText = "";
			for await (const frame of handle.events) {
				const text = assistantText(frame);
				if (text.length > 0) lastAssistantText = text;
			}
			const receipt = await handle.finalPromise;
			strictEqual(lastAssistantText, finalOutput);
			strictEqual(receipt.output?.text, lastAssistantText);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("closes the stream when the assignment is canceled", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 1;
		let finish!: (result: SpawnedWorkerResult) => void;
		const pending = new Promise<SpawnedWorkerResult>((resolve) => {
			finish = resolve;
		});
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => ({
				pid: 9101,
				promise: pending,
				events: (async function* () {
					yield { type: "agent_start" };
					await pending;
				})(),
				abort: () => finish({ exitCode: 1, signal: "SIGTERM" }),
				heartbeatAt: { current: Date.now() },
			}),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "cancel closes stream",
			});
			const drained = (async () => {
				const frames: unknown[] = [];
				for await (const frame of handle.events) frames.push(frame);
				return frames;
			})();
			bundle.contract.abort(handle.runId);
			// A hanging consumer would never settle this promise.
			const frames = await drained;
			ok(Array.isArray(frames));
			strictEqual((await handle.finalPromise).outcome, "canceled");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("drops the oldest frames rather than stalling a slow consumer", async () => {
		const stream = createAssignmentEventStream({ limit: 3 });
		let produced = 0;
		let sourceDrained!: () => void;
		const drained = new Promise<void>((resolve) => {
			sourceDrained = resolve;
		});
		stream.attach(
			(async function* () {
				for (let index = 0; index < 10; index += 1) {
					produced += 1;
					yield { type: "frame", index };
				}
				sourceDrained();
			})(),
		);
		stream.close();
		// Ingestion never awaits the consumer, so the source runs to exhaustion
		// while nobody reads. Only the tee's oldest frames are lost.
		await drained;
		strictEqual(produced, 10);
		const frames: Array<{ index: number }> = [];
		for await (const frame of stream.events) frames.push(frame as { index: number });
		deepStrictEqual(
			frames.map((frame) => frame.index),
			[7, 8, 9],
		);
		strictEqual(stream.droppedEvents(), 7);
	});

	it("orders attached sources and publishes the prelude between them", async () => {
		const stream = createAssignmentEventStream();
		stream.attach(
			(async function* () {
				yield { type: "a", n: 1 };
				yield { type: "a", n: 2 };
			})(),
		);
		stream.attach(
			(async function* () {
				yield { type: "b", n: 3 };
			})(),
			{ type: "attempt_start", attempt: 1 },
		);
		stream.close();
		const frames: unknown[] = [];
		for await (const frame of stream.events) frames.push(frame);
		deepStrictEqual(frameTypes(frames), ["a", "a", "attempt_start", "b"]);
		const after = await stream.events.next();
		strictEqual(after.done, true);
	});
});
