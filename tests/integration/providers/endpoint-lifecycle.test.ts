import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ClioSettings } from "../../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../../src/core/defaults.js";
import type { DomainContext } from "../../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../../src/core/event-bus.js";
import { resetXdgCache } from "../../../src/core/xdg.js";
import type { ConfigContract } from "../../../src/domains/config/contract.js";
import { openAuthStorage } from "../../../src/domains/providers/auth/index.js";
import { createProvidersBundle } from "../../../src/domains/providers/extension.js";
import { getRuntimeRegistry } from "../../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../../src/domains/providers/runtimes/builtins.js";
import { EMPTY_CAPABILITIES } from "../../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../../src/domains/providers/types/runtime-descriptor.js";

const ORIGINAL_ENV = { ...process.env };

function syntheticSettings(): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	settings.endpoints = [
		{
			id: "synthetic",
			runtime: "synthetic-runtime",
			url: "http://synthetic.invalid",
			defaultModel: "synthetic-model",
			auth: { apiKeyEnvVar: "CLIO_SYNTHETIC_KEY" },
		},
	];
	return settings;
}

function stubContext(settings: ClioSettings): DomainContext {
	const bus = createSafeEventBus();
	const config: ConfigContract = {
		get: () => settings,
		onChange: () => () => {},
	};
	const getContract = ((name: string) => {
		if (name === "config") return config;
		return undefined;
	}) as DomainContext["getContract"];
	return { bus, getContract };
}

function syntheticRuntime(): RuntimeDescriptor {
	return {
		id: "synthetic-runtime",
		displayName: "Synthetic",
		kind: "http",
		apiFamily: "openai-completions",
		auth: "api-key",
		credentialsEnvVar: "CLIO_SYNTHETIC_KEY",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		synthesizeModel: (endpoint, wireModelId) =>
			({ id: wireModelId, provider: "synthetic", baseUrl: endpoint.url ?? "" }) as never,
	};
}

describe("providers domain endpoint lifecycle", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-providers-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		// No credential present by default; each test sets its own.
		Reflect.deleteProperty(process.env, "CLIO_SYNTHETIC_KEY");
		resetXdgCache();
		// Reset the runtime singleton so test-only descriptors do not leak
		// between tests.
		getRuntimeRegistry().clear();
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("probeAll is a config-only sweep and does not throw even when the runtime is missing", async () => {
		const settings = syntheticSettings();
		const bundle = createProvidersBundle(stubContext(settings));
		await bundle.contract.probeAll();
		const list = bundle.contract.list();
		strictEqual(list.length, 1);
		strictEqual(list[0]?.endpoint.id, "synthetic");
		strictEqual(list[0]?.runtime, null);
		strictEqual(list[0]?.available, false);
	});

	it("list() reflects the endpoint as available=true when a credential is present", async () => {
		const settings = syntheticSettings();
		const registry = getRuntimeRegistry();
		registry.register(syntheticRuntime());
		process.env.CLIO_SYNTHETIC_KEY = "sk-test";
		const bundle = createProvidersBundle(stubContext(settings));
		await bundle.contract.probeAll();
		const entry = bundle.contract.list()[0];
		ok(entry, "expected a status row");
		strictEqual(entry.endpoint.id, "synthetic");
		strictEqual(entry.runtime?.id, "synthetic-runtime");
		strictEqual(entry.available, true);
		strictEqual(entry.reason, "env:CLIO_SYNTHETIC_KEY");
	});

	it("list() reflects the endpoint as available=false when credential is missing", async () => {
		const settings = syntheticSettings();
		const registry = getRuntimeRegistry();
		registry.register(syntheticRuntime());
		const bundle = createProvidersBundle(stubContext(settings));
		await bundle.contract.probeAll();
		const entry = bundle.contract.list()[0];
		ok(entry);
		strictEqual(entry.available, false);
		ok(entry.reason.includes("missing auth"));
	});

	it("list() reflects oauth-backed http endpoints as available when an oauth credential is stored", async () => {
		const settings = syntheticSettings();
		settings.endpoints = [
			{
				id: "synthetic-oauth",
				runtime: "synthetic-oauth",
				url: "https://chatgpt.com/backend-api",
				defaultModel: "gpt-5.4",
			},
		];
		const registry = getRuntimeRegistry();
		registry.register({
			...syntheticRuntime(),
			id: "synthetic-oauth",
			displayName: "Synthetic OAuth",
			auth: "oauth",
		});
		openAuthStorage().set("synthetic-oauth", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			updatedAt: new Date().toISOString(),
		});
		const bundle = createProvidersBundle(stubContext(settings));
		await bundle.contract.probeAll();
		const entry = bundle.contract.list()[0];
		ok(entry);
		strictEqual(entry.available, true);
		strictEqual(entry.reason, "store:oauth:synthetic-oauth");
	});

	it("list() uses catalog capabilities for cloud endpoint default models", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
		settings.endpoints = [
			{
				id: "or",
				runtime: "openrouter",
				defaultModel: "tencent/hy3-preview:free",
				auth: { apiKeyEnvVar: "OPENROUTER_API_KEY" },
			},
		];
		const registry = getRuntimeRegistry();
		registerBuiltinRuntimes(registry);

		const bundle = createProvidersBundle(stubContext(settings));
		await bundle.contract.probeAll();
		const entry = bundle.contract.list()[0];
		ok(entry);
		strictEqual(entry.available, false);
		strictEqual(entry.capabilities.reasoning, true);
		strictEqual(entry.capabilities.thinkingFormat, "openrouter");
		strictEqual(entry.capabilities.contextWindow, 262144);
		strictEqual(entry.capabilities.maxTokens, 262144);
	});

	it("getEndpoint returns the descriptor for known ids and null for unknown", () => {
		const settings = syntheticSettings();
		const bundle = createProvidersBundle(stubContext(settings));
		const found = bundle.contract.getEndpoint("synthetic");
		ok(found);
		strictEqual(found.id, "synthetic");
		strictEqual(bundle.contract.getEndpoint("does-not-exist"), null);
	});

	it("credentials.set/get/remove round-trips through the temp CLIO_CONFIG_DIR", () => {
		const settings = syntheticSettings();
		const registry = getRuntimeRegistry();
		registry.register(syntheticRuntime());
		const bundle = createProvidersBundle(stubContext(settings));
		const { credentials } = bundle.contract;
		strictEqual(credentials.hasKey("synthetic-runtime"), false);
		credentials.set("synthetic-runtime", "sk-round-trip");
		strictEqual(credentials.hasKey("synthetic-runtime"), true);
		strictEqual(credentials.get("synthetic-runtime"), "sk-round-trip");
		credentials.remove("synthetic-runtime");
		strictEqual(credentials.hasKey("synthetic-runtime"), false);
		strictEqual(credentials.get("synthetic-runtime"), null);
	});
});
