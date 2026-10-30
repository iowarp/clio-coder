import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { UsageReport } from "../../contracts/reports.js";
import { TelemetryCache, TelemetryCost, TelemetrySession } from "../../contracts/telemetry.js";
import type { CliRunner } from "./cli-runner.js";
import { reportCostDisplays } from "./cost-display.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

/** Read-model rows of the usage report and the field holding each one's DTO (#434 §11.3). */
const TELEMETRY_ROWS: Readonly<Record<string, { field: string; schema: TSchema }>> = {
	"telemetry-cost": { field: "report", schema: TelemetryCost },
	"telemetry-cache": { field: "report", schema: TelemetryCache },
	"telemetry-tokens": { field: "tokens", schema: TelemetrySession.properties.own.properties.tokens },
};

export class ReportsService {
	constructor(
		private readonly runner: CliRunner,
		private readonly workspaces: WorkspaceService,
	) {}
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
			const telemetry = typeof fact === "string" && Object.hasOwn(TELEMETRY_ROWS, fact) ? TELEMETRY_ROWS[fact] : undefined;
			if (kind === "fact" && telemetry) {
				// The read model's rows arrive already worded by the canonical renderer; the client trusts their shape (#434).
				if (!Value.Check(telemetry.schema, values[telemetry.field]))
					throw new AppProblem("unavailable", `Usage returned an invalid ${fact} row.`);
				facts.push({ name: fact as string, values });
			} else if (kind === "fact" && typeof fact === "string")
				facts.push({ name: fact, values: reportCostDisplays(values) as Record<string, unknown> });
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
