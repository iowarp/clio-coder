import type { RunOutcome, RunOutcomeCode } from "../dispatch/types.js";
import type { EvidenceTag } from "./types.js";

export interface EvidenceFailureFacts {
	outcome: RunOutcome | null;
	outcomeCode: RunOutcomeCode | null;
	outcomeDetail: string | null;
	failureMessage: string | null;
}

/**
 * Attribute a forensic failure tag only from termination evidence.
 *
 * The task describes what the operator wanted, not why execution failed. A
 * task containing "test", "auth", or "timeout" is therefore never causal
 * evidence. Typed outcome facts take precedence over bounded diagnostics, and
 * insufficient evidence deliberately stays `unknown` instead of blaming the
 * model, harness, or environment by guesswork.
 */
export function attributeEvidenceFailure(facts: EvidenceFailureFacts): EvidenceTag {
	if (
		facts.outcomeCode === "worker_tool_call_cap_exhausted" ||
		facts.outcomeCode === "loop_guard_tools_disabled_exhausted"
	) {
		return "tool-loop";
	}
	if (facts.outcome === "timed_out" || facts.outcome === "stalled") return "timeout";

	const diagnostic = [facts.outcomeDetail, facts.failureMessage]
		.filter((value): value is string => value !== null)
		.join("\n")
		.toLowerCase();
	if (diagnostic.length === 0) return "unknown";
	if (/\b(?:401|403)\b|unauthorized|forbidden|invalid api key|authentication/.test(diagnostic)) {
		return "auth-failure";
	}
	if (/\b429\b|rate[ -]?limit|too many requests|temporar(?:y|ily)|unavailable|\b50[234]\b/.test(diagnostic)) {
		return "provider-transient";
	}
	if (/context (?:length|window)|context[_ -]?overflow|maximum context|too many tokens/.test(diagnostic)) {
		return "context-overflow";
	}
	if (/module not found|cannot find module|missing (?:dependency|package)|dependency .* missing/.test(diagnostic)) {
		return "missing-dependency";
	}
	if (/wrong runtime|runtime mismatch|model mismatch|unsupported runtime/.test(diagnostic)) return "wrong-runtime";
	if (
		/\b(?:test|tests|pytest|ctest)\b.*(?:fail|error)|(?:fail|error).*\b(?:test|tests|pytest|ctest)\b/.test(diagnostic)
	) {
		return "test-failure";
	}
	if (/\bbuild\b.*(?:fail|error)|(?:fail|error).*\bbuild\b/.test(diagnostic)) return "build-failure";
	return "unknown";
}
