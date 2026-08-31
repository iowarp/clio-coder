/**
 * A fleet node states its own result contract.
 *
 * The regression these pin is the one that made `build-review` and
 * `build-test` unresolvable by construction: the plan compiler handed the same
 * rendered body to every agent node, the body ended in the builder's "Answer
 * with your `mutation-report`", and the loop's check node was dispatched under
 * `verifier-report`. The verifier obeyed the instruction it was given and the
 * gate refused the answer against the schema that instruction never mentioned,
 * so every review cycle ended in `review gate produced no structured verdict`
 * and every run in `loop_bound_exhausted`.
 */

import { ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type FleetContract, parseFleetContract } from "../../src/domains/agents/index.js";
import { resultContractShape } from "../../src/domains/agents/result-contract.js";
import { fleetNodeAnswerDirective } from "../../src/domains/dispatch/fleet-node-prompt.js";
import { compileFleetExecutionPlan } from "../../src/domains/dispatch/fleet-plan.js";

const FLEETS_DIR = new URL("../../src/domains/agents/fleets/", import.meta.url);

const VERIFIER_SHAPE = resultContractShape({ kind: "verifier-report" });
const MUTATION_SHAPE = resultContractShape({ kind: "mutation-report" });

function builtin(name: string): FleetContract {
	const path = fileURLToPath(new URL(`${name}.md`, FLEETS_DIR));
	return parseFleetContract(readFileSync(path, "utf8"), path);
}

/**
 * The resolution the shipping callers make: a loop's check node is a reviewer
 * gate position and answers `verifier-report` whatever its recipe declares,
 * every other agent node answers its recipe's contract.
 */
function planOf(contract: FleetContract, task: string) {
	return compileFleetExecutionPlan({
		contract,
		task,
		resolveAgent: (context) => ({
			requestedAuthority: context.scope === "readonly" ? "read-only" : "workspace-edit",
			approvedAuthority: context.scope === "readonly" ? "read-only" : "workspace-edit",
			expectedResultContract: context.gateRole === "reviewer" ? "verifier-report" : "mutation-report",
			executionRole: context.gateRole === "reviewer" ? "reviewer" : context.attempt > 0 ? "recovery" : "builder",
		}),
	});
}

function taskOf(contract: FleetContract, stepId: string, task = "Add a subtract(a, b) function to sum.py."): string {
	const step = planOf(contract, task).steps.find((candidate) => candidate.id === stepId);
	ok(step !== undefined, `step '${stepId}' is missing from the compiled plan`);
	ok(step.kind === "agent", `step '${stepId}' is not an agent node`);
	return step.task;
}

describe("fleet check node prompt", () => {
	it("states the verifier contract and not the builder's answer instruction", () => {
		let checked = 0;
		for (const name of ["build-review", "build-test", "sdlc"]) {
			const contract = builtin(name);
			for (const step of contract.steps) {
				if (step.kind !== "loop" || step.check.kind !== "agent") continue;
				checked += 1;
				const id = `${step.id}.check.1`;
				const task = taskOf(contract, id);
				ok(task.includes(VERIFIER_SHAPE), `${name}/${id} does not state its own verifier shape:\n${task}`);
				ok(!task.includes(MUTATION_SHAPE), `${name}/${id} states the builder's mutation-report shape:\n${task}`);
				ok(
					!/answer with your `?[a-z-]*report`?/iu.test(task),
					`${name}/${id} carries another step's answer instruction:\n${task}`,
				);
			}
		}
		ok(checked >= 2, `expected the shipped agent-checked loops to be covered, saw ${checked}`);
	});

	it("never asks a check node for the commitMessage its contract has no field for", () => {
		// `sdlc` is excluded on purpose: its body scopes the ask to the agents
		// that produce a work product, which the verifier is not. The two fleets
		// here carried it unscoped, as the last line every node read.
		for (const name of ["build-review", "build-test"]) {
			const contract = builtin(name);
			for (const step of contract.steps) {
				if (step.kind !== "loop" || step.check.kind !== "agent") continue;
				const id = `${step.id}.check.1`;
				const task = taskOf(contract, id);
				ok(!/\bcommitMessage\b/u.test(task), `${name}/${id} is asked for commitMessage:\n${task}`);
			}
		}
	});

	it("gives the builder and its repairs the contract they are validated against", () => {
		const contract = builtin("build-review");
		for (const stepId of ["build", "review.repair.1"]) {
			const task = taskOf(contract, stepId);
			ok(task.includes(MUTATION_SHAPE), `${stepId} does not state its own mutation-report shape:\n${task}`);
			ok(!task.includes(VERIFIER_SHAPE), `${stepId} states the reviewer's verifier shape:\n${task}`);
		}
	});

	it("keeps the rendered body every node shares", () => {
		const contract = builtin("build-review");
		const task = "Add a subtract(a, b) function to sum.py.";
		const plan = planOf(contract, task);
		strictEqual(plan.rootTask, task);
		for (const step of plan.steps) {
			if (step.kind !== "agent") continue;
			ok(step.task.startsWith(task), `${step.id} lost the shared body:\n${step.task}`);
		}
	});

	it("leaves no contract-naming answer instruction in a shipped body", () => {
		for (const name of ["build-review", "build-test", "sdlc"]) {
			const body = builtin(name).body;
			ok(
				!/answer with your `?(mutation|verifier|scout|research|debugger)-report`?/iu.test(body),
				`${name} body names one node's result contract for every node to read`,
			);
		}
	});

	it("declines to invent the shape a kind alone does not fix", () => {
		// `architect-plan` names the path it must write and the compiler holds only
		// the kind, so the recipe keeps sole authority rather than being handed a
		// wire example with a path invented for it.
		strictEqual(fleetNodeAnswerDirective("architect-plan"), null);
		const directive = fleetNodeAnswerDirective("verifier-report");
		ok(directive !== null);
		ok(directive.includes("`verifier-report`"), directive);
		ok(directive.includes(VERIFIER_SHAPE), directive);
	});
});
