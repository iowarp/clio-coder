import {
	PROTOCOL_VERSION,
	type ServerEventKind,
	type ServerEventOf,
	type ServerEventPayloadByKind,
	type WireAgentRecord,
	type WireChangeRecord,
	type WireEngineKind,
	type WireEnginePhase,
	type WireEngineReadinessFact,
	type WireEngineSnapshot,
	type WireEvidenceRecord,
	type WirePendingPermission,
	type WireSessionSummary,
	type WireTimelineItem,
	type WireTreeNode,
} from "../src/protocol.ts";
import type { BootstrapPayload } from "../src/state.ts";

const source = "simulated-by-workbench" as const;

export function engineSnapshotFixture(
	phase: WireEnginePhase = "ready",
	kind: WireEngineKind = "fake",
	facts?: readonly WireEngineReadinessFact[],
): WireEngineSnapshot {
	return {
		kind,
		phase,
		facts: facts ?? [
			{ key: "runtime", label: "Runtime", state: "ready", detail: "Available", source },
			{ key: "protocol", label: "Protocol", state: "ready", detail: "Negotiated", source },
			{ key: "project", label: "Project", state: "ready", detail: "Bounded", source },
			{ key: "target", label: "Target", state: "ready", detail: "Configured", source },
			{ key: "authentication", label: "Authentication", state: "ready", detail: "Available", source },
			{ key: "provider", label: "Provider", state: "ready", detail: "Available", source },
			{ key: "context", label: "Context", state: "ready", detail: "Available", source },
		],
		checkedAt: "2026-08-17T12:00:00.000Z",
	};
}

export function workspaceFixture(id: string, displayName: string) {
	const workspace = {
		project: {
			id,
			displayName,
			identity: { kind: "local-sandbox" as const, displayPath: `sandbox://scaffold/${displayName.toLowerCase()}` },
			lastOpenedAt: "2026-08-17T12:00:00.000Z",
		},
		tree: [] as WireTreeNode[],
		treeTruncated: false,
		sessions: [] as WireSessionSummary[],
		selectedSessionId: null as string | null,
		timeline: [] as WireTimelineItem[],
		engine: engineSnapshotFixture(),
		pendingPermission: null as WirePendingPermission | null,
		deleteChallenge: null,
		agents: [] as WireAgentRecord[],
		changes: [] as WireChangeRecord[],
		evidence: [] as WireEvidenceRecord[],
		engineGeneration: null as string | null,
		activeTurnId: null as string | null,
		lastSequence: 0,
	};
	return workspace;
}

export function bootstrapFixture() {
	const bootstrap = {
		protocolVersion: PROTOCOL_VERSION,
		appName: "Clio Workbench" as const,
		workspaceInstanceId: "workspace-fixture-0001",
		localToken: "token-fixture-0000000000000001",
		mode: "browser" as const,
		selectedProjectId: "project-alpha-0001",
		projects: [workspaceFixture("project-alpha-0001", "Alpha"), workspaceFixture("project-beta-0002", "Beta")],
		registerableSandboxFolders: ["gamma"],
		sandboxLabel: "Controlled test sandbox",
		securityNote: "This fixture has no generic filesystem authority.",
	} satisfies BootstrapPayload;
	return bootstrap;
}

const TURN_EVENT_KINDS = new Set<ServerEventKind>([
	"turn.started",
	"turn.text",
	"turn.thought",
	"turn.agent",
	"turn.tool",
	"turn.change",
	"turn.permission.requested",
	"turn.permission.resolved",
	"turn.evidence",
	"turn.terminal",
]);

const PROJECT_EVENT_KINDS = new Set<ServerEventKind>([
	"project.snapshot",
	"project.created",
	"project.registered",
	"project.selected",
	"fs.changed",
	"fs.delete.challenge",
	"engine.state",
]);

export interface ServerEventFixtureOptions {
	readonly sequence?: number;
	readonly eventId?: string;
	readonly workspaceInstanceId?: string;
	readonly projectId?: string;
	readonly engineGeneration?: string;
	readonly sessionId?: string;
	readonly turnId?: string;
}

export function serverEventFixture<K extends ServerEventKind>(
	kind: K,
	payload: ServerEventPayloadByKind[K],
	options: ServerEventFixtureOptions = {},
): ServerEventOf<K> {
	const sequence = options.sequence ?? 1;
	const context = TURN_EVENT_KINDS.has(kind)
		? {
			projectId: options.projectId ?? "project-alpha-0001",
			engineGeneration: options.engineGeneration ?? "generation-alpha-0001",
			sessionId: options.sessionId ?? "session-alpha-0001",
			turnId: options.turnId ?? "turn-alpha-0001",
		}
		: PROJECT_EVENT_KINDS.has(kind)
		? { projectId: options.projectId ?? "project-alpha-0001" }
		: {};
	return {
		protocolVersion: PROTOCOL_VERSION,
		workspaceInstanceId: options.workspaceInstanceId ?? "workspace-fixture-0001",
		sequence,
		eventId: options.eventId ?? `event-${kind.replaceAll(".", "-")}-${sequence}`,
		kind,
		...context,
		terminal: kind === "turn.terminal" || kind === "protocol.error",
		payload,
	} as ServerEventOf<K>;
}
