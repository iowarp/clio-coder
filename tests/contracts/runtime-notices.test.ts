import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
} from "@earendil-works/pi-ai";

import { RUNTIME_NOTICE_KINDS, type RuntimeNoticePayload } from "../../src/core/bus-events.js";
import {
	createDegradedInferenceStream,
	runningDegradedInferenceWatchdogs,
} from "../../src/engine/apis/degraded-inference.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";
import { ollamaNativeApiProvider } from "../../src/engine/apis/ollama-native.js";
import { withLocalResidency } from "../../src/engine/apis/openai-completions.js";
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
function fixtureTurn(signal?: AbortSignal, options: { defaultClock?: boolean } = {}) {
	let clock = 0;
	let poll: (() => void) | null = null;
	const notices: RuntimeNoticePayload[] = [];
	setResidencyNoticeSink((notice) => notices.push(notice));
	const output = partial();
	const source = createDegradedInferenceStream({
		targetId: "mini",
		runtimeId: "ollama-native",
		model: "qwen3:32b",
		...(signal ? { signal } : {}),
		listResident: async () => [
			{ modelId: "qwen3:32b", sizeBytes: 100, sizeVramBytes: 40 },
			{ modelId: "nomic-embed-text" },
		],
		timing: {
			...(options.defaultClock ? {} : { monotonicNow: () => clock }),
			setTimer: (fn: () => void) => {
				poll = fn;
				return { cancel: () => (poll = null) };
			},
		},
	});
	const drained = (async () => {
		for await (const _ of source) {
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

	it("judges elapsed time on a monotonic clock that a wall-clock step cannot move", async (t) => {
		let wall = 1_700_000_000_000;
		t.mock.method(Date, "now", () => wall);
		const turn = fixtureTurn(undefined, { defaultClock: true });
		await turn.start();
		wall += 60_000;
		await turn.tick();
		await turn.finish();
		strictEqual(turn.notices.length, 0, "a forward wall-clock step is not elapsed generation time");
	});
});

async function withServer(
	handler: Parameters<typeof createServer>[1],
	run: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const server: Server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

// Drain a stream with a bound, so a stream that never ends fails the test
// instead of hanging it. Collects any rejection nobody handled meanwhile.
async function drainBounded(stream: AssistantMessageEventStream) {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	const events: AssistantMessageEvent[] = [];
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const drained = (async () => {
			for await (const event of stream) events.push(event);
			return stream.result();
		})();
		const result = await Promise.race([
			drained,
			new Promise<"hung">((resolve) => {
				timeout = setTimeout(() => resolve("hung"), 5_000);
			}),
		]);
		await flush();
		return { events, result, unhandled };
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		process.off("unhandledRejection", onUnhandled);
	}
}

describe("degraded-inference error propagation", () => {
	it("ends an OpenAI-compatible local turn with an error event when the source throws mid-stream", async () => {
		// A 404 on every route leaves residency observe-only without loading anything.
		await withServer(
			(_req, res) => res.writeHead(404).end(),
			async (baseUrl) => {
				const model = {
					id: "qwen3-32b",
					name: "qwen3-32b",
					api: "openai-completions",
					provider: "llamacpp",
					baseUrl,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
					clioCoder: { runtimeId: "llamacpp", targetId: "dragon" },
				} as unknown as Model<"openai-completions">;
				const output = partial();
				const throwing = {
					async *[Symbol.asyncIterator]() {
						yield { type: "start", partial: output } as AssistantMessageEvent;
						yield { type: "text_delta", contentIndex: 0, delta: "ab", partial: output } as AssistantMessageEvent;
						throw new Error("socket reset mid-stream");
					},
				} as unknown as AssistantMessageEventStream;
				const { events, result, unhandled } = await drainBounded(withLocalResidency(model, {}, () => throwing));
				strictEqual(result === "hung" ? "hung" : "ended", "ended", "the stream ends");
				deepStrictEqual(
					events.map((event) => event.type),
					["start", "text_delta", "error"],
				);
				strictEqual(result !== "hung" && result.stopReason, "error");
				strictEqual(result !== "hung" && result.errorMessage, "socket reset mid-stream");
				deepStrictEqual(unhandled, []);
				strictEqual(runningDegradedInferenceWatchdogs(), 0, "the watchdog timer is stopped");
			},
		);
	});

	it("ends an Ollama turn with an error event when the chat stream breaks mid-stream", async () => {
		await withServer(
			(req, res) => {
				if (req.url === "/api/chat") {
					res.writeHead(200, { "content-type": "application/x-ndjson" });
					res.write(
						`${JSON.stringify({ model: "qwen3:32b", message: { role: "assistant", content: "ab" }, done: false })}\n`,
					);
					setImmediate(() => res.destroy());
					return;
				}
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [] }));
			},
			async (baseUrl) => {
				const model = {
					id: "qwen3:32b",
					name: "qwen3:32b",
					api: "ollama-native",
					provider: "ollama",
					baseUrl,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
				} as unknown as Model<"ollama-native">;
				const stream = ollamaNativeApiProvider.stream(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
				const { events, result, unhandled } = await drainBounded(stream);
				strictEqual(result === "hung" ? "hung" : "ended", "ended", "the stream ends");
				strictEqual(events.at(0)?.type, "start");
				strictEqual(events.at(-1)?.type, "error");
				strictEqual(result !== "hung" && result.stopReason, "error");
				deepStrictEqual(unhandled, []);
				strictEqual(runningDegradedInferenceWatchdogs(), 0, "the watchdog timer is stopped");
			},
		);
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
