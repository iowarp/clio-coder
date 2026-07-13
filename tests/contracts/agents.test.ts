import { deepStrictEqual, doesNotMatch, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { renderAgentCatalog, renderAgentCatalogSectionsFromSpecs } from "../../src/domains/agents/catalog.js";
import { loadRecipesFromDir, mergeRecipes } from "../../src/domains/agents/registry.js";
import { agentSpecPolicyErrors, isUserVisibleAgent, normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import { SPOT_CHECK_GUIDANCE, workerTextLabel } from "../../src/tools/worker-evidence.js";

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
					"tools: [read, grep, find, ls, context]",
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
				tools: ["read", "verify"],
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
		match(catalog, /verifier \(base, quality, verification, fast, builtin, tags=tests, budget=operator-default\)/);
		match(catalog, /Shadow agents for internal orchestration:/);
		match(catalog, /scout \(shadow, explore, read-only, fast, builtin, budget=operator-default\)/);
		// Recipe selection weighs skill fit: the catalog says to prefer a recipe
		// whose bound skill matches the task.
		match(catalog, /prefer the recipe that binds it/);
		// Delegated evidence stays qualified: the sealed receipt is the evidence
		// and worker prose is an advisory claim, never bare "evidence".
		match(catalog, /synthesize from the sealed receipt/);
		match(catalog, /advisory claim until its verification state is verified/);
		doesNotMatch(catalog, /use that receipt\/output as evidence/);
		// The spot-check sentence is byte-exact with the one dispatch renders
		// head-anchored in its summary (worker-evidence.ts).
		ok(catalog.includes(SPOT_CHECK_GUIDANCE));
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
				projectContextTier: "none",
				audience: "custom",
				tags: ["delegation", "acp"],
				skills: [],
				output: null,
				budget: null,
				body: "",
			},
		]);

		match(sections.stable, /User-facing agents:/);
		match(
			sections.stable,
			/claude-cli \(custom, explore, orchestration, deep, custom, tags=delegation\/acp, budget=operator-default\)/,
		);
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

	it("requires context when a recipe declares agent-bound skills", () => {
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
		match(errors[0] ?? "", /declares skills but does not expose context/);
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

	it("loads the exact shipped Scout and Coder budget profiles", () => {
		const builtinDir = join(resolvePackageRoot(), "src", "domains", "agents", "builtins");
		const recipes = loadRecipesFromDir({ dir: builtinDir, source: "builtin" });
		deepStrictEqual(recipes.find((recipe) => recipe.id === "scout")?.budget, {
			toolCalls: 18,
			readReserve: 4,
			synthesis: true,
		});
		deepStrictEqual(recipes.find((recipe) => recipe.id === "coder")?.budget, {
			toolCalls: 50,
			readReserve: 5,
			synthesis: true,
		});
	});

	it("normalizes valid user and project budgets identically and preserves an absent budget", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-agent-budget-"));
		try {
			writeFileSync(
				join(dir, "bounded.md"),
				[
					"---",
					"name: Bounded",
					"budget:",
					"  toolCalls: 18",
					"  readReserve: 4",
					"  synthesis: true",
					"---",
					"Bounded agent.",
				].join("\n"),
			);
			const userRecipe = loadRecipesFromDir({ dir, source: "user" })[0];
			const projectRecipe = loadRecipesFromDir({ dir, source: "project" })[0];
			ok(userRecipe);
			ok(projectRecipe);
			const user = normalizeAgentSpec(userRecipe);
			const project = normalizeAgentSpec(projectRecipe);
			deepStrictEqual(user.budget, { toolCalls: 18, readReserve: 4, synthesis: true });
			deepStrictEqual(project.budget, user.budget);
			strictEqual(
				normalizeAgentSpec({
					id: "legacy",
					name: "Legacy",
					description: "No declared budget.",
					source: "user",
					filepath: "/tmp/legacy.md",
					body: "Legacy agent.",
				}).budget,
				null,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects every malformed budget with a source-qualified property error", () => {
		const invalid: ReadonlyArray<{ yaml: ReadonlyArray<string>; property: string }> = [
			{ yaml: ["budget: null"], property: "budget" },
			{ yaml: ["budget: 18"], property: "budget" },
			{ yaml: ["budget: [18, 4, true]"], property: "budget" },
			{ yaml: ["budget: {toolCalls: 18, readReserve: 4}"], property: "budget.synthesis" },
			{
				yaml: ["budget: {toolCalls: 18, readReserve: 4, synthesis: true, extra: 1}"],
				property: "budget.extra",
			},
			{ yaml: ["budget: {toolCalls: '18', readReserve: 4, synthesis: true}"], property: "budget.toolCalls" },
			{ yaml: ["budget: {toolCalls: 18.5, readReserve: 4, synthesis: true}"], property: "budget.toolCalls" },
			{ yaml: ["budget: {toolCalls: 0, readReserve: 0, synthesis: true}"], property: "budget.toolCalls" },
			{ yaml: ["budget: {toolCalls: -1, readReserve: 0, synthesis: true}"], property: "budget.toolCalls" },
			{
				yaml: ["budget: {toolCalls: 9007199254740992, readReserve: 4, synthesis: true}"],
				property: "budget.toolCalls",
			},
			{ yaml: ["budget: {toolCalls: 18, readReserve: '4', synthesis: true}"], property: "budget.readReserve" },
			{ yaml: ["budget: {toolCalls: 18, readReserve: 4.5, synthesis: true}"], property: "budget.readReserve" },
			{ yaml: ["budget: {toolCalls: 18, readReserve: -1, synthesis: true}"], property: "budget.readReserve" },
			{ yaml: ["budget: {toolCalls: 18, readReserve: 18, synthesis: true}"], property: "budget.readReserve" },
			{ yaml: ["budget: {toolCalls: 18, readReserve: 19, synthesis: true}"], property: "budget.readReserve" },
			{ yaml: ["budget: {toolCalls: 18, readReserve: 4, synthesis: 'true'}"], property: "budget.synthesis" },
		];

		for (const [index, testCase] of invalid.entries()) {
			const dir = mkdtempSync(join(tmpdir(), "clio-agent-budget-invalid-"));
			const filepath = join(dir, `invalid-${index}.md`);
			try {
				writeFileSync(filepath, ["---", "name: Invalid", ...testCase.yaml, "---", "Invalid."].join("\n"));
				throws(
					() => loadRecipesFromDir({ dir, source: "project" }),
					(error: unknown) =>
						error instanceof Error && error.message.includes(filepath) && error.message.includes(testCase.property),
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("renders deterministic declared and operator-default budget metadata", () => {
		const catalog = renderAgentCatalog([
			{
				id: "bounded",
				name: "Bounded",
				description: "Bounded agent.",
				budget: { toolCalls: 18, readReserve: 4, synthesis: true },
				source: "user",
				filepath: "/tmp/bounded.md",
				body: "Bounded.",
			},
			{
				id: "legacy",
				name: "Legacy",
				description: "Default policy.",
				source: "user",
				filepath: "/tmp/legacy.md",
				body: "Legacy.",
			},
		]);
		match(catalog, /bounded .*budget=18\/4\/synthesize/);
		match(catalog, /legacy .*budget=operator-default/);
		strictEqual(
			catalog,
			renderAgentCatalog([
				{
					id: "legacy",
					name: "Legacy",
					description: "Default policy.",
					source: "user",
					filepath: "/tmp/legacy.md",
					body: "Legacy.",
				},
				{
					id: "bounded",
					name: "Bounded",
					description: "Bounded agent.",
					budget: { toolCalls: 18, readReserve: 4, synthesis: true },
					source: "user",
					filepath: "/tmp/bounded.md",
					body: "Bounded.",
				},
			]),
		);
	});

	it("gives Scout the exact bounded split-recommendation protocol", () => {
		const builtinDir = join(resolvePackageRoot(), "src", "domains", "agents", "builtins");
		const scout = loadRecipesFromDir({ dir: builtinDir, source: "builtin" }).find((recipe) => recipe.id === "scout");
		ok(scout, "shipped Scout recipe is missing");
		const protocol = [
			"When and only when the task cannot be grounded within budget or spans multiple independent domains, emit as the first non-empty lines of the final message:",
			"`SPLIT RECOMMENDATION: <one-line rationale, 1..200 bytes>`",
			"`- <scoped subtask with entry file(s), 1..120 bytes>`",
			"Use 1..4 contiguous bullet lines and keep the whole block within the first 800 bytes (all limits UTF-8).",
		].join("\n");
		ok(scout.body.includes(protocol), scout.body);
		strictEqual(scout.body.match(/SPLIT RECOMMENDATION/g)?.length, 1);
	});

	it("requires Scout to ground reconnaissance in live reads", () => {
		const builtinDir = join(resolvePackageRoot(), "src", "domains", "agents", "builtins");
		const scout = loadRecipesFromDir({ dir: builtinDir, source: "builtin" }).find((recipe) => recipe.id === "scout");
		ok(scout, "shipped Scout recipe is missing");
		// Live grounding: source claims cite path:line from a read in this run.
		ok(
			scout.body.includes(
				"Ground every source claim you return in a live read from this run and cite its `path:line` location.",
			),
		);
		// Unverifiable leads are quarantined under an explicit heading, not asserted.
		ok(
			scout.body.includes(
				"Report leads you could not verify live under a final `Unresolved gaps:` heading instead of asserting them.",
			),
		);
		// Wiki/index content orients; it is never citable evidence.
		ok(
			scout.body.includes(
				"Treat wiki and index content as orientation only, never as evidence: confirm every lead in the current source before reporting it.",
			),
		);
		// The advertised label is byte-exact with the not_applicable header the
		// parent sees from dispatch/monitor (worker-evidence.ts).
		const reconLabel = workerTextLabel({ state: "not_applicable", basis: "read-only-agent" });
		ok(scout.body.includes(`\`${reconLabel}\``));
		// Recon prose is never advertised to the scout as bare "evidence".
		doesNotMatch(scout.body, /Return compact evidence/);
	});
});
