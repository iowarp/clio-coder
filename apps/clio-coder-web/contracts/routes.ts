import { type Static, type TSchema, Type } from "typebox";
import { Empty, Id } from "./common.js";
import { Blueprints, DocPage, DocsSearch, DocsTree } from "./docs.js";
import { EventCursor } from "./events.js";
import { EvidenceDetail, EvidencePage } from "./evidence.js";
import {
	Councils,
	DispatchRun,
	DispatchRuns,
	FleetGates,
	FleetPageQuery,
	FleetReceipt,
	FleetRootDetail,
	FleetRoots,
} from "./fleet.js";
import { LibraryAgents, LibraryExtensions, LibraryInventory, LibraryVerifiers } from "./library.js";
import { Meta } from "./meta.js";
import { Accepted, Operation } from "./operations.js";
import { PermissionDecision } from "./permissions.js";
import { EvalDetail, EvalPage, UsageReport } from "./reports.js";
import { SessionSnapshot, SessionSummary, Workspace } from "./sessions.js";
import { ConfigGraph, SettingsReport } from "./settings.js";
import { Autonomy, AutonomyLevel, SafeSettings, SafeSettingsPatch } from "./settings-safe.js";
import { Interop, SystemReport } from "./system.js";
import { SessionTargets, TargetProbe } from "./targets.js";
import { CliTargets, Routing } from "./targets-cli.js";
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
	system: defineRoute({
		...get,
		path: "/api/system",
		response: SystemReport,
		summary: "Read-only doctor findings and the four resolved Clio paths",
	}),
	interop: defineRoute({
		...get,
		path: "/api/workspaces/:id/interop",
		params: operationParams,
		response: Interop,
		summary: "All registered external agents and bounded resource discovery",
	}),
	library: defineRoute({
		...get,
		path: "/api/workspaces/:id/library",
		params: operationParams,
		response: LibraryInventory,
		summary: "Canonical library packages, installed copies and recipe resources",
	}),
	libraryExtensions: defineRoute({
		...get,
		path: "/api/workspaces/:id/library/extensions",
		params: operationParams,
		response: LibraryExtensions,
		summary: "Installed extensions and admission state",
	}),
	libraryAgents: defineRoute({
		...get,
		path: "/api/workspaces/:id/library/agents",
		params: operationParams,
		response: LibraryAgents,
		summary: "Resolved user-facing agent specifications",
	}),
	libraryVerifiers: defineRoute({
		...get,
		path: "/api/workspaces/:id/library/verifiers",
		params: operationParams,
		response: LibraryVerifiers,
		summary: "Verifier discovery without executing checks",
	}),
	evals: defineRoute({
		...get,
		path: "/api/evals",
		query: FleetPageQuery,
		response: EvalPage,
		summary: "Paginated current-format evaluation reports",
	}),
	evalDetail: defineRoute({
		...get,
		path: "/api/evals/:id",
		params: operationParams,
		response: EvalDetail,
		summary: "Stored evaluation outcomes and metrics",
	}),
	usage: defineRoute({
		...get,
		path: "/api/workspaces/:id/usage",
		params: operationParams,
		response: UsageReport,
		summary: "Canonical usage report for the last 30 days",
	}),
	evidenceList: defineRoute({
		...get,
		path: "/api/evidence",
		query: FleetPageQuery,
		response: EvidencePage,
		summary: "Paginated evidence artifacts and trust verdicts",
	}),
	evidenceDetail: defineRoute({
		...get,
		path: "/api/evidence/:id",
		params: operationParams,
		response: EvidenceDetail,
		summary: "Evidence findings, canonical trust, admitted provenance and gate decisions",
	}),
	evidenceBuild: defineRoute({
		...post,
		path: "/api/workspaces/:id/evidence/:runId/build",
		params: Type.Object({ id: Id, runId: Id }, { additionalProperties: false }),
		response: Accepted,
		summary: "Collect evidence for a run through Clio",
	}),
	receiptVerify: defineRoute({
		...post,
		path: "/api/workspaces/:id/receipts/:runId/verify",
		params: Type.Object({ id: Id, runId: Id }, { additionalProperties: false }),
		response: Accepted,
		summary: "Recheck receipt integrity against its run through Clio",
	}),
	fleetRoots: defineRoute({
		...get,
		path: "/api/fleet/runs",
		response: FleetRoots,
		summary: "Paginated durable fleet roots",
		query: FleetPageQuery,
	}),
	fleetRoot: defineRoute({
		...get,
		path: "/api/fleet/runs/:id",
		response: FleetRootDetail,
		summary: "Fleet plan results, receipt and related topology",
		params: operationParams,
	}),
	dispatchRuns: defineRoute({
		...get,
		path: "/api/fleet/dispatches",
		response: DispatchRuns,
		summary: "Paginated durable dispatch runs",
		query: FleetPageQuery,
	}),
	dispatchRun: defineRoute({
		...get,
		path: "/api/fleet/dispatches/:id",
		response: DispatchRun,
		summary: "One durable dispatch run",
		params: operationParams,
	}),
	fleetReceipt: defineRoute({
		...get,
		path: "/api/fleet/receipts/:id",
		response: FleetReceipt,
		summary: "Full durable receipt by run identifier",
		params: operationParams,
	}),
	fleetCouncils: defineRoute({
		...get,
		path: "/api/fleet/councils",
		response: Councils,
		summary: "Canonical bounded council topology",
	}),
	fleetGates: defineRoute({
		...get,
		path: "/api/fleet/gates",
		response: FleetGates,
		summary: "Canonical verified gate decision topology",
	}),

	targetsList: defineRoute({
		...get,
		path: "/api/workspaces/:id/targets",
		params: operationParams,
		response: CliTargets,
		summary: "Configured targets through the canonical CLI",
	}),
	routing: defineRoute({
		...get,
		path: "/api/workspaces/:id/routing",
		params: operationParams,
		response: Routing,
		summary: "Offline models, fleet profiles and agent bindings",
	}),
	targetsProbe: defineRoute({
		...post,
		path: "/api/workspaces/:id/targets/:targetId/probe",
		params: Type.Object({ id: Id, targetId: Id }, { additionalProperties: false }),
		response: Accepted,
		summary: "Probe configured targets and return this target's status",
	}),
	targetsUse: defineRoute({
		...post,
		path: "/api/workspaces/:id/targets/:targetId/use",
		params: Type.Object({ id: Id, targetId: Id }, { additionalProperties: false }),
		response: Accepted,
		summary: "Use a target for chat and fleet through the CLI",
	}),
	targetsRemove: defineRoute({
		...post,
		path: "/api/workspaces/:id/targets/:targetId/remove",
		params: Type.Object({ id: Id, targetId: Id }, { additionalProperties: false }),
		response: Accepted,
		summary: "Remove a configured target through the CLI",
	}),
	workspaceSettings: defineRoute({
		...get,
		path: "/api/workspaces/:id/settings",
		params: operationParams,
		response: SettingsReport,
		summary: "Effective settings and each leaf's origin layer",
	}),
	configGraph: defineRoute({
		...get,
		path: "/api/workspaces/:id/config-graph",
		params: operationParams,
		response: ConfigGraph,
		summary: "Read-only customization graph without secrets or hook argv",
	}),
	docsTree: defineRoute({
		...get,
		path: "/api/docs/tree",
		response: DocsTree,
		summary: "Documentation navigation and Markdown inventory",
	}),
	docsPage: defineRoute({
		...get,
		path: "/api/docs/page",
		query: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }),
		response: DocPage,
		summary: "Read a contained Markdown page and resolve its links",
	}),
	docsSearch: defineRoute({
		...get,
		path: "/api/docs/search",
		query: Type.Object({ q: Type.String({ maxLength: 200 }) }, { additionalProperties: false }),
		response: DocsSearch,
		summary: "Search the package documentation",
	}),
	docsBlueprints: defineRoute({
		...get,
		path: "/api/docs/blueprints",
		response: Blueprints,
		summary: "Available visual blueprints and their paired guides",
	}),
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
