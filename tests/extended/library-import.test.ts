import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgentRecipes } from "../../src/domains/agents/registry.js";
import { OperatorExtensionRuntime } from "../../src/domains/extensions/operator-runtime.js";
import {
	disableExtension,
	enableExtension,
	installExtension,
	listInstalledExtensions,
	removeExtension,
} from "../../src/domains/extensions/state.js";
import { applyInteropAdoption, planInteropAdoption } from "../../src/domains/interop/adopt.js";
import { detectForeignPlugin, projectForeignPlugin } from "../../src/domains/interop/foreign.js";
import {
	applyLibraryImport,
	libraryImportPlanSummary,
	planLibraryImport,
	releaseLibraryImport,
	renderLibraryImportPlan,
} from "../../src/domains/interop/import.js";
import type { InteropInventory } from "../../src/domains/interop/types.js";
import {
	clearPluginSnapshots,
	disablePlugin,
	enablePlugin,
	installLibraryPackage,
	installPlugin,
	listInstalledPlugins,
	PLUGIN_SCHEMA,
	readPluginInstallRecord,
	removePlugin,
} from "../../src/domains/plugins/index.js";
import { readLibraryInventory } from "../../src/domains/resources/library-inventory.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { reloadPluginResourcesAndNotify } from "../../src/entry/plugin-reload.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";
import { registerHarnessExtensionTools } from "../../src/tools/harness-extensions.js";
import { createRegistry } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
let cwd: string;
let vendor: string;

function file(relative: string, text: string, mode?: number): string {
	const target = path.join(vendor, relative);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, text);
	if (mode !== undefined) chmodSync(target, mode);
	return target;
}
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string): void => {
		for (const name of readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, name.name);
			if (name.isDirectory()) walk(full);
			else out[path.relative(dir, full)] = readFileSync(full, "utf8");
		}
	};
	walk(dir);
	return out;
}
const skill = (name: string, extra = "", body = "Read the task carefully.\n") =>
	`---\nname: ${name}\ndescription: Fixture skill ${name}\n${extra}---\n${body}`;

function claudeBundle(name = "claude-pack"): string {
	const root = path.join(vendor, name);
	file(`${name}/.claude-plugin/plugin.json`, JSON.stringify({ name, version: "1.2.3", description: "Claude fixture" }));
	file(`${name}/skills/review/SKILL.md`, skill("review", "allowed-tools: Bash\nmodel: opus\n"));
	file(`${name}/skills/review/notes.md`, "Reference notes.\n");
	file(
		`${name}/commands/deploy.md`,
		"---\ndescription: Deploy\nargument-hint: <env>\nallowed-tools: Bash\n---\nDeploy $ARGUMENTS now.\n",
	);
	file(
		`${name}/agents/checker.md`,
		"---\nname: checker\ndescription: Checks\ntools: Read, Grep\nmodel: sonnet\n---\nReview the evidence.\n",
	);
	file(`${name}/hooks/hooks.json`, JSON.stringify({ hooks: { PreToolUse: [{ command: "do-not-run" }] } }));
	file(`${name}/.mcp.json`, JSON.stringify({ mcpServers: { secret: { token: "do-not-copy" } } }));
	file(`${name}/scripts/run.sh`, "#!/bin/sh\nexit 99\n", 0o755);
	return root;
}

describe("library import of foreign plugin packages", () => {
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-library-import-");
		cwd = path.join(env.dir, "project");
		vendor = path.join(env.dir, "vendor");
		mkdirSync(cwd);
		mkdirSync(vendor);
		clearPluginSnapshots();
	});
	afterEach(() => {
		clearPluginSnapshots();
		env.restore();
	});

	it("keeps Materio, foreign recipe imports and real harness runtimes independently owned across reloads", async () => {
		for (const name of ["lab-status", "measurements"]) {
			const installed = installExtension(path.resolve("examples/extensions", name), { cwd, scope: "project" });
			ok(installed.extension?.loadable, JSON.stringify(installed.diagnostics));
		}
		const registry = createRegistry({ safety: createWorkerSafety({ cwd }) });
		registerHarnessExtensionTools(registry, cwd);
		const frozenTools = registry
			.listAll()
			.flatMap((tool) => (tool.sourceInfo?.extension ? [tool.sourceInfo.extension] : []));
		deepStrictEqual(
			frozenTools.map((tool) => tool.id),
			["measurements"],
		);
		const runtime = new OperatorExtensionRuntime({
			context: () => ({ workspace: cwd, sessionId: "joint-library-session", mode: "interactive" }),
			isIdle: () => true,
			frozenTools,
		});
		try {
			const notices: string[] = [];
			const references: string[] = [];
			const resourceGenerations: number[] = [];
			const prompts = () => loadPromptTemplates({ cwd, home: env.dir });
			const ctx = {
				operatorExtensions: runtime,
				reloadPlugins: () => reloadPluginResourcesAndNotify(cwd, (event) => resourceGenerations.push(event.generation)),
				listPrompts: prompts,
				expandPromptTemplate: (text: string) => expandPromptTemplateInput(text, prompts()),
				notice: (_level: string, text: string) => notices.push(text),
				showReference: (card: { text: string }) => references.push(card.text),
				render: () => {},
				submitChat: () => {
					throw new Error("an untrusted prompt must not start a model turn");
				},
				runLocalOperation: () => {
					throw new Error("a prompt-owned command must not queue harness execution");
				},
			} as unknown as SlashCommandContext;
			const reloadRecipes = () => {
				const before = resourceGenerations.length;
				strictEqual(dispatchSlashCommand(parseSlashCommand("/library reload"), ctx), "accepted");
				strictEqual(resourceGenerations.length, before + 1, notices.join("\n"));
			};
			const materioResources = () =>
				readLibraryInventory({ cwd, home: env.dir }).resources.filter((item) => item.owner?.ref === "plugin:materio");
			const materioSource = path.resolve("library/plugins/materio");
			const installMaterio = () => {
				const result = installPlugin(materioSource, {
					cwd,
					scope: "project",
					origin: { kind: "catalog", source: materioSource },
				});
				ok(result.plugin?.loadable, JSON.stringify(result.diagnostics));
				return result.plugin.rootPath;
			};
			const materioRoot = installMaterio();
			reloadRecipes();
			strictEqual(runtime.activeGeneration, 0, "recipe installation/reload cannot activate an eligible runtime");
			deepStrictEqual(runtime.entries(), []);
			const recipes = materioResources();
			for (const [kind, count] of [
				["skill", 6],
				["agent", 6],
				["prompt", 17],
				["fleet", 1],
			] as const) {
				strictEqual(recipes.filter((item) => item.kind === kind).length, count);
			}
			ok(recipes.every((item) => item.availability === "available" && item.owner?.scope === "project"));
			const materioBytes = snapshot(materioRoot);
			strictEqual((await runtime.reload("startup")).status, "committed");
			const invocation = "ext:lab-status:dashboard";
			const output = await runtime.invoke(invocation, "");
			match(output.text, /SYNTHETIC FIXTURE/);
			ok(output.panel && output.status);
			const active = runtime.entries().find((entry) => entry.id === "lab-status");
			strictEqual(active?.state, "ready");
			strictEqual(active?.toolEvidence, "frozen-registry");
			const generation = runtime.activeGeneration;

			// Reuse the vendor fixture with executable omissions. A foreign refusal
			// retains prompt ownership without granting model or harness execution.
			const source = claudeBundle();
			const sourceBytes = snapshot(source);
			const plan = planLibraryImport(source, { cwd, scope: "project" });
			strictEqual(plan.action, "install", plan.reasons.join("; "));
			ok(plan.unsupported.some((line) => line.startsWith("hooks/hooks.json")));
			ok(plan.unsupported.some((line) => line.startsWith(".mcp.json")));
			ok(plan.omitted.includes("scripts/run.sh"));
			const imported = applyLibraryImport(plan, true, { trustProjectImports: false });
			strictEqual(imported.published, true, JSON.stringify(imported.diagnostics));
			strictEqual(imported.admission?.trust, "foreign");
			reloadRecipes();
			const importedRoot = path.join(cwd, ".clio-coder/plugins/claude-pack");
			ok(!existsSync(path.join(importedRoot, "hooks")) && !existsSync(path.join(importedRoot, "scripts")));
			deepStrictEqual(snapshot(source), sourceBytes);
			deepStrictEqual(
				listInstalledExtensions(cwd, { all: true })
					.map((entry) => entry.id)
					.sort(),
				["lab-status", "measurements"],
			);
			strictEqual(runtime.activeGeneration, generation);
			deepStrictEqual(
				runtime.entries().find((entry) => entry.id === "lab-status"),
				active,
			);
			const loadedPrompt = prompts().items.find((item) => item.name === "deploy");
			ok(loadedPrompt);
			ok(loadedPrompt.filePath.startsWith(importedRoot));
			strictEqual(loadedPrompt.trusted, false);
			strictEqual(dispatchSlashCommand(parseSlashCommand("/deploy"), ctx), "rejected");
			match(notices.at(-1) ?? "", /untrusted/);

			// A real host-loaded display-only prompt also owns a canonical ext: token.
			const collision = path.join(env.dir, "config/prompts/ext/lab-status/dashboard.md");
			mkdirSync(path.dirname(collision), { recursive: true });
			writeFileSync(collision, "---\ndescription: Local reference\ndisplay-only: true\n---\nRecipe-owned reference.\n");
			strictEqual(dispatchSlashCommand(parseSlashCommand(`/${invocation}`), ctx), "accepted");
			deepStrictEqual(references, ["Recipe-owned reference."]);
			await rejects(
				runtime.invoke(
					invocation,
					"",
					prompts().items.map((item) => item.name),
				),
				/prompt/,
			);
			rmSync(collision);
			ok(removePlugin("claude-pack", { cwd, scope: "project" }).removed);
			reloadRecipes();

			for (const operation of [disablePlugin, enablePlugin, removePlugin]) {
				deepStrictEqual(operation("materio", { cwd, scope: "project" }).diagnostics, []);
				reloadRecipes();
				strictEqual(materioResources().length, operation === enablePlugin ? 30 : 0);
				strictEqual(existsSync(materioRoot), operation !== removePlugin);
				strictEqual(runtime.activeGeneration, generation);
				deepStrictEqual(
					runtime.entries().find((entry) => entry.id === "lab-status"),
					active,
				);
				match((await runtime.invoke(invocation, "")).text, /SYNTHETIC FIXTURE/);
			}
			installMaterio();
			reloadRecipes();
			for (const operation of [disableExtension, enableExtension, removeExtension]) {
				deepStrictEqual(operation("lab-status", { cwd, scope: "project" }).diagnostics, []);
				strictEqual((await runtime.reload()).status, "committed");
				strictEqual(
					runtime.commands().some((row) => row.invocation === invocation && row.available),
					operation === enableExtension,
				);
				deepStrictEqual(materioResources(), recipes);
				deepStrictEqual(snapshot(materioRoot), materioBytes);
			}
			deepStrictEqual(
				registry.listAll().flatMap((tool) => (tool.sourceInfo?.extension ? [tool.sourceInfo.extension] : [])),
				frozenTools,
			);
			const measurement = registry.listAll().find((tool) => tool.sourceInfo?.extension?.id === "measurements");
			ok(measurement);
			strictEqual((await measurement.run({ values: [1, 2, 3], units: "seconds" })).kind, "ok");
		} finally {
			await runtime.dispose();
		}
	});

	it("normalizes a Claude-only package, installs it with import provenance, and leaves the source untouched", () => {
		const root = claudeBundle();
		const before = snapshot(root);
		const plan = planLibraryImport(root, { cwd, scope: "user" });
		strictEqual(plan.action, "install", plan.reasons.join("; "));
		strictEqual(plan.format, "claude-code");
		strictEqual(plan.detection.manifestPath, ".claude-plugin/plugin.json");
		strictEqual(plan.id, "claude-pack");
		strictEqual(plan.version, "1.2.3");
		const outcomes = Object.fromEntries(plan.outcomes.map((o) => [`${o.kind}:${o.name}`, o]));
		strictEqual(outcomes["skill:review"]?.status, "converted");
		deepStrictEqual(outcomes["skill:review"]?.omittedFields, ["allowed-tools", "model"]);
		strictEqual(outcomes["prompt:deploy"]?.destination, "prompts/deploy.md");
		deepStrictEqual(outcomes["prompt:deploy"]?.omittedFields, ["allowed-tools"]);
		strictEqual(outcomes["agent:checker"]?.destination, "agents/checker.md");
		ok(outcomes["agent:checker"]?.omittedFields?.includes("tools"));
		ok(plan.unsupported.some((line) => line.startsWith("hooks/hooks.json")));
		ok(plan.unsupported.some((line) => line.startsWith(".mcp.json")));
		ok(plan.omitted.includes("scripts/run.sh"));
		ok(plan.files?.["skills/review/notes.md"], "data companions are retained");
		ok(plan.files?.["skills/review/SKILL.md"]?.includes("name: review"));
		ok(!plan.files?.["skills/review/SKILL.md"]?.includes("allowed-tools"));
		const rendered = renderLibraryImportPlan(plan);
		ok(rendered.includes("CONVERT skill review"));
		ok(rendered.includes("UNSUPPORTED hooks/hooks.json"));
		const summary = libraryImportPlanSummary(plan) as Record<string, unknown>;
		ok(!("files" in summary) && !("cleanup" in summary));
		ok(!JSON.stringify(summary).includes("do-not-copy"));
		const result = applyLibraryImport(plan, true, { trustProjectImports: false });
		deepStrictEqual(result.diagnostics, []);
		strictEqual(result.published, true);
		strictEqual(result.installed, "claude-pack");
		strictEqual(result.validation?.valid, true, JSON.stringify(result.validation?.validation.diagnostics));
		strictEqual(result.validation?.validation.resources.length, 3);
		deepStrictEqual(result.admission, {
			trust: "foreign",
			gate: "integrations.projectResources.trustProjectImports",
			gateEnabled: false,
		});
		deepStrictEqual(snapshot(root), before, "vendor source is never rewritten");
		const record = readPluginInstallRecord("claude-pack", { cwd, scope: "user" });
		strictEqual(record?.trust, "foreign");
		deepStrictEqual(record?.origin, { kind: "import", source: root, transport: "local", format: "claude-code" });
		const installed = listInstalledPlugins(cwd, { all: true }).find((pkg) => pkg.id === "claude-pack");
		ok(installed?.loadable, JSON.stringify(installed?.diagnostics));
		ok(!existsSync(path.join(installed.rootPath, "hooks")));
		ok(!existsSync(path.join(installed.rootPath, "scripts")));
		const loadedSkill = loadSkills({ cwd, home: path.join(env.dir, "empty") }).items.find((item) =>
			item.filePath.startsWith(installed.rootPath),
		);
		ok(loadedSkill);
		strictEqual(loadedSkill.name, "review");
		strictEqual(loadedSkill.trusted, false, "foreign trust survives installation");
		const prompt = loadPromptTemplates({ cwd, home: path.join(env.dir, "empty") }).items.find((item) =>
			item.filePath.startsWith(installed.rootPath),
		);
		ok(prompt);
		strictEqual(prompt.argumentHint, "<env>");
		const agent = discoverAgentRecipes(cwd).find((item) => item.filepath.startsWith(installed.rootPath));
		ok(agent, "installed agent recipe is readable by the native loader");
	});

	it("reads a Codex-only compatibility manifest with a custom skills path and ignores non-Codex folders", () => {
		file(
			"codex-pack/.codex-plugin/plugin.json",
			JSON.stringify({ name: "codex-pack", skills: "./workflows/", apps: "./.app.json" }),
		);
		file("codex-pack/workflows/triage/SKILL.md", skill("triage"));
		file("codex-pack/skills/ignored/SKILL.md", skill("ignored"));
		file("codex-pack/commands/deploy.md", "---\ndescription: d\n---\nDeploy.\n");
		file("codex-pack/.app.json", JSON.stringify({ apps: {} }));
		const root = path.join(vendor, "codex-pack");
		strictEqual(detectForeignPlugin(root).format, "codex");
		const plan = planLibraryImport(root, { cwd });
		strictEqual(plan.action, "install", plan.reasons.join("; "));
		strictEqual(plan.format, "codex");
		strictEqual(plan.version, "0.0.0");
		ok(plan.reasons.some((line) => line.includes("declares no version")));
		deepStrictEqual(
			plan.outcomes.map((o) => [o.kind, o.name, o.status]),
			[["skill", "triage", "converted"]],
		);
		ok(plan.unsupported.some((line) => line.includes("#apps")));
		ok(plan.omitted.includes("commands/deploy.md"));
		ok(plan.omitted.includes("skills/ignored/SKILL.md"));
		releaseLibraryImport(plan);
	});

	it("keeps portable root precedence and never hides an invalid native manifest behind a foreign fallback", () => {
		file("both/plugin.json", JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "both", version: "1.0.0" }));
		file("both/.claude-plugin/plugin.json", JSON.stringify({ name: "other-name" }));
		file("both/skills/one/SKILL.md", skill("one"));
		const portable = planLibraryImport(path.join(vendor, "both"), { cwd, format: "claude-code" });
		strictEqual(portable.format, "portable");
		strictEqual(portable.id, "both");
		ok(portable.reasons.some((line) => line.includes("takes precedence")));
		ok(portable.reasons.some((line) => line.includes("--format claude-code is ignored")));
		releaseLibraryImport(portable);
		file("broken/plugin.json", "{ not json");
		file("broken/.claude-plugin/plugin.json", JSON.stringify({ name: "broken" }));
		file("broken/skills/one/SKILL.md", skill("one"));
		const broken = planLibraryImport(path.join(vendor, "broken"), { cwd });
		strictEqual(broken.action, "blocked");
		strictEqual(broken.format, "portable");
		ok(broken.reasons[0]?.includes("invalid portable root plugin.json"), broken.reasons.join("; "));
		deepStrictEqual(applyLibraryImport(broken, true).published, false);
		strictEqual(listInstalledPlugins(cwd, { all: true }).length, 0);
	});

	it("inspects implicit portable skills through the real loaders and refuses their missing companions", () => {
		file("conventional/plugin.json", JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "conventional", version: "1.0.0" }));
		file("conventional/skills/on-disk/SKILL.md", skill("runtime-name"));
		const root = path.join(vendor, "conventional");
		const plan = planLibraryImport(root, { cwd });
		strictEqual(plan.action, "install", plan.reasons.join("; "));
		deepStrictEqual(
			plan.outcomes.map((item) => [item.kind, item.name, item.id, item.source]),
			[["skill", "runtime-name", undefined, "skills/on-disk/SKILL.md"]],
		);
		strictEqual(applyLibraryImport(plan, true).published, true);
		file("conventional/skills/on-disk/SKILL.md", skill("runtime-name", "", "Read references/guide.md.\n"));
		file("conventional/skills/on-disk/references/guide.md", "Run helper.py to collect the evidence.\n");
		file("conventional/skills/on-disk/scripts/helper.py", "print('evidence')\n");
		const blocked = planLibraryImport(root, { cwd, scope: "project" });
		strictEqual(blocked.action, "blocked");
		ok(
			blocked.reasons.some((reason) => reason.includes("omitted companions") && reason.includes("runtime-name")),
			blocked.reasons.join("; "),
		);
		releaseLibraryImport(blocked);
	});

	it("reports portable invocation names separately from component identifiers", () => {
		file(
			"named/plugin.json",
			JSON.stringify({
				$schema: PLUGIN_SCHEMA,
				name: "named",
				version: "1.0.0",
				extensions: {
					"ai.iowarp.clio": {
						manifestVersion: 1,
						components: [{ kind: "skill", id: "declared-component", path: "skills/on-disk/SKILL.md" }],
					},
				},
			}),
		);
		file("named/skills/on-disk/SKILL.md", skill("runtime-name"));
		const plan = planLibraryImport(path.join(vendor, "named"), { cwd });
		strictEqual(plan.action, "install", plan.reasons.join("; "));
		deepStrictEqual(
			plan.outcomes.map((item) => [item.name, item.id]),
			[["runtime-name", "declared-component"]],
		);
		releaseLibraryImport(plan);
		file("empty/plugin.json", JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "empty", version: "1.0.0" }));
		const empty = planLibraryImport(path.join(vendor, "empty"), { cwd });
		strictEqual(empty.action, "blocked");
		ok(empty.reasons.some((reason) => reason.includes("no supported data-only recipes")));
		releaseLibraryImport(empty);
	});

	it("imports a portable skill package with its declared kind, refuses portable recipes needing omitted scripts, and treats any root plugin.json entry as authoritative", () => {
		const portableSkill = (name: string, body: string, script?: string): string => {
			file(`${name}/skills/${name}/SKILL.md`, skill(name, "", body));
			if (script) file(`${name}/skills/${name}/scripts/helper.py`, script, 0o755);
			file(
				`${name}/plugin.json`,
				JSON.stringify({
					$schema: PLUGIN_SCHEMA,
					name,
					version: "1.0.0",
					extensions: {
						"ai.iowarp.clio": {
							manifestVersion: 1,
							kind: "skill",
							resources: { skills: "skills" },
							components: [{ kind: "skill", id: name, path: `skills/${name}/SKILL.md` }],
						},
					},
				}),
			);
			return path.join(vendor, name);
		};
		const clean = planLibraryImport(portableSkill("tidy", "Just read.\n"), { cwd });
		strictEqual(clean.action, "install", clean.reasons.join("; "));
		strictEqual(clean.format, "portable");
		deepStrictEqual(
			clean.outcomes.map((o) => [o.kind, o.name, o.status]),
			[["skill", "tidy", "converted"]],
		);
		const done = applyLibraryImport(clean, true);
		strictEqual(done.published, true, done.diagnostics.join("; "));
		strictEqual(readPluginInstallRecord("tidy", { cwd, scope: "user" })?.kind, "skill");
		strictEqual(listInstalledPlugins(cwd, { all: true }).find((pkg) => pkg.id === "tidy")?.kind, "skill");
		const scripted = planLibraryImport(portableSkill("scripted", "Run scripts/helper.py first.\n", "print(1)\n"), {
			cwd,
		});
		strictEqual(scripted.action, "blocked");
		ok(scripted.reasons[0]?.includes("scripts/helper.py"), scripted.reasons.join("; "));
		ok(scripted.reasons[0]?.includes("library install"));
		strictEqual(applyLibraryImport(scripted, true).published, false);
		const rootSkill = (name: string, body: string, extra: Record<string, string>): string => {
			file(`${name}/SKILL.md`, skill(name, "", body));
			for (const [rel, text] of Object.entries(extra))
				file(`${name}/${rel}`, text, rel.endsWith(".py") ? 0o755 : undefined);
			file(
				`${name}/plugin.json`,
				JSON.stringify({
					$schema: PLUGIN_SCHEMA,
					name,
					version: "1.0.0",
					extensions: {
						"ai.iowarp.clio": {
							manifestVersion: 1,
							kind: "skill",
							resources: { skills: "." },
							components: [{ kind: "skill", id: name, path: "SKILL.md" }],
						},
					},
				}),
			);
			return path.join(vendor, name);
		};
		const rootClean = planLibraryImport(
			rootSkill("rooted", "See references/guide.md.\n", { "references/guide.md": "Guide.\n" }),
			{ cwd },
		);
		strictEqual(rootClean.action, "install", rootClean.reasons.join("; "));
		ok(rootClean.files?.["references/guide.md"], "root skill keeps its text companions");
		strictEqual(applyLibraryImport(rootClean, true).published, true);
		strictEqual(readPluginInstallRecord("rooted", { cwd, scope: "user" })?.kind, "skill");
		const rootScripted = planLibraryImport(
			rootSkill("rootscript", "Run helper.py first.\n", { "scripts/helper.py": "print(1)\n" }),
			{ cwd },
		);
		strictEqual(rootScripted.action, "blocked", "a root skill referencing its omitted script by basename is refused");
		ok(rootScripted.reasons[0]?.includes("scripts/helper.py"), rootScripted.reasons.join("; "));
		file("shared/skills/user/SKILL.md", skill("user", "", "Execute assets/shared.py from the package root.\n"));
		file("shared/assets/shared.py", "print(2)\n", 0o755);
		file(
			"shared/plugin.json",
			JSON.stringify({
				$schema: PLUGIN_SCHEMA,
				name: "shared",
				version: "1.0.0",
				extensions: {
					"ai.iowarp.clio": {
						manifestVersion: 1,
						resources: { skills: "skills" },
						components: [{ kind: "skill", id: "user", path: "skills/user/SKILL.md" }],
					},
				},
			}),
		);
		const sharedAsset = planLibraryImport(path.join(vendor, "shared"), { cwd });
		strictEqual(sharedAsset.action, "blocked", "an explicit package path to an omitted shared asset is refused");
		ok(sharedAsset.reasons[0]?.includes("assets/shared.py"), sharedAsset.reasons.join("; "));
		mkdirSync(path.join(vendor, "dirmanifest", "plugin.json"), { recursive: true });
		file("dirmanifest/.claude-plugin/plugin.json", JSON.stringify({ name: "dirmanifest", version: "1.0.0" }));
		file("dirmanifest/skills/one/SKILL.md", skill("one"));
		const detected = detectForeignPlugin(path.join(vendor, "dirmanifest"));
		strictEqual(detected.format, "portable");
		ok(detected.diagnostics.some((line) => line.includes("not a regular file")));
		const dir = planLibraryImport(path.join(vendor, "dirmanifest"), { cwd });
		strictEqual(dir.action, "blocked");
		ok(dir.reasons[0]?.includes("invalid portable root plugin.json"), dir.reasons.join("; "));
	});

	it("supports the root SKILL.md fallback and manifest skill directories that hold SKILL.md directly", () => {
		file("single/.claude-plugin/plugin.json", JSON.stringify({ name: "single", version: "0.1.0" }));
		file("single/SKILL.md", skill("root-skill", "", "Follow references/guide.md.\n"));
		file("single/references/guide.md", "Guidance text.\n");
		file("single/agents/helper.md", "---\nname: helper\ndescription: d\n---\nAssist.\n");
		const single = projectForeignPlugin({ root: path.join(vendor, "single"), format: "claude-code" });
		deepStrictEqual(
			single.outcomes.map((o) => [o.kind, o.name, o.status, o.destination]),
			[
				["skill", "root-skill", "converted", "skills/root-skill/SKILL.md"],
				["agent", "helper", "converted", "agents/helper.md"],
			],
		);
		ok("skills/root-skill/references/guide.md" in single.files, "root skill keeps its data companions");
		ok(!("skills/root-skill/agents/helper.md" in single.files), "sibling resource roots are not companions");
		ok(!single.omitted.includes("agents/helper.md"));
		file("scripted/.claude-plugin/plugin.json", JSON.stringify({ name: "scripted", version: "0.1.0" }));
		file("scripted/SKILL.md", skill("scripted", "", "Run scripts/helper.py first.\n"));
		file("scripted/scripts/helper.py", "print(1)\n");
		const scripted = projectForeignPlugin({ root: path.join(vendor, "scripted"), format: "claude-code" });
		strictEqual(scripted.outcomes[0]?.status, "unsupported");
		ok(scripted.outcomes[0]?.reason?.includes("scripts/helper.py"), scripted.outcomes[0]?.reason);
		deepStrictEqual(Object.keys(scripted.files), ["plugin.json"]);
		file("indirect/.claude-plugin/plugin.json", JSON.stringify({ name: "indirect", version: "0.1.0" }));
		file("indirect/skills/deep/SKILL.md", skill("deep", "", "See references/guide.md.\n"));
		file("indirect/skills/deep/references/guide.md", "Then execute scripts/tool.py.\n");
		file("indirect/skills/deep/scripts/tool.py", "print(2)\n");
		const indirect = projectForeignPlugin({ root: path.join(vendor, "indirect"), format: "claude-code" });
		strictEqual(
			indirect.outcomes[0]?.status,
			"unsupported",
			"a retained companion referencing an omitted script blocks the recipe",
		);
		ok(indirect.outcomes[0]?.reason?.includes("scripts/tool.py"));
		file(
			"custom/.claude-plugin/plugin.json",
			JSON.stringify({ name: "custom", version: "0.1.0", skills: ["./extra/", "./solo"] }),
		);
		file("custom/skills/base/SKILL.md", skill("base"));
		file("custom/extra/more/SKILL.md", skill("more"));
		file("custom/solo/SKILL.md", skill("solo"));
		file("custom/SKILL.md", skill("never-loaded"));
		const custom = projectForeignPlugin({ root: path.join(vendor, "custom"), format: "claude-code" });
		deepStrictEqual(custom.outcomes.map((o) => o.name).sort(), ["base", "more", "solo"]);
		ok(custom.omitted.includes("SKILL.md"), "root SKILL.md is not a skill once skills/ exists");
	});

	it("refuses escaping manifest paths and symlinked packages, omits executables, and blocks recipes needing omitted companions", () => {
		file(
			"unsafe/.claude-plugin/plugin.json",
			JSON.stringify({ name: "unsafe", version: "1.0.0", skills: ["../outside"], agents: "./elsewhere/agent.md" }),
		);
		file("unsafe/skills/tooling/SKILL.md", skill("tooling", "", "Run scripts/helper.py before answering.\n"));
		file("unsafe/skills/tooling/scripts/helper.py", "print('x')\n");
		file("unsafe/skills/binary/SKILL.md", skill("binary"));
		file("unsafe/skills/binary/run.sh", "#!/bin/sh\n", 0o755);
		file("unsafe/skills/clean/SKILL.md", skill("clean"));
		file("unsafe/elsewhere/agent.md", "---\nname: x\ndescription: d\n---\nbody\n");
		mkdirSync(path.join(vendor, "outside", "evil"), { recursive: true });
		writeFileSync(path.join(vendor, "outside", "evil", "SKILL.md"), skill("evil"));
		const plan = planLibraryImport(path.join(vendor, "unsafe"), { cwd });
		strictEqual(plan.action, "install", plan.reasons.join("; "));
		const byName = Object.fromEntries(plan.outcomes.map((o) => [o.name, o]));
		strictEqual(byName.tooling?.status, "unsupported");
		ok(byName.tooling?.reason?.includes("scripts/helper.py"));
		strictEqual(byName.binary?.status, "converted");
		deepStrictEqual(byName.binary?.omittedFiles, ["skills/binary/run.sh"]);
		strictEqual(byName.clean?.status, "converted");
		strictEqual(byName.x?.status, "converted", "an explicit manifest agent file outside agents/ is documented");
		ok(!plan.outcomes.some((o) => o.name === "evil"));
		ok(plan.unsupported.some((line) => line.includes("escapes the package")));
		ok(!Object.keys(plan.files ?? {}).some((name) => name.includes("helper.py") || name.includes("run.sh")));
		releaseLibraryImport(plan);
		file("linked/.claude-plugin/plugin.json", JSON.stringify({ name: "linked", version: "1.0.0" }));
		file("linked/skills/one/SKILL.md", skill("one"));
		symlinkSync(path.join(vendor, "outside"), path.join(vendor, "linked", "skills", "shortcut"));
		const linked = planLibraryImport(path.join(vendor, "linked"), { cwd });
		strictEqual(linked.action, "blocked");
		ok(linked.reasons[0]?.includes("Symbolic links"), linked.reasons.join("; "));
	});

	it("treats vendor dependencies and agent skill bindings as prerequisites, not omissions", () => {
		file(
			"needy/.claude-plugin/plugin.json",
			JSON.stringify({ name: "needy", version: "1.0.0", dependencies: ["helper-lib"] }),
		);
		file("needy/skills/one/SKILL.md", skill("one"));
		file("needy/agents/bound.md", "---\nname: bound\ndescription: d\nskills: [one, missing-skill]\n---\nDo work.\n");
		file("needy/agents/fine.md", "---\nname: fine\ndescription: d\nskills: [one]\n---\nDo work.\n");
		const blocked = planLibraryImport(path.join(vendor, "needy"), { cwd });
		strictEqual(blocked.action, "blocked");
		deepStrictEqual(blocked.requirements, ["plugin:helper-lib"]);
		ok(blocked.reasons.some((line) => line.includes("plugin:helper-lib")));
		const bound = blocked.outcomes.find((o) => o.name === "bound");
		strictEqual(bound?.status, "unsupported");
		ok(bound?.reason?.includes("missing-skill"));
		strictEqual(blocked.outcomes.find((o) => o.name === "fine")?.status, "converted");
		ok(blocked.files?.["agents/fine.md"]?.includes("skills:\n  - one"), "the binding is expressed in the Clio schema");
		ok(!blocked.outcomes.find((o) => o.name === "fine")?.omittedFields?.includes("skills"));
		strictEqual(applyLibraryImport(blocked, true).published, false);
		mkdirSync(path.join(vendor, "native-helper", "skills", "h"), { recursive: true });
		writeFileSync(
			path.join(vendor, "native-helper", "plugin.json"),
			JSON.stringify({
				$schema: PLUGIN_SCHEMA,
				name: "helper-lib",
				version: "2.0.0",
				extensions: { "ai.iowarp.clio": { manifestVersion: 1 } },
			}),
		);
		writeFileSync(path.join(vendor, "native-helper", "skills", "h", "SKILL.md"), skill("h"));
		const native = installLibraryPackage({
			kind: "plugin",
			sourcePath: path.join(vendor, "native-helper"),
			scope: "user",
			origin: { kind: "local", source: path.join(vendor, "native-helper") },
			trust: "trusted",
			cwd,
		});
		ok(native.plugin);
		const spoofed = planLibraryImport(path.join(vendor, "needy"), { cwd });
		strictEqual(spoofed.action, "blocked", "a native package with the same id never satisfies a vendor dependency");
		ok(
			spoofed.reasons.some((line) => line.includes("same-named native package")),
			spoofed.reasons.join("; "),
		);
		removePlugin("helper-lib", { cwd, scope: "user" });
		file("helper-lib/.claude-plugin/plugin.json", JSON.stringify({ name: "helper-lib", version: "2.0.0" }));
		file("helper-lib/skills/help/SKILL.md", skill("help"));
		const helper = planLibraryImport(path.join(vendor, "helper-lib"), { cwd });
		strictEqual(applyLibraryImport(helper, true).published, true);
		const ready = planLibraryImport(path.join(vendor, "needy"), { cwd });
		strictEqual(ready.action, "install", ready.reasons.join("; "));
		const result = applyLibraryImport(ready, true);
		strictEqual(result.published, true, result.diagnostics.join("; "));
		deepStrictEqual(listInstalledPlugins(cwd, { all: true }).find((pkg) => pkg.id === "needy")?.manifest?.clio.requires, [
			"plugin:helper-lib",
		]);
		file(
			"pinned/.claude-plugin/plugin.json",
			JSON.stringify({ name: "pinned", version: "1.0.0", dependencies: [{ name: "helper-lib", version: "~2.0.0" }] }),
		);
		file("pinned/skills/one/SKILL.md", skill("one"));
		const pinned = planLibraryImport(path.join(vendor, "pinned"), { cwd });
		strictEqual(pinned.action, "blocked");
		ok(pinned.reasons[0]?.includes("version constraint"), pinned.reasons.join("; "));
		file(
			"sourced/.claude-plugin/plugin.json",
			JSON.stringify({ name: "sourced", version: "1.0.0", dependencies: [{ name: "helper-lib", source: "acme" }] }),
		);
		file("sourced/skills/one/SKILL.md", skill("one"));
		const sourced = planLibraryImport(path.join(vendor, "sourced"), { cwd });
		strictEqual(sourced.action, "blocked");
		ok(sourced.reasons[0]?.includes("unsupported fields source"), sourced.reasons.join("; "));
		file(
			"odd/.claude-plugin/plugin.json",
			JSON.stringify({ name: "odd", version: "1.0.0", dependencies: ["Helper Lib"] }),
		);
		file("odd/skills/one/SKILL.md", skill("one"));
		const odd = planLibraryImport(path.join(vendor, "odd"), { cwd });
		strictEqual(odd.action, "blocked");
		ok(odd.reasons[0]?.includes("not a portable identifier"), odd.reasons.join("; "));
	});

	it("diagnoses malformed versions and ambiguous hidden manifests instead of guessing", () => {
		file("badver/.claude-plugin/plugin.json", JSON.stringify({ name: "badver", version: "latest" }));
		file("badver/skills/one/SKILL.md", skill("one"));
		const badver = planLibraryImport(path.join(vendor, "badver"), { cwd });
		strictEqual(badver.action, "blocked");
		ok(badver.reasons[0]?.includes("not a Semantic Version"), badver.reasons.join("; "));
		file("dual/.claude-plugin/plugin.json", JSON.stringify({ name: "dual-claude", version: "1.0.0" }));
		file("dual/.codex-plugin/plugin.json", JSON.stringify({ name: "dual-codex", version: "1.0.0" }));
		file("dual/skills/one/SKILL.md", skill("one"));
		const ambiguous = planLibraryImport(path.join(vendor, "dual"), { cwd });
		strictEqual(ambiguous.action, "blocked");
		strictEqual(ambiguous.detection.ambiguous, true);
		strictEqual(ambiguous.format, undefined);
		const codex = planLibraryImport(path.join(vendor, "dual"), { cwd, format: "codex" });
		strictEqual(codex.action, "install", codex.reasons.join("; "));
		strictEqual(codex.id, "dual-codex");
		releaseLibraryImport(codex);
		const claude = planLibraryImport(path.join(vendor, "dual"), { cwd, format: "claude-code" });
		strictEqual(claude.id, "dual-claude");
		releaseLibraryImport(claude);
	});

	it("blocks identifier collisions across origins, keeps previews immutable, and refuses stale sources", () => {
		const root = claudeBundle("shared-id");
		const home = path.join(env.dir, "foreign-home");
		mkdirSync(path.join(home, ".claude"), { recursive: true });
		const local = path.join(home, ".claude", "plugins", "cache", "market", "shared-id");
		mkdirSync(path.join(local, ".claude-plugin"), { recursive: true });
		writeFileSync(
			path.join(local, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "shared-id", version: "9.9.9" }),
		);
		mkdirSync(path.join(local, "skills", "other"), { recursive: true });
		writeFileSync(path.join(local, "skills", "other", "SKILL.md"), skill("other"));
		const inventory: InteropInventory = {
			status: "known",
			listing: "unknown",
			diagnostics: [],
			items: [{ kind: "plugin", name: "shared-id", scope: "user", path: local, marketplace: "market" }],
		};
		const adopted = planInteropAdoption({ host: "claude-code", inventory, cwd, kind: "plugin" });
		strictEqual(adopted.entries[0]?.action, "install", adopted.entries[0]?.reason);
		deepStrictEqual(applyInteropAdoption(adopted, true).installed, ["shared-id"]);
		const collision = planLibraryImport(root, { cwd });
		strictEqual(collision.action, "blocked");
		ok(collision.reasons.some((line) => line.includes("already installed")));
		const record = readPluginInstallRecord("shared-id", { cwd, scope: "user" });
		strictEqual((record?.origin as { kind: string }).kind, "interop");
		removePlugin("shared-id", { cwd, scope: "user" });
		const plan = planLibraryImport(root, { cwd });
		strictEqual(plan.action, "install");
		const reviewed = plan.digest;
		writeFileSync(path.join(root, "skills", "review", "SKILL.md"), skill("review", "", "Changed after review.\n"));
		const stale = applyLibraryImport(plan, true);
		strictEqual(stale.published, false);
		ok(stale.diagnostics[0]?.includes("changed after review"), stale.diagnostics.join("; "));
		strictEqual(plan.digest, reviewed, "the reviewed plan is not rewritten by apply");
		strictEqual(listInstalledPlugins(cwd, { all: true }).length, 0);
		const hidden = planLibraryImport(root, { cwd });
		strictEqual(hidden.action, "install");
		writeFileSync(
			path.join(root, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "shared-id", version: "1.2.3", dependencies: ["helper-lib"] }),
		);
		const drifted = applyLibraryImport(hidden, true);
		strictEqual(
			drifted.published,
			false,
			"a hidden manifest change after review is refused even when projected text is equal",
		);
		ok(drifted.diagnostics[0]?.includes("Source changed after review"), drifted.diagnostics.join("; "));
		writeFileSync(
			path.join(root, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "shared-id", version: "1.2.3" }),
		);
		writeFileSync(path.join(root, "scripts", "run.sh"), "#!/bin/sh\nexit 1\n");
		const runtime = planLibraryImport(root, { cwd });
		strictEqual(runtime.action, "install", runtime.reasons.join("; "));
		writeFileSync(path.join(root, "scripts", "run.sh"), "#!/bin/sh\nexit 2\n");
		ok(
			applyLibraryImport(runtime, true).diagnostics[0]?.includes("Source changed after review"),
			"omitted runtime files are part of the review",
		);
		strictEqual(listInstalledPlugins(cwd, { all: true }).length, 0);
	});

	it("stages GitHub tree sources through the existing transport and releases them on cancel, failure, and apply", () => {
		const source = claudeBundle("remote-pack");
		const tools = path.join(env.dir, "bin");
		mkdirSync(tools);
		writeFileSync(
			path.join(tools, "git"),
			`#!${process.execPath}\nconst fs=require('node:fs');const p=require('node:path');const args=process.argv.slice(2);fs.cpSync(${JSON.stringify(source)},p.join(args.at(-1),'plugins','remote-pack'),{recursive:true});\n`,
			{ mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${tools}${path.delimiter}${previousPath ?? ""}`;
		const url = "https://github.com/example/repo/tree/v1/plugins/remote-pack";
		try {
			const cancelled = planLibraryImport(url, { cwd });
			strictEqual(cancelled.source.transport, "github");
			ok(existsSync(cancelled.source.root), "preview retains staged source");
			ok(!cancelled.source.root.startsWith(source));
			releaseLibraryImport(cancelled);
			ok(!existsSync(cancelled.source.root), "cancel removes the staging clone");
			const refused = planLibraryImport(url, { cwd });
			strictEqual(applyLibraryImport(refused, false).published, false);
			ok(!existsSync(refused.source.root), "refusal releases staging");
			const plan = planLibraryImport(url, { cwd });
			const result = applyLibraryImport(plan, true);
			strictEqual(result.published, true, result.diagnostics.join("; "));
			ok(!existsSync(plan.source.root), "apply releases staging");
			deepStrictEqual(readPluginInstallRecord("remote-pack", { cwd, scope: "user" })?.origin, {
				kind: "import",
				source: url,
				transport: "github",
				format: "claude-code",
			});
			const again = planLibraryImport(url, { cwd });
			strictEqual(again.action, "blocked");
			ok(!existsSync(again.source.root) || releaseLibraryImport(again) === undefined);
			ok(!existsSync(again.source.root));
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("retains foreign trust across reload, refuses in-place replacement, and allows remove then re-import", () => {
		const root = claudeBundle("sticky");
		strictEqual(applyLibraryImport(planLibraryImport(root, { cwd }), true).published, true);
		clearPluginSnapshots();
		const reloaded = listInstalledPlugins(cwd, { all: true }).find((pkg) => pkg.id === "sticky");
		strictEqual(reloaded?.trust, "foreign");
		mkdirSync(path.join(vendor, "replacement", "skills", "x"), { recursive: true });
		writeFileSync(
			path.join(vendor, "replacement", "plugin.json"),
			JSON.stringify({
				$schema: PLUGIN_SCHEMA,
				name: "sticky",
				version: "2.0.0",
				extensions: { "ai.iowarp.clio": { manifestVersion: 1 } },
			}),
		);
		writeFileSync(path.join(vendor, "replacement", "skills", "x", "SKILL.md"), skill("x"));
		const replaced = installLibraryPackage({
			kind: "plugin",
			sourcePath: path.join(vendor, "replacement"),
			scope: "user",
			origin: { kind: "local", source: path.join(vendor, "replacement") },
			trust: "trusted",
			cwd,
			force: true,
		});
		ok(!replaced.plugin);
		ok(replaced.diagnostics[0]?.message.includes("remove the installed copy"));
		strictEqual(readPluginInstallRecord("sticky", { cwd, scope: "user" })?.trust, "foreign");
		removePlugin("sticky", { cwd, scope: "user" });
		const again = applyLibraryImport(planLibraryImport(root, { cwd }), true);
		strictEqual(again.published, true, again.diagnostics.join("; "));
		strictEqual(readPluginInstallRecord("sticky", { cwd, scope: "user" })?.trust, "foreign");
	});

	it("exposes the CLI route with JSON that omits reviewed bytes and requires --yes to publish", () => {
		const root = claudeBundle("cli-pack");
		const cli = (...args: string[]) =>
			spawnSync(process.execPath, [path.resolve("dist/cli/index.js"), "library", "import", ...args], {
				cwd,
				env: { ...process.env, HOME: path.join(env.dir, "home") },
				encoding: "utf8",
				timeout: 60000,
			});
		const dry = cli(root, "--dry-run", "--json");
		strictEqual(dry.status, 0, dry.stderr);
		const parsed = JSON.parse(dry.stdout) as { ok: boolean; confirmed: boolean; plan: Record<string, unknown> };
		strictEqual(parsed.confirmed, false);
		strictEqual(parsed.plan.format, "claude-code");
		ok(!("files" in parsed.plan) && !("cleanup" in parsed.plan));
		ok(!dry.stdout.includes("do-not-copy"));
		strictEqual(listInstalledPlugins(cwd, { all: true }).length, 0);
		const text = cli(root, "--dry-run");
		strictEqual(text.status, 0, text.stderr);
		ok(text.stdout.includes("CONVERT prompt deploy"));
		const no = cli(root, "--json");
		strictEqual(no.status, 1, no.stdout);
		ok(no.stdout.includes("Approval required"));
		strictEqual(listInstalledPlugins(cwd, { all: true }).length, 0);
		const yes = cli(root, "--yes", "--json");
		strictEqual(yes.status, 0, `${yes.stdout}${yes.stderr}`);
		const done = JSON.parse(yes.stdout) as {
			ok: boolean;
			result: { published: boolean; validation: { valid: boolean } };
		};
		strictEqual(done.result.published, true);
		strictEqual(done.result.validation.valid, true);
		clearPluginSnapshots();
		strictEqual(listInstalledPlugins(cwd, { all: true })[0]?.trust, "foreign");
		const bad = cli(root, "--format", "gemini");
		strictEqual(bad.status, 2);
	});
});
