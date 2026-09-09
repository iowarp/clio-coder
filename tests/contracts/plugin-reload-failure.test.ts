import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { BusChannels, type PluginsReloadedPayload } from "../../src/core/bus-events.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createAgentsBundle } from "../../src/domains/agents/extension.js";
import { disableExtension, installExtension } from "../../src/domains/extensions/state.js";
import { disablePlugin, installPlugin, removePlugin } from "../../src/domains/plugins/index.js";
import { reloadPluginResourcesAndNotify } from "../../src/entry/plugin-reload.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const recipe = readFileSync(
	fileURLToPath(new URL("../../src/domains/agents/builtins/researcher.md", import.meta.url)),
	"utf8",
).replace("audience: shadow", "audience: custom");
function packageFixture(root: string, name: string, agent: string, legacy = false): void {
	mkdirSync(join(root, "agents"), { recursive: true });
	writeFileSync(join(root, "agents", `${agent}.md`), recipe);
	if (legacy)
		writeFileSync(
			join(root, "clio-coder-extension.yaml"),
			`manifestVersion: 1\nid: ${name}\nname: ${name}\nversion: 1.0.0\ndescription: Reload fixture\nresources: {agents: agents}\n`,
		);
	else
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
		const env = await isolateClioEnv(`clio-reload-failure-${mutation}-`);
		const originalCwd = process.cwd();
		const bus = createSafeEventBus();
		let delegates = [{ id: "reload-clash" }];
		const context: DomainContext = {
			bus,
			getContract: (() => ({
				get: () => ({ integrations: { externalAgents: { entries: delegates } } }),
			})) as DomainContext["getContract"],
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
			const legacy = join(env.dir, "legacy");
			packageFixture(legacy, "reload-legacy", "reload-legacy-agent", true);
			ok(installPlugin(first, { cwd, scope: "user" }).plugin?.loadable);
			ok(installExtension(legacy, { cwd, scope: "user" }).extension?.loadable);
			mkdirSync(join(env.dir, "config/agents"), { recursive: true });
			writeFileSync(join(env.dir, "config/agents/user-survivor.md"), recipe);
			await agents.extension.start();
			ok(agents.contract.get("reload-active-agent"));
			ok(agents.contract.get("reload-legacy-agent"));
			if (mutation === "disable") disablePlugin("reload-first", { cwd, scope: "user" });
			else removePlugin("reload-first", { cwd, scope: "user" });
			disableExtension("reload-legacy", { cwd, scope: "user" });
			ok(installPlugin(second, { cwd, scope: "user" }).plugin?.loadable);
			const events: PluginsReloadedPayload[] = [];
			const reload = () =>
				reloadPluginResourcesAndNotify(cwd, (event) => {
					events.push(event);
					bus.emit(BusChannels.PluginsReloaded, event);
				});
			reload();
			strictEqual(agents.contract.get("reload-active-agent"), null);
			strictEqual(agents.contract.get("reload-legacy-agent"), null);
			ok(!agents.contract.listSpecs().some((spec) => spec.id === "reload-active-agent"));
			ok(agents.contract.get("coder"));
			ok(agents.contract.get("user-survivor"));
			ok(agents.contract.diagnostics().some((item) => item.message.includes("withdrawn until retry")));
			const failedRevision = agents.contract.revision();
			reload();
			strictEqual(events.at(-1)?.changed, false);
			ok(agents.contract.revision() > failedRevision);
			delegates = [];
			reload();
			strictEqual(events.at(-1)?.changed, false);
			ok(agents.contract.get("reload-clash"));
			strictEqual(agents.contract.get("reload-active-agent"), null);
			strictEqual(agents.contract.diagnostics().length, 0);
		} finally {
			await agents.extension.stop?.();
			process.chdir(originalCwd);
			env.restore();
		}
	});
}
