import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { SessionTelemetry } from "../../contracts/session-telemetry.js";
import {
	ActiveEggs,
	LiveUsage,
	MemoryGuardian,
	ProjectTrust,
	SessionPlan,
	SessionWorkspace,
} from "../../contracts/session-telemetry.js";
import {
	ACP_CONTEXT_META_KEY,
	ACP_EGGS_META_KEY,
	ACP_MEMORY_META_KEY,
	ACP_PLAN_META_KEY,
	ACP_TRUST_META_KEY,
	ACP_USAGE_META_KEY,
	ACP_WORKSPACE_META_KEY,
} from "../../contracts/wire.js";
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
		...(meta[ACP_WORKSPACE_META_KEY] !== undefined
			? { workspace: projectTelemetryValue(SessionWorkspace, meta[ACP_WORKSPACE_META_KEY]) }
			: {}),
		...(meta[ACP_TRUST_META_KEY] !== undefined
			? { trust: projectTelemetryValue(ProjectTrust, meta[ACP_TRUST_META_KEY]) }
			: {}),
	};
}

export function sessionUpdateTelemetry(update: Record<string, unknown>): SessionTelemetry | null {
	const meta = record(update._meta);
	if (update.sessionUpdate === "session_info_update" && meta[ACP_EGGS_META_KEY] !== undefined)
		return { eggs: projectTelemetryValue(ActiveEggs, meta[ACP_EGGS_META_KEY]) };
	if (update.sessionUpdate === "session_info_update" && meta[ACP_MEMORY_META_KEY] !== undefined)
		return { memory: projectTelemetryValue(MemoryGuardian, meta[ACP_MEMORY_META_KEY]) };
	if (update.sessionUpdate === "usage_update") {
		const usage = record(meta[ACP_USAGE_META_KEY]);
		return {
			usage: projectTelemetryValue(LiveUsage, {
				used: update.used,
				size: update.size,
				...(update.cost !== undefined ? { cost: update.cost } : {}),
				...(meta[ACP_CONTEXT_META_KEY] !== undefined ? { context: meta[ACP_CONTEXT_META_KEY] } : {}),
				...(usage.session != null ? { session: usage.session } : {}),
			}),
		};
	}
	if (update.sessionUpdate === "plan") {
		if (!Array.isArray(update.entries)) throw new AppProblem("upstream_acp", "Clio returned invalid plan entries.");
		return {
			plan: projectTelemetryValue(SessionPlan, {
				title: record(meta[ACP_PLAN_META_KEY]).title ?? null,
				entries: update.entries.map((value, index) => {
					const entry = record(value),
						detail = record(record(entry._meta)[ACP_PLAN_META_KEY]);
					return {
						id: detail.id ?? String(index),
						content: entry.content,
						status: detail.status === "blocked" ? "blocked" : entry.status,
						reason: detail.reason ?? null,
					};
				}),
				truncated: record(meta[ACP_PLAN_META_KEY]).truncated === true,
			}),
		};
	}
	if (update.sessionUpdate === "session_info_update" && meta[ACP_WORKSPACE_META_KEY] !== undefined)
		return { workspace: projectTelemetryValue(SessionWorkspace, meta[ACP_WORKSPACE_META_KEY]) };
	return null;
}
