/** Explicit plan-only wording in the operator request, shared by the close gate and card. */
export function isPlanOnlyRequest(text: string): boolean {
	return (
		/\bplan(?:s|ning)?\b/iu.test(text) &&
		(/\bplan[ -]only\b|\bonly\s+(?:a\s+|the\s+)?plan\b/iu.test(text) ||
			/\b(?:do\s+not|don['’]t|never)\s+(?:(?:edit|modify|change)\s+(?:anything|(?:any\s+)?(?:files|code))|(?:implement|execute)(?:\s+(?:anything|it|the\s+plan))?)(?=\s*(?:[.;,!]|$))|\bno\s+(?:edits|implementation)(?=\s*(?:[.;,!]|$))/iu.test(
				text,
			))
	);
}

/**
 * A question that closes a plan: the contract's wording, or a card offering the
 * close options the contract teaches. Three of three Haiku runs on one design
 * request worded their own question over those options, and reading only the
 * wording asked the operator a second time after they had answered.
 */
export function isPlanCloseQuestion(question: unknown): boolean {
	if (question === null || typeof question !== "object") return false;
	const { question: text, options } = question as { question?: unknown; options?: unknown };
	if (typeof text === "string" && /^carry out this plan\?/iu.test(text.trim())) return true;
	return (
		Array.isArray(options) &&
		options.some((option) => {
			const label = typeof option === "string" ? option : (option as { label?: unknown } | null)?.label;
			return typeof label === "string" && /^(?:keep|revise) (?:the|this) plan\b/iu.test(label.trim());
		})
	);
}

/** Remove a trailing prose close duplicated by the harness card (flywheel p9/D4). */
export function stripPlanCloseOptions(text: string): string {
	return text
		.replace(
			/(?:\n[ \t]*)+(?:[-*] |\d+\. )(?:\*\*)?(?:Keep (?:this|the) plan|Proceed\b)[^\n]*(?:\n[ \t]*(?:[-*] |\d+\. )[^\n]*)*\n?[ \t]*$/iu,
			"",
		)
		.trimEnd();
}
