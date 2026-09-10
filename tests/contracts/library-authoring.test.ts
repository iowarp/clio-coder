import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";

import { runLibraryCommand } from "../../src/cli/library.js";
import { parseFleetContract } from "../../src/domains/agents/fleet-contract.js";
import { parseFrontmatter } from "../../src/domains/agents/frontmatter.js";
import { parseAgentRecipeSchema } from "../../src/domains/agents/recipe-schema.js";
import { listInstalledPlugins, readPluginManifest } from "../../src/domains/plugins/index.js";
import { validateLibraryPackage } from "../../src/domains/resources/library-validation.js";
import { loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { loadSkills, skillCatalogValidity } from "../../src/domains/resources/skills/loader.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const TEMPLATES_DIR = join(REPO_ROOT, "library", "_authoring", "templates");
const TEMPLATE_KINDS = ["skill", "agent", "fleet", "prompt", "plugin"] as const;

function computeDirectoryFingerprint(dir: string): Record<string, string> {
	const result: Record<string, string> = {};
	function walk(current: string) {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				const rel = fullPath.slice(dir.length);
				const hash = createHash("sha256").update(readFileSync(fullPath)).digest("hex");
				result[rel] = hash;
			}
		}
	}
	walk(dir);
	return result;
}

describe("library package authoring templates", () => {
	it("all 5 templates load cleanly through native domain loaders", () => {
		// 1. Skill template
		const skillRoot = join(TEMPLATES_DIR, "skill");
		const skillManifest = readPluginManifest(skillRoot);
		ok(skillManifest.valid, `skill manifest should be valid: ${JSON.stringify(skillManifest.diagnostics)}`);
		equal(skillManifest.manifest?.clio.kind, "skill");
		const loadedSkills = loadSkills({
			roots: [{ path: skillRoot, scope: "package", rootPath: skillRoot, plugin: true, trusted: true }],
		});
		const catalogValidity = skillCatalogValidity(loadedSkills);
		ok(catalogValidity.ok, `skill catalog should be valid: ${catalogValidity.reason}`);
		equal(loadedSkills.items.length, 1);
		equal(loadedSkills.items[0]?.name, "citation-check");

		// 2. Agent template
		const agentRoot = join(TEMPLATES_DIR, "agent");
		const agentManifest = readPluginManifest(agentRoot);
		ok(agentManifest.valid, `agent manifest should be valid: ${JSON.stringify(agentManifest.diagnostics)}`);
		equal(agentManifest.manifest?.clio.kind, "agent");
		const agentRecipePath = join(agentRoot, "agents", "benchmark-scout.md");
		ok(existsSync(agentRecipePath), "benchmark-scout.md must exist");
		const rawAgent = readFileSync(agentRecipePath, "utf8");
		const { frontmatter: agentFm, body: agentBody } = parseFrontmatter(rawAgent, agentRecipePath);
		const parsedAgent = parseAgentRecipeSchema({
			id: "benchmark-scout",
			source: "plugin",
			filepath: agentRecipePath,
			body: agentBody,
			frontmatter: agentFm,
		});
		equal(parsedAgent.id, "benchmark-scout");
		equal(parsedAgent.audience, "custom");
		deepStrictEqual(parsedAgent.skills, []);
		ok(parsedAgent.description.length > 0);
		ok(parsedAgent.budget !== undefined);

		// 3. Fleet template
		const fleetRoot = join(TEMPLATES_DIR, "fleet");
		const fleetManifest = readPluginManifest(fleetRoot);
		ok(fleetManifest.valid, `fleet manifest should be valid: ${JSON.stringify(fleetManifest.diagnostics)}`);
		equal(fleetManifest.manifest?.clio.kind, "fleet");
		const fleetPath = join(fleetRoot, "fleets", "pipeline-review.md");
		ok(existsSync(fleetPath), "pipeline-review.md must exist");
		const parsedFleet = parseFleetContract(readFileSync(fleetPath, "utf8"), fleetPath);
		equal(parsedFleet.name, "pipeline-review");
		equal(parsedFleet.steps.length, 2);
		equal(parsedFleet.steps[0]?.id, "inspect-pipeline");
		equal(parsedFleet.steps[1]?.id, "verify-invariants");
		deepStrictEqual(parsedFleet.steps[1]?.dependencies, ["inspect-pipeline"]);
		equal(parsedFleet.onFailure, "stop");

		// 4. Prompt template
		const promptRoot = join(TEMPLATES_DIR, "prompt");
		const promptManifest = readPluginManifest(promptRoot);
		ok(promptManifest.valid, `prompt manifest should be valid: ${JSON.stringify(promptManifest.diagnostics)}`);
		equal(promptManifest.manifest?.clio.kind, "prompt");
		const loadedPrompts = loadPromptTemplates({
			roots: [{ path: join(promptRoot, "prompts"), scope: "package", rootPath: promptRoot, plugin: true, trusted: true }],
		});
		equal(loadedPrompts.items.length, 1);
		equal(loadedPrompts.items[0]?.name, "paper-summary");
		ok(loadedPrompts.items[0]?.content.includes("$ARGUMENTS"));
		equal(loadedPrompts.items[0]?.unavailable, undefined);

		// 5. Plugin template (composite)
		const pluginRoot = join(TEMPLATES_DIR, "plugin");
		const pluginManifest = readPluginManifest(pluginRoot);
		ok(pluginManifest.valid, `plugin manifest should be valid: ${JSON.stringify(pluginManifest.diagnostics)}`);
		equal(pluginManifest.manifest?.clio.kind, "plugin");
		const components = pluginManifest.manifest?.clio.components ?? [];
		equal(components.length, 4);
		ok(components.some((c) => c.kind === "resource" && c.id === "guidelines" && c.path === "assets/curation-guide.md"));
		ok(
			components.some(
				(c) => c.kind === "skill" && c.id === "dataset-curation" && c.path === "skills/dataset-curation/SKILL.md",
			),
		);
		ok(components.some((c) => c.kind === "agent" && c.id === "data-curator" && c.path === "agents/data-curator.md"));
		ok(
			components.some((c) => c.kind === "prompt" && c.id === "inspect-dataset" && c.path === "prompts/inspect-dataset.md"),
		);
	});

	it("all 5 templates pass validateLibraryPackage and clio library validate CLI", async () => {
		for (const kind of TEMPLATE_KINDS) {
			const templateDir = join(TEMPLATES_DIR, kind);
			const validation = validateLibraryPackage(templateDir);
			ok(
				validation.valid,
				`template '${kind}' failed validateLibraryPackage: ${JSON.stringify(validation.validation.diagnostics)}`,
			);
			ok(validation.manifestValid, `template '${kind}' manifest should be valid`);
			ok(validation.validation.contentValid, `template '${kind}' content should be valid`);
			equal(validation.validation.diagnostics.length, 0);

			// Check CLI execution
			const exitCode = await runLibraryCommand(["validate", templateDir, "--json"]);
			equal(exitCode, 0, `CLI validation failed for template '${kind}'`);
		}

		// Fleet template surfaces external agent prerequisites
		const fleetVal = validateLibraryPackage(join(TEMPLATES_DIR, "fleet"));
		const agentPrereqs = fleetVal.validation.prerequisites.filter((p) => p.type === "agent");
		ok(agentPrereqs.some((p) => p.identifier === "scout"));
		ok(agentPrereqs.some((p) => p.identifier === "verifier"));
	});

	it("validation rejects manifest-valid malformed agent", async () => {
		const env = await isolateClioEnv("val-bad-agent-");
		try {
			const pkgDir = join(env.dir, "bad-agent-pkg");
			mkdirSync(join(pkgDir, "agents"), { recursive: true });
			writeFileSync(
				join(pkgDir, "plugin.json"),
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
					name: "bad-agent-pkg",
					version: "1.0.0",
					description: "Agent package with malformed recipe",
					extensions: {
						"ai.iowarp.clio": {
							manifestVersion: 1,
							kind: "agent",
							resources: { agents: "agents" },
							components: [{ kind: "agent", id: "bad-agent", path: "agents/bad-agent.md" }],
						},
					},
				}),
			);
			// Missing required description, invalid audience
			writeFileSync(
				join(pkgDir, "agents", "bad-agent.md"),
				"---\nversion: 1\nname: bad-agent\naudience: invalid-audience\n---\nPersona body without required fields.\n",
			);

			const res = validateLibraryPackage(pkgDir);
			equal(res.valid, false);
			equal(res.manifestValid, true);
			equal(res.validation.contentValid, false);
			ok(res.validation.diagnostics.some((d) => d.code === "ERR_AGENT"));

			const cliCode = await runLibraryCommand(["validate", pkgDir, "--json"]);
			equal(cliCode, 1);
		} finally {
			env.restore();
		}
	});

	it("validation rejects broken fleet graph with dependency cycle", async () => {
		const env = await isolateClioEnv("val-bad-fleet-");
		try {
			const pkgDir = join(env.dir, "bad-fleet-pkg");
			mkdirSync(join(pkgDir, "fleets"), { recursive: true });
			writeFileSync(
				join(pkgDir, "plugin.json"),
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
					name: "bad-fleet-pkg",
					version: "1.0.0",
					description: "Fleet package with cyclic dependencies",
					extensions: {
						"ai.iowarp.clio": {
							manifestVersion: 1,
							kind: "fleet",
							resources: { fleets: "fleets" },
							components: [{ kind: "fleet", id: "cyclic-fleet", path: "fleets/cyclic-fleet.md" }],
						},
					},
				}),
			);
			writeFileSync(
				join(pkgDir, "fleets", "cyclic-fleet.md"),
				`---
version: 1
name: cyclic-fleet
description: Fleet with cyclic dependency
steps:
  - id: step-a
    agent: scout
    scope: readonly
    dependencies: [step-b]
  - id: step-b
    agent: verifier
    scope: readonly
    dependencies: [step-a]
maxWorkers: 1
onFailure: stop
---
Fleet instructions.
`,
			);

			const res = validateLibraryPackage(pkgDir);
			equal(res.valid, false);
			equal(res.manifestValid, true);
			equal(res.validation.contentValid, false);
			ok(res.validation.diagnostics.some((d) => d.code === "ERR_FLEET"));

			const cliCode = await runLibraryCommand(["validate", pkgDir, "--json"]);
			equal(cliCode, 1);
		} finally {
			env.restore();
		}
	});

	it("validation rejects unresolved component reference markers", async () => {
		const env = await isolateClioEnv("val-unresolved-ref-");
		try {
			const pkgDir = join(env.dir, "unresolved-ref-pkg");
			mkdirSync(join(pkgDir, "prompts"), { recursive: true });
			writeFileSync(
				join(pkgDir, "plugin.json"),
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
					name: "unresolved-ref-pkg",
					version: "1.0.0",
					description: "Prompt package with unresolved component reference",
					extensions: {
						"ai.iowarp.clio": {
							manifestVersion: 1,
							kind: "prompt",
							resources: { prompts: "prompts" },
							components: [{ kind: "prompt", id: "broken-prompt", path: "prompts/broken-prompt.md" }],
						},
					},
				}),
			);
			writeFileSync(
				join(pkgDir, "prompts", "broken-prompt.md"),
				`---
description: Prompt with non-existent component reference
---
Refer to \${component:resource:missing-document} before proceeding.
`,
			);

			const res = validateLibraryPackage(pkgDir);
			equal(res.valid, false);
			equal(res.manifestValid, true);
			equal(res.validation.contentValid, false);
			ok(res.validation.diagnostics.some((d) => d.code === "ERR_PROMPT" || d.code === "ERR_PACKAGE_REFERENCE"));

			const cliCode = await runLibraryCommand(["validate", pkgDir, "--json"]);
			equal(cliCode, 1);
		} finally {
			env.restore();
		}
	});

	it("validation rejects unsupported cross-package skill binding on standalone agent", async () => {
		const env = await isolateClioEnv("val-unsupported-skill-");
		try {
			const pkgDir = join(env.dir, "cross-skill-agent-pkg");
			mkdirSync(join(pkgDir, "agents"), { recursive: true });
			writeFileSync(
				join(pkgDir, "plugin.json"),
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
					name: "cross-skill-agent-pkg",
					version: "1.0.0",
					description: "Standalone agent attempting to bind external skill",
					extensions: {
						"ai.iowarp.clio": {
							manifestVersion: 1,
							kind: "agent",
							resources: { agents: "agents" },
							components: [{ kind: "agent", id: "cross-agent", path: "agents/cross-agent.md" }],
						},
					},
				}),
			);
			writeFileSync(
				join(pkgDir, "agents", "cross-agent.md"),
				`---
version: 1
name: cross-agent
description: Standalone agent binding external skill
tools:
  required: [read]
  optional: []
skills: [external-unsupported-skill]
audience: custom
category: science
capabilityClass: read-only
latencyClass: balanced
projectContextTier: bounded
budget: {toolCalls: 32, readReserve: 4, synthesis: true}
resultContract: {kind: scout-report}
tags: [test]
---
Persona body.
`,
			);

			const res = validateLibraryPackage(pkgDir);
			equal(res.valid, false);
			equal(res.manifestValid, true);
			equal(res.validation.contentValid, false);
			ok(res.validation.diagnostics.some((d) => d.code === "ERR_AGENT"));

			const cliCode = await runLibraryCommand(["validate", pkgDir, "--json"]);
			equal(cliCode, 1);
		} finally {
			env.restore();
		}
	});

	it("validation rejects prompt whose body is unavailable", async () => {
		const env = await isolateClioEnv("val-unavailable-prompt-");
		try {
			const pkgDir = join(env.dir, "unavailable-prompt-pkg");
			mkdirSync(join(pkgDir, "prompts"), { recursive: true });
			writeFileSync(
				join(pkgDir, "plugin.json"),
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
					name: "unavailable-prompt-pkg",
					version: "1.0.0",
					description: "Prompt package with escaping package reference",
					extensions: {
						"ai.iowarp.clio": {
							manifestVersion: 1,
							kind: "prompt",
							resources: { prompts: "prompts" },
							components: [{ kind: "prompt", id: "missing-body", path: "prompts/missing-body.md" }],
						},
					},
				}),
			);
			writeFileSync(
				join(pkgDir, "prompts", "missing-body.md"),
				`---
description: Prompt with invalid pluginRoot reference
---
Check \${pluginRoot}/assets/nonexistent-file.txt
`,
			);

			const res = validateLibraryPackage(pkgDir);
			equal(res.valid, false);
			equal(res.manifestValid, true);
			equal(res.validation.contentValid, false);
			ok(res.validation.diagnostics.some((d) => d.code === "ERR_PROMPT" || d.code === "ERR_PACKAGE_REFERENCE"));

			const cliCode = await runLibraryCommand(["validate", pkgDir, "--json"]);
			equal(cliCode, 1);
		} finally {
			env.restore();
		}
	});

	it("read-only validation leaves source bytes and installation state unchanged", async () => {
		const env = await isolateClioEnv("val-readonly-");
		try {
			// Record file hashes across all templates before validation
			const beforeHashes = computeDirectoryFingerprint(TEMPLATES_DIR);

			// Run validation on all templates
			for (const kind of TEMPLATE_KINDS) {
				const templateDir = join(TEMPLATES_DIR, kind);
				validateLibraryPackage(templateDir);
				await runLibraryCommand(["validate", templateDir, "--json"]);
			}

			// Record file hashes after validation
			const afterHashes = computeDirectoryFingerprint(TEMPLATES_DIR);
			deepStrictEqual(afterHashes, beforeHashes, "validation must not modify any template source files");

			// Ensure no plugins were installed into isolated Clio environment
			const installed = listInstalledPlugins(env.dir, { all: true });
			equal(installed.length, 0, "validation must not install packages or modify installed state");
		} finally {
			env.restore();
		}
	});

	it("all 34 curated library packages pass validation, including Materio", () => {
		const isDir = (p: string) => statSync(p).isDirectory();
		const libraryDir = join(REPO_ROOT, "library");

		const packagePaths: string[] = [
			...readdirSync(join(libraryDir, "agents"))
				.map((d) => join(libraryDir, "agents", d))
				.filter(isDir),
			...readdirSync(join(libraryDir, "fleets"))
				.map((d) => join(libraryDir, "fleets", d))
				.filter(isDir),
			...readdirSync(join(libraryDir, "plugins"))
				.map((d) => join(libraryDir, "plugins", d))
				.filter(isDir),
			...readdirSync(join(libraryDir, "prompts"))
				.map((d) => join(libraryDir, "prompts", d))
				.filter(isDir),
			...readdirSync(join(libraryDir, "skills"))
				.filter((d) => !d.endsWith(".yaml") && !d.endsWith(".md") && !d.endsWith(".json"))
				.filter((d) => isDir(join(libraryDir, "skills", d)))
				.flatMap((cat) =>
					readdirSync(join(libraryDir, "skills", cat))
						.map((d) => join(libraryDir, "skills", cat, d))
						.filter(isDir),
				),
		];

		equal(packagePaths.length, 34, `expected 34 curated library packages, found ${packagePaths.length}`);

		// Ensure Materio is explicitly included and verified
		const materioPath = join(libraryDir, "plugins", "materio");
		ok(packagePaths.includes(materioPath), "library/plugins/materio must be among verified packages");

		for (const pkgPath of packagePaths) {
			const res = validateLibraryPackage(pkgPath);
			ok(
				res.valid,
				`curated package at '${pkgPath}' must be valid. Diagnostics: ${JSON.stringify(res.validation.diagnostics)}`,
			);
			ok(res.manifestValid, `manifest for '${pkgPath}' must be valid`);
			ok(res.validation.contentValid, `content for '${pkgPath}' must be valid`);
			equal(
				res.validation.diagnostics.length,
				0,
				`curated package '${pkgPath}' should have zero diagnostics, got: ${JSON.stringify(res.validation.diagnostics)}`,
			);
		}
	});

	it("authoring templates are strictly excluded from generated registries", () => {
		// Verify library/registry.yaml
		const libraryRegistryPath = join(REPO_ROOT, "library", "registry.yaml");
		ok(existsSync(libraryRegistryPath), "library/registry.yaml must exist");
		const libraryRegistryContent = readFileSync(libraryRegistryPath, "utf8");
		const libraryRegistry = parseYaml(libraryRegistryContent) as {
			entries: Array<{ name: string; sourceUrl: string }>;
		};

		equal(libraryRegistry.entries.length, 34, "library registry must contain exactly 34 packages");

		// None of the entries should reference _authoring or templates
		for (const entry of libraryRegistry.entries) {
			ok(
				!entry.sourceUrl.includes("_authoring") && !entry.sourceUrl.includes("templates"),
				`entry '${entry.name}' has unexpected sourceUrl '${entry.sourceUrl}'`,
			);
			ok(
				![
					"citation-check",
					"scientific-eval",
					"benchmark-scout",
					"pipeline-review",
					"paper-summary",
					"data-curation",
				].includes(entry.name),
				`authoring template '${entry.name}' found in library registry`,
			);
		}

		// Verify library/skills/registry.yaml
		const skillsRegistryPath = join(REPO_ROOT, "library", "skills", "registry.yaml");
		ok(existsSync(skillsRegistryPath), "library/skills/registry.yaml must exist");
		const skillsRegistryContent = readFileSync(skillsRegistryPath, "utf8");
		const skillsRegistry = parseYaml(skillsRegistryContent) as {
			skills: Array<{ name: string; path: string }>;
		};

		equal(skillsRegistry.skills.length, 33, "skills registry must contain exactly 33 skills");

		for (const skill of skillsRegistry.skills) {
			ok(
				!skill.path.includes("_authoring") && !skill.path.includes("templates"),
				`skill '${skill.name}' has unexpected path '${skill.path}'`,
			);
			ok(
				skill.name !== "citation-check" && skill.name !== "scientific-eval" && skill.name !== "dataset-curation",
				`authoring template skill '${skill.name}' found in skills registry`,
			);
		}
	});

	it("validation accepts a valid package whose component IDs intentionally differ from public runtime names", async () => {
		const env = await isolateClioEnv("val-divergent-ids-");
		try {
			const pkgDir = join(env.dir, "divergent-pkg");
			mkdirSync(join(pkgDir, "agents"), { recursive: true });
			mkdirSync(join(pkgDir, "prompts", "curate"), { recursive: true });
			mkdirSync(join(pkgDir, "fleets"), { recursive: true });
			mkdirSync(join(pkgDir, "skills", "validator-tool"), { recursive: true });
			mkdirSync(join(pkgDir, "assets"), { recursive: true });

			writeFileSync(join(pkgDir, "assets", "spec.json"), JSON.stringify({ schemaVersion: 1 }));

			writeFileSync(
				join(pkgDir, "skills", "validator-tool", "SKILL.md"),
				`---
name: schema-validator
description: Validate data against schemas.
---
# Schema Validator
Instructions for schema validation.
`,
			);

			writeFileSync(
				join(pkgDir, "agents", "worker.md"),
				`---
version: 1
name: data-worker
description: Inspects datasets and checks schemas.
tools:
  required: [read, context]
  optional: []
skills: [schema-validator]
audience: custom
category: science
capabilityClass: read-only
latencyClass: balanced
projectContextTier: bounded
budget: {toolCalls: 16, readReserve: 4, synthesis: true}
resultContract: {kind: scout-report}
tags: [curation, review]
---
Worker instructions.
`,
			);

			writeFileSync(
				join(pkgDir, "prompts", "curate", "inspect.md"),
				`---
description: Curate inspection prompt
---
Inspect dataset using $ARGUMENTS
`,
			);

			writeFileSync(
				join(pkgDir, "fleets", "workflow.md"),
				`---
version: 1
name: dataset-curation-workflow
description: Coordinates worker and built-in verifier.
steps:
  - id: inspect-step
    agent: worker
    scope: readonly
    dependencies: []
  - id: verify-step
    agent: verifier
    scope: readonly
    dependencies: [inspect-step]
maxWorkers: 2
onFailure: stop
---
Run curation on {{datasetPath}}.
`,
			);

			writeFileSync(
				join(pkgDir, "plugin.json"),
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
					name: "divergent-pkg",
					version: "1.0.0",
					description: "Valid package whose component IDs differ from runtime names",
					extensions: {
						"ai.iowarp.clio": {
							manifestVersion: 1,
							kind: "plugin",
							resources: {
								skills: "skills",
								agents: "agents",
								prompts: "prompts",
								fleets: "fleets",
							},
							components: [
								{
									kind: "resource",
									id: "spec-doc-id",
									path: "assets/spec.json",
								},
								{
									kind: "skill",
									id: "skill-comp-id",
									path: "skills/validator-tool/SKILL.md",
									requires: ["resource:spec-doc-id"],
								},
								{
									kind: "agent",
									id: "agent-comp-id",
									path: "agents/worker.md",
									requires: ["skill:skill-comp-id"],
								},
								{
									kind: "prompt",
									id: "prompt-comp-id",
									path: "prompts/curate/inspect.md",
									requires: ["agent:agent-comp-id"],
								},
								{
									kind: "fleet",
									id: "fleet-comp-id",
									path: "fleets/workflow.md",
									requires: ["agent:agent-comp-id"],
								},
							],
						},
					},
				}),
			);

			const res = validateLibraryPackage(pkgDir);
			ok(res.manifestValid, "manifest must be valid");
			ok(
				res.validation.contentValid,
				`content must be valid, got diagnostics: ${JSON.stringify(res.validation.diagnostics)}`,
			);
			ok(res.valid, "package must be valid overall");
			equal(res.validation.diagnostics.length, 0);

			// Check componentRef vs runtime name mapping
			const agentRec = res.validation.resources.find((r) => r.kind === "agent");
			ok(agentRec, "agent resource must be recorded");
			equal(agentRec.name, "worker"); // file-derived recipe ID
			equal(agentRec.componentRef, "agent:agent-comp-id");
			equal(agentRec.valid, true);

			const promptRec = res.validation.resources.find((r) => r.kind === "prompt");
			ok(promptRec, "prompt resource must be recorded");
			equal(promptRec.name, "curate:inspect"); // path-derived prompt command name
			equal(promptRec.componentRef, "prompt:prompt-comp-id");
			equal(promptRec.valid, true);

			const fleetRec = res.validation.resources.find((r) => r.kind === "fleet");
			ok(fleetRec, "fleet resource must be recorded");
			equal(fleetRec.name, "dataset-curation-workflow"); // contract.name
			equal(fleetRec.componentRef, "fleet:fleet-comp-id");
			equal(fleetRec.valid, true);

			const skillRec = res.validation.resources.find((r) => r.kind === "skill");
			ok(skillRec, "skill resource must be recorded");
			equal(skillRec.name, "schema-validator"); // skill.name
			equal(skillRec.componentRef, "skill:skill-comp-id");
			equal(skillRec.valid, true);

			const ancillaryRec = res.validation.resources.find((r) => r.kind === "resource");
			ok(ancillaryRec, "ancillary resource must be recorded");
			equal(ancillaryRec.name, "spec-doc-id");
			equal(ancillaryRec.componentRef, "resource:spec-doc-id");
			equal(ancillaryRec.valid, true);

			// Check prerequisites correctly identified verifier
			const prereqs = res.validation.prerequisites;
			equal(prereqs.length, 1);
			equal(prereqs[0]?.identifier, "verifier");

			// CLI validation exit code 0
			const cliCode = await runLibraryCommand(["validate", pkgDir, "--json"]);
			equal(cliCode, 0);
		} finally {
			env.restore();
		}
	});

	it("behavioral check for prompt-unavailable, malformed, and missing component diagnostics", async () => {
		const env = await isolateClioEnv("val-prompt-behavior-");
		try {
			const pkgDir = join(env.dir, "prompt-behavior-pkg");
			mkdirSync(join(pkgDir, "prompts"), { recursive: true });

			// Component file exists on disk but is ignored by runtime loader (.txt not .md)
			writeFileSync(join(pkgDir, "prompts", "ignored.txt"), "Not markdown content");

			writeFileSync(
				join(pkgDir, "plugin.json"),
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
					name: "prompt-behavior-pkg",
					version: "1.0.0",
					description: "Prompt behavioral check package",
					extensions: {
						"ai.iowarp.clio": {
							manifestVersion: 1,
							kind: "plugin",
							resources: { prompts: "prompts" },
							components: [
								{ kind: "prompt", id: "ignored-comp", path: "prompts/ignored.txt" },
								{ kind: "prompt", id: "unclosed-fm", path: "prompts/unclosed.md" },
								{ kind: "prompt", id: "escaping-ref", path: "prompts/escaping.md" },
							],
						},
					},
				}),
			);

			// Prompt with unclosed frontmatter: loader falls back to treating as plain markdown
			writeFileSync(
				join(pkgDir, "prompts", "unclosed.md"),
				`---
description: Unclosed frontmatter prompt
No closing delimiter here
Inspect data with $ARGUMENTS
`,
			);

			// Prompt with escaping path reference
			writeFileSync(
				join(pkgDir, "prompts", "escaping.md"),
				`---
description: Escaping reference prompt
---
Refer to \${pluginRoot}/../../outside.txt
`,
			);

			const res = validateLibraryPackage(pkgDir);
			equal(res.manifestValid, true);
			equal(res.valid, false);
			equal(res.validation.contentValid, false);

			// Omitted component produces ERR_COMPONENT diagnostic
			const componentDiags = res.validation.diagnostics.filter((d) => d.code === "ERR_COMPONENT");
			ok(componentDiags.length > 0, "must report ERR_COMPONENT for omitted component file");
			ok(componentDiags.some((d) => d.componentRef === "prompt:ignored-comp"));

			// Escaping/unavailable reference produces ERR_PROMPT diagnostic
			const promptDiags = res.validation.diagnostics.filter((d) => d.code === "ERR_PROMPT");
			ok(promptDiags.length > 0, "must report ERR_PROMPT for unavailable template");
			ok(promptDiags.some((d) => d.path?.includes("escaping.md")));

			// Unclosed frontmatter prompt was loaded into resources
			const unclosedRec = res.validation.resources.find((r) => r.path === "prompts/unclosed.md");
			ok(unclosedRec, "unclosed frontmatter prompt must be loaded as resource");
			equal(unclosedRec.componentRef, "prompt:unclosed-fm");

			// Escaping prompt was recorded as invalid resource
			const escapingRec = res.validation.resources.find((r) => r.path === "prompts/escaping.md");
			ok(escapingRec, "escaping prompt must be loaded as resource");
			equal(escapingRec.valid, false);

			const cliCode = await runLibraryCommand(["validate", pkgDir, "--json"]);
			equal(cliCode, 1);
		} finally {
			env.restore();
		}
	});
});
