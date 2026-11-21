import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { WireContextLedger } from "../../contracts/context-ledger.js";
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
import { withLedgerDisplay } from "../services/context-display.js";
import { AppProblem } from "../services/problem.js";

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function projectTelemetryValue<S extends TSchema>(schema: S, value: unknown): Static<S> {
	const projected = Value.Clean(schema, structuredClone(value));
	if (!Value.Check(schema, projected))
		throw new AppProblem("upstream_acp", "CLIO Coder returned invalid session telemetry.");
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
				turn: usage.turn ?? null,
				session: usage.session ?? null,
				...(meta[ACP_CONTEXT_META_KEY] !== undefined
					? { context: withLedgerDisplay(projectTelemetryValue(WireContextLedger, meta[ACP_CONTEXT_META_KEY])) }
					: {}),
			}),
		};
	}
	if (update.sessionUpdate === "plan") {
		if (!Array.isArray(update.entries)) throw new AppProblem("upstream_acp", "CLIO Coder returned invalid plan entries.");
		const cancelled = record(meta[ACP_PLAN_META_KEY]).cancelled;
		return {
			plan: projectTelemetryValue(SessionPlan, {
				title: record(meta[ACP_PLAN_META_KEY]).title ?? null,
				...(cancelled !== undefined ? { cancelled } : {}),
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

/** The GUI's own label route refuses more than this; an engine title is cut to it instead. */
const TITLE_MAX_BYTES = 256;

/**
 * The session title a `session_info_update` carries: a string, null when the engine cleared it, undefined when the
 * frame says nothing readable about the title. An empty title reads as cleared, as the label route stores it.
 */
export function sessionInfoTitle(update: Record<string, unknown>): string | null | undefined {
	if (update.sessionUpdate !== "session_info_update" || !("title" in update)) return undefined;
	if (update.title === null || update.title === "") return null;
	if (typeof update.title !== "string") return undefined;
	let bytes = 0,
		title = "";
	for (const char of update.title) {
		bytes += Buffer.byteLength(char);
		if (bytes > TITLE_MAX_BYTES) break;
		title += char;
	}
	return title;
}
