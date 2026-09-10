import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFleetContract } from "../../src/domains/agents/fleet-contract.js";
import { type AgentRecipeDiagnostic, loadRecipesFromDir } from "../../src/domains/agents/registry.js";
import { normalizeAgentSpec, resolveAgentToolCompatibility } from "../../src/domains/agents/spec.js";
import { installPlugin, pluginContentDigest, readPluginManifest } from "../../src/domains/plugins/index.js";
import { resolvePackageReferences } from "../../src/domains/resources/package-references.js";
import { loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";

const source = fileURLToPath(new URL("../../library/plugins/materio/", import.meta.url));
const temporary: string[] = [];

function scratch(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "clio-coder materials bundle "));
	temporary.push(directory);
	return directory;
}

describe("materio plugin", () => {
	afterEach(() => {
		for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("loads the complete installed graph through native production resource loaders", () => {
		const candidate = readPluginManifest(source);
		strictEqual(candidate.valid, true, JSON.stringify(candidate.diagnostics));
		ok(candidate.manifest);
		const counts: Record<string, number> = {};
		for (const component of candidate.manifest.clio.components) {
			counts[component.kind] = (counts[component.kind] ?? 0) + 1;
		}
		deepStrictEqual(counts, { resource: 25, script: 5, skill: 6, agent: 6, prompt: 17, fleet: 1 });
		const project = scratch();
		const result = installPlugin(source, {
			cwd: project,
			scope: "project",
			expectedDigest: pluginContentDigest(source),
			expectedId: "materio",
		});
		ok(result.plugin?.loadable, JSON.stringify(result.diagnostics));
		const root = result.plugin.rootPath;
		const prompts = loadPromptTemplates({
			cwd: project,
			roots: [{ path: path.join(root, "ai.iowarp.clio/prompts"), rootPath: root, plugin: true, scope: "project" }],
		});
		strictEqual(prompts.items.length, 17);
		deepStrictEqual(prompts.diagnostics, []);
		for (const prompt of prompts.items) {
			ok(prompt.name.startsWith("materio:"));
			ok(!prompt.unavailable, prompt.unavailable);
			ok(!prompt.content.includes("${component:"));
			ok(!/\$\{pluginRoot\}/u.test(prompt.content));
		}
		const skills = loadSkills({ cwd: project, disableDiscovery: true, explicitSkillPaths: [path.join(root, "skills")] });
		strictEqual(skills.items.length, 6);
		const diagnostics: AgentRecipeDiagnostic[] = [];
		const recipes = loadRecipesFromDir(
			{
				source: "plugin",
				dir: path.join(root, "ai.iowarp.clio/agents"),
				rootPath: root,
				skillRoot: path.join(root, "skills"),
				cwd: project,
			},
			diagnostics,
		);
		deepStrictEqual(diagnostics, []);
		strictEqual(recipes.length, 6);
		for (const recipe of recipes) {
			strictEqual(recipe.boundSkillPaths.length, 1);
			ok(recipe.boundSkillPaths[0]?.startsWith(path.join(root, "skills")));
			if (recipe.capabilityClass === "workspace-edit") {
				const spec = normalizeAgentSpec(recipe);
				strictEqual(resolveAgentToolCompatibility(spec, spec.tools, { mediatesDispatch: false }).compatible, true);
				const withoutLimitation = resolveAgentToolCompatibility(
					spec,
					spec.tools.filter((tool) => tool !== "limitation"),
					{ mediatesDispatch: false },
				);
				deepStrictEqual(withoutLimitation.missingRequired, ["limitation"], recipe.id);
			}
		}
		const verifier = recipes.find((recipe) => recipe.id === "materio-task-verifier");
		strictEqual(verifier?.capabilityClass, "read-only");
		ok(verifier?.tools.every((tool) => !["write", "edit", "bash", "ask_user"].includes(tool)));
		const fleetPath = path.join(root, "ai.iowarp.clio/fleets/materio-execute-task.md");
		const fleet = parseFleetContract(readFileSync(fleetPath, "utf8"), fleetPath);
		strictEqual(fleet.steps.length, 2);
		const executorStep = fleet.steps[0];
		const verifierStep = fleet.steps[1];
		ok(executorStep?.kind === "agent");
		ok(verifierStep?.kind === "agent");
		deepStrictEqual(executorStep.writes, [".research/tasks/"]);
		strictEqual(verifierStep.scope, "readonly");
		for (const component of candidate.manifest.clio.components) {
			if (!component.path.endsWith(".md")) continue;
			const body = resolvePackageReferences(readFileSync(path.join(root, component.path), "utf8"), {
				rootPath: root,
				plugin: true,
			});
			ok(!body.includes("${component:"), component.path);
		}
	});

	it("keeps portable skill links and complete action guides inside the bundle", () => {
		const skillsRoot = path.join(source, "skills");
		for (const directory of readdirSync(skillsRoot)) {
			const skill = path.join(skillsRoot, directory, "SKILL.md");
			const body = readFileSync(skill, "utf8");
			for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
				const linked = path.resolve(path.dirname(skill), match[1] ?? "");
				ok(linked.startsWith(source), `${skill}: ${linked}`);
				ok(existsSync(linked), linked);
			}
		}
		strictEqual(readdirSync(path.join(source, "assets/actions")).length, 17);
	});

	it("pins scientific scripts and references as part of the whole installed unit", () => {
		const packageRoot = path.join(scratch(), "package");
		cpSync(source, packageRoot, { recursive: true });
		const expected = pluginContentDigest(packageRoot);
		writeFileSync(path.join(packageRoot, "assets/references/research-domains.md"), "changed scientific context");
		ok(pluginContentDigest(packageRoot) !== expected);
		const result = installPlugin(packageRoot, {
			cwd: scratch(),
			scope: "project",
			force: true,
			expectedDigest: expected,
		});
		strictEqual(result.plugin, undefined);
		ok(result.diagnostics.some((diagnostic) => diagnostic.type === "error"));
	});

	it("runs deterministic state, advisory-checker, and peer-export behavior contracts", () => {
		const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", path.join(source, "tests")], {
			encoding: "utf8",
			env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
			timeout: 30_000,
		});
		strictEqual(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
	});
});
