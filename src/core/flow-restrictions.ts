/** One restriction carried on content: a reference to the rule, never the content. */
export interface FlowRestriction {
	/** `informationFlow.sources[].id` in the trusted project safety policy. */
	readonly ruleId: string;
	/** sha256 of the policy bytes that defined the rule when the content was read. */
	readonly policyHash: string;
	/** Canonical path or tool name that matched. Evidence for the operator, not content. */
	readonly sourceRef: string;
	/**
	 * Exact recipient identities the rule allowed at read time, groups and
	 * target bindings already expanded. The restriction stays enforceable from
	 * this snapshot when the live policy later drops or rewrites the rule.
	 */
	readonly recipients: ReadonlyArray<string>;
}

/**
 * Compact, durable restriction metadata attached to context, artifacts, and
 * worker inputs. `advisory` holds model-inferred annotations; they are carried
 * for display and never enforced.
 */
export interface FlowRestrictionSet {
	readonly version: 1;
	readonly restrictions: ReadonlyArray<FlowRestriction>;
	readonly advisory?: ReadonlyArray<string>;
}

export function isFlowRestrictionSet(value: unknown): value is FlowRestrictionSet {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const set = value as Record<string, unknown>;
	if (set.version !== 1 || !Array.isArray(set.restrictions)) return false;
	if (set.advisory !== undefined && (!Array.isArray(set.advisory) || set.advisory.some((a) => typeof a !== "string")))
		return false;
	return set.restrictions.every((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const r = entry as Record<string, unknown>;
		return (
			typeof r.ruleId === "string" &&
			typeof r.policyHash === "string" &&
			typeof r.sourceRef === "string" &&
			Array.isArray(r.recipients) &&
			r.recipients.every((ref) => typeof ref === "string")
		);
	});
}
