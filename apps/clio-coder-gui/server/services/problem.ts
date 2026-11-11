import { randomUUID } from "node:crypto";
import type { Problem, ProblemCode } from "../../contracts/common.js";

const statusByCode: Record<ProblemCode, number> = {
	validation: 422,
	unauthorized: 401,
	not_found: 404,
	conflict: 409,
	unsupported: 409,
	unavailable: 503,
	upstream_acp: 409,
	operation_failed: 500,
	internal: 500,
};
export class AppProblem extends Error {
	readonly problem: Problem;
	constructor(
		code: ProblemCode,
		detail: string,
		status = statusByCode[code],
		instance: string = randomUUID(),
		extensions: Pick<Problem, "modelSelection" | "control"> = {},
	) {
		super(detail);
		this.problem = {
			type: `urn:clio-coder:problem:${code}`,
			title: code.replaceAll("_", " "),
			status,
			detail,
			code,
			instance,
			...extensions,
		};
	}
}
export function problemOf(error: unknown): Problem {
	if (error instanceof AppProblem) return error.problem;
	const problem = new AppProblem("internal", "The request could not be completed.").problem;
	console.error(`[clio-coder:gui] ${problem.instance}`, error);
	return problem;
}

/** A request path or path segment, percent-decoded; malformed encoding is the caller's error (400), not ours. */
export function decodeRequestPath(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new AppProblem("validation", "The request path has malformed percent-encoding.", 400);
	}
}
