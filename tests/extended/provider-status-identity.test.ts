import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { updateSettings } from "../../src/core/config.js";
import { loadDomains } from "../../src/core/domain-loader.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import { ConfigDomainModule } from "../../src/domains/config/index.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import type { TargetStatus } from "../../src/domains/providers/contract.js";
import { ProvidersDomainModule } from "../../src/domains/providers/index.js";
import {
	readTargetModelSnapshot,
	recordTargetModelSnapshot,
	TARGET_MODEL_CACHE_TTL_MS,
	targetModelSnapshotPath,
} from "../../src/domains/providers/target-model-cache.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { startGatewayThinkingFixture } from "../harness/gateway-thinking-fixture.js";
import { closeServer, startOpenAICompatFixture } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("changing a target's probe identity drops the previous endpoint's health and capabilities", async () => {
	const scratch = await isolateClioEnv("clio-coder-provider-status-identity-");
	const originalCwd = process.cwd();
	let duringReasoning = () => {};
	const fixture = await startOpenAICompatFixture(() => {
		duringReasoning();
		return "fixture";
	});
	try {
		const cwd = join(scratch.dir, "workspace");
		mkdirSync(cwd);
		process.chdir(cwd);
		ensureClioState();
		const target: TargetDescriptor = {
			id: "fixture",
			runtime: "openai-compat",
			url: fixture.url,
			defaultModel: "mock-model",
		};
		updateSettings((settings) => {
			settings.targets = [target];
		});
		const loaded = await loadDomains([ConfigDomainModule, ProvidersDomainModule]);
		try {
			const config = loaded.getContract("config");
			const providers = loaded.getContract("providers");
			ok(config?.update && providers);
			const runtime = providers.getRuntime(target.runtime);
			ok(runtime);
			providers.auth.setRuntimeOverrideForTarget(target, runtime, "fixture-key");
			for (const replacement of [
				{ ...target, url: `${fixture.url}/different-endpoint` },
				{ ...target, defaultModel: "different-model" },
				{ ...target, runtime: "unregistered-fixture" },
			]) {
				config.update((settings) => {
					settings.targets = [target];
				}, "settings-ui");
				const probed: TargetStatus | null = await providers.probeTarget(target.id, { reasoning: false });
				ok(probed);
				strictEqual(probed.health.status, "healthy");
				deepStrictEqual(probed.discoveredModels, ["mock-model"]);
				config.update((settings) => {
					settings.targets = [replacement];
				}, "settings-ui");
				const current: TargetStatus | undefined = providers.list()[0];
				ok(current);
				strictEqual(current.target.runtime, replacement.runtime);
				strictEqual(current.target.url, replacement.url);
				strictEqual(current.health.status, "unknown");
				strictEqual(current.health.lastCheckAt, null);
				strictEqual(current.probeCapabilities, null);
				strictEqual(current.probeModelCapabilities, null);
				deepStrictEqual(
					current.discoveredModels,
					replacement.defaultModel !== target.defaultModel ? ["mock-model"] : [],
					"a model change may retain the durable catalog of the same endpoint",
				);
				if (replacement.runtime === "unregistered-fixture") strictEqual(current.capabilities.chat, false);
			}
			config.update((settings) => {
				settings.targets = [target];
			}, "settings-ui");
			duringReasoning = () =>
				config.update?.((settings) => {
					settings.targets = [{ ...target, url: `${fixture.url}/replacement` }];
				}, "settings-ui");
			strictEqual(await providers.probeReasoningForModel(target.id, "mock-model"), null);
			strictEqual(providers.getDetectedReasoning(target.id, "mock-model"), null);
		} finally {
			await loaded.stop();
		}
	} finally {
		await closeServer(fixture.server);
		process.chdir(originalCwd);
		scratch.restore();
	}
});

for (const ending of ["retargeted", "removed", "stopped", "overridden"] as const) {
	test(`a delayed provider probe respects the ${ending} target`, { timeout: 10_000 }, async () => {
		const scratch = await isolateClioEnv("clio-coder-provider-late-probe-");
		const originalCwd = process.cwd();
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fixture = await startGatewayThinkingFixture("lm-studio", "fixture-model", async () => {
			entered();
			await gate;
		});
		try {
			const cwd = join(scratch.dir, "workspace");
			mkdirSync(cwd);
			process.chdir(cwd);
			ensureClioState();
			const target: TargetDescriptor = {
				id: "fixture",
				runtime: "litellm",
				url: fixture.url,
				defaultModel: fixture.modelId,
			};
			updateSettings((settings) => {
				settings.targets = [target];
			});
			const loaded = await loadDomains([ConfigDomainModule, ProvidersDomainModule]);
			let pending: Promise<TargetStatus | null> | undefined;
			let publications = 0;
			const unsubscribe = telemetryHub().subscribe("provider.health_changed", () => {
				publications++;
			});
			try {
				const config = loaded.getContract("config");
				const providers = loaded.getContract("providers");
				ok(config?.update && providers);
				const runtime = providers.getRuntime(target.runtime);
				ok(runtime);
				providers.auth.setRuntimeOverrideForTarget(target, runtime, "fixture-key");
				pending = providers.probeTarget(target.id, { reasoning: false });
				await started;
				if (ending === "stopped") await loaded.stop();
				else
					config.update((settings) => {
						settings.targets =
							ending === "removed"
								? []
								: [
										ending === "overridden"
											? { ...target, capabilities: { contextWindow: 8192 } }
											: { ...target, url: `${fixture.url}/replacement` },
									];
					}, "settings-ui");
				const before = [...providers.list()];
				release();
				const result = await pending;
				if (ending === "overridden") {
					ok(result);
					strictEqual(result.capabilities.contextWindow, 8192);
					strictEqual(providers.list()[0]?.target.capabilities?.contextWindow, 8192);
					strictEqual(publications, 1);
					return;
				}
				strictEqual(result, null);
				deepStrictEqual(providers.list(), before);
				strictEqual(publications, 0);
				strictEqual(readTargetModelSnapshot(target), null);
			} finally {
				release();
				await pending;
				unsubscribe();
				await loaded.stop();
			}
		} finally {
			release();
			await fixture.close();
			process.chdir(originalCwd);
			scratch.restore();
		}
	});
}

test("a probe confirming the snapshot it already has skips the write until the snapshot is half way to expiry", async (t) => {
	const home = await isolateClioEnv("clio-model-snapshot-");
	t.after(() => home.restore());
	const cacheDir = join(home.dir, "cache");
	const target = { id: "local", runtime: "openai-compat", url: "http://127.0.0.1:9/v1" };
	const start = Date.parse("2026-01-01T00:00:00.000Z");
	const observed = (nowMs: number) => readTargetModelSnapshot(target, { cacheDir, nowMs })?.observedAt;
	ok(recordTargetModelSnapshot(target, ["a", "b"], { cacheDir, nowMs: start }));
	const path = targetModelSnapshotPath(target.id, cacheDir);
	const written = statSync(path).mtimeMs;
	ok(recordTargetModelSnapshot(target, ["a", "b"], { cacheDir, nowMs: start + 60_000 }));
	strictEqual(statSync(path).mtimeMs, written, "the same list is not rewritten");
	strictEqual(observed(start + 60_000), new Date(start).toISOString());
	ok(recordTargetModelSnapshot(target, ["a", "c"], { cacheDir, nowMs: start + 120_000 }));
	strictEqual(observed(start + 120_000), new Date(start + 120_000).toISOString(), "a changed list is written");
	const later = start + 120_000 + TARGET_MODEL_CACHE_TTL_MS / 2;
	ok(recordTargetModelSnapshot(target, ["a", "c"], { cacheDir, nowMs: later }));
	strictEqual(observed(later), new Date(later).toISOString(), "an aging snapshot is refreshed before it expires");
});
