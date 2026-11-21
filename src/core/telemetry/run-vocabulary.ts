/**
 * A finished run's outcome vocabularies, free of schema imports so the dispatch types that name them stay cheap to
 * load (#434).
 */
export const RUN_OUTCOMES = [
	"succeeded",
	"failed",
	"timed_out",
	"stalled",
	"canceled",
	"denied_by_policy",
	"spawn_failed",
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** Stable machine classifications for terminal conditions that drive policy. */
export const RUN_OUTCOME_CODES = [
	"vram_capacity_fit_failure",
	"worker_tool_call_cap_exhausted",
	"worker_context_exhausted",
	"worker_turn_timeout",
	/** The run's wall clock moved it to its handback round (fleet M8); the run seals timed_out. */
	"worker_run_timeout",
	"worker_output_cap_exhausted",
	"loop_guard_tools_disabled_exhausted",
	/** The read-streak decision gate refused two rounds of reads after every note (exploration design X7). */
	"exploration_stalled",
	"result_contract_exhausted",
	"result_contract_invalid",
	"worker_final_output_missing",
	"host_verification_rejected",
	/**
	 * Retired by the grader (fleet M9): obligation_unmet replaced it. No path writes it; it stays only so run journals
	 * sealed before M9 still parse.
	 */
	"worker_no_work",
	/** The run left the obligation its role owes unmet (fleet design 4.8); the detail names the obligation. */
	"obligation_unmet",
	/** A builder declared its assignment unfinished, or asked for wider write roots, and changed nothing. */
	"worker_not_done",
	"worker_partial_work",
	"worker_mutation_blocked",
	"merge_withheld",
	"worker_removed_tests",
	"information_flow_blocked",
	"acp_auth_required",
	"acp_model_unavailable",
	"acp_thinking_unavailable",
	"acp_transport_error",
] as const;
export type RunOutcomeCode = (typeof RUN_OUTCOME_CODES)[number];

/** What evidence a run's result must rest on, resolved once from its role (fleet design 4.8). */
export const RUN_OBLIGATIONS = [
	"observed-evidence",
	"answer",
	"change-or-declared",
	"executed-checks",
	"cited-evidence",
] as const;
export type RunObligation = (typeof RUN_OBLIGATIONS)[number];

/** The grader's layers: V0 is enforced at admission and V5 by the gates, so it holds V1 to V4 and the landing (V6). */
export const GRADE_LAYERS = ["V1", "V2", "V3", "V4", "V6"] as const;
export type GradeLayer = (typeof GRADE_LAYERS)[number];

/** The grader's rules, in the order they are evaluated: the order is the precedence (fleet M9). */
export const GRADE_RULE_IDS = [
	"termination",
	"change-return",
	"worker-outcome-code",
	"finish-contract",
	"writes-blocked",
	"final-output",
	"result-contract",
	"obligation",
	"host-checks",
	"removed-tests",
	"landing",
] as const;
export type GradeRuleId = (typeof GRADE_RULE_IDS)[number];

/** `not_reached`: an earlier rule already failed the run. `unknown`: the facts the rule needs were not observed. */
export const GRADE_RULE_STATUSES = ["pass", "fail", "unknown", "not_applicable", "not_reached"] as const;
export type GradeRuleStatus = (typeof GRADE_RULE_STATUSES)[number];

/** How far a run's result is backed (fleet design 4.8): the trust verdict of its own settled facts. */
export const RUN_ASSURANCES = ["reviewed", "grounded", "unverified", "compromised", "unknown"] as const;
export type RunAssurance = (typeof RUN_ASSURANCES)[number];

/** How each labelled hash a finished run carries was computed (`run-hashes.ts`, #434). */
export const RUN_HASH_CANONICALIZATIONS = [
	/** UTF-8 bytes of the text as given (trimmed where the subject says so). */
	"utf8-text",
	/** Non-empty trimmed parts joined with a blank line, then UTF-8. */
	"trimmed-parts-v1",
	/** Sorted-key JSON without a domain prefix. */
	"json-sorted-v1",
	/** A `clio-coder.<kind>:` domain prefix followed by sorted-key JSON. */
	"json-sorted-prefixed-v1",
	/** `JSON.stringify` in insertion order. */
	"json-insertion-order",
	/** Child content hashes joined with newlines. */
	"hash-lines-v1",
	/** `git diff` bytes for a committed task, or the streamed working-tree snapshot form. */
	"task-diff-v1",
	/** The referenced artifact's own integrity digest, copied. */
	"artifact-digest",
] as const;
export type RunHashCanonicalization = (typeof RUN_HASH_CANONICALIZATIONS)[number];

/** What each labelled hash a finished run carries is a hash of. */
export const RUN_HASH_SUBJECTS = [
	"worker-prompt",
	"compiled-system-prompt",
	"dynamic-messages",
	"tool-names",
	"tool-schemas",
	"briefing",
	"steering",
	"worker-context-snapshot",
	"worker-context-seed",
	"project-context",
	"plan-text",
	"execution-plan",
	"run-settlement",
	"validation-result",
	"response-schema",
	"result-contract",
	"safety-rule-pack",
	"project-safety-policy",
	"protected-artifacts",
	"worker-permit",
	"worker-envelope",
	"mcp-server",
	"checkout-tree",
	"check-payload",
	"task-diff",
	"route-decision",
	"agent-spec",
	"route-prompt-composition",
	"endpoint",
	"settings",
	"skill-file",
	"package-provenance",
] as const;
export type RunHashSubject = (typeof RUN_HASH_SUBJECTS)[number];
