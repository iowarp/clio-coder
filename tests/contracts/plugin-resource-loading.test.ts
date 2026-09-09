// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixtures exercise literal package reference syntax.
import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { BusChannels, type PluginsReloadedPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createAgentsBundle } from "../../src/domains/agents/extension.js";
import { listFleetContracts, loadFleetContract } from "../../src/domains/agents/fleet-contract.js";
import { discoverAgentRecipes } from "../../src/domains/agents/registry.js";
import { installExtension } from "../../src/domains/extensions/state.js";
import { disablePlugin, installPlugin, reloadPluginResources } from "../../src/domains/plugins/index.js";
import { resolvePackageReferences } from "../../src/domains/resources/package-references.js";
import { loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";
import { reloadPluginResourcesAndNotify } from "../../src/entry/plugin-reload.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function write(root: string, name: string, text: string): void {
	const file = join(root, name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function fixture(root: string): void {
	write(root, "assets/reference.txt", "reference evidence");
	write(
		root,
		"skills/research/SKILL.md",
		"---\nname: fixture-research\ndescription: Read fixture evidence.\n---\nRead ${component:resource:reference} and ${pluginRoot}/assets/reference.txt\n",
	);
	write(
		root,
		"ai.iowarp.clio/prompts/materials-characterization/help.md",
		"---\ndescription: Fixture help\n---\nRead ${component:resource:reference}\n",
	);
	const recipe = readFileSync(resolve("src/domains/agents/builtins/researcher.md"), "utf8")
		.replace("audience: shadow", "audience: custom")
		.replace("required: [read]", "required: [read, context]")
		.replace("optional: [web_fetch, context, ledger]", "optional: [web_fetch, ledger]")
		.replace("skills: []", "skills: [fixture-research]");
	write(
		root,
		"ai.iowarp.clio/agents/materials-characterization-researcher.md",
		`${recipe}\nRead ${"${pluginRoot}"}/assets/reference.txt\n`,
	);
	write(
		root,
		"ai.iowarp.clio/fleets/materials-characterization-review.md",
		"---\nversion: 1\nname: materials-characterization-review\ndescription: Fixture review\nsteps:\n  - id: research\n    agent: materials-characterization-researcher\n    scope: readonly\n    dependencies: []\nmaxWorkers: 1\nonFailure: stop\n---\nRead ${component:resource:reference}\n",
	);
	write(
		root,
		"ai.iowarp.clio/fleets/materials-characterization-code.md",
		`---
version: 2
name: materials-characterization-code
description: Package script arguments
steps:
  - kind: code
    id: verify
    command: verify
    args: ['${"$"}{pluginRoot}/assets/reference.txt']
    scope: readonly
    dependencies: []
maxWorkers: 1
onFailure: stop
---
Verify supplied evidence.
`,
	);
	write(
		root,
		"plugin.json",
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name: "resource-fixture",
			version: "1.0.0",
			description: "Resource integration fixture",
			extensions: {
				"ai.iowarp.clio": {
					manifestVersion: 1,
					resources: {
						skills: "skills",
						prompts: "ai.iowarp.clio/prompts",
						agents: "ai.iowarp.clio/agents",
						fleets: "ai.iowarp.clio/fleets",
					},
					components: [{ kind: "resource", id: "reference", path: "assets/reference.txt" }],
				},
			},
		}),
	);
}

it("loads installed plugin prompts, bound skills, recipes and fleets with contained references and stable names", async () => {
	const env = await isolateClioEnv("clio-plugin-quote'-load-");
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd);
		const source = join(env.dir, "source");
		fixture(source);
		const installed = installPlugin(source, { cwd, scope: "user" });
		ok(installed.plugin?.loadable, JSON.stringify(installed.diagnostics));
		const root = installed.plugin.rootPath;
		const prompts = loadPromptTemplates({ cwd });
		const prompt = prompts.items.find((item) => item.name === "materials-characterization:help");
		ok(prompt);
		strictEqual(prompt.content.trim(), `Read ${join(root, "assets/reference.txt")}`);
		strictEqual(prompt.sourceInfo.source, "plugin:user:resource-fixture");
		const skills = loadSkills({ cwd, home: env.dir });
		const skill = skills.items.find((item) => item.name === "fixture-research");
		ok(skill);
		strictEqual(skill.source, "plugin");
		ok(!skill.content.includes("${"));
		const recipe = discoverAgentRecipes(cwd).find((item) => item.id === "materials-characterization-researcher");
		ok(recipe);
		strictEqual(recipe.source, "plugin");
		ok(recipe.body.includes(join(root, "assets/reference.txt")));
		deepStrictEqual(recipe.boundSkillPaths, [join(root, "skills/research/SKILL.md")]);
		const bound = loadSkills({ cwd, disableDiscovery: true, explicitSkillPaths: recipe.boundSkillPaths });
		ok(bound.items[0]);
		ok(!bound.items[0].content.includes("${"));
		const fleet = loadFleetContract(cwd, "materials-characterization-review");
		ok(fleet.body.includes(join(root, "assets/reference.txt")));
		strictEqual(listFleetContracts(cwd).find((item) => item.name === fleet.name)?.source, "plugin");
		write(
			cwd,
			".clio-coder/fleets/commands.yaml",
			"version: 1\ncommands: {verify: {argv: [echo], argumentSlots: [{name: evidencePath, maxLength: 4096}]}}\n",
		);
		const code = loadFleetContract(cwd, "materials-characterization-code").steps[0];
		deepStrictEqual(code?.kind === "code" ? code.args : undefined, [join(root, "assets/reference.txt")]);
	} finally {
		env.restore();
	}
});

it("keeps legacy namespaces and user overrides; disabled project plugin suppresses its user copy", async () => {
	const env = await isolateClioEnv("clio-plugin-precedence-");
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd);
		const source = join(env.dir, "source");
		fixture(source);
		ok(installPlugin(source, { cwd, scope: "user" }).plugin?.loadable);
		write(
			join(env.dir, "legacy"),
			"clio-coder-extension.yaml",
			"manifestVersion: 1\nid: wtfp\nname: WTF-P fixture\nversion: 1.0.0\ndescription: Legacy fixture\nresources: {prompts: prompts}\n",
		);
		write(join(env.dir, "legacy"), "prompts/wtfp/help.md", "---\ndescription: Legacy help\n---\nLegacy help\n");
		ok(installExtension(join(env.dir, "legacy"), { cwd, scope: "user" }).extension?.loadable);
		write(
			join(env.dir, "config"),
			"prompts/materials-characterization/help.md",
			"---\ndescription: User help\n---\nUser override\n",
		);
		strictEqual(
			loadPromptTemplates({ cwd })
				.items.find((item) => item.name === "materials-characterization:help")
				?.content.trim(),
			"User override",
		);
		ok(loadPromptTemplates({ cwd }).items.some((item) => item.name === "wtfp:help"));
		ok(installPlugin(source, { cwd, scope: "project" }).plugin?.loadable);
		disablePlugin("resource-fixture", { cwd, scope: "project" });
		reloadPluginResources(cwd);
		ok(!discoverAgentRecipes(cwd).some((item) => item.id === "materials-characterization-researcher"));
		ok(loadPromptTemplates({ cwd }).items.some((item) => item.name === "wtfp:help"));
	} finally {
		env.restore();
	}
});

it("rejects missing and escaping package references without changing non-package content", async () => {
	const env = await isolateClioEnv("clio-plugin-reference-");
	try {
		const root = join(env.dir, "source");
		fixture(root);
		const context = { rootPath: root, plugin: true };
		throws(() => resolvePackageReferences("${pluginRoot}/../outside", context), /escaping/);
		throws(() => resolvePackageReferences("${pluginRoot}/assets/missing", context), /unresolved/);
		throws(() => resolvePackageReferences("${component:resource:absent}", context), /unresolved component/);
		write(env.dir, "outside", "private");
		symlinkSync(join(env.dir, "outside"), join(root, "assets/escape"));
		throws(() => resolvePackageReferences("${pluginRoot}/assets/escape", context), /escaping/);
		strictEqual(resolvePackageReferences("${pluginRoot}/assets/reference.txt", {}), "${pluginRoot}/assets/reference.txt");
		match(resolvePackageReferences("${extensionRoot}/assets/reference.txt", { rootPath: root }), /reference.txt$/);
	} finally {
		env.restore();
	}
});

it("refreshes admitted plugin resources after drift and does not bind another owner's skill", async () => {
	const env = await isolateClioEnv("clio-plugin-admission-");
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd);
		const source = join(env.dir, "source");
		fixture(source);
		const recipePath = "ai.iowarp.clio/agents/materials-characterization-researcher.md";
		write(
			source,
			recipePath,
			readFileSync(join(source, recipePath), "utf8").replace("skills: [fixture-research]", "skills: [other-owner]"),
		);
		write(
			join(env.dir, "config"),
			"skills/other-owner/SKILL.md",
			"---\nname: other-owner\ndescription: Foreign skill\n---\nForeign context\n",
		);
		const installed = installPlugin(source, { cwd, scope: "user" });
		ok(installed.plugin?.loadable);
		const diagnostics: import("../../src/domains/agents/registry.js").AgentRecipeDiagnostic[] = [];
		ok(!discoverAgentRecipes(cwd, diagnostics).some((item) => item.id === "materials-characterization-researcher"));
		ok(diagnostics.some((item) => item.message.includes("bound skill(s) unavailable")));
		reloadPluginResources(cwd);
		ok(loadPromptTemplates({ cwd }).items.some((item) => item.name === "materials-characterization:help"));
		write(installed.plugin.rootPath, "assets/reference.txt", "changed bytes");
		const explicit = loadSkills({
			cwd,
			disableDiscovery: true,
			explicitSkillPaths: [join(installed.plugin.rootPath, "skills/research/SKILL.md")],
		});
		strictEqual(explicit.items.length, 0);
		ok(explicit.diagnostics.some((item) => item.message.includes("inactive")));
		reloadPluginResources(cwd);
		ok(!loadPromptTemplates({ cwd }).items.some((item) => item.name === "materials-characterization:help"));
	} finally {
		env.restore();
	}
});

it("publishes plugin generations before refreshing cached recipes and unsubscribes on stop", async () => {
	const env = await isolateClioEnv("clio-plugin-reload-");
	const oldCwd = process.cwd();
	const bus = createSafeEventBus();
	const agents = createAgentsBundle({ bus, getContract: () => undefined });
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd);
		process.chdir(cwd);
		reloadPluginResources(cwd);
		await agents.extension.start();
		const source = join(env.dir, "source");
		// The fixture reads one builtin recipe by repository-relative path.
		process.chdir(oldCwd);
		fixture(source);
		process.chdir(cwd);
		ok(installPlugin(source, { cwd, scope: "user" }).plugin?.loadable);
		strictEqual(agents.contract.get("materials-characterization-researcher"), null);
		const events: PluginsReloadedPayload[] = [];
		const reload = () =>
			reloadPluginResourcesAndNotify(cwd, (event) => {
				events.push(event);
				bus.emit(BusChannels.PluginsReloaded, event);
			});
		const first = reload();
		ok(agents.contract.get("materials-characterization-researcher"));
		strictEqual(events[0]?.generation, first.generation);
		strictEqual(events[0]?.changed, true);
		const revision = agents.contract.revision();
		reload();
		strictEqual(events[1]?.changed, false);
		strictEqual(agents.contract.revision(), revision);
		disablePlugin("resource-fixture", { cwd, scope: "user" });
		reload();
		strictEqual(agents.contract.get("materials-characterization-researcher"), null);
		await agents.extension.stop?.();
		const stoppedRevision = agents.contract.revision();
		bus.emit(BusChannels.PluginsReloaded, {
			generation: 999,
			previousGeneration: first.generation,
			changed: true,
			digest: "test",
		});
		strictEqual(agents.contract.revision(), stoppedRevision);
	} finally {
		await agents.extension.stop?.();
		process.chdir(oldCwd);
		env.restore();
	}
});
