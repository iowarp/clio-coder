/**
 * Renderer state for protocol v3.
 *
 * The host holds the authoritative projection; this module validates what
 * arrives, folds turn events through the same `applyTurnEvent` the host used,
 * and keeps nothing the host did not send. One project is open at a time.
 */

import {
	type CommandErrorCode,
	MAX_WIRE_FLEET_RUNS,
	PRODUCT_NAME,
	type ProjectBrowseListingPayload,
	PROTOCOL_VERSION,
	type ServerEvent,
	validateDispatchInspection,
	validateEvidenceInspection,
	validateFleetInspection,
	validateServerEvent,
	validateToolchainInspection,
	validateTraceInspection,
	type WireCatalogInspection,
	type WireClioSnapshot,
	type WireConfigInspection,
	type WireDeleteChallenge,
	type WireDispatchInspection,
	type WireEvidenceDetail,
	type WireEvidenceInspection,
	type WireFleetInspection,
	type WireFleetRun,
	type WireFleetVerification,
	type WireProjectPath,
	type WireProjectSummary,
	type WireProjectWorkspace,
	type WireRecoveryInspection,
	type WireRoutingInspection,
	type WireSessionSummary,
	type WireSettingsState,
	type WireTarget,
	type WireToolchainInspection,
	type WireTraceInspection,
	type WireTreeNode,
	type WireUsageInspection,
} from "./protocol.ts";
import {
	applyTurnEvent,
	emptyTurnProjection,
	restoreTurnProjection,
	type TurnEventInput,
	type TurnProjection,
} from "./timeline.ts";

export type ConnectionState =
	| "connecting"
	| "connected"
	| "disconnected"
	| "failed";

export interface OpenWorkspaceState {
	readonly project: WireProjectSummary;
	readonly tree: readonly WireTreeNode[];
	readonly treeTruncated: boolean;
	readonly sessions: readonly WireSessionSummary[];
	readonly sessionsTruncated: boolean;
	readonly clio: WireClioSnapshot;
	readonly projection: TurnProjection;
	readonly deleteChallenge: WireDeleteChallenge | null;
	readonly settings: WireSettingsState | null;
	readonly configInspection: WireConfigInspection | null;
	readonly catalogInspection: WireCatalogInspection | null;
	readonly usageInspection: WireUsageInspection | null;
	readonly routingInspection: WireRoutingInspection | null;
	readonly targets: readonly WireTarget[] | null;
	readonly targetsTruncated: boolean;
	/** Dispatch runs Clio Coder reported on this session, oldest first. */
	readonly fleet: readonly WireFleetRun[];
	readonly processGeneration: string | null;
}

export interface WireBootstrap {
	readonly protocolVersion: typeof PROTOCOL_VERSION;
	readonly appName: typeof PRODUCT_NAME;
	readonly workspaceInstanceId: string;
	readonly localToken: string;
	readonly mode: "browser" | "desktop";
	readonly openProjectId: string | null;
	readonly workspace: WireProjectWorkspace | null;
	readonly recent: readonly WireProjectSummary[];
	readonly homePath: string;
	readonly stateDirNote: string;
	readonly securityNote: string;
	readonly dispatchInspection: WireDispatchInspection | null;
	readonly fleetInspection: WireFleetInspection | null;
	readonly toolchainInspection: WireToolchainInspection | null;
	readonly traceInspection: WireTraceInspection | null;
	readonly evidenceInspection: WireEvidenceInspection | null;
}

export interface Notice {
	readonly tone: "error" | "warning" | "info";
	readonly message: string;
}

export interface AppState {
	readonly boot: "loading" | "ready" | "failed";
	readonly bootError: string | null;
	readonly workspaceInstanceId: string | null;
	readonly localToken: string | null;
	readonly mode: "browser" | "desktop";
	readonly connection: ConnectionState;
	readonly open: OpenWorkspaceState | null;
	readonly recent: readonly WireProjectSummary[];
	readonly homePath: string;
	readonly stateDirNote: string;
	readonly securityNote: string;
	readonly dispatchInspection: WireDispatchInspection | null;
	readonly fleetInspection: WireFleetInspection | null;
	readonly toolchainInspection: WireToolchainInspection | null;
	readonly traceInspection: WireTraceInspection | null;
	readonly evidenceInspection: WireEvidenceInspection | null;
	/** The one bundle the operator opened, if any. */
	readonly evidenceDetail: WireEvidenceDetail | null;
	/** The most recent on-demand receipt check, if any. */
	readonly fleetVerification: WireFleetVerification | null;
	readonly recoveryInspection: WireRecoveryInspection | null;
	readonly browse: ProjectBrowseListingPayload | null;
	readonly leftDrawerOpen: boolean;
	readonly settingsOpen: boolean;
	/**
	 * Whether an approval may post a desktop notification. Held in memory only,
	 * because the browser's own permission is the durable half of this decision
	 * and Workbench must not keep a second, staler copy of it.
	 */
	readonly desktopNotifications: boolean;
	readonly announcement: string;
	readonly notice: Notice | null;
	/** Request id of a submitted prompt whose acknowledgement has not arrived. */
	readonly pendingTurnStart: string | null;
	/** Request id of the one serialized read-only configuration inspection. */
	readonly pendingConfigInspect: string | null;
	/** Request id of the one serialized read-only resource catalog inspection. */
	readonly pendingCatalogInspect: string | null;
	/** Request id of the one serialized project usage inspection. */
	readonly pendingUsageInspect: string | null;
	/** Request id of the one serialized offline model and worker-routing inspection. */
	readonly pendingRoutingInspect: string | null;
	/** Request id of the installation-wide, read-only dispatch snapshot. */
	readonly pendingDispatchInspect: string | null;
	/** Request id of the installation-wide durable run and journal snapshot. */
	readonly pendingFleetInspect: string | null;
	/** Request id of the installation-wide pinned external-tool inventory. */
	readonly pendingToolchainInspect: string | null;
	/** Request id of the installation-wide durable trace accounting snapshot. */
	readonly pendingTraceInspect: string | null;
	/** Request id of the installation-wide durable evidence inventory. */
	readonly pendingEvidenceInspect: string | null;
	/** The bundle id whose trust record is being read, if any. */
	readonly pendingEvidenceRead: string | null;
	/** The run id whose receipt is being re-authenticated, if any. */
	readonly pendingFleetVerify: string | null;
	/** Request id of the redacted Clio Coder doctor/paths sweep. */
	readonly pendingRecoveryInspect: string | null;
	/**
	 * The recent project a `project.select` is waiting on. A refusal for this
	 * exact request is the only evidence the renderer has that a remembered folder
	 * stopped being openable since bootstrap computed its availability.
	 */
	readonly pendingProjectSelect: {
		readonly requestId: string;
		readonly projectId: string;
	} | null;
	readonly lastSequence: number;
}

export type AppAction =
	| { readonly type: "bootstrap.loaded"; readonly payload: WireBootstrap }
	| { readonly type: "bootstrap.failed"; readonly message: string }
	| {
		readonly type: "connection.changed";
		readonly connection: ConnectionState;
	}
	| { readonly type: "drawer.left"; readonly open: boolean }
	| { readonly type: "settings.opened"; readonly open: boolean }
	| { readonly type: "notifications.set"; readonly enabled: boolean }
	| { readonly type: "browse.dismissed" }
	| { readonly type: "notice.dismissed" }
	| {
		readonly type: "notice.raised";
		readonly tone: Notice["tone"];
		readonly message: string;
	}
	| { readonly type: "turn.submitted"; readonly requestId: string }
	| { readonly type: "config.inspect.submitted"; readonly requestId: string }
	| { readonly type: "catalog.inspect.submitted"; readonly requestId: string }
	| { readonly type: "usage.inspect.submitted"; readonly requestId: string }
	| { readonly type: "routing.inspect.submitted"; readonly requestId: string }
	| { readonly type: "dispatch.inspect.submitted"; readonly requestId: string }
	| { readonly type: "fleet.inspect.submitted"; readonly requestId: string }
	| { readonly type: "toolchain.inspect.submitted"; readonly requestId: string }
	| { readonly type: "trace.inspect.submitted"; readonly requestId: string }
	| { readonly type: "evidence.inspect.submitted"; readonly requestId: string }
	| {
		readonly type: "evidence.read.submitted";
		readonly requestId: string;
		readonly evidenceId: string;
	}
	| {
		readonly type: "fleet.verify.submitted";
		readonly requestId: string;
		readonly runId: string;
	}
	| { readonly type: "recovery.inspect.submitted"; readonly requestId: string }
	| {
		readonly type: "project.select.submitted";
		readonly requestId: string;
		readonly projectId: string;
	}
	| { readonly type: "host.events"; readonly events: readonly ServerEvent[] }
	| { readonly type: "host.event"; readonly event: ServerEvent };

export const initialAppState: AppState = {
	boot: "loading",
	bootError: null,
	workspaceInstanceId: null,
	localToken: null,
	mode: "browser",
	connection: "connecting",
	open: null,
	recent: [],
	homePath: "/",
	stateDirNote: "The desktop app has not reported where it keeps its own state yet.",
	securityNote: "The desktop app has not reported its project boundary yet.",
	dispatchInspection: null,
	fleetInspection: null,
	toolchainInspection: null,
	traceInspection: null,
	evidenceInspection: null,
	evidenceDetail: null,
	fleetVerification: null,
	recoveryInspection: null,
	browse: null,
	leftDrawerOpen: false,
	settingsOpen: false,
	desktopNotifications: true,
	announcement: `Loading ${PRODUCT_NAME}`,
	notice: null,
	pendingTurnStart: null,
	pendingConfigInspect: null,
	pendingCatalogInspect: null,
	pendingUsageInspect: null,
	pendingRoutingInspect: null,
	pendingDispatchInspect: null,
	pendingFleetInspect: null,
	pendingToolchainInspect: null,
	pendingTraceInspect: null,
	pendingEvidenceInspect: null,
	pendingEvidenceRead: null,
	pendingFleetVerify: null,
	pendingRecoveryInspect: null,
	pendingProjectSelect: null,
	lastSequence: 0,
};

const encoder = new TextEncoder();
const BOOTSTRAP_KEYS = [
	"protocolVersion",
	"appName",
	"workspaceInstanceId",
	"localToken",
	"mode",
	"openProjectId",
	"workspace",
	"recent",
	"homePath",
	"stateDirNote",
	"securityNote",
	"dispatchInspection",
	"fleetInspection",
	"toolchainInspection",
	"traceInspection",
	"evidenceInspection",
] as const;

function invalidBootstrap(detail: string): never {
	throw new Error(
		`The GUI bootstrap response did not match protocol v${PROTOCOL_VERSION}: ${detail}.`,
	);
}

function expectExactBootstrapRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return invalidBootstrap("the payload must be a record");
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return invalidBootstrap("the payload must be a plain record");
	}
	const record = value as Record<string, unknown>;
	const expected = new Set<string>(BOOTSTRAP_KEYS);
	for (const key of Object.keys(record)) {
		if (!expected.has(key)) {
			invalidBootstrap(`the payload has unknown field ${JSON.stringify(key)}`);
		}
	}
	for (const key of BOOTSTRAP_KEYS) {
		if (!Object.hasOwn(record, key)) {
			invalidBootstrap(`the payload is missing field ${JSON.stringify(key)}`);
		}
	}
	return record;
}

function expectBootstrapString(
	value: unknown,
	label: string,
	options: { readonly maxBytes: number; readonly trim?: boolean } = {
		maxBytes: 4096,
	},
): string {
	if (typeof value !== "string" || value.length === 0) {
		return invalidBootstrap(`${label} must be a non-empty string`);
	}
	if (options.trim && value.trim() !== value) {
		return invalidBootstrap(`${label} must not have surrounding whitespace`);
	}
	if (encoder.encode(value).byteLength > options.maxBytes) {
		return invalidBootstrap(`${label} is too long`);
	}
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (
			codePoint === 0x7f ||
			(codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a &&
				codePoint !== 0x0d)
		) {
			return invalidBootstrap(`${label} contains an unsafe control character`);
		}
	}
	return value;
}

function expectBootstrapId(value: unknown, label: string): string {
	const id = expectBootstrapString(value, label, { maxBytes: 128, trim: true });
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
		return invalidBootstrap(`${label} is not a valid identifier`);
	}
	return id;
}

function expectAbsolutePath(value: unknown, label: string): string {
	const path = expectBootstrapString(value, label, {
		maxBytes: 4096,
		trim: true,
	});
	if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(path)) {
		return invalidBootstrap(`${label} must be absolute`);
	}
	return path;
}

/**
 * The one contradiction the renderer refuses: an approval that is pending
 * without the phase that says so, or the reverse. The host publishes the card
 * and the phase in the same step, so a disagreement means a broken host.
 */
export function workspaceConsistencyError(
	workspace: WireProjectWorkspace,
): string | null {
	const awaiting = workspace.clio.phase === "awaiting-approval";
	if (awaiting !== (workspace.pendingPermission !== null)) {
		return "pendingPermission must be present exactly while Clio Coder awaits approval";
	}
	if (workspace.pendingPermission !== null && workspace.activeTurn === null) {
		return "pendingPermission requires an active turn";
	}
	if (
		workspace.pendingPermission !== null &&
		workspace.pendingPermission.toolCallId.length === 0
	) {
		return "pendingPermission must name its tool call";
	}
	const sessionIds = new Set(workspace.sessions.map((session) => session.id));
	if (sessionIds.size !== workspace.sessions.length) {
		return "session identifiers must be unique";
	}
	return null;
}

function validateBootstrapWorkspace(
	value: unknown,
	workspaceInstanceId: string,
	projectId: string,
): WireProjectWorkspace {
	let event: ServerEvent;
	try {
		// Reuse the protocol's authoritative workspace validator.
		event = validateServerEvent({
			protocolVersion: PROTOCOL_VERSION,
			workspaceInstanceId,
			sequence: 1,
			eventId: "bootstrap-workspace",
			kind: "project.opened",
			projectId,
			terminal: false,
			payload: { workspace: value },
		});
	} catch (error) {
		return invalidBootstrap(
			`workspace is invalid${error instanceof Error ? ` (${error.message})` : ""}`,
		);
	}
	if (event.kind !== "project.opened") {
		return invalidBootstrap("workspace could not be validated");
	}
	const consistency = workspaceConsistencyError(event.payload.workspace);
	if (consistency !== null) {
		return invalidBootstrap(`workspace is contradictory (${consistency})`);
	}
	return event.payload.workspace;
}

function validateRecent(
	value: unknown,
	workspaceInstanceId: string,
): readonly WireProjectSummary[] {
	if (!Array.isArray(value) || value.length > 512) {
		return invalidBootstrap("recent must be a bounded array");
	}
	const summaries = value.map((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return invalidBootstrap(`recent[${index}] must be a record`);
		}
		const record = entry as Record<string, unknown>;
		return {
			id: expectBootstrapId(record.id, `recent[${index}].id`),
			displayName: expectBootstrapString(
				record.displayName,
				`recent[${index}].displayName`,
				{
					maxBytes: 128,
					trim: true,
				},
			),
			rootPath: expectAbsolutePath(
				record.rootPath,
				`recent[${index}].rootPath`,
			),
			lastOpenedAt: expectBootstrapString(
				record.lastOpenedAt,
				`recent[${index}].lastOpenedAt`,
				{ maxBytes: 128 },
			),
			available: typeof record.available === "boolean"
				? record.available
				: invalidBootstrap(`recent[${index}].available must be a boolean`),
		};
	});
	if (new Set(summaries.map((entry) => entry.id)).size !== summaries.length) {
		return invalidBootstrap("recent project identifiers must be unique");
	}
	void workspaceInstanceId;
	return summaries;
}

export function parseBootstrapPayload(value: unknown): WireBootstrap {
	const record = expectExactBootstrapRecord(value);
	if (record.protocolVersion !== PROTOCOL_VERSION) {
		invalidBootstrap(`protocolVersion must be ${PROTOCOL_VERSION}`);
	}
	if (record.appName !== PRODUCT_NAME) invalidBootstrap("appName is invalid");
	const workspaceInstanceId = expectBootstrapId(
		record.workspaceInstanceId,
		"workspaceInstanceId",
	);
	const localToken = expectBootstrapString(record.localToken, "localToken", {
		maxBytes: 512,
		trim: true,
	});
	if (record.mode !== "browser" && record.mode !== "desktop") {
		invalidBootstrap("mode is invalid");
	}
	const openProjectId = record.openProjectId === null ? null : expectBootstrapId(record.openProjectId, "openProjectId");
	if ((record.workspace === null) !== (openProjectId === null)) {
		invalidBootstrap(
			"workspace and openProjectId must be present or absent together",
		);
	}
	const workspace = record.workspace === null || openProjectId === null ? null : validateBootstrapWorkspace(
		record.workspace,
		workspaceInstanceId,
		openProjectId,
	);
	if (workspace !== null && workspace.project.id !== openProjectId) {
		invalidBootstrap("workspace does not describe the open project");
	}
	return {
		protocolVersion: PROTOCOL_VERSION,
		appName: PRODUCT_NAME,
		workspaceInstanceId,
		localToken,
		mode: record.mode,
		openProjectId,
		workspace,
		recent: validateRecent(record.recent, workspaceInstanceId),
		homePath: expectAbsolutePath(record.homePath, "homePath"),
		stateDirNote: expectBootstrapString(record.stateDirNote, "stateDirNote", {
			maxBytes: 4096,
		}),
		securityNote: expectBootstrapString(record.securityNote, "securityNote", {
			maxBytes: 4096,
		}),
		dispatchInspection: record.dispatchInspection === null ? null : validateDispatchInspection(
			record.dispatchInspection,
			"bootstrap.dispatchInspection",
		),
		fleetInspection: record.fleetInspection === null ? null : validateFleetInspection(
			record.fleetInspection,
			"bootstrap.fleetInspection",
		),
		toolchainInspection: record.toolchainInspection === null ? null : validateToolchainInspection(
			record.toolchainInspection,
			"bootstrap.toolchainInspection",
		),
		traceInspection: record.traceInspection === null ? null : validateTraceInspection(
			record.traceInspection,
			"bootstrap.traceInspection",
		),
		evidenceInspection: record.evidenceInspection === null ? null : validateEvidenceInspection(
			record.evidenceInspection,
			"bootstrap.evidenceInspection",
		),
	};
}

export function workspaceFromWire(
	workspace: WireProjectWorkspace,
): OpenWorkspaceState {
	return {
		project: workspace.project,
		tree: workspace.tree,
		treeTruncated: workspace.treeTruncated,
		sessions: workspace.sessions,
		sessionsTruncated: workspace.sessionsTruncated,
		clio: workspace.clio,
		projection: restoreTurnProjection({
			timeline: workspace.timeline,
			timelineTruncated: workspace.timelineTruncated,
			activeTurn: workspace.activeTurn,
			pendingPermission: workspace.pendingPermission,
		}),
		deleteChallenge: workspace.deleteChallenge,
		settings: workspace.settings,
		configInspection: workspace.configInspection,
		catalogInspection: workspace.catalogInspection,
		usageInspection: workspace.usageInspection,
		routingInspection: workspace.routingInspection,
		targets: workspace.targets,
		targetsTruncated: workspace.targetsTruncated,
		fleet: workspace.fleet,
		processGeneration: workspace.processGeneration,
	};
}

const TURN_EVENT_KINDS = new Set<ServerEvent["kind"]>([
	"turn.started",
	"turn.text",
	"turn.thought",
	"turn.tool",
	"turn.loop",
	"turn.permission.requested",
	"turn.permission.resolved",
	"turn.terminal",
]);

function applyToOpen(
	open: OpenWorkspaceState,
	event: ServerEvent,
	now: string,
): OpenWorkspaceState {
	if (TURN_EVENT_KINDS.has(event.kind)) {
		if (event.turnId === undefined) return open;
		const input = {
			kind: event.kind,
			turnId: event.turnId,
			payload: event.payload,
		} as TurnEventInput;
		return { ...open, projection: applyTurnEvent(open.projection, input, now) };
	}
	switch (event.kind) {
		case "project.snapshot":
		case "fs.changed":
			return {
				...open,
				tree: event.payload.tree,
				treeTruncated: event.payload.treeTruncated,
				deleteChallenge: null,
			};
		case "fs.delete.challenge":
			return { ...open, deleteChallenge: event.payload };
		case "clio.state":
			return { ...open, clio: event.payload.snapshot };
		case "session.list":
			return {
				...open,
				sessions: event.payload.sessions,
				sessionsTruncated: event.payload.truncated,
			};
		case "settings.state":
			return { ...open, settings: event.payload.settings };
		case "config.state":
			return { ...open, configInspection: event.payload.inspection };
		case "catalog.state":
			return { ...open, catalogInspection: event.payload.inspection };
		case "usage.state":
			return { ...open, usageInspection: event.payload.inspection };
		case "routing.state":
			return { ...open, routingInspection: event.payload.inspection };
		case "targets.state":
			return {
				...open,
				targets: event.payload.targets,
				targetsTruncated: event.payload.truncated,
			};
		case "fleet.activity": {
			// Keyed by run: the strip shows one entry per run, and a later fact
			// about a run replaces the earlier one in place rather than stacking.
			const run = event.payload.run;
			const index = open.fleet.findIndex((candidate) => candidate.runId === run.runId);
			const fleet = index < 0
				? [...open.fleet, run].slice(-MAX_WIRE_FLEET_RUNS)
				: open.fleet.map((candidate, candidateIndex) => candidateIndex === index ? run : candidate);
			return { ...open, fleet };
		}
		case "targets.probed": {
			const targetId = event.payload.targetId;
			const health = event.payload.health;
			return {
				...open,
				targets: (open.targets ?? []).map((target) => target.id === targetId ? { ...target, health } : target),
			};
		}
		default:
			return open;
	}
}

function announcementFor(event: ServerEvent): string | null {
	switch (event.kind) {
		case "turn.permission.requested":
			return `${event.payload.title} needs your approval`;
		case "turn.terminal":
			return event.payload.outcome === "completed" ? "Clio Coder finished this turn." : event.payload.summary;
		case "turn.loop":
			return `Clio Coder blocked a repeated ${event.payload.tool} call`;
		case "clio.state":
			return event.payload.snapshot.phase === "failed"
				? (event.payload.snapshot.lastFailure?.summary ?? "Clio Coder failed.")
				: null;
		case "project.opened":
			return `${event.payload.workspace.project.displayName} is open`;
		case "project.forgotten":
			return "The project was closed and removed from the recent list";
		default:
			return null;
	}
}

/** Command failures the composer must reflect rather than only announce. */
function noticeToneFor(code: CommandErrorCode): Notice["tone"] {
	return code === "conflict" || code === "refused" || code === "not-ready" ? "warning" : "error";
}

export function appReducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "bootstrap.loaded": {
			const open = action.payload.workspace === null ? null : workspaceFromWire(action.payload.workspace);
			return {
				...state,
				boot: "ready",
				bootError: null,
				workspaceInstanceId: action.payload.workspaceInstanceId,
				localToken: action.payload.localToken,
				mode: action.payload.mode,
				open,
				recent: action.payload.recent,
				homePath: action.payload.homePath,
				stateDirNote: action.payload.stateDirNote,
				securityNote: action.payload.securityNote,
				dispatchInspection: action.payload.dispatchInspection,
				fleetInspection: action.payload.fleetInspection,
				toolchainInspection: action.payload.toolchainInspection,
				traceInspection: action.payload.traceInspection,
				evidenceInspection: action.payload.evidenceInspection,
				evidenceDetail: null,
				fleetVerification: null,
				pendingConfigInspect: null,
				pendingCatalogInspect: null,
				pendingUsageInspect: null,
				pendingRoutingInspect: null,
				pendingDispatchInspect: null,
				pendingFleetInspect: null,
				pendingToolchainInspect: null,
				pendingTraceInspect: null,
				pendingEvidenceInspect: null,
				pendingEvidenceRead: null,
				pendingFleetVerify: null,
				announcement: open === null
					? `${PRODUCT_NAME} is ready. Open a project folder to begin.`
					: `${open.project.displayName} is open`,
			};
		}
		case "bootstrap.failed":
			return {
				...state,
				boot: "failed",
				bootError: action.message,
				connection: "failed",
				announcement: action.message,
			};
		case "connection.changed":
			return {
				...state,
				connection: action.connection,
				lastSequence: action.connection === "connected" ? 0 : state.lastSequence,
				announcement: action.connection === "connected"
					? "Local GUI connection ready"
					: action.connection === "disconnected"
					? "The local GUI connection dropped; reconnecting"
					: state.announcement,
			};
		case "drawer.left":
			return { ...state, leftDrawerOpen: action.open };
		case "settings.opened":
			return { ...state, settingsOpen: action.open };
		case "notifications.set":
			return { ...state, desktopNotifications: action.enabled };
		case "browse.dismissed":
			return { ...state, browse: null };
		case "notice.dismissed":
			return { ...state, notice: null };
		case "notice.raised":
			return {
				...state,
				notice: { tone: action.tone, message: action.message },
				announcement: action.message,
			};
		case "turn.submitted":
			return { ...state, pendingTurnStart: action.requestId };
		case "config.inspect.submitted":
			return { ...state, pendingConfigInspect: action.requestId };
		case "catalog.inspect.submitted":
			return { ...state, pendingCatalogInspect: action.requestId };
		case "usage.inspect.submitted":
			return { ...state, pendingUsageInspect: action.requestId };
		case "routing.inspect.submitted":
			return { ...state, pendingRoutingInspect: action.requestId };
		case "dispatch.inspect.submitted":
			return { ...state, pendingDispatchInspect: action.requestId };
		case "fleet.inspect.submitted":
			return { ...state, pendingFleetInspect: action.requestId };
		case "toolchain.inspect.submitted":
			return { ...state, pendingToolchainInspect: action.requestId };
		case "trace.inspect.submitted":
			return { ...state, pendingTraceInspect: action.requestId };
		case "evidence.inspect.submitted":
			return { ...state, pendingEvidenceInspect: action.requestId };
		case "evidence.read.submitted":
			return { ...state, pendingEvidenceRead: action.evidenceId };
		case "fleet.verify.submitted":
			return { ...state, pendingFleetVerify: action.runId };
		case "recovery.inspect.submitted":
			return { ...state, pendingRecoveryInspect: action.requestId };
		case "project.select.submitted":
			return {
				...state,
				pendingProjectSelect: {
					requestId: action.requestId,
					projectId: action.projectId,
				},
			};
		case "host.events": {
			let next = state;
			for (const event of action.events) {
				next = appReducer(next, { type: "host.event", event });
			}
			return next;
		}
		case "host.event": {
			const event = action.event;
			if (
				state.workspaceInstanceId !== null &&
				event.workspaceInstanceId !== state.workspaceInstanceId
			) return state;
			if (event.kind === "connection.ready") {
				return {
					...state,
					connection: "connected",
					lastSequence: event.sequence,
					announcement: "Local GUI connection ready",
				};
			}
			if (event.sequence <= state.lastSequence) return state;
			const sequenced: AppState = { ...state, lastSequence: event.sequence };
			switch (event.kind) {
				case "protocol.error":
					return {
						...sequenced,
						connection: "failed",
						notice: { tone: "error", message: event.payload.message },
						announcement: event.payload.message,
						pendingTurnStart: null,
						pendingConfigInspect: null,
						pendingCatalogInspect: null,
						pendingUsageInspect: null,
						pendingRoutingInspect: null,
						pendingDispatchInspect: null,
						pendingFleetInspect: null,
						pendingToolchainInspect: null,
						pendingTraceInspect: null,
						pendingEvidenceInspect: null,
						pendingEvidenceRead: null,
						pendingFleetVerify: null,
						pendingRecoveryInspect: null,
					};
				case "command.error": {
					const pendingSelect = state.pendingProjectSelect;
					const answersSelect = pendingSelect !== null &&
						event.payload.requestId === pendingSelect.requestId;
					// Only a refusal means the guards or the filesystem rejected the
					// canonical path. A conflict or an internal fault says nothing about
					// whether the folder is still openable, so neither may flip the row.
					const unavailableId = answersSelect && event.payload.code === "refused" ? pendingSelect.projectId : null;
					return {
						...sequenced,
						notice: {
							tone: noticeToneFor(event.payload.code),
							message: event.payload.message,
						},
						announcement: event.payload.message,
						recent: unavailableId === null
							? state.recent
							: state.recent.map((entry) => entry.id === unavailableId ? { ...entry, available: false } : entry),
						pendingTurnStart: event.payload.requestId === undefined ||
								event.payload.requestId === state.pendingTurnStart
							? null
							: state.pendingTurnStart,
						pendingConfigInspect: event.payload.requestId === undefined ||
								event.payload.requestId === state.pendingConfigInspect
							? null
							: state.pendingConfigInspect,
						pendingCatalogInspect: event.payload.requestId === undefined ||
								event.payload.requestId === state.pendingCatalogInspect
							? null
							: state.pendingCatalogInspect,
						pendingUsageInspect: event.payload.requestId === undefined ||
								event.payload.requestId === state.pendingUsageInspect
							? null
							: state.pendingUsageInspect,
						pendingRoutingInspect: event.payload.requestId === undefined ||
								event.payload.requestId === state.pendingRoutingInspect
							? null
							: state.pendingRoutingInspect,
						pendingDispatchInspect: event.payload.requestId === undefined ||
								event.payload.requestId === state.pendingDispatchInspect
							? null
							: state.pendingDispatchInspect,
						pendingFleetInspect: event.payload.requestId === undefined ||
								event.payload.requestId === state.pendingFleetInspect
							? null
							: state.pendingFleetInspect,
						pendingToolchainInspect: event.payload.requestId === undefined ||
								event.payload.requestId === state.pendingToolchainInspect
							? null
							: state.pendingToolchainInspect,
						pendingTraceInspect: event.payload.requestId === undefined ||
								event.payload.requestId === state.pendingTraceInspect
							? null
							: state.pendingTraceInspect,
						pendingEvidenceInspect: event.payload.requestId === undefined ||
								event.payload.requestId === state.pendingEvidenceInspect
							? null
							: state.pendingEvidenceInspect,
						pendingEvidenceRead: null,
						pendingFleetVerify: null,
						pendingRecoveryInspect: event.payload.requestId === undefined ||
								event.payload.requestId === state.pendingRecoveryInspect
							? null
							: state.pendingRecoveryInspect,
						pendingProjectSelect: answersSelect ? null : pendingSelect,
					};
				}
				case "project.browse.listing":
					return { ...sequenced, browse: event.payload };
				case "dispatch.state":
					return {
						...sequenced,
						dispatchInspection: event.payload.inspection,
						pendingDispatchInspect: null,
						announcement: "Installation-wide dispatch snapshot updated",
					};
				case "fleet.inspection.state":
					return {
						...sequenced,
						fleetInspection: event.payload.inspection,
						// A new window can retire the run that was checked, and the host
						// will refuse it from here on, so a verdict about a run that is no
						// longer shown is dropped rather than left standing.
						fleetVerification: event.payload.inspection.runs.some(
								(run) => run.runId === state.fleetVerification?.runId,
							)
							? state.fleetVerification
							: null,
						pendingFleetInspect: null,
						pendingFleetVerify: null,
						announcement: "Recent durable run record updated",
					};
				case "toolchain.state":
					return {
						...sequenced,
						toolchainInspection: event.payload.inspection,
						pendingToolchainInspect: null,
						announcement: "Clio Coder toolchain inventory updated",
					};
				case "trace.state":
					return {
						...sequenced,
						traceInspection: event.payload.inspection,
						pendingTraceInspect: null,
						announcement: "Durable run accounting updated",
					};
				case "evidence.state":
					return {
						...sequenced,
						evidenceInspection: event.payload.inspection,
						// A new window can retire the bundle that was open, and the host
						// will refuse it from here on, so the stale record is dropped
						// rather than left on screen as if it were still referenceable.
						evidenceDetail: event.payload.inspection.artifacts.some(
								(artifact) => artifact.evidenceId === state.evidenceDetail?.evidenceId,
							)
							? state.evidenceDetail
							: null,
						pendingEvidenceInspect: null,
						pendingEvidenceRead: null,
						announcement: "Durable evidence inventory updated",
					};
				case "evidence.detail.state":
					return {
						...sequenced,
						evidenceDetail: event.payload.detail,
						pendingEvidenceRead: null,
						announcement: `Trust record for ${event.payload.detail.evidenceId}`,
					};
				case "fleet.verification.state":
					return {
						...sequenced,
						fleetVerification: event.payload.verification,
						pendingFleetVerify: null,
						announcement:
							`Receipt for ${event.payload.verification.runId} checked: ${event.payload.verification.state}`,
					};
				case "recovery.state":
					return {
						...sequenced,
						recoveryInspection: event.payload.inspection,
						pendingRecoveryInspect: null,
						announcement: event.payload.inspection.healthy
							? "Clio Coder diagnostics found no failures"
							: "Clio Coder diagnostics found failures",
					};
				case "project.opened": {
					const consistency = workspaceConsistencyError(
						event.payload.workspace,
					);
					if (consistency !== null) {
						return {
							...sequenced,
							notice: {
								tone: "error",
								message: "The GUI received a contradictory project snapshot and ignored it.",
							},
						};
					}
					const open = workspaceFromWire(event.payload.workspace);
					return {
						...sequenced,
						open,
						leftDrawerOpen: false,
						browse: null,
						pendingConfigInspect: null,
						pendingCatalogInspect: null,
						pendingUsageInspect: null,
						pendingRoutingInspect: null,
						pendingRecoveryInspect: null,
						recoveryInspection: state.recoveryInspection?.projectContext ? null : state.recoveryInspection,
						recent: state.recent.some((entry) => entry.id === open.project.id)
							? state.recent.map((entry) => entry.id === open.project.id ? open.project : entry)
							: [open.project, ...state.recent],
						pendingProjectSelect: state.pendingProjectSelect?.projectId === open.project.id
							? null
							: state.pendingProjectSelect,
						announcement: `${open.project.displayName} is open`,
					};
				}
				case "project.forgotten":
					return {
						...sequenced,
						open: event.projectId === state.open?.project.id ? null : state.open,
						pendingConfigInspect: event.projectId === state.open?.project.id ? null : state.pendingConfigInspect,
						pendingCatalogInspect: event.projectId === state.open?.project.id ? null : state.pendingCatalogInspect,
						pendingUsageInspect: event.projectId === state.open?.project.id ? null : state.pendingUsageInspect,
						pendingRoutingInspect: event.projectId === state.open?.project.id ? null : state.pendingRoutingInspect,
						pendingRecoveryInspect: event.projectId === state.open?.project.id ? null : state.pendingRecoveryInspect,
						recoveryInspection: event.projectId === state.open?.project.id &&
								state.recoveryInspection?.projectContext
							? null
							: state.recoveryInspection,
						recent: state.recent.filter((entry) => entry.id !== event.projectId),
						pendingProjectSelect: state.pendingProjectSelect?.projectId === event.projectId
							? null
							: state.pendingProjectSelect,
						announcement: "The project was removed from the recent list",
					};
				default: {
					if (
						state.open === null || event.projectId !== state.open.project.id
					) return sequenced;
					const open = applyToOpen(state.open, event, new Date().toISOString());
					return {
						...sequenced,
						open,
						pendingTurnStart: event.kind === "turn.started" ? null : state.pendingTurnStart,
						pendingConfigInspect: event.kind === "config.state" ? null : state.pendingConfigInspect,
						pendingCatalogInspect: event.kind === "catalog.state" ? null : state.pendingCatalogInspect,
						pendingUsageInspect: event.kind === "usage.state" ? null : state.pendingUsageInspect,
						pendingRoutingInspect: event.kind === "routing.state" ? null : state.pendingRoutingInspect,
						announcement: announcementFor(event) ?? state.announcement,
					};
				}
			}
		}
	}
}

export function formatProjectPath(
	path: WireProjectPath | Readonly<{ segments: readonly string[] }>,
): string {
	return path.segments.length === 0 ? "/" : path.segments.join("/");
}

export function isPromptBlocked(open: OpenWorkspaceState | null): boolean {
	if (open === null) return true;
	return open.clio.phase === "running" ||
		open.clio.phase === "awaiting-approval" || open.clio.phase === "cancelling";
}

export const emptyProjection = emptyTurnProjection;
