import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ClioSettings } from "../../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../../src/core/defaults.js";
import type { DomainContext } from "../../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../../src/core/event-bus.js";
import { resetXdgCache } from "../../../src/core/xdg.js";
import type { ConfigContract } from "../../../src/domains/config/contract.js";
import { createProvidersBundle } from "../../../src/domains/providers/extension.js";
import { getRuntimeRegistry } from "../../../src/domains/providers/registry.js";

const ORIGINAL_ENV = { ...process.env };

function seedSettings(scratch: string): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	settings.endpoints = [
		{
			id: "claude-prod",
			runtime: "anthropic",
			wireModels: ["claude-opus-4-7"],
			defaultModel: "claude-opus-4-7",
		},
	];
	settings.orchestrator = {
		endpoint: "claude-prod",
		model: "claude-opus-4-7",
		thinkingLevel: "off",
	};
	const configDir = join(scratch, "config");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "credentials.yaml"),
		[
			"version: 2",
			"entries:",
			"  anthropic:",
			"    type: api_key",
			"    key: stored-key-from-file",
			"    updatedAt: 2026-01-01T00:00:00.000Z",
			"",
		].join("\n"),
		"utf8",
	);
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

describe("providers/auth runtime override wiring", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-override-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
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

	it("runtime override wins over env var and file-backed stored key for the active endpoint", async () => {
		const settings = seedSettings(scratch);
		process.env.ANTHROPIC_API_KEY = "env-key-ANTHROPIC_API_KEY";

		const bundle = createProvidersBundle(stubContext(settings));
		await bundle.extension.start();
		try {
			const endpoint = bundle.contract.getEndpoint("claude-prod");
			strictEqual(endpoint?.id, "claude-prod");
			const runtime = endpoint ? bundle.contract.getRuntime(endpoint.runtime) : null;
			strictEqual(runtime?.id, "anthropic");
			if (!endpoint || !runtime) return;

			const pre = await bundle.contract.auth.resolveForTarget(endpoint, runtime);
			strictEqual(pre.source, "stored-api-key");
			strictEqual(pre.apiKey, "stored-key-from-file");

			bundle.contract.auth.setRuntimeOverrideForTarget(endpoint, runtime, "OVERRIDE-sk-flag");

			const post = await bundle.contract.auth.resolveForTarget(endpoint, runtime);
			strictEqual(post.source, "runtime-override");
			strictEqual(post.apiKey, "OVERRIDE-sk-flag");

			bundle.contract.auth.clearRuntimeOverrideForTarget(endpoint, runtime);
			const cleared = await bundle.contract.auth.resolveForTarget(endpoint, runtime);
			strictEqual(cleared.source, "stored-api-key");
			strictEqual(cleared.apiKey, "stored-key-from-file");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("runtime override is scoped to the active endpoint and does not leak to other endpoints sharing the runtime", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
		settings.endpoints = [
			{ id: "claude-prod", runtime: "anthropic", defaultModel: "claude-opus-4-7" },
			{ id: "claude-staging", runtime: "anthropic", defaultModel: "claude-opus-4-7" },
		];
		settings.orchestrator = {
			endpoint: "claude-prod",
			model: "claude-opus-4-7",
			thinkingLevel: "off",
		};
		mkdirSync(join(scratch, "config"), { recursive: true });
		writeFileSync(
			join(scratch, "config", "credentials.yaml"),
			[
				"version: 2",
				"entries:",
				"  anthropic:",
				"    type: api_key",
				"    key: shared-stored-key",
				"    updatedAt: 2026-01-01T00:00:00.000Z",
				"",
			].join("\n"),
			"utf8",
		);

		const bundle = createProvidersBundle(stubContext(settings));
		await bundle.extension.start();
		try {
			const active = bundle.contract.getEndpoint("claude-prod");
			const other = bundle.contract.getEndpoint("claude-staging");
			const runtime = active ? bundle.contract.getRuntime(active.runtime) : null;
			if (!active || !other || !runtime) throw new Error("test setup: endpoints missing");

			bundle.contract.auth.setRuntimeOverrideForTarget(active, runtime, "OVERRIDE-active-only");

			const activeResolved = await bundle.contract.auth.resolveForTarget(active, runtime);
			strictEqual(activeResolved.source, "runtime-override");
			strictEqual(activeResolved.apiKey, "OVERRIDE-active-only");

			const otherResolved = await bundle.contract.auth.resolveForTarget(other, runtime);
			strictEqual(otherResolved.source, "stored-api-key");
			strictEqual(otherResolved.apiKey, "shared-stored-key");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("runtime override wins when only an env var is configured and nothing is stored", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
		settings.endpoints = [{ id: "claude-prod", runtime: "anthropic", defaultModel: "claude-opus-4-7" }];
		settings.orchestrator = {
			endpoint: "claude-prod",
			model: "claude-opus-4-7",
			thinkingLevel: "off",
		};
		mkdirSync(join(scratch, "config"), { recursive: true });
		process.env.ANTHROPIC_API_KEY = "env-key-only";

		const bundle = createProvidersBundle(stubContext(settings));
		await bundle.extension.start();
		try {
			const endpoint = bundle.contract.getEndpoint("claude-prod");
			const runtime = endpoint ? bundle.contract.getRuntime(endpoint.runtime) : null;
			if (!endpoint || !runtime) throw new Error("test setup: endpoint/runtime missing");

			const pre = await bundle.contract.auth.resolveForTarget(endpoint, runtime);
			strictEqual(pre.source, "environment");
			strictEqual(pre.apiKey, "env-key-only");

			bundle.contract.auth.setRuntimeOverrideForTarget(endpoint, runtime, "OVERRIDE-sk-flag");

			const post = await bundle.contract.auth.resolveForTarget(endpoint, runtime);
			strictEqual(post.source, "runtime-override");
			strictEqual(post.apiKey, "OVERRIDE-sk-flag");
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
