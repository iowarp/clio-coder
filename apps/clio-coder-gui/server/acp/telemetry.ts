import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { SessionTelemetry } from "../../contracts/session-telemetry.js";
import { LiveUsage, ProjectTrust, SessionPlan, SessionWorkspace } from "../../contracts/session-telemetry.js";
import { AppProblem } from "../services/problem.js";

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function projectTelemetryValue<S extends TSchema>(schema: S, value: unknown): Static<S> {
	const projected = Value.Clean(schema, structuredClone(value));
	if (!Value.Check(schema, projected)) throw new AppProblem("upstream_acp", "Clio returned invalid session telemetry.");
	return projected as Static<S>;
}

export function sessionResultTelemetry(result: unknown): SessionTelemetry {
	const meta = record(record(result)._meta);
	return {
		...(meta["clio-coder/workspace"] !== undefined
			? { workspace: projectTelemetryValue(SessionWorkspace, meta["clio-coder/workspace"]) }
			: {}),
		...(meta["clio-coder/trust"] !== undefined
			? { trust: projectTelemetryValue(ProjectTrust, meta["clio-coder/trust"]) }
			: {}),
	};
}

export function sessionUpdateTelemetry(update: Record<string, unknown>): SessionTelemetry | null {
	const meta = record(update._meta);
	if (update.sessionUpdate === "usage_update") {
		const usage = record(meta["clio-coder/usage"]);
		return {
			usage: projectTelemetryValue(LiveUsage, {
				used: update.used,
				size: update.size,
				...(update.cost !== undefined ? { cost: update.cost } : {}),
				...(meta["clio-coder/context"] !== undefined ? { context: meta["clio-coder/context"] } : {}),
				...(usage.session != null ? { session: usage.session } : {}),
			}),
		};
	}
	if (update.sessionUpdate === "plan") {
		if (!Array.isArray(update.entries)) throw new AppProblem("upstream_acp", "Clio returned invalid plan entries.");
		return {
			plan: projectTelemetryValue(SessionPlan, {
				title: record(meta["clio-coder/plan"]).title ?? null,
				entries: update.entries.map((value, index) => {
					const entry = record(value),
						detail = record(record(entry._meta)["clio-coder/plan"]);
					return {
						id: detail.id ?? String(index),
						content: entry.content,
						status: detail.status === "blocked" ? "blocked" : entry.status,
						reason: detail.reason ?? null,
					};
				}),
				truncated: record(meta["clio-coder/plan"]).truncated === true,
			}),
		};
	}
	if (update.sessionUpdate === "session_info_update" && meta["clio-coder/workspace"] !== undefined)
		return { workspace: projectTelemetryValue(SessionWorkspace, meta["clio-coder/workspace"]) };
	return null;
}
