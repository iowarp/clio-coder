import {
	PROTOCOL_VERSION,
	type ServerEventKind,
	type ServerEventOf,
	type ServerEventPayloadByKind,
	type WireCatalogInspection,
	type WireClioSnapshot,
	type WireConfigInspection,
	type WireProjectWorkspace,
	type WireSessionSummary,
	type WireTimelineItem,
	type WireTreeNode,
	type WireUsageInspection,
} from "../src/protocol.ts";
import type { WireBootstrap } from "../src/state.ts";

export const FIXTURE_PROJECT_ID = "project-alpha-0001";
export const FIXTURE_ROOT = "/tmp/workbench-fixture/alpha";

export function configInspectionFixture(): WireConfigInspection {
	return {
		inspectedAt: "2026-08-29T12:00:00.000Z",
		settings: [
			{ key: "autonomy", source: "project", value: "suggest", valueKind: "exact" },
			{ key: "orchestrator.model", source: "project", value: "qwen3.8-27b", valueKind: "exact" },
			{ key: "retry.maxRetries", source: "user", value: "3", valueKind: "exact" },
			{ key: "targets", source: "user", value: "4 items", valueKind: "collection" },
		],
		settingsTruncated: false,
		entries: [
			{
				category: "clio-md",
				id: "CLIO-CODER.md",
				scope: "project",
				sourcePath: { segments: ["CLIO-CODER.md"] },
				hash: "a1b2c3d4",
				trust: "trusted",
				precedence: "single",
				reloadClass: "next-turn",
				contextCostTokens: 164,
				facts: [{ label: "Preload", value: "included" }],
			},
			{
				category: "rule",
				id: "project-safety",
				scope: "project",
				sourcePath: { segments: [".clio-coder", "rules", "safety.yaml"] },
				trust: "trusted",
				precedence: "winner",
				reloadClass: "next-turn",
				contextCostTokens: 28,
				facts: [{ label: "Enabled", value: "yes" }],
			},
			{
				category: "extension",
				id: "lab-notebook",
				scope: "user",
				trust: "untrusted",
				precedence: "winner",
				reloadClass: "restart",
				facts: [{ label: "Version", value: "1.2.0" }, { label: "Effective", value: "yes" }],
			},
			{
				category: "memory",
				id: "memory-store",
				scope: "user",
				trust: "trusted",
				precedence: "single",
				reloadClass: "hot",
				facts: [{ label: "Present", value: "yes" }, { label: "Records", value: "7" }],
			},
		],
		entriesTruncated: false,
		issueCounts: [{ surface: "hook", count: 1 }],
		issuesTruncated: false,
	};
}

export function catalogInspectionFixture(): WireCatalogInspection {
	return {
		inspectedAt: "2026-08-29T13:00:00.000Z",
		agents: {
			availability: "available",
			items: [{
				id: "researcher",
				name: "Researcher",
				description: "Finds and synthesizes citation-ready evidence without modifying the project.",
				version: 1,
				source: "builtin",
				audience: "base",
				category: "research",
				capability: "read-only",
				latency: "deep",
				contextTier: "none",
				tags: ["evidence", "citations"],
				skills: ["arxiv-literature"],
				tools: ["read", "web_fetch", "code_nav"],
				resultKind: "research-report",
				budget: {
					toolCalls: 24,
					readReserve: 4,
					synthesis: true,
					maximumToolCalls: 64,
					maximumReadReserve: 10,
				},
			}],
			truncated: false,
			issueCount: 0,
		},
		skills: {
			availability: "available",
			items: [{
				name: "frontend-design",
				description: "Creates distinctive production-grade web interfaces with strong visual hierarchy.",
				scope: "user",
				source: "claude",
				trusted: true,
				precedence: 20,
				modelInvocable: true,
				issueCount: 0,
			}],
			truncated: false,
			issueCount: 1,
		},
		library: {
			availability: "available",
			items: [{
				kind: "skill",
				name: "experiment-protocol",
				description: "Pre-registers thresholds and verdict conditions before scientific performance measurements.",
				version: "0.1.2",
				category: "research",
				origin: "catalog",
				audit: "pass",
			}],
			truncated: false,
			issueCount: 0,
		},
		verifiers: { availability: "typed-interface-required" },
	};
}

export function usageInspectionFixture(): WireUsageInspection {
	return {
		inspectedAt: "2026-08-29T14:00:00.000Z",
		schema: "experimental",
		windowDays: 30,
		windowFrom: "2026-07-30T13:00:00.000Z",
		windowTo: "2026-08-29T13:00:00.000Z",
		stores: { sessions: "available", dispatchReceipts: "available" },
		sessionCount: 3,
		dispatchRunCount: 2,
		totals: {
			apiCalls: 42,
			input: 8_500_000,
			output: 1_200_000,
			cacheRead: 3_400_000,
			cacheWrite: 22_000,
			reasoning: 800_000,
			totalTokens: 13_922_000,
			costUsd: 4.125,
			turns: 38,
			sideQuestions: 3,
			handoffs: 1,
		},
		models: [{
			provider: "lmstudio",
			model: "qwen3.8-27b",
			apiCalls: 42,
			input: 8_500_000,
			output: 1_200_000,
			cacheRead: 3_400_000,
			cacheWrite: 22_000,
			reasoning: 800_000,
			totalTokens: 13_922_000,
			costUsd: 4.125,
		}],
		modelsTruncated: false,
		tools: [{ name: "read", calls: 17, successful: 16, errors: 1, blocked: 0 }],
		toolsTruncated: false,
		skills: [
			{ name: "frontend-design", activations: 5, observedInWindow: true },
			{ name: "experiment-protocol", activations: 0, observedInWindow: false },
		],
		skillsTruncated: false,
		recipes: [{ agentId: "researcher", runs: 4 }],
		recipesTruncated: false,
		opportunities: [
			{ kind: "workflow-distiller", count: 1 },
			{ kind: "recipe", count: 1 },
		],
	};
}

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
		configInspection: null,
		catalogInspection: null,
		usageInspection: null,
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
	"config.state",
	"catalog.state",
	"usage.state",
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
