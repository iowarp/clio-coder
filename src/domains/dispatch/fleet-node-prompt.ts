/**
 * What one fleet node is told about its own answer.
 *
 * A playbook renders a single prompt body and the plan compiler gives it
 * to every agent node, because the body describes the whole chain and each node
 * does one part of it. That is fine for the work description and wrong for the
 * answer: nodes in the same chain hold different result contracts, so a body
 * that names one contract names the wrong one for every other node. A loop's
 * check node is where the mismatch is fatal rather than merely untidy. It is
 * dispatched with `verifier-report` as its expected contract, and in
 * `build-review` and `build-test` it received a body ending in "Answer with
 * your `mutation-report`". The verifier complied with the instruction it was
 * given, the gate held it to the schema that instruction never mentioned, and
 * both were behaving correctly: every review cycle in those two fleets ended in
 * `review gate produced no structured verdict` and the bounded revise loop was
 * unresolvable by construction.
 *
 * So each node states its own contract, appended to the shared body, and the
 * precedence line settles the conflict explicitly rather than leaving it to the
 * model to guess which of two shapes the run will actually validate. This is
 * the same remedy `COUNCIL_VOTE_MEMBER_DIRECTIVE` applies to a voting council
 * member, for the same reason and with the same shape of failure behind it
 * (#230): a run whose postcondition differs from the shape its prompt names
 * fails on every input, not intermittently.
 *
 * The shape itself is quoted from `resultContractShape`, the one place a
 * contract's wire example is written, so this directive cannot drift from the
 * validator that judges the answer.
 */

import { type ResultContract, resultContractShape } from "../agents/result-contract.js";

/**
 * The answer directive for a node holding this contract, or null when the kind
 * alone does not fix the shape.
 *
 * `architect-plan` names the path it must write, and a plan compiler resolving
 * agents holds only the contract's kind. Inventing a path to render would state
 * a location the validator does not check, so that kind gets no directive and
 * its recipe keeps sole authority over the shape. Every other kind is fully
 * determined by its kind and can be quoted exactly.
 */
function fleetNodeAnswerDirective(kind: ResultContract["kind"]): string | null {
	if (kind === "architect-plan") return null;
	return [
		`Your result contract for this step is \`${kind}\`.`,
		"The task above describes the whole chain. Any result shape it states belongs to the step that produces it, and does not apply to you.",
		`End with exactly this shape and nothing else: ${resultContractShape({ kind })}`,
		// The wire example carries literal names and evidence, and a small model
		// handed one on a first attempt copies them: the first run of this
		// directive came back claiming `npm run typecheck` / `exit 0` in the same
		// breath as admitting it could not run a command. The fields are the
		// contract; the values in the example are not.
		"Its field values are an example. Fill them with what this run actually produced or observed, and never report a name or evidence you did not.",
	].join("\n");
}

/**
 * The shared body, the node's own step and its answer directive. The body tells every node to do only the step it was
 * given, so it has to name that step: left to the persona, a documenter read "the documentation step" as someone else's
 * job, and a verifier and a coder took up the plan.
 */
/**
 * The operator's own task inside a rendered plan-step task: what the step was asked to do, without the chain
 * directive Clio appended for the worker's model. Surfaces that word a run's task read this, so the step instructions
 * stay in the prompt and the record. A task without the directive comes back as it was.
 */
export function fleetNodeTaskBrief(task: string): string {
	const at = task.search(/\s+Your step in this chain is `[^`]*`\. Do that step now\./u);
	return at > 0 ? task.slice(0, at).trimEnd() : task;
}

export function renderFleetNodeTask(task: string, kind: ResultContract["kind"], stepId: string): string {
	const step = `Your step in this chain is \`${stepId}\`. Do that step now. Earlier steps are finished and later ones belong to other workers.`;
	const directive = fleetNodeAnswerDirective(kind);
	return [task, step, ...(directive === null ? [] : [directive])].join("\n\n");
}
