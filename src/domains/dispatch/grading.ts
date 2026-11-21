/**
 * The grader (fleet design 4.8, slice M9). A run's outcome is a pure function of its contract and of facts the host
 * observed: `grade(contract, facts)` evaluates one rule table in layer order, the first failing rule sets the outcome,
 * and every rule's result is sealed as `verdict.rules`, so "why did this run fail" is data on the receipt. It reads no
 * prose: a builder's completion is the typed field of its report, never its opening words. The native settle path and
 * ACP delegation call the same function; ACP supplies unobserved facts, which grade `unknown`, never unmet.
 *
 * Pure: no I/O, no clock. The settle path calls it once before host checks, once after them, and once after landing,
 * each time with more facts filled; facts not yet gathered are `undefined` and their rules read `not_applicable`.
 */

import type { CompletionDeclaration } from "../../core/completion.js";
import type {
	GradeLayer,
	GradeRuleId,
	GradeRuleStatus,
	RunAssurance,
	RunOutcome,
	RunOutcomeCode,
} from "../../core/telemetry/run-vocabulary.js";
import type { Obligation, RunRole } from "./obligation.js";

/** One rule's sealed result. The failing rule's words are the run's outcome detail, so they are not repeated here. */
export interface GradeRuleResult {
	id: GradeRuleId;
	layer: GradeLayer;
	status: GradeRuleStatus;
	code?: RunOutcomeCode;
}

/** What the grader reads off the Run Contract: the run's role and the obligation resolved from it. */
export interface GradeContract {
	role: RunRole;
	obligation: Obligation;
	contractKind: string | null;
	/** False for a CLI subprocess and for ACP delegation: Clio did not see their tool lane, so zero counts say nothing. */
	toolLaneObserved: boolean;
	/** A gate decider's evidence packet ids (M10), what its verdict may cite; absent for a gate given no packet. */
	packet?: ReadonlyArray<string>;
	/** The packet's host check ids whose status is verified: the only items that ground a command-shaped claim. */
	verifiedChecks?: ReadonlyArray<string>;
}

/**
 * Facts the host observed, in the stages the settle path gathers them. Everything here was measured by Clio or typed by
 * the worker's validated report. A stage not gathered yet is `undefined`, and its rules read `not_applicable`.
 */
export interface GradeFacts {
	/** How the process ended, before any rule: `resolveRunOutcome`. */
	termination: { outcome: RunOutcome; detail: string | null };
	/** Why bringing a remote node's changes back failed; null when it did not run or succeeded. */
	changeReturnFailure?: string | null;
	/** The worker runtime's own typed outcome code and its reason. */
	workerCode: { code: RunOutcomeCode | null; detail?: string };
	/** The host's account of a wall-clock handback (whether a report came back), set with `worker_run_timeout`. */
	wallHandback?: string;
	/** The high-rigor finish gate engaged on an unvalidated mutation. */
	finishGateEngaged: boolean;
	/** Writes the run attempted when policy refused every one of them; null when any landed. */
	blockedWrites: number | null;
	/** V2: the handback. */
	handback?: {
		/** A durable final answer was captured. */
		finalOutput: boolean;
		/** The applied result contract's verdict; null for a run with none. */
		resultContract: { conformance: "pass" | "fail" | "not-reached"; reason: string | null } | null;
	};
	/** V3: what the run did, for its obligation. */
	work?: WorkFacts;
	/** V4: host verification; undefined until it ran. */
	host?: { rejection: { code: RunOutcomeCode; detail: string } | null };
	/** V4: existing test cases the change removed; undefined until checked. */
	removedTests?: ReadonlyArray<string>;
	/**
	 * The run's assurance (4.8) and, when compromised, the evidence that lowered it; undefined until it was derived.
	 * `operatorAccepted`: the operator merged the branch from the merge card anyway (V6).
	 */
	assurance?: { value: RunAssurance; cause: string; operatorAccepted?: boolean };
	/** V6: why landing the run's work failed or was withheld; undefined until it was attempted. */
	landing?: { failure: { code: RunOutcomeCode | null; detail: string } | null };
}

export interface WorkFacts {
	/** Tool activity from the run's trail; null when the lane was not observed. */
	activity: {
		/** Calls that ran, the observation pool's notices excluded. */
		executed: number;
		/** Succeeded read- or check-class calls, the handback tool excluded: the one observation counter. */
		observations: number;
		mutatingSucceeded: boolean;
		storeWritten: boolean;
	} | null;
	/** Paths the host measured as changed; null when it could not measure. */
	mutatedPathCount: number | null;
	/** Execute- or write-class calls policy refused, when every such call was refused. */
	blockedStateChanging: number;
	escalations: { denied: number; deniedBy?: "operator" | "main agent" | "safety judge"; timedOut: number };
	/** Limitations the run recorded through the `limitation` tool; the host merges them into the declaration. */
	recordedLimitations: string[];
	/** The worker stopped to ask for wider write roots: the request's detail, or null. */
	writeRootRequest: string | null;
	/** The builder report's typed completion; null when the run has no builder report. */
	completion: CompletionDeclaration | null;
	/** Passing checks the report claims with no matching execution on the final tree. */
	ungroundedChecks: ReadonlyArray<string>;
	/** A gate decider's verdict as its verdict contract parses it; null for any other run or an unparsed one. */
	gateVerdict: GateVerdictFacts | null;
}

/** What the grader reads of a reviewer's or judge's verdict (M10): no prose, only its typed fields. */
export interface GateVerdictFacts {
	/** A reviewer's pass or fail; null for a judge, whose winner the gate validates. */
	verdict: "pass" | "fail" | null;
	/** Each check, in report order: its name, the packet ids it cites, and what grounds it. */
	checks: ReadonlyArray<GateCheckFacts>;
}

/** One verdict check as the cited-evidence rule matches it, per check and never by name. */
export interface GateCheckFacts {
	name: string;
	cites: ReadonlyArray<string>;
	passed: boolean;
	/** The claim names a validation command (`detectValidationCommand`), so only a run of it can ground it. */
	command: boolean;
	/** A command this run ran to a clean exit, or a verify run on its final tree, grounds the claim. */
	ran: boolean;
}

export interface GradeVerdict {
	outcome: RunOutcome;
	outcomeCode: RunOutcomeCode | null;
	detail: string | null;
	rules: GradeRuleResult[];
	/** The obligation a model left unmet in a way another model may meet (ruling 5); null otherwise. */
	retryObligation: Obligation | null;
	/** A quality gate failed the run (the finish contract or an evidence obligation): classified as model quality. */
	qualityGateFailure: boolean;
	/** The run's result contract fact grades `fail`, whatever the report's own words said. */
	qualityFail: boolean;
	/** A rule after the process's own end supplied new words, so they are also the run's failure message. */
	messageChanged: boolean;
}

type RuleCheck =
	| { status: "pass" | "unknown" | "not_applicable" }
	| {
			status: "fail";
			code: RunOutcomeCode | null;
			detail: string | null;
			outcome?: RunOutcome;
			retry?: boolean;
			qualityGate?: boolean;
			qualityFail?: boolean;
	  };

interface GradeState {
	outcome: RunOutcome;
	detail: string | null;
}

interface GradeRule {
	id: GradeRuleId;
	layer: GradeLayer;
	/** `always` rules run whatever came before; `succeeded` rules only while the run still succeeds. */
	when: "always" | "succeeded";
	appliesTo(contract: GradeContract): boolean;
	check(facts: GradeFacts, contract: GradeContract, state: Readonly<GradeState>): RuleCheck;
}

const PASS: RuleCheck = { status: "pass" };
const NOT_APPLICABLE: RuleCheck = { status: "not_applicable" };
const UNKNOWN: RuleCheck = { status: "unknown" };

function joined(...parts: ReadonlyArray<string | null | undefined>): string | null {
	const kept = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
	return kept.length === 0 ? null : kept.join("; ");
}

function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}

const unchanged = (facts: WorkFacts): boolean => facts.mutatedPathCount === 0;
const changed = (facts: WorkFacts): boolean =>
	(facts.mutatedPathCount ?? 0) > 0 || (facts.mutatedPathCount === null && facts.activity?.mutatingSucceeded === true);

/** The builder's obligation, change-or-declared: a measured change, a typed declaration, or a typed no-change finish. */
function checkChangeOrDeclared(facts: WorkFacts, contract: GradeContract): RuleCheck {
	if (facts.writeRootRequest !== null)
		return { status: "fail", code: "worker_not_done", detail: facts.writeRootRequest };
	const activity = facts.activity;
	const mutated = activity?.mutatingSucceeded === true;
	// The operator must see that the run did nothing because a permission ask was denied (flywheel p7/A5).
	if (facts.escalations.denied > 0 && !mutated && (facts.mutatedPathCount ?? 0) === 0) {
		const denied = facts.escalations.denied;
		return {
			status: "fail",
			code: "obligation_unmet",
			detail: `obligation change-or-declared unmet: the ${facts.escalations.deniedBy ?? "operator"} denied ${plural(denied, "the worker's permission request", `${denied} of the worker's permission requests`)}, so it changed nothing and the assignment was not done`,
		};
	}
	if (facts.escalations.timedOut > 0 && !mutated && (facts.mutatedPathCount ?? 0) === 0) {
		const timedOut = facts.escalations.timedOut;
		return {
			status: "fail",
			code: "obligation_unmet",
			detail: `obligation change-or-declared unmet: nobody answered ${plural(timedOut, "the worker's permission request", `${timedOut} of the worker's permission requests`)} in time, so it changed nothing and the assignment was not done`,
		};
	}
	const completion = facts.completion;
	if (completion !== null && completion.state !== "done") {
		const limits = [
			...completion.limitations.map((entry) => `${entry.what} (${entry.why})`),
			...facts.recordedLimitations,
		];
		const reason = limits.length > 0 ? `: ${[...new Set(limits)].join("; ")}` : "";
		const state = completion.state === "partly_done" ? "partly done" : "not done";
		return changed(facts)
			? {
					status: "fail",
					code: "worker_partial_work",
					detail: `worker declared its assignment ${state}, so its changes are a partial result${reason}`,
				}
			: {
					status: "fail",
					code: "worker_not_done",
					detail: `worker declared its assignment ${state} and changed nothing${reason}`,
				};
	}
	// A recorded limitation is a typed declaration too; a store put is a store-only worker's deliverable.
	if (unchanged(facts) && activity?.storeWritten !== true && facts.recordedLimitations.length > 0)
		return {
			status: "fail",
			code: "worker_not_done",
			detail: `worker recorded a limitation and changed nothing, so the assignment was not done: ${facts.recordedLimitations.join("; ")}`,
		};
	if (!contract.toolLaneObserved || activity === null) return UNKNOWN;
	if (activity.executed === 0 && !changed(facts) && activity.storeWritten !== true)
		return {
			status: "fail",
			code: "obligation_unmet",
			detail: "obligation change-or-declared unmet: worker executed no tools, so it did none of its assignment",
			// Ruling 5: a builder retries only over an unchanged tree.
			retry: facts.mutatedPathCount === 0,
		};
	// A worker that found nothing to change says so in its typed completion; without one, refusals are why.
	const refused = facts.blockedStateChanging;
	if (unchanged(facts) && refused > 0 && !mutated && completion?.state !== "done")
		return {
			status: "fail",
			code: "obligation_unmet",
			detail: `obligation change-or-declared unmet: the worker's ${plural(refused, "state-changing call was", `${refused} state-changing calls were`)} refused by policy and nothing changed, so the assignment was not done`,
		};
	return PASS;
}

function checkObligation(facts: WorkFacts, contract: GradeContract): RuleCheck {
	switch (contract.obligation) {
		case "answer":
			return PASS;
		case "change-or-declared":
			return checkChangeOrDeclared(facts, contract);
		case "observed-evidence":
			if (!contract.toolLaneObserved || facts.activity === null) return UNKNOWN;
			if (facts.activity.executed > 0) return PASS;
			return {
				status: "fail",
				code: "obligation_unmet",
				detail:
					"obligation observed-evidence unmet: no tools executed, so the worker reported without reading anything and its findings are unaudited",
				retry: true,
				qualityGate: true,
				qualityFail: true,
			};
		case "executed-checks":
			if (!contract.toolLaneObserved) return UNKNOWN;
			if (facts.ungroundedChecks.length === 0) return PASS;
			return {
				status: "fail",
				code: "obligation_unmet",
				detail: `obligation executed-checks unmet: the report claims checks this run never executed on the final tree (${facts.ungroundedChecks.join(", ")})`,
				retry: true,
				qualityGate: true,
				qualityFail: true,
			};
		case "cited-evidence":
			return checkCitedEvidence(facts, contract);
	}
}

function citedEvidenceUnmet(detail: string): RuleCheck {
	return {
		status: "fail",
		code: "obligation_unmet",
		detail: `obligation cited-evidence unmet: ${detail}`,
		retry: true,
		qualityGate: true,
		qualityFail: true,
	};
}

/**
 * A gate's obligation (DESIGN 4.8): every reason cites an item of its evidence packet or an observation it made, and a
 * reviewer's pass cites at least one item about its subject. A verdict that cites none of its packet, or cites an id the
 * packet does not hold, is unmet, and the gate it decides is exhausted. A gate given no packet (a playbook loop's check
 * step) still owes a pass that rests on something it observed. A judge may make zero reads (4.9).
 */
function checkCitedEvidence(facts: WorkFacts, contract: GradeContract): RuleCheck {
	const verdict = facts.gateVerdict;
	const packet = contract.packet;
	if (packet === undefined) {
		if (contract.role !== "reviewer" || verdict?.verdict !== "pass") return PASS;
		if (!contract.toolLaneObserved || facts.activity === null) return UNKNOWN;
		if (facts.activity.observations === 0)
			return citedEvidenceUnmet("the reviewer passed the work without inspecting it: no tool call succeeded");
	} else {
		// An unparsed verdict is the result contract's failure, judged before this rule.
		if (verdict === null) return PASS;
		const known = new Set(packet);
		const cited = verdict.checks.flatMap((check) => check.cites);
		const unknown = [...new Set(cited.filter((id) => !known.has(id)))];
		if (unknown.length > 0)
			return citedEvidenceUnmet(`the verdict cites ids its evidence packet does not hold (${unknown.join(", ")})`);
		if (cited.length === 0) return citedEvidenceUnmet("the verdict cites no item of its evidence packet");
		const uncited = verdict.checks.filter((check) => check.cites.length === 0).map((check) => check.name);
		const observed = contract.toolLaneObserved && facts.activity !== null;
		// An unobserved lane cannot say an uncited check rests on something the gate read: unknown, as with no packet.
		if (uncited.length > 0 && !observed) return UNKNOWN;
		if (uncited.length > 0 && facts.activity !== null && facts.activity.observations === 0)
			return citedEvidenceUnmet(
				`${plural(uncited.length, "check", "checks")} ${uncited.join(", ")} ${plural(uncited.length, "cites", "cite")} no packet item and the gate observed nothing itself`,
			);
		if (contract.role !== "reviewer" || verdict.verdict !== "pass") return PASS;
		// 4.8: a participant's own report cannot raise assurance. A passing check that names a validation command rests
		// on a run the gate observed, or on a host check the packet records as verified; a handback or diff citation
		// grounds only a claim about what the gate read. Matched per check, before any name list is cut.
		const verified = new Set(contract.verifiedChecks ?? []);
		const unearned = verdict.checks
			.filter((check) => check.passed && check.command && !check.cites.some((id) => verified.has(id)))
			.filter((check) => !check.ran);
		if (unearned.length === 0) return PASS;
		if (!observed) return UNKNOWN;
		return citedEvidenceUnmet(
			`the reviewer passed the work without inspecting it: its report claims checks it never ran (${[...new Set(unearned.map((check) => check.name))].join(", ")})`,
		);
	}
	if (contract.role === "reviewer" && verdict?.verdict === "pass" && facts.ungroundedChecks.length > 0)
		return citedEvidenceUnmet(
			`the reviewer passed the work without inspecting it: its report claims checks it never ran (${facts.ungroundedChecks.join(", ")})`,
		);
	return PASS;
}

const anyRun = (): boolean => true;

/** The rule table, in layer order. Its order is the precedence; nothing else is. */
const RULES: ReadonlyArray<GradeRule> = [
	{
		id: "termination",
		layer: "V1",
		when: "always",
		appliesTo: anyRun,
		check: (facts) =>
			facts.termination.outcome === "succeeded"
				? PASS
				: { status: "fail", code: null, detail: facts.termination.detail, outcome: facts.termination.outcome },
	},
	{
		id: "change-return",
		layer: "V1",
		when: "succeeded",
		appliesTo: anyRun,
		check: (facts) =>
			facts.changeReturnFailure === undefined || facts.changeReturnFailure === null
				? NOT_APPLICABLE
				: { status: "fail", code: null, detail: facts.changeReturnFailure },
	},
	{
		id: "worker-outcome-code",
		layer: "V1",
		when: "always",
		appliesTo: anyRun,
		check: (facts, _contract, state) => {
			const code = facts.workerCode.code;
			if (code === null) return PASS;
			// An operator's cancel is the outcome; the loop's missing answer is its consequence, not its cause.
			if (state.outcome === "canceled" && code === "worker_final_output_missing") return PASS;
			// DESIGN 4.5 (fleet M8): a run its wall clock moved to handback seals timed_out, and the host's account of
			// the handback, not the worker's line, says whether a report came back.
			if (
				code === "worker_run_timeout" &&
				(state.outcome === "succeeded" || state.outcome === "failed" || state.outcome === "timed_out")
			) {
				const handback =
					facts.wallHandback ?? facts.workerCode.detail ?? "worker_run_timeout: the run reached its wall clock";
				return {
					status: "fail",
					code,
					outcome: "timed_out",
					detail: state.outcome === "timed_out" ? joined(handback, state.detail) : handback,
				};
			}
			const succeeded = state.outcome === "succeeded";
			const outcome = succeeded ? "failed" : state.outcome;
			return {
				status: "fail",
				code,
				outcome,
				// The worker runtime seals a builder's zero-call finish itself; ruling 5 retries it over an unchanged tree.
				retry:
					code === "obligation_unmet" &&
					facts.work?.mutatedPathCount === 0 &&
					facts.work.activity?.executed === 0 &&
					facts.work.writeRootRequest === null,
				detail: joined(
					state.detail,
					outcome === "failed" ? facts.workerCode.detail : undefined,
					succeeded ? `deterministic worker failure: ${code}` : undefined,
				),
			};
		},
	},
	{
		id: "finish-contract",
		layer: "V1",
		when: "succeeded",
		appliesTo: anyRun,
		check: (facts) =>
			facts.finishGateEngaged
				? { status: "fail", code: null, detail: "high-rigor finish gate: unvalidated mutation", qualityGate: true }
				: PASS,
	},
	{
		id: "writes-blocked",
		layer: "V1",
		when: "succeeded",
		appliesTo: (contract) => contract.role === "builder",
		check: (facts) =>
			facts.blockedWrites === null
				? PASS
				: {
						status: "fail",
						code: "worker_mutation_blocked",
						detail: `${facts.blockedWrites === 1 ? "the one write it attempted was" : `all ${facts.blockedWrites} writes it attempted were`} blocked by policy, so no workspace change landed`,
					},
	},
	{
		id: "final-output",
		layer: "V2",
		when: "succeeded",
		// An architect's postcondition is its plan file, judged by its result contract below.
		appliesTo: (contract) => contract.contractKind !== "architect-plan",
		check: (facts) =>
			facts.handback === undefined || facts.handback.finalOutput
				? facts.handback === undefined
					? NOT_APPLICABLE
					: PASS
				: { status: "fail", code: "worker_final_output_missing", detail: WORKER_FINAL_OUTPUT_MISSING_DETAIL },
	},
	{
		id: "result-contract",
		layer: "V2",
		when: "succeeded",
		appliesTo: (contract) => contract.contractKind !== null,
		check: (facts) => {
			const verdict = facts.handback?.resultContract ?? null;
			if (verdict === null || verdict.conformance === "not-reached") return NOT_APPLICABLE;
			if (verdict.conformance === "pass") return PASS;
			// #425: only the worker's repair loop can attest that repair rounds were exhausted.
			return {
				status: "fail",
				code: "result_contract_invalid",
				detail: `result contract failed: ${verdict.reason ?? "invalid result"}`,
			};
		},
	},
	{
		id: "obligation",
		layer: "V3",
		when: "succeeded",
		appliesTo: anyRun,
		check: (facts, contract) => (facts.work === undefined ? NOT_APPLICABLE : checkObligation(facts.work, contract)),
	},
	{
		id: "host-checks",
		layer: "V4",
		when: "succeeded",
		appliesTo: anyRun,
		check: (facts) => {
			if (facts.host === undefined) return NOT_APPLICABLE;
			const rejection = facts.host.rejection;
			return rejection === null ? PASS : { status: "fail", code: rejection.code, detail: rejection.detail };
		},
	},
	{
		id: "removed-tests",
		layer: "V4",
		when: "succeeded",
		appliesTo: anyRun,
		check: (facts) => {
			const removed = facts.removedTests;
			if (removed === undefined) return NOT_APPLICABLE;
			if (removed.length === 0) return PASS;
			return {
				status: "fail",
				code: "worker_removed_tests",
				detail: `the change removes existing test cases (${removed.slice(0, 2).join("; ")}${removed.length > 2 ? `; and ${removed.length - 2} more` : ""}); fix the source or restore them`,
			};
		},
	},
	{
		// A participant's own report can lower assurance and never raise it (4.8). A builder's change resting on a
		// compromised result is not delivered; a checker's or reviewer's fail verdict is its deliverable, so it is exempt.
		id: "assurance",
		layer: "V4",
		when: "succeeded",
		appliesTo: (contract) => contract.role === "builder",
		check: (facts) => {
			const assurance = facts.assurance;
			if (assurance === undefined) return NOT_APPLICABLE;
			if (assurance.value !== "compromised" || assurance.operatorAccepted === true) return PASS;
			return { status: "fail", code: "assurance_compromised", detail: `assurance compromised: ${assurance.cause}` };
		},
	},
	{
		id: "landing",
		layer: "V6",
		when: "always",
		appliesTo: anyRun,
		check: (facts) => {
			const failure = facts.landing?.failure;
			if (facts.landing === undefined) return NOT_APPLICABLE;
			return failure === null || failure === undefined
				? PASS
				: { status: "fail", code: failure.code, detail: failure.detail, outcome: "failed" };
		},
	},
];

export const WORKER_FINAL_OUTPUT_MISSING_DETAIL = "worker loop ended without a sealed final assistant output";

/** Grade one run. Pure: the same contract and facts always give the same verdict. */
export function grade(contract: GradeContract, facts: GradeFacts): GradeVerdict {
	const state: GradeState = { outcome: "succeeded", detail: facts.termination.detail };
	let outcomeCode: RunOutcomeCode | null = null;
	let retryObligation: Obligation | null = null;
	let qualityGateFailure = false;
	let qualityFail = false;
	let messageChanged = false;
	const rules: GradeRuleResult[] = [];
	for (const rule of RULES) {
		if (!rule.appliesTo(contract)) {
			rules.push({ id: rule.id, layer: rule.layer, status: "not_applicable" });
			continue;
		}
		if (rule.when === "succeeded" && state.outcome !== "succeeded") {
			rules.push({ id: rule.id, layer: rule.layer, status: "not_reached" });
			continue;
		}
		const result = rule.check(facts, contract, state);
		if (result.status !== "fail") {
			rules.push({ id: rule.id, layer: rule.layer, status: result.status });
			continue;
		}
		rules.push({
			id: rule.id,
			layer: rule.layer,
			status: "fail",
			...(result.code !== null ? { code: result.code } : {}),
		});
		// The landing reports on a run already graded; it overrides only the outcome it found succeeded.
		state.outcome = result.outcome ?? (state.outcome === "succeeded" ? "failed" : state.outcome);
		if (rule.id !== "termination" && result.detail !== state.detail) messageChanged = true;
		state.detail = result.detail;
		if (result.code !== null) outcomeCode = result.code;
		if (result.retry === true) retryObligation = contract.obligation;
		if (result.qualityGate === true) qualityGateFailure = true;
		if (result.qualityFail === true) qualityFail = true;
	}
	return {
		outcome: state.outcome,
		outcomeCode,
		detail: state.detail,
		rules,
		retryObligation,
		qualityGateFailure,
		qualityFail,
		messageChanged,
	};
}

/** The verdict as the receipt seals it: the obligation, every rule's result, and the run's assurance. */
export interface RunVerdict {
	version: 1;
	obligation: Obligation;
	rules: GradeRuleResult[];
	assurance: RunAssurance;
}
