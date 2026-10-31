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
	"worker_output_cap_exhausted",
	"loop_guard_tools_disabled_exhausted",
	"result_contract_exhausted",
	"result_contract_invalid",
	"worker_final_output_missing",
	"host_verification_rejected",
	"worker_no_work",
	"worker_mutation_blocked",
	"merge_withheld",
	"worker_removed_tests",
	"information_flow_blocked",
] as const;
export type RunOutcomeCode = (typeof RUN_OUTCOME_CODES)[number];

/** How each labelled hash a finished run carries was computed (`receipt-hashes.ts`, #434). */
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
export type ReceiptHashCanonicalization = (typeof RUN_HASH_CANONICALIZATIONS)[number];

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
	"run-receipt",
	"validation-result",
	"response-schema",
	"result-contract",
	"safety-rule-pack",
	"project-safety-policy",
	"protected-artifacts",
	"worker-permit",
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
export type ReceiptHashSubject = (typeof RUN_HASH_SUBJECTS)[number];
