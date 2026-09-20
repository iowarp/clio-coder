import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { type EvalRequest, UsageReport } from "../../contracts/reports.js";
import type { WorkerHost } from "../worker/host.js";
import type { CliRunner } from "./cli-runner.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

export class ReportsService {
	constructor(
		private readonly reads: WorkerHost,
		private readonly runner: CliRunner,
		private readonly workspaces: WorkspaceService,
	) {}
	async evals<S extends TSchema>(input: EvalRequest, schema: S): Promise<Static<S>> {
		const value = Value.Clean(schema, await this.reads.call("evals.read", input));
		if (!Value.Check(schema, value)) throw new AppProblem("unavailable", "Eval storage returned an invalid projection.");
		return value;
	}
	async usage(workspaceId: string): Promise<UsageReport> {
		const workspace = await this.workspaces.get(workspaceId);
		const rows = await this.runner.run({ kind: "usage.report" }, workspace.path);
		if (!Array.isArray(rows) || !rows.length) throw new AppProblem("unavailable", "Usage returned no report rows.");
		const facts: UsageReport["facts"] = [],
			opportunities: UsageReport["opportunities"] = [];
		let from: string | undefined, to: string | undefined;
		for (const value of rows as unknown[]) {
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new AppProblem("unavailable", "Usage returned an invalid row.");
			const {
				schema,
				windowDays,
				from: start,
				to: end,
				kind,
				fact,
				opportunity,
				suggestion,
				evidence,
				...values
			} = value as Record<string, unknown>;
			if (
				schema !== "experimental" ||
				windowDays !== 30 ||
				typeof start !== "string" ||
				typeof end !== "string" ||
				(from && from !== start) ||
				(to && to !== end)
			)
				throw new AppProblem("unavailable", "Usage report windows do not agree.");
			from = start;
			to = end;
			if (kind === "fact" && typeof fact === "string") facts.push({ name: fact, values });
			else if (
				kind === "opportunity" &&
				typeof opportunity === "string" &&
				typeof suggestion === "string" &&
				typeof evidence === "string"
			)
				opportunities.push({ kind: opportunity, suggestion, evidence });
			else throw new AppProblem("unavailable", "Usage returned an unsupported row kind.");
		}
		const result = { schema: "experimental", workspaceId, windowDays: 30, from, to, facts, opportunities };
		if (!Value.Check(UsageReport, result)) throw new AppProblem("unavailable", "Usage returned an invalid report.");
		return result;
	}
}
