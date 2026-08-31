import {
	PROTOCOL_VERSION,
	type ServerEventKind,
	type ServerEventOf,
	type ServerEventPayloadByKind,
	type WireCatalogInspection,
	type WireClioSnapshot,
	type WireConfigInspection,
	type WireDispatchInspection,
	type WireEvidenceDetail,
	type WireEvidenceInspection,
	type WireFleetInspection,
	type WireFleetVerification,
	type WireProjectWorkspace,
	type WireRecoveryInspection,
	type WireRoutingInspection,
	type WireSessionSummary,
	type WireTimelineItem,
	type WireToolchainInspection,
	type WireTraceInspection,
	type WireTreeNode,
	type WireUsageInspection,
} from "../src/protocol.ts";
import type { WireBootstrap } from "../src/state.ts";

export const FIXTURE_PROJECT_ID = "project-alpha-0001";
export const FIXTURE_ROOT = "/tmp/workbench-fixture/alpha";

export function dispatchInspectionFixture(): WireDispatchInspection {
	return {
		scope: "installation",
		inspectedAt: "2026-08-30T14:02:00.000Z",
		generatedAt: "2026-08-30T14:01:28.728Z",
		admission: { state: "open", expiresAt: null },
		running: { total: 5, alive: 3, stale: 1, dead: 1, unreported: 0 },
		retryingCount: 0,
		totals: {
			inputTokens: 9_557_544,
			outputTokens: 517_406,
			totalTokens: 15_918_587,
			costUsd: 1.78098108,
			runtimeSeconds: 42_963.751,
		},
	};
}

export function fleetInspectionFixture(): WireFleetInspection {
	return {
		scope: "installation",
		inspectedAt: "2026-08-31T14:02:00.000Z",
		generatedAt: "2026-08-31T14:01:28.728Z",
		runs: [{
			runId: "run-alpha",
			agentId: "builder",
			model: "qwen3-coder",
			target: "local-lmstudio",
			node: "local",
			phase: "succeeded",
			startedAt: "2026-08-31T14:00:00.000Z",
			elapsedMs: 30_000,
			task: "Inspect the durable event boundary",
			journal: "available",
			events: [
				{
					at: "2026-08-31T14:00:00.000Z",
					label: "run opened (builder)",
					detail: null,
				},
				{
					at: "2026-08-31T14:00:02.000Z",
					label: "tool completed",
					detail: "read project files",
				},
			],
			eventsTruncated: false,
			evidence: {
				state: "verified",
				summary: "trust v1: receipt integrity verified",
			},
			outcome: "succeeded",
			outcomeDetail: null,
			terminal: true,
		}],
		truncated: false,
		roots: [{
			rootId: "fleet-345ea2e6c1ad",
			fleet: "build-review",
			startedAt: "2026-08-31T13:59:00.000Z",
			elapsedMs: 210_000,
			running: true,
			resumedFrom: null,
			plannedSteps: 3,
			recordedSteps: 2,
			steps: [
				{
					stepId: "build",
					runId: "run-alpha",
					agentId: "builder",
					outcome: "succeeded",
					detail: null,
				},
				{
					stepId: "review",
					runId: "run-beta",
					agentId: "debugger",
					outcome: "failed",
					detail: "review gate produced no structured verdict",
				},
				{
					stepId: "apply",
					runId: null,
					agentId: null,
					outcome: "not run",
					detail: null,
				},
			],
			stepsTruncated: false,
		}],
		rootsTruncated: false,
	};
}

export function fleetVerificationFixture(): WireFleetVerification {
	return {
		runId: "run-alpha",
		verifiedAt: "2026-08-31T14:05:00.000Z",
		state: "failed",
		reason: "ledger-mismatch",
		axes: {
			artifactIntegrity: "failed",
			validationGrounding: "absent",
			independentReview: "absent",
			contextProvenance: "absent",
			autonomyEnforcement: "absent",
			completionEvidence: "absent",
		},
	};
}

export function toolchainInspectionFixture(): WireToolchainInspection {
	return {
		scope: "installation",
		inspectedAt: "2026-08-31T15:02:00.000Z",
		tools: [
			{
				id: "herdr",
				pinnedVersion: "0.8.2",
				license: "Apache-2.0",
				platform: "linux-x64",
				supported: true,
				installed: true,
				source: "vendored",
				foundVersion: "0.8.2",
				minimumVersion: "0.8.2",
				pathCandidate: { version: "0.7.5", satisfiesMinimum: false },
			},
			{
				id: "yazi",
				pinnedVersion: "26.8.15",
				license: "MIT",
				platform: "linux-x64",
				supported: true,
				installed: false,
				source: "none",
				foundVersion: null,
				minimumVersion: "26.8.15",
				pathCandidate: { version: "26.1.22", satisfiesMinimum: false },
			},
		],
		truncated: false,
	};
}

export function traceInspectionFixture(): WireTraceInspection {
	return {
		scope: "installation",
		inspectedAt: "2026-08-31T14:02:00.000Z",
		generatedAt: "2026-08-31T14:01:30.000Z",
		available: true,
		runs: [{
			runId: "run-alpha",
			agent: "builder",
			target: "local-lmstudio",
			model: "qwen3-coder",
			runtime: "lmstudio",
			node: null,
			status: "success",
			startedAt: "2026-08-31T14:00:00.000Z",
			elapsedMs: 30_000,
			totalTokens: 28_665,
			totalCostUsd: 0.4213,
			phases: [
				{
					name: "builder",
					kind: "agent",
					owner: "builder",
					status: "success",
					attempt: 1,
					retries: 0,
					failed: false,
					elapsedMs: 21_000,
					totalTokens: 20_120,
					totalCostUsd: 0.31,
				},
				{
					name: "gate",
					kind: "verifier",
					owner: "verifier",
					status: "fail",
					attempt: 2,
					retries: 1,
					failed: true,
					elapsedMs: 9_000,
					totalTokens: 8_545,
					totalCostUsd: 0.1113,
				},
			],
			phasesTruncated: false,
		}],
		truncated: false,
	};
}

export function evidenceDetailFixture(): WireEvidenceDetail {
	return {
		evidenceId: "run-alpha-bundle",
		sourceKind: "run",
		inspectedAt: "2026-08-31T14:03:00.000Z",
		generatedAt: "2026-08-31T14:00:40.000Z",
		canonical: true,
		runs: [
			{
				runId: "run-alpha",
				verdict: "compromised",
				axes: {
					artifactIntegrity: "verified",
					validationGrounding: "failed",
					independentReview: "absent",
					contextProvenance: "recorded",
					autonomyEnforcement: "enforced",
					completionEvidence: "absent",
				},
			},
			{
				runId: "run-beta",
				verdict: "grounded",
				axes: {
					artifactIntegrity: "verified",
					validationGrounding: "validated",
					independentReview: "absent",
					contextProvenance: "recorded",
					autonomyEnforcement: "enforced",
					completionEvidence: "evidenced",
				},
			},
		],
		runsTruncated: false,
	};
}

export function evidenceInspectionFixture(): WireEvidenceInspection {
	return {
		scope: "installation",
		inspectedAt: "2026-08-31T14:02:00.000Z",
		generatedAt: "2026-08-31T14:01:40.000Z",
		artifacts: [
			{
				evidenceId: "run-alpha-bundle",
				sourceKind: "run",
				generatedAt: "2026-08-31T14:00:40.000Z",
				startedAt: "2026-08-31T14:00:00.000Z",
				endedAt: "2026-08-31T14:00:30.000Z",
				runIds: ["run-alpha", "run-beta"],
				runIdsTruncated: true,
				agentIds: ["builder", "debugger"],
				statuses: ["completed"],
				tags: ["audit-linked", "blocked-tool"],
				totals: {
					runs: 2,
					receipts: 2,
					toolCalls: 9,
					toolErrors: 1,
					blockedToolCalls: 2,
					protectedArtifacts: 1,
					tokens: 28_665,
					costUsd: 0.4213,
					wallTimeMs: 30_000,
				},
				redactionCount: 3,
				trust: { verdict: "compromised", runsCovered: 2, historical: false },
			},
			{
				evidenceId: "session-legacy-bundle",
				sourceKind: "session",
				generatedAt: "2026-08-30T09:00:00.000Z",
				startedAt: null,
				endedAt: null,
				runIds: [],
				runIdsTruncated: false,
				agentIds: [],
				statuses: [],
				tags: [],
				totals: {
					runs: 1,
					receipts: 0,
					toolCalls: 0,
					toolErrors: 0,
					blockedToolCalls: 0,
					protectedArtifacts: 0,
					tokens: 0,
					costUsd: 0,
					wallTimeMs: 0,
				},
				redactionCount: 0,
				trust: { verdict: "unknown", runsCovered: 0, historical: true },
			},
		],
		truncated: true,
	};
}

export function recoveryInspectionFixture(): WireRecoveryInspection {
	return {
		scope: "installation",
		projectContext: true,
		inspectedAt: "2026-08-30T15:00:00.000Z",
		healthy: false,
		pathsResolved: 4,
		versions: { clioCoder: "0.3.9", node: "v24.9.0", platform: "linux-x64" },
		summary: { checks: 18, passed: 12, warnings: 4, failures: 2 },
		sections: [
			{ id: "runtime", checks: 4, passed: 4, warnings: 0, failures: 0 },
			{ id: "storage", checks: 4, passed: 4, warnings: 0, failures: 0 },
			{ id: "configuration", checks: 2, passed: 1, warnings: 0, failures: 1 },
			{ id: "history", checks: 1, passed: 1, warnings: 0, failures: 0 },
			{ id: "models", checks: 2, passed: 0, warnings: 1, failures: 1 },
			{
				id: "interoperability",
				checks: 1,
				passed: 0,
				warnings: 1,
				failures: 0,
			},
			{ id: "toolchain", checks: 1, passed: 0, warnings: 1, failures: 0 },
			{ id: "panes", checks: 1, passed: 1, warnings: 0, failures: 0 },
			{ id: "fleet", checks: 1, passed: 0, warnings: 1, failures: 0 },
			{ id: "other", checks: 1, passed: 1, warnings: 0, failures: 0 },
		],
		checks: [
			{ name: "Clio Coder version", section: "runtime", level: "ok" },
			{ name: "node version", section: "runtime", level: "ok" },
			{ name: "platform", section: "runtime", level: "ok" },
			{ name: "engine runtime", section: "runtime", level: "ok" },
			{ name: "config dir", section: "storage", level: "ok" },
			{ name: "data dir", section: "storage", level: "ok" },
			{ name: "state dir", section: "storage", level: "ok" },
			{ name: "cache dir", section: "storage", level: "ok" },
			{ name: "settings.yaml", section: "configuration", level: "error" },
			{ name: "credentials", section: "configuration", level: "ok" },
			{ name: "session store", section: "history", level: "ok" },
			{ name: "target private-lab", section: "models", level: "warn" },
			{ name: "model private-lab", section: "models", level: "error" },
			{ name: "interop private-peer", section: "interoperability", level: "warn" },
			{ name: "fleet node ssh-private", section: "fleet", level: "warn" },
			{ name: "external tool yazi", section: "toolchain", level: "warn" },
			{ name: "panes socket", section: "panes", level: "ok" },
			// A check whose name held a native path arrives unnamed.
			{ name: null, section: "other", level: "ok" },
		],
		checksTruncated: false,
	};
}

export function configInspectionFixture(): WireConfigInspection {
	return {
		inspectedAt: "2026-08-29T12:00:00.000Z",
		settings: [
			{
				key: "autonomy",
				source: "project",
				value: "suggest",
				valueKind: "exact",
			},
			{
				key: "orchestrator.model",
				source: "project",
				value: "qwen3.8-27b",
				valueKind: "exact",
			},
			{
				key: "retry.maxRetries",
				source: "user",
				value: "3",
				valueKind: "exact",
			},
			{
				key: "targets",
				source: "user",
				value: "4 items",
				valueKind: "collection",
			},
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
				facts: [{ label: "Version", value: "1.2.0" }, {
					label: "Effective",
					value: "yes",
				}],
			},
			{
				category: "memory",
				id: "memory-store",
				scope: "user",
				trust: "trusted",
				precedence: "single",
				reloadClass: "hot",
				facts: [{ label: "Present", value: "yes" }, {
					label: "Records",
					value: "7",
				}],
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
		extensions: {
			availability: "available",
			items: [{
				id: "clio-lab-pack",
				name: "Clio Coder Lab Pack",
				version: "2.1.0",
				description: "Contributes research agents, prompts, and skills to this project.",
				scope: "project",
				enabled: true,
				effective: true,
				overriddenBy: null,
				resources: ["skills", "prompts", "agents"],
				issueCount: 0,
			}],
			truncated: false,
			issueCount: 0,
		},
		verifiers: { availability: "typed-interface-required" },
	};
}

export function routingInspectionFixture(): WireRoutingInspection {
	return {
		inspectedAt: "2026-08-29T15:00:00.000Z",
		models: {
			availability: "available",
			items: [
				{
					targetId: "lmstudio",
					runtimeId: "openai-compatible",
					modelId: "qwen3.8-27b",
					capabilities: ["chat", "tools", "reasoning"],
					contextWindow: 262_144,
					maxOutputTokens: 32_768,
					residency: "loaded",
				},
				{
					targetId: "lmstudio",
					runtimeId: "openai-compatible",
					modelId: "qwen3.8-4b",
					capabilities: ["chat", "tools"],
					contextWindow: 131_072,
					maxOutputTokens: 16_384,
					residency: "unloaded",
				},
			],
			truncated: false,
			emptyTargetCount: 1,
		},
		profiles: {
			availability: "available",
			items: [{
				name: "deep-research",
				target: "lmstudio",
				runtime: "openai-compatible",
				model: "qwen3.8-27b",
				thinkingLevel: "high",
			}],
			truncated: false,
		},
		bindings: {
			availability: "available",
			items: [
				{
					agentId: "researcher",
					profile: "deep-research",
					target: "lmstudio",
					model: "qwen3.8-27b",
					resolved: true,
				},
				{
					agentId: "critic",
					profile: "missing-profile",
					target: null,
					model: null,
					resolved: false,
				},
			],
			truncated: false,
		},
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
			dispatchEvents: true,
			agentAttribution: true,
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
		routingInspection: null,
		targets: null,
		targetsTruncated: false,
		fleet: [],
		processGeneration: "generation-alpha-0001",
		lastSequence: 0,
		...overrides,
	};
}

export function bootstrapFixture(
	overrides: Partial<WireBootstrap> = {},
): WireBootstrap {
	return {
		protocolVersion: PROTOCOL_VERSION,
		appName: "Clio Coder" as const,
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
		stateDirNote: "The desktop app keeps only its recent-project list under /tmp/workbench-fixture/state.",
		securityNote: "The desktop app enforces the project boundary in its own code; Deno grants are broad.",
		dispatchInspection: null,
		fleetInspection: null,
		toolchainInspection: null,
		traceInspection: null,
		evidenceInspection: null,
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
	"routing.state",
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
		: kind === "fleet.activity"
		// Session scoped: a dispatch run can settle after the turn that started it.
		? {
			projectId: options.projectId ?? FIXTURE_PROJECT_ID,
			processGeneration: options.processGeneration ?? "generation-alpha-0001",
			sessionId: options.sessionId ?? "session-alpha-0001",
		}
		: PROJECT_EVENT_KINDS.has(kind)
		? { projectId: options.projectId ?? FIXTURE_PROJECT_ID }
		: {};
	return {
		protocolVersion: PROTOCOL_VERSION,
		workspaceInstanceId: options.workspaceInstanceId ??
			"workspace-fixture-0001",
		sequence,
		eventId: options.eventId ??
			`event-${kind.replaceAll(".", "-")}-${sequence}`,
		kind,
		...context,
		terminal: kind === "turn.terminal" || kind === "protocol.error",
		payload,
	} as ServerEventOf<K>;
}
