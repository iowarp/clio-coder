import { strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFleetContract, renderFleetPrompt } from "../../src/domains/agents/index.js";

describe("contracts/fleet contracts", () => {
	const valid = [
		"---",
		"name: review-and-fix",
		"description: Review and fix a target.",
		"steps:",
		"  - agent: verifier",
		"    scope: readonly",
		"  - agent: coder",
		"    scope: workspace",
		"maxWorkers: 2",
		"budgetUsd: 1.5",
		"onFailure: stop",
		"futureKey: ignored",
		"---",
		"Check {{target}} with {{tool}}.",
		"",
	].join("\n");

	it("parses typed front matter while ignoring unknown top-level keys", () => {
		const contract = parseFleetContract(valid, "/repo/.clio/fleets/review-and-fix.md");
		strictEqual(contract.name, "review-and-fix");
		strictEqual(contract.steps.length, 2);
		strictEqual(contract.steps[0]?.agent, "verifier");
		strictEqual(contract.steps[0]?.scope, "readonly");
		strictEqual(contract.maxWorkers, 2);
		strictEqual(contract.budgetUsd, 1.5);
		strictEqual(contract.onFailure, "stop");
	});

	it("rejects invalid step scopes and non-positive budgets", () => {
		throws(
			() =>
				parseFleetContract(
					["---", "name: invalid-scope", "steps:", "  - agent: coder", "    scope: confirmed", "---", "Body."].join("\n"),
					"/repo/.clio/fleets/invalid-scope.md",
				),
			/scope.*must be equal to constant/,
		);
		throws(
			() =>
				parseFleetContract(
					["---", "name: zero-budget", "steps:", "  - agent: coder", "budgetUsd: 0", "---", "Body."].join("\n"),
					"/repo/.clio/fleets/zero-budget.md",
				),
			/budgetUsd must be a positive number/,
		);
	});

	it("renders prompt templates strictly", () => {
		strictEqual(
			renderFleetPrompt("Run {{target}} with {{tool}}.", { target: "src", tool: "build" }),
			"Run src with build.",
		);
		throws(
			() => renderFleetPrompt("Run {{target}} and {{missing}}.", { target: "src" }),
			/unresolved template variables: missing/,
		);
	});
});
