/**
 * The job-to-recipe table: the one source for which recipe does which kind of
 * work. The dispatch list text and the dispatch tool description lead with it,
 * an omitted or `auto` agent resolves from it, routing priors read it, and a
 * capability mismatch suggests from it. The first six rows are the ruled table
 * and lead every rendering; the specialist rows after them keep the task shapes
 * the ruled six do not name on their own recipe.
 */

export type DispatchJob =
	| "inspect"
	| "review"
	| "check"
	| "diagnose"
	| "add-tests"
	| "implement"
	| "docs"
	| "research"
	| "open-world"
	| "run-records";

interface DispatchJobRow {
	job: DispatchJob;
	/** How the job reads in the rendered table. */
	label: string;
	recipe: string;
	/** True when finishing the job changes the workspace. */
	writes: boolean;
}

const DISPATCH_JOBS: ReadonlyArray<DispatchJobRow> = [
	{ job: "inspect", label: "inspect", recipe: "scout", writes: false },
	{ job: "review", label: "review a diff", recipe: "reviewer", writes: false },
	{ job: "check", label: "run checks", recipe: "verifier", writes: false },
	{ job: "diagnose", label: "diagnose a failure", recipe: "debugger", writes: false },
	{ job: "add-tests", label: "add tests", recipe: "tester", writes: true },
	{ job: "implement", label: "implement", recipe: "coder", writes: true },
	{ job: "docs", label: "write docs", recipe: "documenter", writes: true },
	{ job: "research", label: "supplied sources", recipe: "researcher", writes: false },
	{ job: "open-world", label: "open-world survey", recipe: "world-knowledge", writes: false },
	{ job: "run-records", label: "run records", recipe: "provenance", writes: false },
];

function jobRow(job: DispatchJob): DispatchJobRow {
	const row = DISPATCH_JOBS.find((entry) => entry.job === job);
	if (row === undefined) throw new Error(`dispatch job table has no row for '${job}'`);
	return row;
}

export function dispatchJobRecipe(job: DispatchJob): string {
	return jobRow(job).recipe;
}

export function dispatchJobWrites(job: DispatchJob): boolean {
	return jobRow(job).writes;
}

/** The table as one line, rendered identically in the list text and the tool description. */
export const DISPATCH_JOB_TABLE_TEXT = `Job table; an omitted agent resolves from the job: ${DISPATCH_JOBS.map(
	(row) => `${row.label}: ${row.recipe}`,
).join("; ")}.`;
