import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isClioHomeRelocated, resolveClioDirs } from "../../src/core/xdg.js";
import { createAnthropicMaxQuotaProvider } from "../../src/domains/quota/anthropic-max-provider.js";
import { createAntigravityQuotaProvider } from "../../src/domains/quota/antigravity-provider.js";
import { createClaudeCodeQuotaProvider } from "../../src/domains/quota/claude-code-provider.js";
import { createCodexQuotaProvider } from "../../src/domains/quota/codex-provider.js";
import { buildQuotaProviders } from "../../src/domains/quota/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("BT-006 relocated homes exclude implicit sibling credentials before detection or network reads", async () => {
	const env = await isolateClioEnv();
	try {
		process.env.HOME = env.dir;
		for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "ANTIGRAVITY_HOME"]) delete process.env[key];
		const fixtures = [
			[".codex/auth.json", { tokens: { access_token: "scratch" } }],
			[".claude/.credentials.json", { claudeAiOauth: { accessToken: "scratch" } }],
			[".gemini/antigravity-cli/antigravity-oauth-token", { token: { access_token: "scratch" } }],
		] as const;
		for (const [path, data] of fixtures) {
			const full = join(env.dir, path);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, JSON.stringify(data));
		}
		let requests = 0;
		const fetch: typeof globalThis.fetch = async () => {
			requests++;
			throw new Error("unexpected network");
		};
		for (const provider of [
			createCodexQuotaProvider({ fetch }),
			createClaudeCodeQuotaProvider({ fetch }),
			createAntigravityQuotaProvider({ fetch }),
		]) {
			strictEqual(await provider.detect(), false);
			strictEqual((await provider.fetch()).status, "no_credentials");
		}
		strictEqual(requests, 0);
		deepStrictEqual(
			buildQuotaProviders().map((p) => p.id),
			["anthropic-max"],
		);
	} finally {
		env.restore();
	}
});

test("BT-006 explicit sibling homes opt in independently and default roots preserve connected accounts", async () => {
	const env = await isolateClioEnv();
	try {
		process.env.HOME = env.dir;
		process.env.XDG_CONFIG_HOME = join(env.dir, "xdg-config");
		process.env.XDG_DATA_HOME = join(env.dir, "xdg-data");
		process.env.XDG_STATE_HOME = join(env.dir, "xdg-state");
		process.env.XDG_CACHE_HOME = join(env.dir, "xdg-cache");
		process.env.APPDATA = join(env.dir, "appdata");
		process.env.LOCALAPPDATA = join(env.dir, "localappdata");
		for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "ANTIGRAVITY_HOME"]) delete process.env[key];
		const homes = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "ANTIGRAVITY_HOME"] as const;
		const leaves = ["auth.json", ".credentials.json", "antigravity-oauth-token"];
		const records = [
			{ tokens: { access_token: "scratch" } },
			{ claudeAiOauth: { accessToken: "scratch" } },
			{ token: { access_token: "scratch" } },
		];
		const factories = [createCodexQuotaProvider, createClaudeCodeQuotaProvider, createAntigravityQuotaProvider];
		for (const [index, key] of homes.entries()) {
			process.env[key] = env.dir;
			writeFileSync(join(env.dir, leaves[index] ?? "missing"), JSON.stringify(records[index]));
			strictEqual(await factories[index]?.().detect(), true);
			strictEqual(buildQuotaProviders().length, 2);
			delete process.env[key];
		}
		for (const key of [
			"CLIO_CODER_HOME",
			"CLIO_CODER_CONFIG_DIR",
			"CLIO_CODER_DATA_DIR",
			"CLIO_CODER_STATE_DIR",
			"CLIO_CODER_CACHE_DIR",
		])
			delete process.env[key];
		strictEqual(isClioHomeRelocated(), false);
		deepStrictEqual(
			buildQuotaProviders().map((p) => p.id),
			["anthropic-max", "claude-code", "codex", "antigravity"],
		);
		process.env.CLIO_CODER_CONFIG_DIR = resolveClioDirs().config;
		strictEqual(isClioHomeRelocated(), false);
		process.env.CLIO_CODER_CACHE_DIR = join(env.dir, "relocated-cache");
		strictEqual(isClioHomeRelocated(), true);
		deepStrictEqual(
			buildQuotaProviders().map((p) => p.id),
			["anthropic-max"],
		);
	} finally {
		env.restore();
	}
});

test("BT-006 Clio-owned Anthropic credentials stay usable in a relocated home", async () => {
	const env = await isolateClioEnv();
	try {
		mkdirSync(join(env.dir, "config"), { recursive: true });
		writeFileSync(
			join(env.dir, "config", "credentials.yaml"),
			JSON.stringify({
				version: 2,
				entries: {
					"anthropic-max": {
						type: "oauth",
						access: "scratch",
						refresh: "scratch",
						expires: Date.now() + 3600000,
						updatedAt: new Date().toISOString(),
					},
				},
			}),
		);
		let requests = 0;
		const provider = createAnthropicMaxQuotaProvider({
			fetch: async () => {
				requests++;
				return new Response(JSON.stringify({ five_hour: { utilization: 5 } }), { status: 200 });
			},
		});
		strictEqual(await provider.detect(), true);
		strictEqual((await provider.fetch()).status, "ok");
		strictEqual(requests, 1);
	} finally {
		env.restore();
	}
});
