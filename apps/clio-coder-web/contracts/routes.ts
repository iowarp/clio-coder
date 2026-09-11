import { type Static, type TSchema, Type } from "typebox";
import { Empty, Id } from "./common.js";
import { EventCursor } from "./events.js";
import { Meta } from "./meta.js";
import { Accepted, Operation } from "./operations.js";
import { PermissionDecision } from "./permissions.js";
import { SessionSnapshot, SessionSummary, Workspace } from "./sessions.js";
import { Autonomy, AutonomyLevel, SafeSettings, SafeSettingsPatch } from "./settings-safe.js";
import { SessionTargets, TargetProbe } from "./targets.js";
import { Install, Tools } from "./toolchain.js";
import {
	RowCursor,
	TraceEnvelope,
	TraceEventsPage,
	TraceEventsQuery,
	TraceGate,
	TraceParams,
	TracePhase,
	TraceProcess,
	TraceReceipt,
	TraceRun,
	TraceRunsPage,
	TraceRunsQuery,
	TraceStatus,
} from "./traces.js";

export interface Route<
	P extends TSchema = TSchema,
	Q extends TSchema = TSchema,
	B extends TSchema = TSchema,
	R extends TSchema = TSchema,
> {
	method: "GET" | "POST" | "PATCH" | "DELETE";
	path: string;
	params: P;
	query: Q;
	body: B;
	response: R;
	status: 200 | 202;
	summary: string;
	stream?: true;
}
export function defineRoute<P extends TSchema, Q extends TSchema, B extends TSchema, R extends TSchema>(
	route: Route<P, Q, B, R>,
): Route<P, Q, B, R> {
	return route;
}
export type Input<R extends Route> = {
	params: Static<R["params"]>;
	query: Static<R["query"]>;
	body: Static<R["body"]>;
};
export type Output<R extends Route> = Static<R["response"]>;
const toolParams = Type.Object({ toolId: Id }, { additionalProperties: false });
const operationParams = Type.Object({ id: Id }, { additionalProperties: false });
const get = { method: "GET", params: Empty, query: Empty, body: Empty, status: 200 } as const;
const post = { method: "POST", query: Empty, body: Empty, status: 202 } as const;
export const routes = {
	permission: defineRoute({
		...post,
		status: 200,
		path: "/api/sessions/:id/permissions/:permissionId",
		params: Type.Object({ id: Id, permissionId: Id }, { additionalProperties: false }),
		body: Type.Object({ decision: PermissionDecision }, { additionalProperties: false }),
		response: Empty,
		summary: "Answer a pending permission once",
	}),
	cancelTurn: defineRoute({
		...post,
		status: 200,
		path: "/api/sessions/:id/turns/:turnId/cancel",
		params: Type.Object({ id: Id, turnId: Id }, { additionalProperties: false }),
		response: Empty,
		summary: "Cancel the specified active turn",
	}),
	sessionSettings: defineRoute({
		...get,
		path: "/api/sessions/:id/settings",
		params: operationParams,
		response: SafeSettings,
		summary: "The four ACP safe settings",
	}),
	patchSessionSettings: defineRoute({
		...post,
		method: "PATCH",
		status: 200,
		path: "/api/sessions/:id/settings",
		params: operationParams,
		body: SafeSettingsPatch,
		response: SafeSettings,
		summary: "Patch only the four ACP safe settings",
	}),
	sessionTargets: defineRoute({
		...get,
		path: "/api/sessions/:id/targets",
		params: operationParams,
		response: SessionTargets,
		summary: "Targets available to this ACP session",
	}),
	probeSessionTarget: defineRoute({
		...post,
		status: 200,
		path: "/api/sessions/:id/targets/:targetId/probe",
		params: Type.Object({ id: Id, targetId: Id }, { additionalProperties: false }),
		response: TargetProbe,
		summary: "Probe a configured target through ACP",
	}),
	labelSession: defineRoute({
		...post,
		method: "PATCH",
		status: 200,
		path: "/api/sessions/:id",
		params: operationParams,
		body: Type.Object(
			{ label: Type.String({ maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), workspaceId: Type.Optional(Id) },
			{ additionalProperties: false },
		),
		response: Empty,
		summary: "Save the session label through ACP",
	}),
	deleteSession: defineRoute({
		...post,
		method: "DELETE",
		status: 200,
		path: "/api/sessions/:id",
		params: operationParams,
		body: Type.Object({ workspaceId: Type.Optional(Id) }, { additionalProperties: false }),
		response: Empty,
		summary: "Delete a closed session through ACP",
	}),
	sessionAutonomy: defineRoute({
		...get,
		path: "/api/sessions/:id/autonomy",
		params: operationParams,
		response: Autonomy,
		summary: "Current session autonomy and source",
	}),
	setSessionAutonomy: defineRoute({
		...post,
		status: 200,
		path: "/api/sessions/:id/autonomy",
		params: operationParams,
		body: Type.Object({ level: AutonomyLevel }, { additionalProperties: false }),
		response: Autonomy,
		summary: "Set autonomy for this session",
	}),
	workspaces: defineRoute({
		...get,
		path: "/api/workspaces",
		response: Type.Array(Workspace),
		summary: "Recent workspaces",
	}),
	openWorkspace: defineRoute({
		...post,
		status: 200,
		params: Empty,
		path: "/api/workspaces",
		body: Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
		response: Workspace,
		summary: "Open an existing workspace by absolute path",
	}),
	workspace: defineRoute({
		...get,
		params: operationParams,
		path: "/api/workspaces/:id",
		response: Workspace,
		summary: "Canonical workspace",
	}),
	sessionHistory: defineRoute({
		...get,
		params: operationParams,
		path: "/api/workspaces/:id/sessions",
		response: Type.Array(SessionSummary),
		summary: "Durable session history without starting a child",
	}),
	newSession: defineRoute({
		...post,
		status: 200,
		params: operationParams,
		path: "/api/workspaces/:id/sessions",
		response: SessionSnapshot,
		summary: "Start a supervised ACP session",
	}),
	loadSession: defineRoute({
		...post,
		status: 200,
		params: operationParams,
		path: "/api/sessions/:id/load",
		body: Type.Object({ workspaceId: Id }, { additionalProperties: false }),
		response: SessionSnapshot,
		summary: "Load a durable session and project its replay",
	}),
	sessions: defineRoute({
		...get,
		path: "/api/sessions",
		response: Type.Array(SessionSnapshot),
		summary: "Sessions supervised or recovered by this server",
	}),
	session: defineRoute({
		...get,
		params: operationParams,
		path: "/api/sessions/:id",
		response: SessionSnapshot,
		summary: "Session projection snapshot",
	}),
	turn: defineRoute({
		...post,
		params: operationParams,
		path: "/api/sessions/:id/turns",
		body: Type.Object(
			{ text: Type.String({ minLength: 1, maxLength: 32000, pattern: "\\S" }) },
			{ additionalProperties: false },
		),
		response: Type.Object({ turnId: Id }, { additionalProperties: false }),
		summary: "Start a streamed turn",
	}),
	closeSession: defineRoute({
		...post,
		status: 200,
		params: operationParams,
		path: "/api/sessions/:id/close",
		response: SessionSnapshot,
		summary: "Close the supervised session and its child",
	}),
	traceStatus: defineRoute({
		...get,
		path: "/api/traces/status",
		response: TraceStatus,
		summary: "Trace availability and retention",
	}),
	traceRuns: defineRoute({
		...get,
		path: "/api/traces/runs",
		query: TraceRunsQuery,
		response: TraceRunsPage,
		summary: "Paginated trace history",
	}),
	traceRun: defineRoute({
		...get,
		path: "/api/traces/runs/:runId",
		params: TraceParams,
		response: TraceRun,
		summary: "Trace run",
	}),
	tracePhases: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/phases",
		params: TraceParams,
		response: Type.Array(TracePhase),
		summary: "Run phases",
	}),
	traceGates: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/gates",
		params: TraceParams,
		response: Type.Array(TraceGate),
		summary: "Run gates",
	}),
	traceEnvelopes: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/envelopes",
		params: TraceParams,
		response: Type.Array(TraceEnvelope),
		summary: "Run envelopes",
	}),
	traceProcesses: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/processes",
		params: TraceParams,
		response: Type.Array(TraceProcess),
		summary: "Run processes",
	}),
	traceEvents: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/events",
		params: TraceParams,
		query: TraceEventsQuery,
		response: TraceEventsPage,
		summary: "Run events by rowid",
	}),
	traceReceipt: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/receipt",
		params: TraceParams,
		query: Type.Object({ include: Type.Optional(Type.Literal("full")) }, { additionalProperties: false }),
		response: TraceReceipt,
		summary: "Receipt and evidence summary; full payload on request",
	}),
	traceLive: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/live",
		params: TraceParams,
		query: Type.Object(
			{ after: Type.Optional(RowCursor), token: Type.Optional(Type.String({ maxLength: 256 })) },
			{ additionalProperties: false },
		),
		response: Type.String(),
		stream: true,
		summary: "Live rowid event tail",
	}),
	meta: defineRoute({ ...get, path: "/api/meta", response: Meta, summary: "Application and Clio versions" }),
	openapi: defineRoute({
		...get,
		path: "/api/openapi.json",
		response: Type.Record(Type.String(), Type.Unknown()),
		summary: "OpenAPI contract",
	}),
	events: defineRoute({
		...get,
		path: "/api/events",
		query: Type.Object(
			{ after: Type.Optional(EventCursor), token: Type.Optional(Type.String({ maxLength: 256 })) },
			{ additionalProperties: false },
		),
		response: Type.String(),
		stream: true,
		summary: "Global event stream",
	}),
	tools: defineRoute({
		...get,
		path: "/api/toolchain/tools",
		response: Tools,
		summary: "Pinned tools in registry order",
	}),
	install: defineRoute({
		...post,
		path: "/api/toolchain/tools/:toolId/install",
		params: toolParams,
		body: Install,
		response: Accepted,
		summary: "Install the pinned tool",
	}),
	remove: defineRoute({
		...post,
		path: "/api/toolchain/tools/:toolId/remove",
		params: toolParams,
		response: Accepted,
		summary: "Remove vendored versions",
	}),
	operation: defineRoute({
		...get,
		path: "/api/operations/:id",
		params: operationParams,
		response: Operation,
		summary: "Operation snapshot",
	}),
	cancel: defineRoute({
		...post,
		status: 200,
		path: "/api/operations/:id/cancel",
		params: operationParams,
		response: Operation,
		summary: "Cancel a cancellable operation",
	}),
};
