import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { LocalModelQuirks } from "../../src/domains/providers/types/local-model-quirks.js";
import { assistantMessage, loadModelConfig } from "../../src/engine/apis/lmstudio-native.js";

interface ClioModel extends Model<"lmstudio-native"> {
	clio?: {
		targetId: string;
		runtimeId: string;
		lifecycle: "user-managed" | "clio-managed";
		quirks?: LocalModelQuirks;
	};
}

function model(quirks?: LocalModelQuirks): Model<"lmstudio-native"> {
	const fixture: ClioModel = {
		id: "local-model",
		name: "Local Model",
		api: "lmstudio-native",
		provider: "lmstudio-native",
		baseUrl: "ws://127.0.0.1:1234",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 4096,
		...(quirks === undefined
			? {}
			: {
					clio: {
						targetId: "local",
						runtimeId: "lmstudio",
						lifecycle: "clio-managed",
						quirks,
					},
				}),
	};
	return fixture;
}

function withKvCacheMode<T>(value: string, fn: () => T): T {
	const previous = process.env.CLIO_KV_CACHE_MODE;
	process.env.CLIO_KV_CACHE_MODE = value;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env.CLIO_KV_CACHE_MODE;
		else process.env.CLIO_KV_CACHE_MODE = previous;
	}
}

function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
	const original = process.stderr.write.bind(process.stderr);
	let stderr = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		return { result: fn(), stderr };
	} finally {
		process.stderr.write = original;
	}
}

describe("lmstudio-native thinking replay", () => {
	it("assistant message with thinking yields a leading <think>...</think> text part", () => {
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "Determining path..." },
			{ type: "text", text: "Done." },
		];
		const message = assistantMessage(content);
		strictEqual(message.role, "assistant");
		strictEqual(message.content.length, 2);
		deepStrictEqual(message.content[0], {
			type: "text",
			text: "<think>\nDetermining path...\n</think>",
		});
		deepStrictEqual(message.content[1], {
			type: "text",
			text: "Done.",
		});
	});

	it("assistant message without thinking matches current behavior (no leading think block)", () => {
		const content: AssistantMessage["content"] = [{ type: "text", text: "Done." }];
		const message = assistantMessage(content);
		strictEqual(message.role, "assistant");
		strictEqual(message.content.length, 1);
		deepStrictEqual(message.content[0], {
			type: "text",
			text: "Done.",
		});
	});
});

describe("contracts/lmstudio-native KV-cache env override", () => {
	it("sets f16 mode and useFp16ForKVCache", () => {
		const config = withKvCacheMode("f16", () => loadModelConfig(model()));
		strictEqual(config.llamaKCacheQuantizationType, "f16");
		strictEqual(config.llamaVCacheQuantizationType, "f16");
		strictEqual(config.useFp16ForKVCache, true);
	});

	it("clears configured KV-cache settings for none", () => {
		const config = withKvCacheMode("none", () =>
			loadModelConfig(model({ kvCache: { kQuant: "q4_0", vQuant: "q5_0", useFp16: true } })),
		);
		ok(!("llamaKCacheQuantizationType" in config));
		ok(!("llamaVCacheQuantizationType" in config));
		ok(!("useFp16ForKVCache" in config));
	});

	it("sets valid quant modes without any casts", () => {
		const config = withKvCacheMode("q8_0", () => loadModelConfig(model()));
		strictEqual(config.llamaKCacheQuantizationType, "q8_0");
		strictEqual(config.llamaVCacheQuantizationType, "q8_0");
		strictEqual(config.useFp16ForKVCache, false);
	});

	it("warns once and leaves config unchanged for invalid values", () => {
		const quirks: LocalModelQuirks = { kvCache: { kQuant: "q4_0", vQuant: "q5_0", useFp16: true } };
		const { result, stderr } = withKvCacheMode("bogus", () => captureStderr(() => loadModelConfig(model(quirks))));
		strictEqual(result.llamaKCacheQuantizationType, "q4_0");
		strictEqual(result.llamaVCacheQuantizationType, "q5_0");
		strictEqual(result.useFp16ForKVCache, true);
		strictEqual(stderr, "clio: ignoring invalid CLIO_KV_CACHE_MODE 'bogus'\n");
	});
});
