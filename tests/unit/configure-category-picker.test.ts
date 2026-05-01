import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { runtimesForCategory } from "../../src/cli/configure.js";
import type { ProviderSupportEntry } from "../../src/domains/providers/support.js";
import { listProviderSupportEntries } from "../../src/domains/providers/support.js";
import type { CapabilityFlags } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";

const NO_CAPS: CapabilityFlags = {
	chat: false,
	tools: false,
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 0,
	maxTokens: 0,
};

interface FakeOpts {
	kind?: RuntimeDescriptor["kind"];
	auth?: RuntimeDescriptor["auth"];
	displayName?: string;
	probe?: boolean;
}

function fakeRuntime(id: string, opts: FakeOpts = {}): RuntimeDescriptor {
	const runtime: RuntimeDescriptor = {
		id,
		displayName: opts.displayName ?? id,
		kind: opts.kind ?? "http",
		apiFamily: "openai-completions",
		auth: opts.auth ?? "api-key",
		defaultCapabilities: NO_CAPS,
		synthesizeModel: () => {
			throw new Error(`synth not implemented for ${id}`);
		},
	};
	if (opts.probe) {
		runtime.probe = async () => ({ ok: true });
	}
	return runtime;
}

function buildEntries(): ProviderSupportEntry[] {
	const runtimes: RuntimeDescriptor[] = [
		fakeRuntime("openai-codex", { auth: "oauth", displayName: "OpenAI Codex" }),
		fakeRuntime("anthropic", { auth: "api-key", displayName: "Anthropic" }),
		fakeRuntime("openai", { auth: "api-key", displayName: "OpenAI" }),
		fakeRuntime("groq", { auth: "api-key", displayName: "Groq" }),
		fakeRuntime("google", { auth: "api-key", displayName: "Google" }),
		fakeRuntime("ollama-native", { auth: "none", displayName: "Ollama", probe: true }),
		fakeRuntime("lmstudio-native", { auth: "api-key", displayName: "LM Studio", probe: true }),
		fakeRuntime("llamacpp", { auth: "none", displayName: "llama.cpp", probe: true }),
		fakeRuntime("vllm", { auth: "none", displayName: "vLLM", probe: true }),
		fakeRuntime("sglang", { auth: "none", displayName: "SGLang", probe: true }),
		fakeRuntime("openai-compat", { auth: "none", displayName: "OpenAI compat", probe: true }),
		fakeRuntime("lemonade", { auth: "none", displayName: "Lemonade", probe: true }),
		fakeRuntime("claude-code-cli", { kind: "subprocess", auth: "cli", displayName: "Claude Code CLI" }),
	];
	return listProviderSupportEntries(runtimes);
}

describe("configure category picker filtering", () => {
	const entries = buildEntries();

	it("local-app returns only ollama-native and lmstudio-native", () => {
		const ids = runtimesForCategory(entries, "local-app")
			.map((entry) => entry.runtimeId)
			.sort();
		deepStrictEqual(ids, ["lmstudio-native", "ollama-native"]);
	});

	it("local-http excludes the local-app runtimes", () => {
		const ids = runtimesForCategory(entries, "local-http").map((entry) => entry.runtimeId);
		ok(!ids.includes("ollama-native"));
		ok(!ids.includes("lmstudio-native"));
		ok(ids.includes("llamacpp"));
		ok(ids.includes("vllm"));
		ok(ids.includes("sglang"));
		ok(ids.includes("openai-compat"));
		ok(ids.includes("lemonade"));
	});

	it("chatgpt returns the openai-codex runtime alone", () => {
		const filtered = runtimesForCategory(entries, "chatgpt");
		strictEqual(filtered.length, 1);
		strictEqual(filtered[0]?.runtimeId, "openai-codex");
	});

	it("cloud-api returns cloud-api runtimes sorted by displayName", () => {
		const filtered = runtimesForCategory(entries, "cloud-api");
		const ids = filtered.map((entry) => entry.runtimeId);
		deepStrictEqual(ids, ["anthropic", "google", "groq", "openai"]);
	});

	it("cloud-api does not include subscription or local runtimes", () => {
		const ids = runtimesForCategory(entries, "cloud-api").map((entry) => entry.runtimeId);
		ok(!ids.includes("openai-codex"));
		ok(!ids.includes("ollama-native"));
		ok(!ids.includes("llamacpp"));
		ok(!ids.includes("claude-code-cli"));
	});

	it("all returns the full entry set unchanged", () => {
		const filtered = runtimesForCategory(entries, "all");
		strictEqual(filtered.length, entries.length);
		deepStrictEqual(
			filtered.map((entry) => entry.runtimeId),
			entries.map((entry) => entry.runtimeId),
		);
	});
});
