/**
 * Capability/task mismatch, decided before a worker process exists.
 *
 * Observed live (receipt 1yd79n91i9b0): `verifier`, a read-only recipe, was
 * pinned to "fix the off-by-one bug in src/sum.ts". It ran to completion, made
 * six read calls, executed no shell command, and sealed `outcome: succeeded`
 * with a fabricated passing `npm run typecheck`. Nothing about that pairing
 * needed a run to discover: the recipe carries its capability class and the
 * task text carries its shape, and both are in hand at admission.
 *
 * Two verdicts, because neither the classifier nor the capability label is good
 * enough to be the only vote. `classifyAgentTask`'s rule list is ordered and
 * imperfect, so "explain how the config loader works" classifies as `config` (a
 * mutating shape) purely because `config` is tested before `code_read`;
 * `capabilityClass` is recipe frontmatter, which a recipe can get wrong without
 * anything catching it. Refusing on either signal alone would cost real work to
 * buy back a defect that costs one wasted run. So refusing takes three
 * independent agreements:
 *
 *   1. the caller pinned this agent id; `agent:"auto"` baselines are the
 *      harness's own choice and its mistakes are for it to report, not for the
 *      caller to be refused over;
 *   2. the task classifies as a mutating shape AND no read-shaped rule also
 *      matches the text, which is the nearest thing to a second opinion on the
 *      classifier available without a model call;
 *   3. the recipe's declared postcondition is a report rather than a change, so
 *      the recipe itself says twice that it does not write.
 *
 * Anything short of all three that still pairs a read-only recipe with a
 * mutating task is admitted with the mismatch flagged, which rides the receipt
 * and the dispatch summary line.
 */

import { type DispatchJob, dispatchJobRecipe, dispatchJobWrites } from "../agents/dispatch-jobs.js";
import type { ResultContract } from "../agents/result-contract.js";
import { capabilityClassWritesNothing } from "../agents/role-class.js";
import type { AgentCapabilityClass, AgentSpec } from "../agents/spec.js";
import { type AgentTaskType, asksForMutation, classifyAgentTask } from "./agent-candidates.js";
import type { DispatchIntent } from "./intent.js";

/**
 * Read-shaped corroboration independent of the classifier's ordered scan.
 * A test filename or subject can win that scan even though the leading verb
 * asks for inspection. This check asks whether any read verb appeared, not
 * which task type won the routing heuristic.
 */
const READ_SHAPED_PATTERNS: ReadonlyArray<RegExp> = [
	/\b(review|audit|critique|inspect for)\b/i,
	/\b(research|investigate|explore|survey|compare|find out)\b/i,
	/\b(read|inspect|explain|understand|summarize|describe|walk through|map|locate|trace|find where|look at)\b/i,
];
/**
 * What a verification recipe is for: running gates and reporting on them. The
 * run form allows words between the verb and its gate so "run this project's
 * unit tests" reads the same as "run the tests".
 */
const VERIFICATION_REQUEST =
	/\b(?:check|verify|validate|confirm|report|ensure|make sure|see (?:if|whether))\b|\b(?:re-?run|run|execute)\b[^.;\n]{0,60}\b(?:tests?|suites?|specs?|lint(?:er)?|type-?check|checks?|gates?|builds?|ci)\b|\btest (?:the|that|whether|if)\b|\btests? (?:pass|fail|succeed|still pass)/i;
/**
 * Contracts whose postcondition is a report. A recipe that declares one has
 * said in its own frontmatter that its terminal result is an account of the
 * workspace rather than a change to it, which is the corroboration a refusal
 * needs. Every other kind, including the harness fixture default
 * `external-delegation` and the deliberately unmeasurable `artifact-report`,
 * leaves the pairing flagged instead of refused.
 */
const REPORTING_CONTRACT_KINDS: ReadonlySet<ResultContract["kind"]> = new Set([
	"scout-report",
	"verifier-report",
	"review-verdict",
	"research-report",
	"world-knowledge-report",
	"provenance-report",
	"debugger-report",
	"oracle-report",
]);

export interface CapabilityMismatch {
	/** `refuse` fails admission; `flag` admits the run and rides the receipt. */
	verdict: "refuse" | "flag";
	agentId: string;
	capabilityClass: AgentCapabilityClass;
	taskType: AgentTaskType;
	/** Installed recipe that can do this work, or null when none is installed. */
	suggestedAgentId: string | null;
	/** One line, model-facing, naming both halves of the mismatch. */
	detail: string;
}

export interface CapabilityMismatchInput {
	agentId: string;
	capabilityClass: AgentCapabilityClass;
	task: string;
	/** True when the caller passed `agent:"auto"` and the harness chose the id. */
	autoSelected: boolean;
	/** The recipe's declared postcondition; null when it declares none. */
	resultContractKind: ResultContract["kind"] | null;
	/** Installed recipes, used only to name a suggestion that actually resolves. */
	specs: ReadonlyArray<AgentSpec>;
	/**
	 * The caller's typed intent, when it sent one. An intent that declares no
	 * write roots and no expected outputs is the caller saying in the schema
	 * that this run changes nothing, which outranks a verb the prose classifier
	 * read as mutating ("write the failing test first" inside a survey question
	 * refused a scout and cost the orchestrator a round).
	 */
	intent?: Pick<DispatchIntent, "writeRoots" | "expectedOutputs"> | null;
}

/** The job table's recipe for a writing job, else its implement recipe, when installed and able to write. */
function suggestedSpecialist(job: DispatchJob, specs: ReadonlyArray<AgentSpec>): string | null {
	const canMutate = new Set(
		specs.filter((spec) => !capabilityClassWritesNothing(spec.capabilityClass)).map((spec) => spec.id),
	);
	for (const id of [dispatchJobRecipe(job), dispatchJobRecipe("implement")]) {
		if (canMutate.has(id)) return id;
	}
	return null;
}

/**
 * Whether this pairing is a mismatch, and how sure the classifier is. Null
 * means the recipe can do the work, or the task never asked it to.
 */
export function assessCapabilityMismatch(input: CapabilityMismatchInput): CapabilityMismatch | null {
	if (!capabilityClassWritesNothing(input.capabilityClass)) return null;
	if (input.intent && input.intent.writeRoots.length === 0 && input.intent.expectedOutputs.length === 0) return null;
	const features = classifyAgentTask(input.task);
	if (
		input.capabilityClass === "verification" &&
		VERIFICATION_REQUEST.test(input.task) &&
		!asksForMutation(input.task)
	) {
		return null;
	}
	if (!dispatchJobWrites(features.job)) return null;
	const readShaped = READ_SHAPED_PATTERNS.some((pattern) => pattern.test(input.task));
	const reportingContract = input.resultContractKind !== null && REPORTING_CONTRACT_KINDS.has(input.resultContractKind);
	const confident = !readShaped && !input.autoSelected && reportingContract;
	const suggestedAgentId = suggestedSpecialist(features.job, input.specs);
	const remedy =
		suggestedAgentId === null
			? "No installed recipe can change the workspace, so this task cannot be delegated as written."
			: `Dispatch agent:"${suggestedAgentId}" for the change itself, then dispatch '${input.agentId}' to check it.`;
	const detail = confident
		? `dispatch: agent '${input.agentId}' is a ${input.capabilityClass} recipe and cannot write to the workspace, but this task classifies as ${features.taskType}, which requires a change on disk. ${remedy}`
		: `capability_mismatch=${input.agentId}/${input.capabilityClass} task_shape=${features.taskType}${
				suggestedAgentId === null ? "" : ` suggested=${suggestedAgentId}`
			}; a read-only recipe cannot land this change, so treat any claim that it did as unsupported.`;
	return {
		verdict: confident ? "refuse" : "flag",
		agentId: input.agentId,
		capabilityClass: input.capabilityClass,
		taskType: features.taskType,
		suggestedAgentId,
		detail,
	};
}
