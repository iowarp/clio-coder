import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import { renderFleetPromptSection } from "../../src/domains/agents/catalog.js";
import { discoverAgentRecipes } from "../../src/domains/agents/registry.js";
import { validateResultContract } from "../../src/domains/agents/result-contract.js";
import { nodeResultContractFilesystem } from "../../src/domains/agents/result-contract-filesystem.js";
import { normalizeAgentSpec, resolveAgentToolCompatibility } from "../../src/domains/agents/spec.js";
import { classifyAgentTask } from "../../src/domains/dispatch/agent-candidates.js";
import {
	cloneRunToolBudgetEnvelope,
	formatEffectiveBudget,
	resolveToolBudgetEnvelope,
} from "../../src/domains/dispatch/budget-envelope.js";
import {
	assertWorkerBudgetEnforceable,
	budgetEnforcementForRuntime,
	effectiveWorkerAutonomy,
} from "../../src/domains/dispatch/extension.js";

function worldResult(discovery: "performed" | "caller-supplied-only" | "unavailable") {
	return JSON.stringify({
		discovery,
		facts: [
			{
				claim: "The current release documents the behavior.",
				evidence: "The release note names it explicitly.",
				sources: ["https://example.test/releases/current"],
			},
		],
		synthesis: ["Option A is the better fit under the stated constraint."],
		uncertainties: ["The deployment-specific limit was not published."],
		followUpVerification: ["Confirm the limit against the deployed version."],
	});
}

describe("world-knowledge agent contract", () => {
	it("is distinct from supplied-source research and repository reconnaissance", () => {
		const recipes = discoverAgentRecipes(process.cwd()).filter((recipe) => recipe.source === "builtin");
		const world = recipes.find((recipe) => recipe.id === "world-knowledge");
		const researcher = recipes.find((recipe) => recipe.id === "researcher");
		const scout = recipes.find((recipe) => recipe.id === "scout");
		ok(world);
		ok(researcher);
		ok(scout);
		equal(world.capabilityClass, "read-only");
		equal(world.resultContract.kind, "world-knowledge-report");
		equal(researcher.resultContract.kind, "research-report");
		equal(scout.resultContract.kind, "scout-report");
		ok(world.body.includes("current open-world discovery"));
		ok(researcher.body.includes("concrete source URLs"));
		ok(scout.body.includes("codebase"));
		match(renderFleetPromptSection(recipes.map(normalizeAgentSpec)), /current ecosystems.*world-knowledge/u);
		equal(
			classifyAgentTask("Survey the ecosystem landscape and give an advisory second opinion").taskType,
			"world_knowledge",
		);
		equal(classifyAgentTask("Research the supplied standards and paper URLs").taskType, "research");
	});

	it("has no mandatory Clio tool and remains compatible with native or opaque external execution", () => {
		const recipe = discoverAgentRecipes(process.cwd()).find((entry) => entry.id === "world-knowledge");
		ok(recipe);
		const spec = normalizeAgentSpec(recipe);
		deepStrictEqual(spec.toolRequirements.required, []);
		equal(resolveAgentToolCompatibility(spec, [], { mediatesDispatch: true }).compatible, true);
		equal(resolveAgentToolCompatibility(spec, ["read", "web_fetch"], { mediatesDispatch: true }).compatible, true);
		equal(effectiveWorkerAutonomy("full-auto", "full-auto", spec.capabilityClass), "read-only");
		equal(effectiveWorkerAutonomy("full-auto", "auto-edit", "workspace-edit"), "auto-edit");
	});

	it("separates supported facts, synthesis, uncertainty, and follow-up without inventing citations", () => {
		const base = {
			contract: { kind: "world-knowledge-report" } as const,
			cwd: process.cwd(),
			filesystem: nodeResultContractFilesystem(),
		};
		const valid = validateResultContract({ ...base, output: worldResult("performed"), networkAllowed: true });
		equal(valid.conformance, "pass");
		const denied = validateResultContract({ ...base, output: worldResult("performed"), networkAllowed: false });
		equal(denied.conformance, "fail");
		match(denied.reason ?? "", /no external-source posture/u);
		const unavailable = validateResultContract({
			...base,
			networkAllowed: false,
			output: JSON.stringify({
				discovery: "unavailable",
				facts: [],
				synthesis: [],
				uncertainties: ["Discovery/search was unavailable."],
				followUpVerification: ["Supply a concrete official URL."],
			}),
		});
		equal(unavailable.conformance, "pass");
	});

	it("preserves native per-tool enforcement and classifies opaque loops as external one-shot", () => {
		const input = {
			recipeId: "world-knowledge",
			policy: { toolCalls: 20, readReserve: 3, synthesis: true },
			hardCap: 50,
			hasReadTool: true,
			retry: false,
			revision: false,
		};
		const native = resolveToolBudgetEnvelope(input);
		equal(native.enforcement.classification, "native-per-tool");
		equal(native.enforcement.perTool, "enforced");
		match(formatEffectiveBudget(native), /native per-tool enforced/u);

		const externalLoop = {
			tools: "externally-governed-unobserved",
			network: "externally-governed-unobserved",
			budget: "external-one-shot",
			generatingRetry: "forbidden",
			modelCatalog: "live-authoritative",
		} as const;
		equal(budgetEnforcementForRuntime({ kind: "http" }), "native-per-tool");
		equal(budgetEnforcementForRuntime({ kind: "sdk" }), "native-per-tool");
		equal(budgetEnforcementForRuntime({ kind: "subprocess" }), "external-one-shot");
		assertWorkerBudgetEnforceable({ id: "antigravity-code", kind: "subprocess", externalAgentLoop: externalLoop }, true);
		assertWorkerBudgetEnforceable({ id: "claude-code", kind: "subprocess" }, false);
		throws(
			() => assertWorkerBudgetEnforceable({ id: "claude-code", kind: "subprocess" }, true),
			/cannot enforce an explicit dispatch budget/u,
		);

		const external = resolveToolBudgetEnvelope({ ...input, hasReadTool: false, enforcement: "external-one-shot" });
		equal(external.enforcement.classification, "external-one-shot");
		equal(external.enforcement.perTool, "unobserved-not-enforced");
		match(formatEffectiveBudget(external), /per-tool unobserved\/not enforced/u);
		const cloned = cloneRunToolBudgetEnvelope(JSON.parse(JSON.stringify(external)));
		deepStrictEqual(cloned, external);
		const serialized = JSON.parse(JSON.stringify(external)) as Record<string, unknown>;
		const enforcement = serialized.enforcement as Record<string, unknown>;
		equal(cloneRunToolBudgetEnvelope({ ...serialized, enforcement: { ...enforcement, perTool: "enforced" } }), undefined);
		equal(cloneRunToolBudgetEnvelope({ ...serialized, enforcement: { ...enforcement, clioControls: [] } }), undefined);
		equal(
			cloneRunToolBudgetEnvelope({
				...serialized,
				enforcement: {
					...enforcement,
					clioControls: ["single-launch", "single-launch", "output-cap", "cancellation", "result-contract"],
				},
			}),
			undefined,
		);
	});
});
