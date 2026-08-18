import {
	MAX_WIRE_COLLECTION_ENTRIES,
	PROTOCOL_VERSION,
	type ServerEvent,
	type ServerEventOf,
	validateServerEvent,
	type WireEngineSnapshot,
	type WireEngineSource,
	type WirePendingPermission,
	type WireProjectPath,
	type WireProjectWorkspace,
	type WireTreeNode,
} from "./protocol.ts";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "failed";
export type TimelineKind =
	| "request"
	| "narrative"
	| "agent"
	| "tool"
	| "change"
	| "approval"
	| "evidence"
	| "outcome"
	| "failure";

export interface ProjectPath {
	readonly segments: readonly string[];
}

export interface TreeNode {
	name: string;
	path: ProjectPath;
	kind: "file" | "directory" | "symlink" | "other";
	operable: boolean;
	size?: number;
	modifiedAt?: string;
	nodeVersion?: string;
	children?: TreeNode[];
}

export interface ProjectSummary {
	id: string;
	displayName: string;
	identity: {
		kind: "local-sandbox" | "wsl" | "native";
		displayPath: string;
		distro?: string;
	};
	lastOpenedAt: string;
}

export interface SessionSummary {
	id: string;
	label: string;
	preview: string;
	updatedAt: string;
	status: "idle" | "active" | "complete" | "canceled" | "failed";
}

export interface TimelineItem {
	id: string;
	kind: TimelineKind;
	title: string;
	summary: string;
	detail?: string;
	status: "queued" | "active" | "waiting" | "complete" | "canceled" | "failed";
	timeLabel: string;
	sequence?: number;
	source?: WireEngineSource;
	meta?: Record<string, string>;
}

export interface DeleteChallenge {
	confirmationId: string;
	target: ProjectPath;
	displayPath: string;
	targetKind: "file" | "empty-directory";
	expiresAt: string;
}

export interface EvidenceRecord {
	id: string;
	label: string;
	detail: string;
	status: "observed" | "reported" | "unavailable";
	source: WireEngineSource;
}

export interface ChangeRecord {
	id: string;
	path: string;
	summary: string;
	status: "planned" | "recorded" | "verified";
	source: WireEngineSource;
}

export interface AgentRecord {
	id: string;
	name: string;
	task: string;
	status: "queued" | "active" | "complete" | "canceled" | "failed";
	elapsed: string;
	target: string;
	source: WireEngineSource;
}

export interface ProjectWorkspaceState {
	project: ProjectSummary;
	tree: TreeNode[];
	treeTruncated: boolean;
	sessions: SessionSummary[];
	selectedSessionId: string | null;
	timeline: TimelineItem[];
	/** Authoritative, provenance-bearing v2 engine state. */
	engine: WireEngineSnapshot;
	/** Authoritative v2 permission DTO. */
	pendingPermission: WirePendingPermission | null;
	deleteChallenge: DeleteChallenge | null;
	agents: AgentRecord[];
	changes: ChangeRecord[];
	evidence: EvidenceRecord[];
	/** Opaque correlation token for the active engine process; never renderer authority. */
	engineGeneration: string | null;
	activeTurnId: string | null;
	lastSequence: number;
}

/** Strict HTTP bootstrap DTO. Project workspaces use the protocol-v2 wire shape. */
export interface WireBootstrap {
	readonly protocolVersion: typeof PROTOCOL_VERSION;
	readonly appName: "Clio Workbench";
	readonly workspaceInstanceId: string;
	readonly localToken: string;
	readonly mode: "browser" | "desktop";
	readonly selectedProjectId: string;
	readonly projects: readonly WireProjectWorkspace[];
	readonly registerableSandboxFolders: readonly string[];
	readonly sandboxLabel: string;
	readonly securityNote: string;
}

/** Compatibility export for existing bootstrap callers. */
export type BootstrapPayload = WireBootstrap;

export interface AppState {
	boot: "loading" | "ready" | "failed";
	bootError: string | null;
	workspaceInstanceId: string | null;
	localToken: string | null;
	mode: "browser" | "desktop";
	connection: ConnectionState;
	selectedProjectId: string | null;
	projects: Record<string, ProjectWorkspaceState>;
	registerableSandboxFolders: string[];
	sandboxLabel: string;
	securityNote: string;
	rightPanel: "team" | "changes" | "evidence";
	leftDrawerOpen: boolean;
	rightDrawerOpen: boolean;
	announcement: string;
	notice: { tone: "error" | "warning" | "info"; message: string } | null;
}

export type HostEventLike = ServerEvent;

export type AppAction =
	| { type: "bootstrap.loaded"; payload: WireBootstrap }
	| { type: "bootstrap.failed"; message: string }
	| { type: "connection.changed"; connection: ConnectionState }
	| { type: "project.selected"; projectId: string }
	| { type: "panel.selected"; panel: AppState["rightPanel"] }
	| { type: "drawer.left"; open: boolean }
	| { type: "drawer.right"; open: boolean }
	| { type: "notice.dismissed" }
	| { type: "notice.raised"; tone: "error" | "warning" | "info"; message: string }
	| { type: "host.event"; event: ServerEvent };

export const initialAppState: AppState = {
	boot: "loading",
	bootError: null,
	workspaceInstanceId: null,
	localToken: null,
	mode: "browser",
	connection: "connecting",
	selectedProjectId: null,
	projects: {},
	registerableSandboxFolders: [],
	sandboxLabel: "Controlled scaffold sandbox",
	securityNote: "Project access is not ready yet.",
	rightPanel: "team",
	leftDrawerOpen: false,
	rightDrawerOpen: false,
	announcement: "Loading Clio Workbench",
	notice: null,
};

const encoder = new TextEncoder();
export const MAX_TIMELINE_STREAM_BYTES = 64 * 1024;
export const TIMELINE_STREAM_TRUNCATION_MARKER = "\n[… stream truncated by Workbench …]";
const BOOTSTRAP_KEYS = [
	"protocolVersion",
	"appName",
	"workspaceInstanceId",
	"localToken",
	"mode",
	"selectedProjectId",
	"projects",
	"registerableSandboxFolders",
	"sandboxLabel",
	"securityNote",
] as const;

function invalidBootstrap(detail: string): never {
	throw new Error(`The Workbench bootstrap response did not match protocol v2: ${detail}.`);
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
		if (!expected.has(key)) invalidBootstrap(`the payload has unknown field ${JSON.stringify(key)}`);
	}
	for (const key of BOOTSTRAP_KEYS) {
		if (!Object.hasOwn(record, key)) invalidBootstrap(`the payload is missing field ${JSON.stringify(key)}`);
	}
	return record;
}

function expectBootstrapString(
	value: unknown,
	label: string,
	options: { readonly maxBytes: number; readonly trim?: boolean } = { maxBytes: 4096 },
): string {
	if (typeof value !== "string" || value.length === 0) return invalidBootstrap(`${label} must be a non-empty string`);
	if (options.trim && value.trim() !== value) return invalidBootstrap(`${label} must not have surrounding whitespace`);
	if (encoder.encode(value).byteLength > options.maxBytes) return invalidBootstrap(`${label} is too long`);
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint === 0x7f || (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)) {
			return invalidBootstrap(`${label} contains an unsafe control character`);
		}
	}
	return value;
}

function expectBootstrapId(value: unknown, label: string): string {
	const id = expectBootstrapString(value, label, { maxBytes: 128, trim: true });
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) return invalidBootstrap(`${label} is not a valid identifier`);
	return id;
}

function workspaceConsistencyError(workspace: WireProjectWorkspace): string | null {
	const awaitingPermission = workspace.engine.phase === "awaiting-approval";
	if (awaitingPermission !== (workspace.pendingPermission !== null)) {
		return "pendingPermission must be present exactly while the engine awaits approval";
	}
	if (workspace.pendingPermission !== null && workspace.activeTurnId === null) {
		return "pendingPermission requires an activeTurnId";
	}
	if ((workspace.engineGeneration === null) !== (workspace.activeTurnId === null)) {
		return "engineGeneration and activeTurnId must be present or absent together";
	}
	if (
		workspace.selectedSessionId !== null &&
		!workspace.sessions.some((session) => session.id === workspace.selectedSessionId)
	) {
		return "selectedSessionId does not name a workspace session";
	}
	const sessionIds = new Set(workspace.sessions.map((session) => session.id));
	if (sessionIds.size !== workspace.sessions.length) return "session IDs must be unique";
	return null;
}

function validateBootstrapWorkspace(
	value: unknown,
	workspaceInstanceId: string,
	index: number,
): WireProjectWorkspace {
	let event: ServerEvent;
	try {
		// Reuse the protocol's authoritative, exact project-workspace validator.
		event = validateServerEvent({
			protocolVersion: PROTOCOL_VERSION,
			workspaceInstanceId,
			sequence: index + 1,
			eventId: `bootstrap-project-${index + 1}`,
			kind: "project.created",
			projectId: "bootstrap-validation",
			terminal: false,
			payload: { workspace: value },
		});
	} catch (error) {
		return invalidBootstrap(
			`projects[${index}] is invalid${error instanceof Error ? ` (${error.message})` : ""}`,
		);
	}
	if (event.kind !== "project.created") return invalidBootstrap(`projects[${index}] could not be validated`);
	const consistencyError = workspaceConsistencyError(event.payload.workspace);
	if (consistencyError) return invalidBootstrap(`projects[${index}] is contradictory (${consistencyError})`);
	return event.payload.workspace;
}

export function parseBootstrapPayload(value: unknown): WireBootstrap {
	const record = expectExactBootstrapRecord(value);
	if (record.protocolVersion !== PROTOCOL_VERSION) {
		return invalidBootstrap(`protocolVersion must be ${PROTOCOL_VERSION}`);
	}
	if (record.appName !== "Clio Workbench") return invalidBootstrap("appName is invalid");
	const workspaceInstanceId = expectBootstrapId(record.workspaceInstanceId, "workspaceInstanceId");
	const localToken = expectBootstrapString(record.localToken, "localToken", { maxBytes: 512, trim: true });
	if (record.mode !== "browser" && record.mode !== "desktop") return invalidBootstrap("mode is invalid");
	const selectedProjectId = expectBootstrapId(record.selectedProjectId, "selectedProjectId");
	if (!Array.isArray(record.projects) || record.projects.length === 0 || record.projects.length > 256) {
		return invalidBootstrap("projects must be a non-empty bounded array");
	}
	const projects = record.projects.map((workspace, index) =>
		validateBootstrapWorkspace(workspace, workspaceInstanceId, index)
	);
	const projectIds = new Set(projects.map((workspace) => workspace.project.id));
	if (projectIds.size !== projects.length) return invalidBootstrap("project IDs must be unique");
	if (!projectIds.has(selectedProjectId)) {
		throw new Error("The selected project is missing from the bootstrap response.");
	}
	if (
		!Array.isArray(record.registerableSandboxFolders) ||
		record.registerableSandboxFolders.length > 256
	) {
		return invalidBootstrap("registerableSandboxFolders must be a bounded array");
	}
	const registerableSandboxFolders = record.registerableSandboxFolders.map((folder, index) =>
		expectBootstrapString(folder, `registerableSandboxFolders[${index}]`, { maxBytes: 255, trim: true })
	);
	if (new Set(registerableSandboxFolders).size !== registerableSandboxFolders.length) {
		return invalidBootstrap("registerableSandboxFolders must not contain duplicates");
	}
	return {
		protocolVersion: PROTOCOL_VERSION,
		appName: "Clio Workbench",
		workspaceInstanceId,
		localToken,
		mode: record.mode,
		selectedProjectId,
		projects,
		registerableSandboxFolders,
		sandboxLabel: expectBootstrapString(record.sandboxLabel, "sandboxLabel", { maxBytes: 512 }),
		securityNote: expectBootstrapString(record.securityNote, "securityNote", { maxBytes: 4096 }),
	};
}

function clonePath(path: WireProjectPath): ProjectPath {
	return { segments: [...path.segments] };
}

function treeNodeFromWire(node: WireTreeNode): TreeNode {
	return {
		name: node.name,
		path: clonePath(node.path),
		kind: node.kind,
		operable: node.operable,
		...(node.size === undefined ? {} : { size: node.size }),
		...(node.modifiedAt === undefined ? {} : { modifiedAt: node.modifiedAt }),
		...(node.nodeVersion === undefined ? {} : { nodeVersion: node.nodeVersion }),
		...(node.children === undefined ? {} : { children: node.children.map(treeNodeFromWire) }),
	};
}

function cloneEngineSnapshot(snapshot: WireEngineSnapshot): WireEngineSnapshot {
	return {
		kind: snapshot.kind,
		phase: snapshot.phase,
		facts: snapshot.facts.map((fact) => ({ ...fact })),
		...(snapshot.checkedAt === undefined ? {} : { checkedAt: snapshot.checkedAt }),
	};
}

function clonePendingPermission(permission: WirePendingPermission): WirePendingPermission {
	return { ...permission, locations: permission.locations.map(clonePath) };
}

function workspaceFromWire(workspace: WireProjectWorkspace): ProjectWorkspaceState {
	const engine = cloneEngineSnapshot(workspace.engine);
	const pendingPermission = workspace.pendingPermission === null
		? null
		: clonePendingPermission(workspace.pendingPermission);
	return {
		project: {
			id: workspace.project.id,
			displayName: workspace.project.displayName,
			identity: {
				kind: workspace.project.identity.kind,
				displayPath: workspace.project.identity.displayPath,
				...(workspace.project.identity.distro === undefined ? {} : { distro: workspace.project.identity.distro }),
			},
			lastOpenedAt: workspace.project.lastOpenedAt,
		},
		tree: workspace.tree.map(treeNodeFromWire),
		treeTruncated: workspace.treeTruncated,
		sessions: workspace.sessions.map((session) => ({ ...session })),
		selectedSessionId: workspace.selectedSessionId,
		timeline: workspace.timeline.map((item) => ({ ...item })),
		engine,
		pendingPermission,
		deleteChallenge: workspace.deleteChallenge === null
			? null
			: { ...workspace.deleteChallenge, target: clonePath(workspace.deleteChallenge.target) },
		agents: workspace.agents.map((agent) => ({
			id: agent.id,
			name: agent.name,
			task: agent.task,
			status: agent.status,
			elapsed: agent.status === "active" ? "active now" : agent.status === "queued" ? "queued" : "finished",
			target: agent.summary,
			source: agent.source,
		})),
		changes: workspace.changes.map((change) => ({
			id: change.id,
			path: formatProjectPath(change.path),
			summary: change.summary,
			status: change.status,
			source: change.source,
		})),
		evidence: workspace.evidence.map((evidence) => ({ ...evidence })),
		engineGeneration: workspace.engineGeneration,
		activeTurnId: workspace.activeTurnId,
		lastSequence: workspace.lastSequence,
	};
}

type TimelineStatus = TimelineItem["status"];

function boundedCollection<T>(records: T[]): T[] {
	return records.length <= MAX_WIRE_COLLECTION_ENTRIES
		? records
		: records.slice(records.length - MAX_WIRE_COLLECTION_ENTRIES);
}

function boundUtf8WithMarker(value: string, maximumBytes: number, marker: string): string {
	if (encoder.encode(value).byteLength <= maximumBytes) return value;
	const markerBytes = encoder.encode(marker).byteLength;
	const prefixBudget = maximumBytes - markerBytes;
	const characters: string[] = [];
	let usedBytes = 0;
	for (const character of value) {
		const characterBytes = encoder.encode(character).byteLength;
		if (usedBytes + characterBytes > prefixBudget) break;
		characters.push(character);
		usedBytes += characterBytes;
	}
	return `${characters.join("")}${marker}`;
}

function appendBoundedStream(prior: string, next: string): string {
	if (prior.endsWith(TIMELINE_STREAM_TRUNCATION_MARKER)) return prior;
	return boundUtf8WithMarker(
		`${prior}${next}`,
		MAX_TIMELINE_STREAM_BYTES,
		TIMELINE_STREAM_TRUNCATION_MARKER,
	);
}

function turnTimelineId(turnId: string, kind: string, entityId?: string): string {
	return `live:${turnId}:${kind}${entityId === undefined ? "" : `:${entityId}`}`;
}

function upsertTimeline(
	timeline: TimelineItem[],
	item: TimelineItem,
	mode: "replace" | "append-summary" = "replace",
): TimelineItem[] {
	const index = timeline.findIndex((candidate) => candidate.id === item.id);
	if (index < 0) return boundedCollection([...timeline, item]);
	const prior = timeline[index]!;
	const updated = mode === "append-summary"
		? { ...prior, ...item, summary: appendBoundedStream(prior.summary, item.summary), timeLabel: prior.timeLabel }
		: { ...prior, ...item, timeLabel: prior.timeLabel };
	return timeline.map((candidate, candidateIndex) => candidateIndex === index ? updated : candidate);
}

function upsertById<T extends { readonly id: string }>(records: T[], record: T): T[] {
	const index = records.findIndex((candidate) => candidate.id === record.id);
	if (index < 0) return boundedCollection([...records, record]);
	return records.map((candidate, candidateIndex) => candidateIndex === index ? record : candidate);
}

function toolStatus(status: ServerEventOf<"turn.tool">["payload"]["status"]): TimelineStatus {
	switch (status) {
		case "in_progress":
			return "active";
		case "completed":
			return "complete";
		case "failed":
			return "failed";
		case "canceled":
			return "canceled";
	}
}

function resolutionStatus(
	decision: ServerEventOf<"turn.permission.resolved">["payload"]["decision"],
): TimelineStatus {
	return decision === "allow-once" ? "complete" : "canceled";
}

function resolutionSummary(decision: ServerEventOf<"turn.permission.resolved">["payload"]["decision"]): string {
	switch (decision) {
		case "allow-once":
			return "Allowed once for this turn.";
		case "reject":
			return "Rejected by the operator.";
		case "cancelled":
			return "Canceled with the turn.";
		case "timeout":
			return "Timed out and failed closed.";
		case "disconnect":
			return "Rejected when the local connection closed.";
	}
}

function outcomeStatus(outcome: ServerEventOf<"turn.terminal">["payload"]["outcome"]): TimelineStatus {
	return outcome === "completed" ? "complete" : outcome === "canceled" ? "canceled" : "failed";
}

function settleTurnTimeline(
	timeline: TimelineItem[],
	turnId: string,
	outcome: ServerEventOf<"turn.terminal">["payload"]["outcome"],
): TimelineItem[] {
	const status = outcomeStatus(outcome);
	const prefix = `live:${turnId}:`;
	return timeline.map((item) =>
		item.id.startsWith(prefix) && (item.status === "active" || item.status === "waiting") ? { ...item, status } : item
	);
}

function updateSession(
	sessions: SessionSummary[],
	sessionId: string,
	update: Omit<SessionSummary, "id">,
): SessionSummary[] {
	return upsertById(sessions, { id: sessionId, ...update });
}

function matchesActiveTurn(
	workspace: ProjectWorkspaceState,
	event: ServerEvent,
): event is ServerEvent & { engineGeneration: string; sessionId: string; turnId: string } {
	return typeof event.engineGeneration === "string" && event.engineGeneration === workspace.engineGeneration &&
		typeof event.sessionId === "string" && event.sessionId === workspace.selectedSessionId &&
		typeof event.turnId === "string" && event.turnId === workspace.activeTurnId;
}

function updateWorkspace(workspace: ProjectWorkspaceState, event: ServerEvent): ProjectWorkspaceState {
	if (event.sequence <= workspace.lastSequence) return workspace;
	const next: ProjectWorkspaceState = { ...workspace, lastSequence: event.sequence };

	switch (event.kind) {
		case "project.snapshot":
		case "fs.changed":
			return {
				...next,
				tree: event.payload.tree.map(treeNodeFromWire),
				treeTruncated: event.payload.treeTruncated,
				deleteChallenge: null,
			};
		case "fs.delete.challenge":
			return { ...next, deleteChallenge: { ...event.payload, target: clonePath(event.payload.target) } };
		case "engine.state": {
			const engine = cloneEngineSnapshot(event.payload.snapshot);
			const retainsPermission = engine.phase === "awaiting-approval";
			return {
				...next,
				engine,
				pendingPermission: retainsPermission ? next.pendingPermission : null,
			};
		}
		case "turn.started": {
			if (!event.engineGeneration || !event.turnId || !event.sessionId) return workspace;
			const timeline: TimelineItem = {
				id: turnTimelineId(event.turnId, "request"),
				kind: "request",
				title: "Research request",
				summary: event.payload.promptSummary,
				status: "active",
				timeLabel: "now",
				sequence: event.sequence,
				source: event.payload.source,
			};
			return {
				...next,
				engineGeneration: event.engineGeneration,
				activeTurnId: event.turnId,
				selectedSessionId: event.sessionId,
				sessions: updateSession(next.sessions, event.sessionId, {
					label: event.payload.promptSummary,
					preview: "Turn in progress",
					updatedAt: "now",
					status: "active",
				}),
				timeline: upsertTimeline(next.timeline, timeline),
				pendingPermission: null,
				agents: [],
				changes: [],
				evidence: [],
			};
		}
		case "turn.text":
		case "turn.thought": {
			if (!matchesActiveTurn(workspace, event)) return workspace;
			const isThought = event.kind === "turn.thought";
			const streamKind = isThought ? "thought" : "text";
			const streamPrefix = `${turnTimelineId(event.turnId, streamKind)}:`;
			const prior = next.timeline.at(-1);
			const streamId = prior?.id.startsWith(streamPrefix) ? prior.id : `${streamPrefix}${event.eventId}`;
			return {
				...next,
				timeline: upsertTimeline(next.timeline, {
					id: streamId,
					kind: "narrative",
					title: event.payload.source === "simulated-by-workbench"
						? isThought ? "Fake reasoning" : "Fake engine"
						: isThought
						? "Reasoning"
						: "Clio",
					summary: event.payload.text,
					status: "complete",
					timeLabel: "now",
					sequence: event.sequence,
					source: event.payload.source,
				}, "append-summary"),
			};
		}
		case "turn.agent": {
			if (!matchesActiveTurn(workspace, event)) return workspace;
			const agent: AgentRecord = {
				id: event.payload.agentId,
				name: event.payload.name,
				task: event.payload.task,
				status: event.payload.status,
				elapsed: event.payload.status === "active" ? "active now" : "finished",
				target: event.payload.summary,
				source: event.payload.source,
			};
			return {
				...next,
				agents: upsertById(next.agents, agent),
				timeline: upsertTimeline(next.timeline, {
					id: turnTimelineId(event.turnId, "agent", event.payload.agentId),
					kind: "agent",
					title: event.payload.name,
					summary: event.payload.summary,
					detail: event.payload.task,
					status: event.payload.status,
					timeLabel: "now",
					sequence: event.sequence,
					source: event.payload.source,
				}),
			};
		}
		case "turn.tool": {
			if (!matchesActiveTurn(workspace, event)) return workspace;
			const locations = event.payload.locations.map(formatProjectPath);
			const detail = locations.length === 0 ? event.payload.kind : `${event.payload.kind} · ${locations.join(", ")}`;
			return {
				...next,
				timeline: upsertTimeline(next.timeline, {
					id: turnTimelineId(event.turnId, "tool", event.payload.toolCallId),
					kind: "tool",
					title: event.payload.title,
					summary: event.payload.summary,
					detail,
					status: toolStatus(event.payload.status),
					timeLabel: "now",
					sequence: event.sequence,
					source: event.payload.source,
				}),
			};
		}
		case "turn.change": {
			if (!matchesActiveTurn(workspace, event)) return workspace;
			const path = formatProjectPath(event.payload.path);
			const id = turnTimelineId(event.turnId, "change", path);
			return {
				...next,
				changes: upsertById(next.changes, {
					id,
					path,
					summary: event.payload.summary,
					status: "recorded",
					source: event.payload.source,
				}),
				timeline: upsertTimeline(next.timeline, {
					id,
					kind: "change",
					title: "Attributed change",
					summary: event.payload.summary,
					detail: path,
					status: "complete",
					timeLabel: "now",
					sequence: event.sequence,
					source: event.payload.source,
				}),
			};
		}
		case "turn.permission.requested": {
			if (!matchesActiveTurn(workspace, event)) return workspace;
			const permission = clonePendingPermission(event.payload);
			const locations = permission.locations.map(formatProjectPath);
			const target = locations.length === 0 ? "this turn" : locations.join(", ");
			return {
				...next,
				pendingPermission: permission,
				timeline: upsertTimeline(next.timeline, {
					id: turnTimelineId(event.turnId, "permission", permission.permissionId),
					kind: "approval",
					title: permission.title,
					summary: `${permission.kind} permission requested for ${target}.`,
					detail: `Allow once for ${target}`,
					status: "waiting",
					timeLabel: "now",
					sequence: event.sequence,
					source: permission.source,
				}),
			};
		}
		case "turn.permission.resolved": {
			if (!matchesActiveTurn(workspace, event)) return workspace;
			if (workspace.pendingPermission?.permissionId !== event.payload.permissionId) return workspace;
			const id = turnTimelineId(event.turnId, "permission", event.payload.permissionId);
			const existing = next.timeline.find((item) => item.id === id);
			return {
				...next,
				pendingPermission: null,
				timeline: upsertTimeline(next.timeline, {
					id,
					kind: "approval",
					title: existing?.title ?? "Permission resolved",
					summary: resolutionSummary(event.payload.decision),
					...(existing?.detail === undefined ? {} : { detail: existing.detail }),
					status: resolutionStatus(event.payload.decision),
					timeLabel: "now",
					sequence: event.sequence,
					source: event.payload.source,
				}),
			};
		}
		case "turn.evidence": {
			if (!matchesActiveTurn(workspace, event)) return workspace;
			const evidence: EvidenceRecord = {
				id: event.eventId,
				label: event.payload.label,
				detail: event.payload.detail,
				status: event.payload.status,
				source: event.payload.source,
			};
			return {
				...next,
				evidence: upsertById(next.evidence, evidence),
				timeline: upsertTimeline(next.timeline, {
					id: event.eventId,
					kind: "evidence",
					title: event.payload.label,
					summary: event.payload.detail,
					status: event.payload.status === "unavailable" ? "failed" : "complete",
					timeLabel: "now",
					sequence: event.sequence,
					source: event.payload.source,
				}),
			};
		}
		case "turn.terminal": {
			if (!matchesActiveTurn(workspace, event) || !event.sessionId) return workspace;
			const status = outcomeStatus(event.payload.outcome);
			const title = event.payload.outcome === "completed"
				? "Outcome"
				: event.payload.outcome === "canceled"
				? "Turn canceled"
				: "Turn failed";
			const sessions = updateSession(next.sessions, event.sessionId, {
				label: next.sessions.find((session) => session.id === event.sessionId)?.label ?? "Research request",
				preview: event.payload.summary,
				updatedAt: "now",
				status: event.payload.outcome === "completed"
					? "complete"
					: event.payload.outcome === "canceled"
					? "canceled"
					: "failed",
			});
			const settledTimeline = settleTurnTimeline(next.timeline, event.turnId, event.payload.outcome);
			return {
				...next,
				engineGeneration: null,
				activeTurnId: null,
				pendingPermission: null,
				sessions,
				timeline: upsertTimeline(settledTimeline, {
					id: turnTimelineId(event.turnId, "terminal"),
					kind: event.payload.outcome === "failed" ? "failure" : "outcome",
					title,
					summary: event.payload.summary,
					detail: event.payload.stopReason ?? event.payload.code,
					status,
					timeLabel: "now",
					sequence: event.sequence,
					source: event.payload.source,
				}),
				agents: next.agents.map((agent) =>
					agent.status === "active" || agent.status === "queued"
						? {
							...agent,
							status: event.payload.outcome === "completed"
								? "complete" as const
								: event.payload.outcome === "canceled"
								? "canceled" as const
								: "failed" as const,
							elapsed: "finished",
						}
						: agent
				),
			};
		}
		case "connection.ready":
		case "project.created":
		case "project.registered":
		case "project.selected":
		case "protocol.error":
		case "command.error":
			return next;
	}
}

function urgentAnnouncement(event: ServerEvent): string | null {
	if (event.kind === "turn.permission.requested") return `${event.payload.title} requires your decision`;
	if (event.kind === "turn.terminal" && event.payload.outcome === "failed") return event.payload.summary;
	if (event.kind === "engine.state" && event.payload.snapshot.phase === "failed") {
		return "The selected engine entered a failed state";
	}
	return null;
}

export function appReducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "bootstrap.loaded": {
			const projects = Object.fromEntries(
				action.payload.projects.map((workspace) => {
					const projected = workspaceFromWire(workspace);
					return [projected.project.id, projected];
				}),
			);
			return {
				...state,
				boot: "ready",
				bootError: null,
				workspaceInstanceId: action.payload.workspaceInstanceId,
				localToken: action.payload.localToken,
				mode: action.payload.mode,
				selectedProjectId: action.payload.selectedProjectId,
				projects,
				registerableSandboxFolders: [...action.payload.registerableSandboxFolders],
				sandboxLabel: action.payload.sandboxLabel,
				securityNote: action.payload.securityNote,
				announcement: `${action.payload.appName} is ready in ${action.payload.mode} mode`,
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
				announcement: action.connection === "connected"
					? "Local Workbench connection ready"
					: "Local connection changed",
			};
		case "project.selected": {
			const selectedProject = state.projects[action.projectId];
			if (!selectedProject) return state;
			return {
				...state,
				selectedProjectId: action.projectId,
				leftDrawerOpen: false,
				announcement: `${selectedProject.project.displayName} selected`,
			};
		}
		case "panel.selected":
			return { ...state, rightPanel: action.panel };
		case "drawer.left":
			return {
				...state,
				leftDrawerOpen: action.open,
				rightDrawerOpen: action.open ? false : state.rightDrawerOpen,
			};
		case "drawer.right":
			return {
				...state,
				rightDrawerOpen: action.open,
				leftDrawerOpen: action.open ? false : state.leftDrawerOpen,
			};
		case "notice.dismissed":
			return { ...state, notice: null };
		case "notice.raised":
			return { ...state, notice: { tone: action.tone, message: action.message }, announcement: action.message };
		case "host.event": {
			if (state.workspaceInstanceId !== null && action.event.workspaceInstanceId !== state.workspaceInstanceId) {
				return state;
			}
			if (action.event.kind === "connection.ready") {
				return { ...state, connection: "connected", announcement: "Local Workbench connection ready" };
			}
			if (action.event.kind === "protocol.error" || action.event.kind === "command.error") {
				const message = action.event.payload.message;
				return {
					...state,
					connection: action.event.kind === "protocol.error" ? "failed" : state.connection,
					announcement: message,
					notice: { tone: "error", message },
				};
			}
			if (action.event.kind === "project.created" || action.event.kind === "project.registered") {
				const wireWorkspace = action.event.payload.workspace;
				if (wireWorkspace.project.id !== action.event.projectId || workspaceConsistencyError(wireWorkspace)) {
					return state;
				}
				const workspace = workspaceFromWire(wireWorkspace);
				workspace.lastSequence = Math.max(workspace.lastSequence, action.event.sequence);
				return {
					...state,
					projects: { ...state.projects, [workspace.project.id]: workspace },
					selectedProjectId: workspace.project.id,
					announcement: `${workspace.project.displayName} added to the project library`,
				};
			}
			const projectId = action.event.projectId;
			if (!projectId || !state.projects[projectId]) return state;
			const workspace = updateWorkspace(state.projects[projectId], action.event);
			if (action.event.kind === "project.selected") {
				return {
					...state,
					projects: { ...state.projects, [projectId]: workspace },
					selectedProjectId: projectId,
					leftDrawerOpen: false,
					announcement: `${workspace.project.displayName} selected`,
				};
			}
			return {
				...state,
				projects: { ...state.projects, [projectId]: workspace },
				announcement: urgentAnnouncement(action.event) ?? state.announcement,
			};
		}
	}
}

export function selectedWorkspace(state: AppState): ProjectWorkspaceState | null {
	return state.selectedProjectId ? (state.projects[state.selectedProjectId] ?? null) : null;
}

export function formatProjectPath(path: ProjectPath | WireProjectPath): string {
	return path.segments.length === 0 ? "/" : path.segments.join("/");
}
