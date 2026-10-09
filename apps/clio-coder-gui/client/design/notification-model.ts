export type NoticeTone = "error" | "warning" | "info" | "success";

export interface Notice {
	readonly id: string;
	readonly tone: NoticeTone;
	readonly title: string;
	readonly detail?: string;
	/** Problem code and instance when the notice came from an ApiProblem. */
	readonly code?: string;
	readonly reference?: string;
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

/** Where focus goes when the focused notice is dismissed: the one below it, else the one above. */
export function noticeAfterDismissal(ids: readonly string[], dismissed: string): string | null {
	const at = ids.indexOf(dismissed);
	if (at < 0) return null;
	return ids[at + 1] ?? ids[at - 1] ?? null;
}
