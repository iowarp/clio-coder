import { match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { renderAgentCatalog, renderAgentCatalogSectionsFromSpecs } from "../../src/domains/agents/catalog.js";
import { loadRecipesFromDir, mergeRecipes } from "../../src/domains/agents/registry.js";
import { agentSpecPolicyErrors, isUserVisibleAgent, normalizeAgentSpec } from "../../src/domains/agents/spec.js";

describe("contracts/agents", () => {
	it("loads recipe metadata into normalized agent specs", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-agents-"));
		try {
			writeFileSync(
				join(dir, "scientific-validator.md"),
				[
					"---",
					"name: Scientific Validator",
					"description: HPC artifact validation planner.",
					"tools: [read, grep, glob, ls, read_skill]",
					"audience: custom",
					"category: science",
					"capabilityClass: read-only",
					"latencyClass: deep",
					"tags: [hpc, artifacts]",
					"skills: [science-validation]",
					"---",
					"",
					"# Scientific Validator",
					"Validate scientific artifacts.",
				].join("\n"),
			);

			const recipe = loadRecipesFromDir({ dir, source: "project" })[0];
			ok(recipe);
			const spec = normalizeAgentSpec(recipe);
			strictEqual(spec.id, "scientific-validator");
			strictEqual(spec.category, "science");
			strictEqual(spec.capabilityClass, "read-only");
			strictEqual(spec.latencyClass, "deep");
			strictEqual(spec.audience, "custom");
			strictEqual(spec.tags.includes("hpc"), true);
			strictEqual(spec.skills.includes("science-validation"), true);
			strictEqual(agentSpecPolicyErrors(spec).length, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("flags capability declarations that contradict tool access", () => {
		const spec = normalizeAgentSpec({
			id: "bad-scout",
			name: "Bad Scout",
			description: "Invalid read-only recipe.",
			tools: ["read", "edit"],
			category: "explore",
			capabilityClass: "read-only",
			source: "project",
			filepath: "/tmp/bad-scout.md",
			body: "# Bad Scout",
		});

		const errors = agentSpecPolicyErrors(spec);
		strictEqual(errors.length, 1);
		match(errors[0] ?? "", /read-only agent 'bad-scout' requests write tools/);
	});

	it("renders catalog entries from normalized specs instead of raw role prose", () => {
		const catalog = renderAgentCatalog([
			{
				id: "verifier",
				name: "Verifier",
				description: "Run gates.",
				tools: ["read", "run_tests"],
				category: "quality",
				capabilityClass: "verification",
				latencyClass: "fast",
				audience: "base",
				tags: ["tests"],
				source: "builtin",
				filepath: "/tmp/verifier.md",
				body: "# Verifier",
			},
			{
				id: "scout",
				name: "Scout",
				description: "Map code.",
				tools: ["read", "grep"],
				category: "explore",
				capabilityClass: "read-only",
				latencyClass: "fast",
				audience: "shadow",
				source: "builtin",
				filepath: "/tmp/scout.md",
				body: "# Scout",
			},
		]);

		match(catalog, /normalized specs carry audience, category, capability/);
		match(catalog, /User-facing agents:/);
		match(catalog, /verifier \(base, quality, verification, fast, builtin, tags=tests\)/);
		match(catalog, /Shadow agents for internal orchestration:/);
		match(catalog, /scout \(shadow, explore, read-only, fast, builtin\)/);
	});

	it("includes config-synthesized delegation specs in the spec-based roster", () => {
		const sections = renderAgentCatalogSectionsFromSpecs([
			normalizeAgentSpec({
				id: "coder",
				name: "Coder",
				description: "Code.",
				source: "builtin",
				filepath: "/tmp/coder.md",
				body: "# Coder",
			}),
			{
				id: "claude-cli",
				name: "claude-cli",
				description: "External ACP delegation agent: claude --acp",
				source: "custom",
				filepath: "settings.yaml",
				tools: [],
				category: "explore",
				capabilityClass: "orchestration",
				latencyClass: "deep",
				audience: "custom",
				tags: ["delegation", "acp"],
				skills: [],
				output: null,
				body: "",
			},
		]);

		match(sections.stable, /User-facing agents:/);
		match(sections.stable, /claude-cli \(custom, explore, orchestration, deep, custom, tags=delegation\/acp\)/);
		match(sections.stable, /External ACP delegation agent/);
	});

	it("keeps shadow agents hidden from user-visible lists", () => {
		const visible = [
			{
				id: "coder",
				name: "Coder",
				description: "Code.",
				source: "builtin" as const,
				filepath: "/tmp/coder.md",
				body: "# Coder",
			},
			{
				id: "scout",
				name: "Scout",
				description: "Scout.",
				source: "builtin" as const,
				filepath: "/tmp/scout.md",
				body: "# Scout",
			},
		]
			.map(normalizeAgentSpec)
			.filter(isUserVisibleAgent)
			.map((spec) => spec.id);
		strictEqual(visible.join(","), "coder");
	});

	it("prevents user and project recipes from overriding reserved shipped agents", () => {
		const builtin = [
			{
				id: "scout",
				name: "Scout",
				description: "Shadow scout.",
				audience: "shadow" as const,
				source: "builtin" as const,
				filepath: "/pkg/scout.md",
				body: "# Scout",
			},
			{
				id: "coder",
				name: "Coder",
				description: "Base coder.",
				audience: "base" as const,
				source: "builtin" as const,
				filepath: "/pkg/coder.md",
				body: "# Coder",
			},
		];
		const user = [
			{
				id: "scout",
				name: "User Scout",
				description: "Should not override shadow.",
				source: "user" as const,
				filepath: "/user/scout.md",
				body: "# User Scout",
			},
			{
				id: "coder",
				name: "User Coder",
				description: "May customize base.",
				source: "user" as const,
				filepath: "/user/coder.md",
				body: "# User Coder",
			},
		];
		const project = [
			{
				id: "coder",
				name: "Project Coder",
				description: "Project must not override shipped ids.",
				source: "project" as const,
				filepath: "/repo/.clio/agents/coder.md",
				body: "# Project Coder",
			},
			{
				id: "domain-helper",
				name: "Domain Helper",
				description: "Project custom agent.",
				source: "project" as const,
				filepath: "/repo/.clio/agents/domain-helper.md",
				body: "# Domain Helper",
			},
		];
		const merged = mergeRecipes(builtin, user, project);
		strictEqual(merged.find((recipe) => recipe.id === "scout")?.name, "Scout");
		strictEqual(merged.find((recipe) => recipe.id === "coder")?.name, "User Coder");
		strictEqual(merged.find((recipe) => recipe.id === "domain-helper")?.source, "project");
	});

	it("requires read_skill when a recipe declares agent-bound skills", () => {
		const spec = normalizeAgentSpec({
			id: "skillful",
			name: "Skillful",
			description: "Invalid skill recipe.",
			tools: ["read"],
			skills: ["missing-tool"],
			category: "research",
			capabilityClass: "read-only",
			source: "project",
			filepath: "/tmp/skillful.md",
			body: "# Skillful",
		});
		const errors = agentSpecPolicyErrors(spec);
		strictEqual(errors.length, 1);
		match(errors[0] ?? "", /declares skills but does not expose read_skill/);
	});

	it("keeps shipped built-in recipes aligned with their declared capability class", () => {
		const builtinDir = join(resolvePackageRoot(), "src", "domains", "agents", "builtins");
		const recipes = loadRecipesFromDir({ dir: builtinDir, source: "builtin" });
		ok(recipes.length > 0);

		const failures = recipes.flatMap((recipe) => {
			const spec = normalizeAgentSpec(recipe);
			return agentSpecPolicyErrors(spec).map((error) => `${spec.id}: ${error}`);
		});
		strictEqual(failures.join("\n"), "");
	});
});
