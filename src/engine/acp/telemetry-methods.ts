import { Value } from "typebox/value";
import type { CallFilter, CostReportV1, TelemetryUpdateV1 } from "../../core/telemetry/dto.js";
import { CallFilterSchema, parseFactRef, TELEMETRY_TOPICS } from "../../core/telemetry/dto.js";
import type { TelemetryReadModel, TelemetryView } from "../../domains/telemetry/contract.js";
import { AcpRequestError } from "./errors.js";
import { ACP_TELEMETRY_METHODS } from "./types.js";

export { ACP_TELEMETRY_META_KEY, ACP_TELEMETRY_METHODS, ACP_TELEMETRY_UPDATE_NOTIFICATION } from "./types.js";

/**
 * `_clio-coder/telemetry/*`: the telemetry read model's DTOs, as the terminal and `clio-coder telemetry --json` read
 * them (#434 §11.3). The session this server has bound answers from the live model, which equals a cold read of the
 * same journals; any other session this server holds is read cold. Every number arrives as `{fact, display, ref}`,
 * so a client renders `display` and resolves `ref` through `explain` instead of computing a total of its own.
 */

/** A calls report bigger than this is cut to its newest rows; `matched` still counts every match. */
const MAX_CALLS = 1000;
const DEFAULT_CALLS = 200;
const GROUP_BY: ReadonlySet<CostReportV1["groupBy"]> = new Set(["role", "model", "turn"]);

export interface AcpTelemetryRequestDeps {
	model: TelemetryReadModel;
	/** Refresh provider readings through the quota domain before reading their telemetry DTO (#434). */
	refreshQuota?: () => Promise<void>;
	/** The server's own parameter check: unknown keys refuse the request. */
	params(params: unknown, allowed: ReadonlySet<string>): Record<string, unknown>;
	/** The ACP session a request names, refusing one this server does not hold. */
	session(params: Record<string, unknown>): { id: string };
}

const invalid = (reason: string) =>
	new AcpRequestError(-32602, "invalid method parameters", { code: "invalid_params", reason });

/** The live view when it is this session's, else a cold read; null only when no directory holds the session. */
async function telemetryViewFor(model: TelemetryReadModel, sessionId: string): Promise<TelemetryView | null> {
	const live = model.live();
	return live?.sessionId === sessionId ? live : model.open(sessionId);
}

export function telemetryRequestHandlers(
	deps: AcpTelemetryRequestDeps,
): Record<string, (params: unknown) => Promise<unknown>> {
	const view = async (request: Record<string, unknown>): Promise<TelemetryView> => {
		const found = await telemetryViewFor(deps.model, deps.session(request).id);
		if (found) return found;
		throw new AcpRequestError(-32002, "session has no telemetry", { code: "session_unknown" });
	};
	const sessionScoped =
		(extra: readonly string[], read: (view: TelemetryView, request: Record<string, unknown>) => unknown) =>
		async (params: unknown) => {
			const request = deps.params(params, new Set(["sessionId", ...extra]));
			return read(await view(request), request);
		};
	const text = (value: unknown, name: string): string | undefined => {
		if (value === undefined) return undefined;
		if (typeof value !== "string" || value.length === 0 || value.length > 512) throw invalid(`${name} must be a string`);
		return value;
	};
	return {
		[ACP_TELEMETRY_METHODS.session]: sessionScoped([], (session) => session.session()),
		[ACP_TELEMETRY_METHODS.calls]: sessionScoped(["filter"], (session, request) => {
			const filter = (request.filter ?? {}) as CallFilter;
			if (!Value.Check(CallFilterSchema, filter)) throw invalid("filter is not a call filter");
			const limit = Math.min(filter.limit ?? DEFAULT_CALLS, MAX_CALLS);
			return session.calls({ ...filter, limit });
		}),
		[ACP_TELEMETRY_METHODS.cost]: sessionScoped(["groupBy"], (session, request) => {
			const groupBy = request.groupBy ?? "role";
			if (!GROUP_BY.has(groupBy as CostReportV1["groupBy"])) throw invalid("groupBy is role, model or turn");
			return session.cost(groupBy as CostReportV1["groupBy"]);
		}),
		[ACP_TELEMETRY_METHODS.cache]: sessionScoped([], (session) => session.cache()),
		[ACP_TELEMETRY_METHODS.timeline]: sessionScoped(["from", "to"], (session, request) => {
			const from = text(request.from, "from");
			const to = text(request.to, "to");
			if ((from === undefined) !== (to === undefined)) throw invalid("a range names both from and to");
			return session.timeline(from !== undefined && to !== undefined ? { from, to } : null);
		}),
		[ACP_TELEMETRY_METHODS.runs]: sessionScoped([], (session) => session.runs()),
		// A run is read only through a session that references it, so a client cannot walk other sessions' runs.
		[ACP_TELEMETRY_METHODS.run]: sessionScoped(["runId"], (session, request) => {
			const runId = text(request.runId, "runId");
			if (runId === undefined) throw invalid("runId is required");
			const run = session.run(runId);
			if (!run) throw new AcpRequestError(-32002, "the session references no such run", { code: "run_unknown" });
			return run;
		}),
		[ACP_TELEMETRY_METHODS.whyStopped]: sessionScoped([], (session) => session.whyStopped()),
		[ACP_TELEMETRY_METHODS.explain]: sessionScoped(["ref"], (session, request) => {
			const ref = text(request.ref, "ref");
			if (ref === undefined || !parseFactRef(ref)) throw invalid("ref is not a fact reference");
			return session.explain(ref);
		}),
		[ACP_TELEMETRY_METHODS.quota]: async (params) => {
			const request = deps.params(params, new Set(["provider"]));
			const provider = text(request.provider, "provider");
			await deps.refreshQuota?.();
			return deps.model.quota(provider);
		},
		[ACP_TELEMETRY_METHODS.health]: async (params) => {
			deps.params(params, new Set());
			return deps.model.health();
		},
	};
}

/** Forward each coalesced update for a session this server holds; the model caps them at 10 Hz. */
export function subscribeTelemetryUpdates(
	model: TelemetryReadModel,
	holds: (sessionId: string) => boolean,
	notify: (update: TelemetryUpdateV1) => void,
): () => void {
	const forward = (update: TelemetryUpdateV1) => {
		if (update.sessionId !== null && holds(update.sessionId)) notify(update);
	};
	const offs = TELEMETRY_TOPICS.map((topic) => model.subscribe(topic, forward));
	return () => {
		for (const off of offs) off();
	};
}
