import type { ProblemCode } from "../../contracts/common.js";

export type NoticeTone = "error" | "warning" | "info" | "success";

export interface Notice {
	readonly id: string;
	readonly tone: NoticeTone;
	readonly title: string;
	readonly detail?: string;
	/** Problem code and instance when the notice came from an ApiProblem. */
	readonly code?: string;
	readonly reference?: string;
	/** The background read that raised the notice; repeats are matched by visible content, not by scope. */
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

/** Five notices are kept; the region shows fewer and counts the rest. */
const NOTICE_LIMIT = 5;

interface ProblemFields {
	readonly code: string;
	readonly title: string;
	readonly detail: string;
	readonly instance: string;
}

/**
 * The server titles a problem with its code spelled out ("not found"), which says nothing a person can
 * act on; the sentence is in the detail. Every code therefore gets a plain heading, and the code itself
 * stays under Technical details.
 */
const PROBLEM_HEADINGS: Readonly<Record<ProblemCode | "model_not_declared", string>> = {
	conflict: "Not possible right now",
	not_found: "Not found",
	validation: "Check the input",
	unsupported: "Not supported here",
	unavailable: "Temporarily unavailable",
	upstream_acp: "CLIO Coder engine problem",
	operation_failed: "The operation failed",
	unauthorized: "Not allowed",
	model_not_declared: "Model not declared",
	internal: "Something went wrong",
};

export function problemHeading(problem: { readonly code: string; readonly title: string }): string {
	const title = problem.title.trim();
	const spelled = problem.code.replaceAll("_", " ");
	// A title the client wrote itself ("Server unavailable") already reads as a heading.
	if (title && title !== problem.code && title !== spelled) return title;
	const known: string | undefined = (PROBLEM_HEADINGS as Readonly<Record<string, string>>)[problem.code];
	if (known) return known;
	const text = title || spelled;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A repeat is judged by what the operator reads: the same heading and detail is one notice, whichever
 * request or background read raised it. Two reads refused with the same sentence would otherwise
 * show the same card twice.
 */
function matchingProblem(notices: readonly Notice[], problem: ProblemFields): Notice | undefined {
	const heading = problemHeading(problem);
	return notices.find(
		(notice) => notice.code !== undefined && notice.title === heading && notice.detail === problem.detail,
	);
}

export type NoticeInput = Omit<Notice, "id" | "at" | "ttl"> & { id?: string; ttl?: number | null };

/** The notice a problem raises: a repeat reuses the earlier notice's id and counts itself. */
export function problemNotice(
	notices: readonly Notice[],
	problem: ProblemFields,
	scope: string | undefined,
	freshId: string,
): NoticeInput & { id: string } {
	const previous = matchingProblem(notices, problem);
	const problemScope = scope ?? previous?.problemScope;
	return {
		// Client-side failures all use "browser" as their reference, not as a notification identity.
		id: previous?.id ?? (scope || problem.instance === "browser" ? freshId : problem.instance),
		tone: problemTone(problem.code),
		title: problemHeading(problem),
		detail: problem.detail,
		code: problem.code,
		reference: problem.instance,
		occurrences: (previous?.occurrences ?? 0) + 1,
		...(problemScope ? { problemScope } : {}),
	};
}

/** The same id replaces in place and moves to the newest end, which is how a retried request does not stack. */
export function withNotice(notices: readonly Notice[], notice: Notice): Notice[] {
	return [...notices.filter((existing) => existing.id !== notice.id), notice].slice(-NOTICE_LIMIT);
}

/** Where focus goes when the focused notice is dismissed: the one below it, else the one above. */
export function noticeAfterDismissal(ids: readonly string[], dismissed: string): string | null {
	const at = ids.indexOf(dismissed);
	if (at < 0) return null;
	return ids[at + 1] ?? ids[at - 1] ?? null;
}
