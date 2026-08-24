import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { renderAgentCatalog } from "../../src/domains/agents/catalog.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { loadRecipesFromDir, mergeRecipes } from "../../src/domains/agents/registry.js";
import {
	agentSpecPolicyErrors,
	normalizeAgentSpec,
	resolveAgentToolCompatibility,
} from "../../src/domains/agents/spec.js";

function recipe(overrides: Partial<AgentRecipe> = {}): AgentRecipe {
	return {
		version: 1,
		id: "helper",
		name: "Helper",
		description: "Strict test helper.",
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
		tags: [],
		source: "project",
		filepath: "/tmp/helper.md",
		body: "# Helper",
		...overrides,
	};
}

describe("contracts/agents", () => {
	it("loads shipped recipes as explicit strict specs", () => {
		const builtinDir = join(resolvePackageRoot(), "src", "domains", "agents", "builtins");
		const recipes = loadRecipesFromDir({ dir: builtinDir, source: "builtin" });
		strictEqual(recipes.length, 13);
		for (const entry of recipes) {
			strictEqual(entry.version, 1);
			ok(entry.body.trim().length > 0);
			ok(entry.resultContract);
			strictEqual(agentSpecPolicyErrors(normalizeAgentSpec(entry)).join("\n"), "");
		}
		const architect = recipes.find((entry) => entry.id === "architect");
		deepStrictEqual(architect?.resultContract, {
			kind: "architect-plan",
			path: ".clio-coder/artifacts/PLAN.md",
		});
		strictEqual(architect?.boundSkillPaths[0]?.endsWith("skills/workflow/cut-it/SKILL.md"), true);
		const documenter = recipes.find((entry) => entry.id === "documenter");
		strictEqual(documenter?.audience, "base");
		deepStrictEqual(documenter?.resultContract, { kind: "mutation-report" });
		// A wiki page's postcondition is the file it left on disk, which only the
		// caller that named the output location can check. Asking this writer for
		// a typed report is what made a small model fabricate one.
		const wikiWriter = recipes.find((entry) => entry.id === "wiki-writer");
		deepStrictEqual(wikiWriter?.resultContract, { kind: "artifact-report" });
		// `clio-coder context init` needs a JSON handbook, and a recipe's result
		// contract is enforced in the worker and sealed by the orchestrator. When
		// bootstrap rode on Scout, every model that obeyed its recipe returned
		// reconnaissance findings and the handbook parser rejected the run. The
		// two agents must therefore keep two different contracts.
		const bootstrap = recipes.find((entry) => entry.id === "context-bootstrap");
		strictEqual(bootstrap?.audience, "internal");
		deepStrictEqual(bootstrap?.resultContract, { kind: "context-handbook" });
		const scout = recipes.find((entry) => entry.id === "scout");
		deepStrictEqual(scout?.resultContract, { kind: "scout-report" });
		const gitMaster = recipes.find((entry) => entry.id === "git-master");
		strictEqual(gitMaster?.audience, "base");
		strictEqual(gitMaster?.capabilityClass, "workspace-edit");
		deepStrictEqual(gitMaster?.resultContract, { kind: "mutation-report" });
		strictEqual(
			gitMaster?.boundSkillPaths.some((path) => path.endsWith("skills/git/ship/SKILL.md")),
			true,
		);
		const coder = recipes.find((entry) => entry.id === "coder");
		deepStrictEqual(coder?.skills, ["fix-issue", "ship"]);
	});

	it("keeps display metadata visible while policy reads hard semantics", () => {
		const catalog = renderAgentCatalog([
			recipe({ name: "Display Name", description: "Display-only description.", tags: ["display"] }),
		]);
		match(catalog, /Display Name/);
		match(catalog, /tags=display/);
		const spec = normalizeAgentSpec(
			recipe({ tools: ["read", "edit"], toolRequirements: { required: ["read"], optional: ["edit"] } }),
		);
		deepStrictEqual(resolveAgentToolCompatibility(spec, [ToolNames.Read], { mediatesDispatch: false }), {
			compatible: true,
			missingRequired: [],
			lostOptional: [ToolNames.Edit],
		});
	});

	it("does not permit bound skills without the required context tool", () => {
		const spec = normalizeAgentSpec(recipe({ skills: ["cut-it"] }));
		match(agentSpecPolicyErrors(spec).join("\n"), /must require context for bound skills/);
	});

	it("preserves native recipe precedence over project overrides", () => {
		const builtin = recipe({ id: "coder", source: "builtin", filepath: "/pkg/coder.md" });
		const project = recipe({ id: "coder", source: "project", filepath: "/repo/.clio-coder/agents/coder.md" });
		const merged = mergeRecipes([builtin], [project]);
		strictEqual(merged[0]?.filepath, "/pkg/coder.md");
	});
});
