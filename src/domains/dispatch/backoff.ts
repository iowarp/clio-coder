import type { RunOutcomeCode } from "./types.js";

/** True only for typed terminal conditions that retrying unchanged cannot heal. */
export function isDeterministicOutcomeCode(code: RunOutcomeCode | null | undefined): boolean {
	return (
		code === "vram_capacity_fit_failure" ||
		code === "worker_tool_call_cap_exhausted" ||
		code === "worker_context_exhausted" ||
		code === "loop_guard_tools_disabled_exhausted" ||
		code === "result_contract_exhausted" ||
		code === "worker_final_output_missing" ||
		code === "host_verification_rejected" ||
		code === "worker_no_work" ||
		code === "worker_mutation_blocked" ||
		code === "merge_withheld" ||
		code === "worker_removed_tests" ||
		code === "information_flow_blocked"
	);
}
