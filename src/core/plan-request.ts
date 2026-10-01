/** Explicit plan-only wording in the operator request, shared by the close gate and card. */
export function isPlanOnlyRequest(text: string): boolean {
	return (
		/\bplan(?:s|ning)?\b/iu.test(text) &&
		(/\bplan[ -]only\b|\bonly\s+(?:a\s+|the\s+)?plan\b/iu.test(text) ||
			/\b(?:do\s+not|don['’]t|never)\s+(?:edit|modify|change|implement|execute)\b|\bno\s+(?:edits|implementation)\b/iu.test(
				text,
			))
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
