import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { renderAgentCatalog } from "../../src/domains/agents/catalog.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { parseAgentRecipeSchema } from "../../src/domains/agents/recipe-schema.js";
import type { AgentRecipeDiagnostic } from "../../src/domains/agents/registry.js";
import { loadRecipesFromDir } from "../../src/domains/agents/registry.js";
import { agentSpecFingerprint, normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import { assertAgentIdNamespace } from "../../src/domains/config/agent-namespace.js";
import { routePriorForLatencyClass } from "../../src/domains/dispatch/route-policy.js";

function frontmatter(lines: ReadonlyArray<string>): string {
	return ["---", ...lines, "---", "", "# Persona", "Work strictly."].join("\n");
}

function validLines(): string[] {
	return [
		"version: 1",
		"name: Custom",
		"description: A strict custom recipe.",
		"tools: {required: [read], optional: []}",
		"skills: []",
		"audience: custom",
		"category: explore",
		"capabilityClass: read-only",
		"latencyClass: fast",
		"projectContextTier: none",
		"budget: {toolCalls: 8, readReserve: 1, synthesis: true}",
		"resultContract: {kind: provenance-report}",
		"tags: [custom]",
	];
}

function fixtureRecipe(overrides: Partial<AgentRecipe> = {}): AgentRecipe {
	return {
		version: 1,
		id: "fixture",
		name: "Fixture",
		description: "Fixture recipe.",
		tools: ["read"],
		toolRequirements: { required: ["read"], optional: [] },
		skills: [],
		boundSkillPaths: [],
		audience: "custom",
		category: "explore",
		capabilityClass: "read-only",
		latencyClass: "fast",
		projectContextTier: "none",
		budget: { toolCalls: 8, readReserve: 1, synthesis: true },
		resultContract: { kind: "provenance-report" },
		tags: ["fixture"],
		source: "project",
		filepath: "/tmp/fixture.md",
		body: "# Fixture",
		...overrides,
	};
}

describe("contracts/agent recipe schema", () => {
	it("builtins satisfy the only supported recipe version", () => {
		const recipes = loadRecipesFromDir({
			dir: join(resolvePackageRoot(), "src", "domains", "agents", "builtins"),
			source: "builtin",
		});
		ok(recipes.length > 0);
		for (const recipe of recipes) strictEqual(recipe.version, 1);
	});

	it("unknown keys fail builtins and quarantine custom recipes", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-strict-recipe-"));
		try {
			writeFileSync(join(dir, "broken.md"), frontmatter([...validLines(), "model: forbidden"]));
			throws(() => loadRecipesFromDir({ dir, source: "builtin" }), /unknown key 'model'/);
			const diagnostics: AgentRecipeDiagnostic[] = [];
			deepStrictEqual(loadRecipesFromDir({ dir, source: "project" }, diagnostics), []);
			strictEqual(diagnostics.length, 1);
			match(diagnostics[0]?.message ?? "", /unknown key 'model'/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("arrays reject non-string members without coercion", () => {
		const source = { id: "custom", source: "project" as const, filepath: "/tmp/custom.md", body: "# Custom" };
		throws(
			() =>
				parseAgentRecipeSchema({
					...source,
					frontmatter: {
						version: 1,
						name: "Custom",
						description: "Custom.",
						tools: { required: ["read"], optional: [] },
						skills: [1],
						audience: "custom",
						category: "explore",
						capabilityClass: "read-only",
						latencyClass: "fast",
						projectContextTier: "none",
						budget: { toolCalls: 8, readReserve: 1, synthesis: true },
						resultContract: { kind: "provenance-report" },
						tags: [],
					},
				}),
			/must be a non-empty string/,
		);
	});

	it("removed routing hints are rejected", () => {
		for (const hint of ["model", "target", "provider", "runtime", "thinkingLevel", "output"]) {
			const frontmatter = Object.fromEntries(
				validLines()
					.map((line) => line.split(/:\s+/, 2))
					.map(([key, value]) => [key, value]),
			);
			frontmatter[hint] = "legacy";
			throws(
				() =>
					parseAgentRecipeSchema({
						id: "custom",
						source: "project",
						filepath: "/tmp/custom.md",
						body: "# Custom",
						frontmatter,
					}),
				/unknown key/,
			);
		}
	});

	it("quarantined recipes are absent from catalog prompt and dispatch", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-quarantine-"));
		try {
			writeFileSync(join(dir, "bad.md"), frontmatter([...validLines(), "target: local"]));
			const diagnostics: AgentRecipeDiagnostic[] = [];
			const recipes = loadRecipesFromDir({ dir, source: "project" }, diagnostics);
			strictEqual(recipes.length, 0);
			strictEqual(renderAgentCatalog(recipes).includes("bad"), false);
			strictEqual(diagnostics.length, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("native and ACP ids cannot collide", () => {
		throws(
			() => assertAgentIdNamespace([fixtureRecipe({ id: "shared" })], [{ id: "shared" }]),
			/native recipe 'shared'.*ACP delegation agent 'shared'/,
		);
	});

	it("missing bound skills fail discovery", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-bound-skill-"));
		try {
			writeFileSync(
				join(dir, "needs-skill.md"),
				frontmatter(validLines().map((line) => (line === "skills: []" ? "skills: [surely-missing-skill]" : line))),
			);
			const diagnostics: AgentRecipeDiagnostic[] = [];
			deepStrictEqual(loadRecipesFromDir({ dir, source: "project" }, diagnostics), []);
			match(diagnostics[0]?.message ?? "", /bound skill\(s\) unavailable/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("display metadata leaves the spec fingerprint unchanged", () => {
		const original = agentSpecFingerprint(normalizeAgentSpec(fixtureRecipe()));
		const displayOnly = agentSpecFingerprint(
			normalizeAgentSpec(
				fixtureRecipe({ name: "Renamed", description: "Changed display text.", category: "operations", tags: ["other"] }),
			),
		);
		strictEqual(displayOnly, original);
	});

	it("latency prior and result contract change the spec fingerprint", () => {
		const original = agentSpecFingerprint(normalizeAgentSpec(fixtureRecipe()));
		const latency = agentSpecFingerprint(normalizeAgentSpec(fixtureRecipe({ latencyClass: "deep" })));
		const contract = agentSpecFingerprint(
			normalizeAgentSpec(fixtureRecipe({ resultContract: { kind: "scout-report" } })),
		);
		strictEqual(latency === original, false);
		strictEqual(contract === original, false);
	});

	it("fast balanced and deep priors are monotonic before measurements", () => {
		const fast = routePriorForLatencyClass("fast").expectedEndToEndMs;
		const balanced = routePriorForLatencyClass("balanced").expectedEndToEndMs;
		const deep = routePriorForLatencyClass("deep").expectedEndToEndMs;
		ok(fast < balanced && balanced < deep);
	});
});
