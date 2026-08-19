/**
 * pi-agent-core owns the text that custom agent messages (bash executions,
 * branch and compaction summaries) become when they are replayed to a model.
 * Clio's replay builder maps its own session entries onto these so the
 * wording never drifts from pi's `convertToLlm`.
 */
export {
	type BashExecutionMessage,
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	bashExecutionToText,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
} from "@earendil-works/pi-agent-core";
