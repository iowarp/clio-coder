import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { updateSettings } from "../../src/core/config.js";
import { loadDomains } from "../../src/core/domain-loader.js";
import { getSharedBus } from "../../src/core/shared-bus.js";
import { type ConfigContract, ConfigDomainModule } from "../../src/domains/config/index.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import type { TargetStatus } from "../../src/domains/providers/contract.js";
import { type ProvidersContract, ProvidersDomainModule } from "../../src/domains/providers/index.js";
import { readTargetModelSnapshot } from "../../src/domains/providers/target-model-cache.js";
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
			const config = loaded.getContract<ConfigContract>("config");
			const providers = loaded.getContract<ProvidersContract>("providers");
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
				});
				const probed: TargetStatus | null = await providers.probeTarget(target.id, { reasoning: false });
				ok(probed);
				strictEqual(probed.health.status, "healthy");
				deepStrictEqual(probed.discoveredModels, ["mock-model"]);
				config.update((settings) => {
					settings.targets = [replacement];
				});
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
			});
			duringReasoning = () =>
				config.update?.((settings) => {
					settings.targets = [{ ...target, url: `${fixture.url}/replacement` }];
				});
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
			const unsubscribe = getSharedBus().on(BusChannels.ProviderHealth, () => {
				publications++;
			});
			try {
				const config = loaded.getContract<ConfigContract>("config");
				const providers = loaded.getContract<ProvidersContract>("providers");
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
					});
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
