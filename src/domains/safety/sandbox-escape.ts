import type { SafetyDecision } from "./contract.js";

/** Rule id of the ask for a call the operator's default would contain that sets `unsandboxed: true`. */
export const SANDBOX_ESCAPE_RULE_ID = "sandbox-escape";

export const SANDBOX_ESCAPE_REASON =
	"unsandboxed: true leaves the main-session sandbox, so the command runs as the operator with the operator's credentials and files; it runs only when the operator's request names this escape or the operator approves it";

/**
 * True when the ask would run a command outside the main-session sandbox,
 * whether the escape is the rule that asked or a reason joined to another ask.
 */
export function asksToLeaveSandbox(decision: SafetyDecision): boolean {
	const policy = decision.policy;
	if (policy === undefined) return false;
	return policy.ruleId === SANDBOX_ESCAPE_RULE_ID || policy.reasons.includes(SANDBOX_ESCAPE_REASON);
}

/**
 * True when an operator message mentions the sandbox. The judge's `operator-named`
 * citation is the model's word; an escape it allows also needs the operator's own
 * text to speak of the sandbox, so a judge that misreads a request cannot grant one.
 */
export function operatorMentionsSandbox(messages: ReadonlyArray<string>): boolean {
	return messages.some((text) => /sandbox|unconfined/i.test(text));
}
