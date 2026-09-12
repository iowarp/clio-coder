import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { type LoadResult, loadDomains } from "../../src/core/domain-loader.js";
import { createConfigDomainModule } from "../../src/domains/config/index.js";
import { type ProvidersContract, ProvidersDomainModule } from "../../src/domains/providers/index.js";
import { resolveReservedOutputTokens, setGlobalDefaultMaxOutputTokens } from "../../src/engine/apis/output-budget.js";
import { type ChatLoop, createChatLoop } from "../../src/interactive/chat-loop.js";
import { closeServer, startOpenAICompatFixture } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("foreground requests use the effective output budget when the existing session changes settings", async () => {
	const env = await isolateClioEnv("clio-coder-foreground-output-");
	const fixture = await startOpenAICompatFixture("Complete.");
	let loaded: LoadResult | undefined;
	let loop: ChatLoop | undefined;
	try {
		process.env.CLIO_CODER_TEST_OPENAI_KEY = "fixture-key";
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{
				id: "fixture",
				runtime: "openai-compat",
				url: fixture.url,
				auth: { apiKeyEnvVar: "CLIO_CODER_TEST_OPENAI_KEY" },
				wireModels: ["mock-model"],
				capabilities: { chat: true, tools: true, contextWindow: 131072, maxTokens: 32768 },
			},
		];
		settings.chat.target = "fixture";
		settings.chat.model = "mock-model";
		settings.chat.maxOutputTokens = 32768;
		settings.chat.prewarm = false;
		loaded = await loadDomains([createConfigDomainModule(settings), ProvidersDomainModule]);
		const providers = loaded.getContract<ProvidersContract>("providers");
		ok(providers);
		loop = createChatLoop({ getSettings: () => settings, providers, knownTargets: () => new Set(["fixture"]) });
		const notices: string[] = [];
		loop.onEvent((event) => {
			if (event.type === "notice") notices.push(event.text);
		});
		for (const budget of [32768, 8192, 16384]) {
			// This is the session's effective view; the providers domain keeps its
			// original saved snapshot, as it does for a session-only settings edit.
			settings.chat.maxOutputTokens = budget;
			await loop.submit("Reply Complete.");
			const requests = fixture.requests.filter((request) => request.stream === true);
			strictEqual(requests.at(-1)?.max_tokens, budget, notices.join("\n"));
			strictEqual(resolveReservedOutputTokens(32768), budget);
		}
		deepStrictEqual(
			fixture.requests.filter((request) => request.stream === true).map((request) => request.max_tokens),
			[32768, 8192, 16384],
		);
	} finally {
		loop?.dispose();
		await loaded?.stop();
		await closeServer(fixture.server);
		setGlobalDefaultMaxOutputTokens(0);
		env.restore();
	}
});
