export type NoticeTone = "error" | "warning" | "info" | "success";

export interface Notice {
	readonly id: string;
	readonly tone: NoticeTone;
	readonly title: string;
	readonly detail?: string;
	/** Problem code and instance when the notice came from an ApiProblem. */
	readonly code?: string;
	readonly reference?: string;
	/** Repeated failures of one background read share a notice; different resources stay distinct. */
	readonly problemScope?: string;
	readonly occurrences?: number;
	/** ms before auto-dismissal; null pins the notice until dismissed. */
	readonly ttl: number | null;
	readonly at: number;
}

export const DEFAULT_TTL: Readonly<Record<NoticeTone, number | null>> = {
	error: null,
	warning: null,
	info: 10_000,
	success: 4_000,
};

export function problemTone(code: string): NoticeTone {
	if (code === "unsupported") return "info";
	return code === "conflict" ? "warning" : "error";
}

/** Only an identical failure of the same background resource is one repeated problem. */
export function matchingProblem(
	notices: readonly Notice[],
	scope: string | undefined,
	problem: { code: string; title: string; detail: string },
): Notice | undefined {
	if (!scope) return undefined;
	return notices.find(
		(notice) =>
			notice.problemScope === scope &&
			notice.code === problem.code &&
			notice.title === problem.title &&
			notice.detail === problem.detail,
	);
}

/** Where focus goes when the focused notice is dismissed: the one below it, else the one above. */
export function noticeAfterDismissal(ids: readonly string[], dismissed: string): string | null {
	const at = ids.indexOf(dismissed);
	if (at < 0) return null;
	return ids[at + 1] ?? ids[at - 1] ?? null;
}
