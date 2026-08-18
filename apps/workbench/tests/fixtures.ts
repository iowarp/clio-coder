import {
	PROTOCOL_VERSION,
	type ServerEventKind,
	type ServerEventOf,
	type ServerEventPayloadByKind,
	type WireClioSnapshot,
	type WireProjectWorkspace,
	type WireSessionSummary,
	type WireTimelineItem,
	type WireTreeNode,
} from "../src/protocol.ts";
import type { WireBootstrap } from "../src/state.ts";

export const FIXTURE_PROJECT_ID = "project-alpha-0001";
export const FIXTURE_ROOT = "/tmp/workbench-fixture/alpha";

export function clioSnapshotFixture(
	phase: WireClioSnapshot["phase"] = "idle",
	overrides: Partial<WireClioSnapshot> = {},
): WireClioSnapshot {
	return {
		phase,
		agent: { name: "clio-coder", version: "0.3.2" },
		capabilities: {
			load: true,
			list: true,
			label: true,
			delete: true,
			autonomy: true,
			settings: true,
			targets: true,
			loopBlocked: true,
		},
		session: {
			id: "session-alpha-0001",
			target: "lmstudio",
			model: "qwen3.8-27b",
			autonomy: "auto-edit",
			autonomySource: "settings",
			resumed: false,
			replayedTurns: 0,
			replayTruncated: false,
			createdAt: "2026-08-18T12:00:00.000Z",
		},
		lastFailure: null,
		checkedAt: "2026-08-18T12:00:00.000Z",
		...overrides,
	};
}

export function sessionSummaryFixture(
	id = "session-alpha-0001",
	overrides: Partial<WireSessionSummary> = {},
): WireSessionSummary {
	return {
		id,
		label: null,
		preview: "Audit the convergence study",
		createdAt: "2026-08-18T12:00:00.000Z",
		updatedAt: "2026-08-18T12:05:00.000Z",
		turns: 2,
		target: "lmstudio",
		model: "qwen3.8-27b",
		state: "open",
		hosted: true,
		...overrides,
	};
}

export function workspaceFixture(
	id = FIXTURE_PROJECT_ID,
	displayName = "Alpha",
	overrides: Partial<WireProjectWorkspace> = {},
): WireProjectWorkspace {
	return {
		project: {
			id,
			displayName,
			rootPath: FIXTURE_ROOT,
			lastOpenedAt: "2026-08-18T12:00:00.000Z",
			available: true,
		},
		tree: [] as WireTreeNode[],
		treeTruncated: false,
		sessions: [sessionSummaryFixture()],
		sessionsTruncated: false,
		clio: clioSnapshotFixture(),
		timeline: [] as WireTimelineItem[],
		timelineTruncated: false,
		activeTurn: null,
		pendingPermission: null,
		deleteChallenge: null,
		settings: null,
		targets: null,
		targetsTruncated: false,
		processGeneration: "generation-alpha-0001",
		lastSequence: 0,
		...overrides,
	};
}

export function bootstrapFixture(overrides: Partial<WireBootstrap> = {}): WireBootstrap {
	return {
		protocolVersion: PROTOCOL_VERSION,
		appName: "Clio Workbench" as const,
		workspaceInstanceId: "workspace-fixture-0001",
		localToken: "token-fixture-0000000000000001",
		mode: "browser" as const,
		openProjectId: FIXTURE_PROJECT_ID,
		workspace: workspaceFixture(),
		recent: [{
			id: FIXTURE_PROJECT_ID,
			displayName: "Alpha",
			rootPath: FIXTURE_ROOT,
			lastOpenedAt: "2026-08-18T12:00:00.000Z",
			available: true,
		}],
		homePath: "/home/operator",
		stateDirNote: "Workbench keeps only its recent-project list under /tmp/workbench-fixture/state.",
		securityNote: "Workbench enforces the project boundary in its own code; Deno grants are broad.",
		...overrides,
	};
}

const TURN_EVENT_KINDS = new Set<ServerEventKind>([
	"turn.started",
	"turn.text",
	"turn.thought",
	"turn.tool",
	"turn.loop",
	"turn.permission.requested",
	"turn.permission.resolved",
	"turn.terminal",
]);

const PROJECT_EVENT_KINDS = new Set<ServerEventKind>([
	"project.opened",
	"project.forgotten",
	"project.snapshot",
	"fs.changed",
	"fs.delete.challenge",
	"clio.state",
	"session.list",
	"settings.state",
	"targets.state",
	"targets.probed",
]);

export interface ServerEventFixtureOptions {
	readonly sequence?: number;
	readonly eventId?: string;
	readonly workspaceInstanceId?: string;
	readonly projectId?: string;
	readonly processGeneration?: string;
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
			projectId: options.projectId ?? FIXTURE_PROJECT_ID,
			processGeneration: options.processGeneration ?? "generation-alpha-0001",
			sessionId: options.sessionId ?? "session-alpha-0001",
			turnId: options.turnId ?? "turn-1",
		}
		: PROJECT_EVENT_KINDS.has(kind)
		? { projectId: options.projectId ?? FIXTURE_PROJECT_ID }
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
