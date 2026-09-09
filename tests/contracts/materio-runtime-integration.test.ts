import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createAgentsBundle } from "../../src/domains/agents/extension.js";
import { parseFleetCommands } from "../../src/domains/agents/fleet-commands.js";
import { listFleetContracts, parseFleetContract } from "../../src/domains/agents/fleet-contract.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { compileFleetExecutionPlan } from "../../src/domains/dispatch/fleet-plan.js";
import { executeFleetRun } from "../../src/domains/dispatch/fleet-run.js";
import { disablePlugin, installPlugin, reloadPluginResources } from "../../src/domains/plugins/index.js";
import { loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";
import { reloadPluginResourcesAndNotify } from "../../src/entry/plugin-reload.js";
import {
	createInteractiveSlashRuntime,
	type InteractiveSlashRuntimeDeps,
} from "../../src/interactive/interactive-slash-runtime.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const source = fileURLToPath(new URL("../../plugins/materio/", import.meta.url));

it("reloads the actual materials bundle through the interactive slash runtime and refreshes native bound roles", async () => {
	const env = await isolateClioEnv("clio-materio-runtime-");
	const originalCwd = process.cwd();
	const bus = createSafeEventBus();
	const agents = createAgentsBundle({ bus, getContract: () => undefined });
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd);
		process.chdir(cwd);
		reloadPluginResources(cwd);
		await agents.extension.start();
		const installed = installPlugin(source, { cwd, scope: "project" });
		ok(installed.plugin?.loadable, JSON.stringify(installed.diagnostics));
		strictEqual(agents.contract.list().filter((x) => x.source === "plugin").length, 0);
		let reloads = 0;
		const runtime = createInteractiveSlashRuntime({
			bus,
			agents: agents.contract,
			getCwd: () => cwd,
			io: { stdout() {}, stderr() {} },
			chatPanel: { appendReplayBlock() {}, appendUser() {} },
			requestRender() {},
			reloadPlugins: () => {
				reloads++;
				return reloadPluginResourcesAndNotify(cwd, (event) => bus.emit(BusChannels.PluginsReloaded, event));
			},
		} as unknown as InteractiveSlashRuntimeDeps);
		strictEqual(runtime.dispatchCommand("/library reload"), "accepted");
		strictEqual(reloads, 1);
		const recipes = agents.contract.list().filter((x) => x.source === "plugin");
		strictEqual(recipes.length, 6);
		const prompts = loadPromptTemplates({ cwd, home: env.dir }).items.filter((x) => x.name.startsWith("materio:"));
		strictEqual(prompts.length, 17);
		ok(prompts.every((x) => !x.unavailable && !/\$\{(?:pluginRoot|component:)/.test(x.content)));
		strictEqual(loadSkills({ cwd, home: env.dir }).items.filter((x) => x.source === "plugin").length, 6);
		strictEqual(listFleetContracts(cwd).filter((x) => x.source === "plugin" && !x.error).length, 1);
		for (const recipe of recipes) {
			strictEqual(recipe.boundSkillPaths.length, 1);
			const bound = loadSkills({ cwd, disableDiscovery: true, explicitSkillPaths: recipe.boundSkillPaths });
			strictEqual(bound.items.length, 1);
			ok(bound.items[0]?.content.length);
			ok(!/\$\{(?:pluginRoot|component:)/.test(recipe.body));
		}
		disablePlugin("materio", { cwd, scope: "project" });
		runtime.dispatchCommand("/library reload");
		strictEqual(reloads, 2);
		strictEqual(agents.contract.list().filter((x) => x.source === "plugin").length, 0);
	} finally {
		await agents.extension.stop?.();
		process.chdir(originalCwd);
		env.restore();
	}
});

it("executes registered fleet task arguments against synthetic supplied data and reads back persisted execution evidence", async () => {
	const env = await isolateClioEnv("clio-materials-code-run-");
	try {
		const cwd = join(env.dir, "workspace");
		const task = "task-01 with spaces";
		mkdirSync(join(cwd, task), { recursive: true });
		writeFileSync(join(cwd, task, "synthetic.csv"), "10\n12\n14\n");
		const script =
			"const fs=require('fs');const p=require('path');const task=process.argv[1];const values=fs.readFileSync(p.join(task,'synthetic.csv'),'utf8').trim().split('\\n').map(Number);process.stdout.write(JSON.stringify({synthetic:true,task,count:values.length,mean:values.reduce((a,b)=>a+b,0)/values.length}));";
		const commands = parseFleetCommands(
			JSON.stringify({
				version: 1,
				commands: {
					analyze: { argv: [process.execPath, "-e", script, "--"], argumentSlots: [{ name: "taskDir", maxLength: 256 }] },
				},
			}),
			join(cwd, "commands.yaml"),
		);
		const contract = parseFleetContract(
			`---
version: 2
name: synthetic-supplied-data
description: Deterministic synthetic data validation, not scientific findings.
steps:
  - kind: code
    id: analyze
    command: analyze
    args: ["{{taskDir}}"]
    scope: readonly
    dependencies: []
maxWorkers: 1
onFailure: stop
---
Pre-approved assumptions: synthetic scalar observations 10, 12, 14; arithmetic mean only, no scientific inference.
`,
			join(cwd, "fleet.md"),
		);
		const vars = { taskDir: task };
		const plan = compileFleetExecutionPlan({
			commands,
			contract,
			task: contract.body,
			vars,
			resolveAgent() {
				throw new Error("no model in this deterministic flow");
			},
		});
		const settled: Array<{ recordPath?: string }> = [];
		const outcome = await executeFleetRun({
			plan,
			contractName: contract.name,
			commands,
			workspaceRoot: cwd,
			fleetRootId: "synthetic-materials-args",
			agents: { getSpec: () => null },
			dispatch: {} as DispatchContract,
			attributionEnabled: false,
			vars,
			onStepSettled: (event) => settled.push(event),
		});
		strictEqual(outcome.cleanRun, true);
		strictEqual(outcome.succeededStepCount, 1);
		const result = outcome.result.results.get("analyze");
		ok(result?.succeeded);
		const report = JSON.parse(result.output);
		deepStrictEqual(JSON.parse(report.outputExcerpt), { synthetic: true, task, count: 3, mean: 12 });
		ok(result.output.includes(task));
		strictEqual(settled.length, 1);
		ok(settled[0]?.recordPath);
		const record = JSON.parse(readFileSync(settled[0].recordPath, "utf8"));
		deepStrictEqual(record.argv.slice(-1), [task]);
		strictEqual(record.exitCode, 0);
		strictEqual(existsSync(join(cwd, ".git")), false);
	} finally {
		env.restore();
	}
});
