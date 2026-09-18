import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { RUNTIME_NOTICE_KINDS, type RuntimeNoticePayload } from "../../src/core/bus-events.js";
import { watchDegradedInference } from "../../src/engine/apis/degraded-inference.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";
import { runtimeNoticeProducers, setResidencyNoticeSink } from "../../src/engine/apis/residency.js";

afterEach(() => setResidencyNoticeSink(null));

function partial(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "ollama-native",
		provider: "ollama",
		model: "qwen3:32b",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// A fixture turn under the watchdog with a manual clock and a manual poll, so
// the 30 second grace passes without waiting on the wall clock.
function fixtureTurn(signal?: AbortSignal) {
	let clock = 0;
	let poll: (() => void) | null = null;
	const notices: RuntimeNoticePayload[] = [];
	setResidencyNoticeSink((notice) => notices.push(notice));
	const source = createAssistantMessageEventStream();
	const output = partial();
	const watched = watchDegradedInference(source, {
		targetId: "mini",
		runtimeId: "ollama-native",
		model: "qwen3:32b",
		...(signal ? { signal } : {}),
		listResident: async () => [
			{ modelId: "qwen3:32b", sizeBytes: 100, sizeVramBytes: 40 },
			{ modelId: "nomic-embed-text" },
		],
		timing: {
			now: () => clock,
			setTimer: (fn) => {
				poll = fn;
				return { cancel: () => (poll = null) };
			},
		},
	});
	const drained = (async () => {
		for await (const _ of watched) {
			// Drain so the watched stream keeps flowing.
		}
	})();
	return {
		notices,
		start: async () => {
			source.push({ type: "start", partial: output });
			await flush();
		},
		text: (delta: string) => source.push({ type: "text_delta", contentIndex: 0, delta, partial: output }),
		thinking: (delta: string) => source.push({ type: "thinking_delta", contentIndex: 0, delta, partial: output }),
		advance: (ms: number) => {
			clock += ms;
		},
		tick: async () => {
			await flush();
			poll?.();
			await flush();
			await flush();
		},
		finish: async () => {
			source.push({ type: "done", reason: "stop", message: output });
			source.end();
			await drained;
		},
	};
}

describe("degraded-inference notice", () => {
	it("reports a stream below the floor past the grace exactly once, naming the residents", async () => {
		const turn = fixtureTurn();
		await turn.start();
		turn.text("abcd");
		turn.thinking("efgh");
		turn.advance(10_000);
		await turn.tick();
		strictEqual(turn.notices.length, 0, "no judgment inside the grace period");
		turn.advance(21_000);
		await turn.tick();
		turn.advance(30_000);
		await turn.tick();
		await turn.finish();
		strictEqual(turn.notices.length, 1);
		const [notice] = turn.notices;
		strictEqual(notice?.kind, "degraded");
		strictEqual(notice?.level, "warning");
		strictEqual(notice?.targetId, "mini");
		deepStrictEqual(notice?.detail, {
			tokens: 2,
			elapsedMs: 31_000,
			tokensPerSecond: 0.06,
			residents: "qwen3:32b (40% on GPU), nomic-embed-text",
		});
		match(notice?.message ?? "", /generated 2 tokens in 31s \(0\.06 tok\/s\)/);
		match(notice?.message ?? "", /Resident there: qwen3:32b \(40% on GPU\), nomic-embed-text\./);
	});

	it("stays silent for a stream above the floor", async () => {
		const turn = fixtureTurn();
		await turn.start();
		for (let i = 0; i < 80; i++) turn.text("four");
		turn.advance(31_000);
		await turn.tick();
		await turn.finish();
		strictEqual(turn.notices.length, 0);
	});

	it("stays silent after the turn is aborted", async () => {
		const controller = new AbortController();
		const turn = fixtureTurn(controller.signal);
		await turn.start();
		turn.text("ab");
		turn.advance(20_000);
		await turn.tick();
		controller.abort();
		turn.advance(60_000);
		await turn.tick();
		await turn.finish();
		strictEqual(turn.notices.length, 0);
	});
});

describe("runtime notice producers", () => {
	it("every RuntimeNoticeKind has a declared producer in the engine", () => {
		registerClioApiProviders();
		const produced = new Set([...runtimeNoticeProducers().values()].flatMap((kinds) => [...kinds]));
		const orphaned = RUNTIME_NOTICE_KINDS.filter((kind) => !produced.has(kind));
		deepStrictEqual(orphaned, [], `RuntimeNoticeKind members with no producer: ${orphaned.join(", ")}`);
	});
});
