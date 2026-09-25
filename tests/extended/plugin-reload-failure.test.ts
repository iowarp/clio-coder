import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { BusChannels, type PluginsReloadedPayload } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createAgentsBundle } from "../../src/domains/agents/extension.js";
import type { ConfigContract } from "../../src/domains/config/index.js";
import { clearPluginSnapshots, disablePlugin, installPlugin, removePlugin } from "../../src/domains/plugins/index.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { reloadPluginResourcesAndNotify } from "../../src/entry/plugin-reload.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const recipe = readFileSync(
	fileURLToPath(new URL("../../src/domains/agents/builtins/researcher.md", import.meta.url)),
	"utf8",
).replace("audience: shadow", "audience: custom");

it("refreshes agent recipes and prompt inputs only on plugin resource reload", async () => {
	const env = await isolateClioEnv("clio-coder-reload-ownership-");
	const originalCwd = process.cwd();
	const bus = createSafeEventBus();
	const config: ConfigContract = {
		get: () => structuredClone(DEFAULT_SETTINGS),
		onChange: () => () => {},
	};
	const context: DomainContext = {
		bus,
		getContract(name) {
			if (name === "config") return config as never;
			if (name === "agents") return agents.contract as never;
			return undefined;
		},
	};
	const agents = createAgentsBundle(context);
	const prompts = createPromptsBundle(context, { noContextFiles: true });
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd);
		process.chdir(cwd);
		await agents.extension.start();
		await prompts.extension.start();
		const revision = agents.contract.revision();
		const epoch = prompts.contract.inputEpoch();
		mkdirSync(join(env.dir, "config/agents"), { recursive: true });
		writeFileSync(join(env.dir, "config/agents/reload-owned-agent.md"), recipe);
		const generation = { generation: 2, previousGeneration: 1, changed: true, digest: "fixture" };
		strictEqual(agents.contract.get("reload-owned-agent"), null);
		strictEqual(agents.contract.revision(), revision);
		strictEqual(prompts.contract.inputEpoch(), epoch);
		bus.emit(BusChannels.PluginsReloaded, generation);
		ok(agents.contract.get("reload-owned-agent"));
		ok(agents.contract.revision() > revision);
		ok(prompts.contract.inputEpoch() !== epoch);
	} finally {
		await prompts.extension.stop?.();
		await agents.extension.stop?.();
		process.chdir(originalCwd);
		env.restore();
	}
});

function packageFixture(root: string, name: string, agent: string): void {
	mkdirSync(join(root, "agents"), { recursive: true });
	writeFileSync(join(root, "agents", `${agent}.md`), recipe);
	writeFileSync(
		join(root, "plugin.json"),
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name,
			version: "1.0.0",
			description: "Reload fixture",
			extensions: { "ai.iowarp.clio": { manifestVersion: 1, resources: { agents: "agents" }, components: [] } },
		}),
	);
}

for (const mutation of ["disable", "remove"] as const) {
	it(`withdraws ${mutation}d cached package authority after namespace failure and retries an unchanged snapshot`, async () => {
		const env = await isolateClioEnv(`clio-coder-reload-failure-${mutation}-`);
		const originalCwd = process.cwd();
		const bus = createSafeEventBus();
		let delegates = [{ id: "reload-clash", command: "fixture", args: [] }];
		const config: ConfigContract = {
			get: () => {
				const settings = structuredClone(DEFAULT_SETTINGS);
				settings.integrations.externalAgents.entries = delegates;
				return settings;
			},
			onChange: () => () => {},
		};
		const context: DomainContext = {
			bus,
			getContract: (() => config) as DomainContext["getContract"],
		};
		const agents = createAgentsBundle(context);
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			process.chdir(cwd);
			const first = join(env.dir, "first");
			packageFixture(first, "reload-first", "reload-active-agent");
			const second = join(env.dir, "second");
			packageFixture(second, "reload-second", "reload-clash");
			const peer = join(env.dir, "peer");
			packageFixture(peer, "reload-peer", "reload-peer-agent");
			ok(installPlugin(first, { cwd, scope: "user" }).plugin?.loadable);
			ok(installPlugin(peer, { cwd, scope: "user" }).plugin?.loadable);
			mkdirSync(join(env.dir, "config/agents"), { recursive: true });
			writeFileSync(join(env.dir, "config/agents/user-survivor.md"), recipe);
			await agents.extension.start();
			ok(agents.contract.get("reload-active-agent"));
			ok(agents.contract.get("reload-peer-agent"));
			if (mutation === "disable") disablePlugin("reload-first", { cwd, scope: "user" });
			else removePlugin("reload-first", { cwd, scope: "user" });
			disablePlugin("reload-peer", { cwd, scope: "user" });
			ok(installPlugin(second, { cwd, scope: "user" }).plugin?.loadable);
			const events: PluginsReloadedPayload[] = [];
			const reload = () =>
				reloadPluginResourcesAndNotify(cwd, (event) => {
					events.push(event);
					bus.emit(BusChannels.PluginsReloaded, event);
				});
			reload();
			strictEqual(agents.contract.get("reload-active-agent"), null);
			strictEqual(agents.contract.get("reload-peer-agent"), null);
			ok(!agents.contract.listSpecs().some((spec) => spec.id === "reload-active-agent"));
			ok(agents.contract.get("coder"));
			ok(agents.contract.get("user-survivor"));
			const failedRevision = agents.contract.revision();
			reload();
			strictEqual(events.at(-1)?.changed, false);
			ok(agents.contract.revision() > failedRevision);
			delegates = [];
			reload();
			strictEqual(events.at(-1)?.changed, false);
			ok(agents.contract.get("reload-clash"));
			strictEqual(agents.contract.get("reload-active-agent"), null);
		} finally {
			await agents.extension.stop?.();
			process.chdir(originalCwd);
			env.restore();
		}
	});
}

it("keeps boot recipes across the first reload only when it commits the projection start verified", async () => {
	const env = await isolateClioEnv("clio-coder-reload-boot-digest-");
	const originalCwd = process.cwd();
	const bus = createSafeEventBus();
	const config: ConfigContract = { get: () => structuredClone(DEFAULT_SETTINGS), onChange: () => () => {} };
	const context: DomainContext = { bus, getContract: (() => config) as DomainContext["getContract"] };
	const events: PluginsReloadedPayload[] = [];
	const bundles: ReturnType<typeof createAgentsBundle>[] = [];
	const boot = async () => {
		const agents = createAgentsBundle(context);
		bundles.push(agents);
		await agents.extension.start();
		return agents;
	};
	const reload = (cwd: string) =>
		reloadPluginResourcesAndNotify(cwd, (event) => {
			events.push(event);
			bus.emit(BusChannels.PluginsReloaded, event);
		});
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd);
		process.chdir(cwd);
		const source = join(env.dir, "boot-kit");
		packageFixture(source, "boot-kit", "boot-agent");
		const installed = installPlugin(source, { cwd, scope: "user" }).plugin;
		ok(installed?.loadable);

		const unchanged = await boot();
		const revision = unchanged.contract.revision();
		reload(cwd);
		strictEqual(events.at(-1)?.changed, true, "no generation was committed before the first reload");
		strictEqual(unchanged.contract.revision(), revision, "an unchanged projection must not rediscover");
		ok(unchanged.contract.get("boot-agent"));
		await unchanged.extension.stop?.();
		clearPluginSnapshots();

		const drifted = await boot();
		ok(drifted.contract.get("boot-agent"));
		writeFileSync(join(installed.rootPath, "agents", "boot-agent.md"), `${recipe}\nTampered after install.\n`);
		reload(cwd);
		strictEqual(drifted.contract.get("boot-agent"), null, "a tree that no longer verifies must go inactive");
	} finally {
		for (const agents of bundles) await agents.extension.stop?.();
		clearPluginSnapshots();
		process.chdir(originalCwd);
		env.restore();
	}
});
