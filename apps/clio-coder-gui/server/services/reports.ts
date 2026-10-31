import { Type } from "typebox";
import { Value } from "typebox/value";
import type { UsageReport } from "../../contracts/reports.js";
import { TelemetryCache, TelemetryCost, TelemetrySession } from "../../contracts/telemetry.js";
import type { CliRunner } from "./cli-runner.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

const closed = { additionalProperties: false };
const shown = Type.Omit(TelemetrySession.properties.own.properties.tokens.properties.input, ["ref"]);
/** The usage command emits one read-model DTO; the GUI arranges its facts without rewording them (#434). */
const UsageDto = Type.Object(
	{
		sessions: shown,
		runs: shown,
		decisions: Type.Object(
			{ total: shown, blocked: shown, tools: Type.Array(Type.Object({ tool: Type.String(), count: shown }, closed)) },
			closed,
		),
		approvals: Type.Object({ requested: shown, granted: shown, denied: shown, expired: shown, rate: shown }, closed),
		tokens: TelemetrySession.properties.own.properties.tokens,
		cost: Type.Array(TelemetryCost),
		cache: Type.Array(TelemetryCache),
	},
	closed,
);

export class ReportsService {
	constructor(
		private readonly runner: CliRunner,
		private readonly workspaces: WorkspaceService,
	) {}
	async usage(workspaceId: string): Promise<UsageReport> {
		const workspace = await this.workspaces.get(workspaceId);
		const now = Date.now();
		const report = await this.runner.run({ kind: "usage.report" }, workspace.path);
		if (!Value.Check(UsageDto, report)) throw new AppProblem("unavailable", "Usage returned an invalid report DTO.");
		return {
			schema: "experimental",
			workspaceId,
			windowDays: 30,
			from: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
			to: new Date(now).toISOString(),
			facts: [
				{ name: "sessions", values: report.sessions },
				{ name: "dispatch-runs", values: report.runs },
				{ name: "tool-decisions", values: report.decisions },
				{ name: "permission-decisions", values: report.approvals },
				{ name: "telemetry-tokens", values: { tokens: report.tokens } },
				...report.cost.map((cost) => ({ name: "telemetry-cost", values: { groupBy: cost.groupBy, report: cost } })),
				...report.cache.map((cache) => ({
					name: "telemetry-cache",
					values: { sessionId: cache.sessionId, report: cache },
				})),
			],
			opportunities: [],
		};
	}
}
