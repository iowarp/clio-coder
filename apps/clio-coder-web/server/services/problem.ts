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
	constructor(code: ProblemCode, detail: string, status = statusByCode[code], instance: string = randomUUID()) {
		super(detail);
		this.problem = {
			type: `urn:clio-coder:problem:${code}`,
			title: code.replaceAll("_", " "),
			status,
			detail,
			code,
			instance,
		};
	}
}
export function problemOf(error: unknown): Problem {
	if (error instanceof AppProblem) return error.problem;
	const problem = new AppProblem("internal", "The request could not be completed.").problem;
	console.error(`[clio-coder:web] ${problem.instance}`, error);
	return problem;
}
