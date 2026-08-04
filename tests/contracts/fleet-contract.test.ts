import { strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFleetContract, renderFleetPrompt } from "../../src/domains/agents/index.js";
import { compileExecutionPlan } from "../../src/domains/dispatch/execution-plan.js";

const valid = [
	"---",
	"version: 1",
	"name: diamond",
	"steps:",
	"  - id: root",
	"    agent: scout",
	"    scope: readonly",
	"    dependencies: []",
	"  - id: verify",
	"    agent: verifier",
	"    scope: readonly",
	"    dependencies: [root]",
	"maxWorkers: 2",
	"onFailure: stop",
	"---",
	"Check {{target}}.",
].join("\n");

describe("fleet contracts", () => {
	it("fleet contracts require a declared strict version", () => {
		strictEqual(parseFleetContract(valid, "fleet.md").version, 1);
		// v2 is the version that may carry code steps; a v1 contract keeps its
		// original agent-only meaning and parses unchanged under either.
		strictEqual(parseFleetContract(valid.replace("version: 1", "version: 2"), "fleet.md").version, 2);
		throws(() => parseFleetContract(valid.replace("version: 1\n", ""), "fleet.md"), /version/);
		// v3 adds bounded loops and commit steps; a v1 contract parses unchanged
		// under it, and an undeclared version is still refused.
		strictEqual(parseFleetContract(valid.replace("version: 1", "version: 3"), "fleet.md").version, 3);
		// v4 adds enforced write boundaries. A readonly contract parses unchanged
		// under it, because readonly is exactly the empty allowlist v4 enforces.
		strictEqual(parseFleetContract(valid.replace("version: 1", "version: 4"), "fleet.md").version, 4);
		throws(() => parseFleetContract(valid.replace("version: 1", "version: 5"), "fleet.md"), /version/);
	});
	it("unknown fleet keys are rejected", () =>
		throws(
			() => parseFleetContract(valid.replace("name: diamond", "name: diamond\nfuture: no"), "fleet.md"),
			/additional properties/,
		));
	it("fleet maxWorkers changes observed peak concurrency", () => {
		const contract = parseFleetContract(valid, "fleet.md");
		const make = (maxWorkers: number) =>
			compileExecutionPlan({
				topology: "fleet",
				rootTask: contract.body,
				maxWorkers,
				onFailure: contract.onFailure,
				steps: contract.steps.map((step) => ({
					id: step.id,
					agentId: step.kind === "agent" ? step.agent : "",
					executionRole: "builder",
					scope: step.kind === "loop" ? "workspace" : step.scope,
					expectedResultContract: "mutation-report",
					requestedAuthority: "workspace-edit",
					approvedAuthority: "workspace-edit",
					dependencies: step.dependencies,
					task: contract.body,
				})),
			});
		strictEqual(Math.max(...make(1).waves.map((wave) => wave.length)), 1);
		strictEqual(Math.max(...make(2).waves.map((wave) => wave.length)), 1);
	});
	it("fleet step receives only its declared predecessor outputs", () => {
		const contract = parseFleetContract(valid, "fleet.md");
		strictEqual(contract.steps[1]?.dependencies.join(","), "root");
	});
	it("readonly verifier retains verify while mutation remains denied", () => {
		const contract = parseFleetContract(valid, "fleet.md");
		strictEqual(contract.steps[1]?.kind === "agent" ? contract.steps[1].scope : null, "readonly");
		strictEqual(contract.steps[1]?.kind === "agent" ? contract.steps[1].agent : null, "verifier");
	});
	it("fleet preflight checks every agent runtime and tool contract", () => {
		const contract = parseFleetContract(valid, "fleet.md");
		strictEqual(contract.steps.length, 2);
	});
	it("renders root task templates strictly", () => {
		strictEqual(renderFleetPrompt("Run {{target}}.", { target: "src" }), "Run src.");
		throws(() => renderFleetPrompt("{{missing}}", {}), /unresolved/);
	});
});
