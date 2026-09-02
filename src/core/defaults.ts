// Default constants for Clio Coder settings.

/**
 * Default settings shipped with Clio Coder. Written to the resolved config
 * directory's settings.yaml on first install if the file does not already
 * exist. Users edit the file directly or through TUI overlays.
 */

import { DEFAULT_WORKING_SET_SETTINGS } from "../domains/context/working-set/defaults.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import { GUARDRAIL_DEFAULTS } from "./guardrails.js";

export type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
export type { AutonomyLevel } from "../domains/safety/autonomy.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export interface WorkerTarget {
	target: string | null;
	model: string | null;
	thinkingLevel: ThinkingLevel;
	/** Optional fleet node pin: workers routed through this profile run on that node. */
	node?: string;
}

export type WorkerProfiles = Record<string, WorkerTarget>;
export const COUNCIL_MEMBER_LABEL_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
export const THEME_NAMED_COLORS = [
	"accent",
	"accentDeep",
	"action",
	"success",
	"warning",
	"error",
	"info",
	"reason",
	"dim",
	"muted",
	"title",
	"frame",
	"frameStrong",
] as const;
export type ThemeNamedColor = (typeof THEME_NAMED_COLORS)[number];
export interface WorkerRosterMember {
	label: string;
	target: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	color?: ThemeNamedColor | string;
}
export type WorkerRosters = Record<string, { members: WorkerRosterMember[] }>;
/** Map of native agent id -> fleet.profiles key. Empty means no agent is pinned to a profile. */
export type FleetAgentProfiles = Record<string, string>;

/**
 * Non-stall posture for dispatched native workers. A worker tool call that
 * requires interactive permission resolves within bounded time: "deny" turns
 * it into a structured tool denial and the run continues; "fail" finalizes
 * the run immediately with outcome failed/permission_required; "escalate"
 * parks the call and hands it to the interactive operator, applying the
 * escalation fallback on timeout so the run still cannot hang. Escalate is
 * only meaningful with an interactive operator attached; headless sessions
 * have no subscriber, so the timeout fallback governs.
 */
export type WorkerPermissionMode = "deny" | "fail" | "escalate";

/** Bounds for the escalate posture; the timeout fallback keeps runs non-stall. */
export interface WorkerEscalationSettings {
	timeoutMs: number;
	fallback: "deny" | "fail";
}

export interface FleetPermissionsSettings {
	mode: WorkerPermissionMode;
	escalation: WorkerEscalationSettings;
}

export interface FleetRetrySettings {
	maxRetries: number;
	routeCooldownMs: number;
}

export interface FleetLimitsSettings {
	toolCallsPerRun: number;
	internalRunTimeoutMs: number;
}

export interface FleetHistorySettings {
	maxRuns: number;
	journal: boolean;
}

export interface FleetRouteSettings {
	default: WorkerTarget;
	profiles: WorkerProfiles;
	rosters: WorkerRosters;
	agentProfiles: FleetAgentProfiles;
}

/**
 * Compaction controls the session domain reads at runtime. The structural
 * type lives here so core/defaults.ts stays free of a backward domain
 * dependency; the engine-level defaults and the companion
 * DEFAULT_COMPACTION_SETTINGS value live alongside the rest of the
 * compaction engine in src/domains/session/compaction/defaults.ts.
 *
 * Fields:
 *   - auto: master switch for the chat-loop's pre-request trigger. Manual
 *     /context compact still runs when auto=false.
 *   - threshold: context pressure (estimated_tokens / context_window, 0..1)
 *     at which compaction acts: stale observations are masked first, and a
 *     full LLM summary runs if pressure stays above the threshold.
 *   - model: optional pattern (e.g. "provider/summary-model-id") used to
 *     resolve a dedicated summarization model. Falls back to the Chat target
 *     when absent.
 *   - systemPrompt: optional path to a prompt-override file; resolved to
 *     text at call time, not at settings load.
 */
export interface CompactionSettings {
	auto: boolean;
	threshold: number;
	excludeLastTurns: number;
	model?: string;
	systemPrompt?: string;
}

/** Durable v2 compaction settings. The legacy mask keeps its own compiled recent-turn fallback. */
export type DurableCompactionSettings = Omit<CompactionSettings, "excludeLastTurns">;

/**
 * Working-set layer settings (`context.workingSet`). The layer decides which
 * tool-result bodies and thinking blocks leave the model's working set when
 * pressure crosses `compaction.threshold`; it records evictions as ledger
 * entries and never rewrites history. Defaults and prose live in
 * src/domains/context/working-set/defaults.ts.
 *
 *   - enabled: master switch. Off skips eviction and goes straight to summary
 *     compaction (the legacy destructive mask is only reachable through
 *     CLIO_CODER_LEGACY_MASK=1).
 *   - policy: candidate selection rule set.
 *   - target: used/window ratio an applied event batches down to.
 *   - protectLastTurns: recent user turns whose observations are never evicted.
 *   - minEvictableTokens: results below this estimate are never evicted; the
 *     marker would cost more than it saves.
 */
export type WorkingSetPolicyId = "age-horizon" | "structural-v1";

export interface WorkingSetSettings {
	enabled: boolean;
	policy: WorkingSetPolicyId;
	target: number;
	protectLastTurns: number;
	minEvictableTokens: number;
}

/**
 * Prompt pre-warm (`chat.prewarm`). On a local server prefill is the cost,
 * and the prefix the next turn will send is fully known before the operator
 * types anything: at session start, after a resume rebuilds the message array,
 * and after a compaction settles. Clio sends that prefix to the backend right
 * then so the slot's prefix cache already holds it when the real turn arrives.
 *
 * The boolean is the master switch. The feature is off on every tier but
 *     `local-native` whatever this says, and off for workers and headless runs,
 *     because it buys latency for an operator watching a local server.
 */
export interface PanesSettings {
	/**
	 * Capability rung the pane layer may reach. `auto` takes guest mode when a
	 * pane host is detected; `embedded` asks Clio to own a private session, which
	 * degrades to none until that ships; `off` skips detection entirely.
	 */
	enabled: "auto" | "embedded" | "off";
	/** Which terminal run states raise a pane-host toast. */
	notifications: "failures" | "all" | "off";
	/**
	 * What composes itself at interactive boot in guest mode. `off` opens
	 * nothing (docks still open on demand); `workers` opens the workers dock;
	 * `cockpit` opens workers and files both.
	 */
	layout: "off" | "workers" | "cockpit";
	/** Workers dock: the live run viewer split right of the Clio pane. */
	workers: {
		/** Share of the width the dock takes, clamped to at most half. */
		ratio: number;
	};
	/** File-pane round-trip settings read live for each explicit open. */
	files: {
		enabled: boolean;
		mode: "companion" | "chooser";
		profile: "managed" | "user";
		followCwd: boolean;
		/** Share of the height the files dock takes, clamped to at most half. */
		ratio: number;
	};
}

/**
 * Transient provider retry controls for the interactive chat loop. These are
 * intentionally small and mirror the session retry helper defaults. Dispatched
 * worker runs are governed by `fleet.retry.maxRetries` instead; the two never meet.
 */
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	/** Silence on an in-flight stream past this many ms is treated as a wedged backend: abort and retry. */
	streamStallMs: number;
}

export type OutputVerbosity = "minimal" | "default" | "verbose";
export type TuiMode = "regular" | "fullscreen";
export type FullscreenScrollbar = "hidden" | "auto" | "always";
export type SmoothStreaming = "off" | "auto" | "on";

export interface InterfaceSettings {
	terminalProgress: boolean;
	/** Transcript detail: collapsed, balanced, or fully transparent. */
	outputDetail: OutputVerbosity;
	/** Regular scrollback-preserving renderer or alternate-screen sticky layout. */
	mode: TuiMode;
	/** Fullscreen transcript scrollbar visibility. */
	fullscreenScrollbar: FullscreenScrollbar;
	/** Presentation-only pacing for streamed assistant text and thinking. */
	smoothStreaming: SmoothStreaming;
	/**
	 * Content-free desktop notifications on turn end, detached batch settlement,
	 * and a parked approval. Interactive TTY runs only; headless, ACP, and
	 * non-TTY runs never emit one.
	 */
	desktopNotifications: boolean;
	panes: PanesSettings;
	keybindings: Record<string, string | string[]>;
}

/**
 * The opt-in turn-end watchdog. Off by default: it spends a worker run per
 * mutating turn, and an operator who has not asked for that must not pay for
 * it. `target` routes the run somewhere cheap, typically a local model, and
 * falls back to the session's active target when unset. `cadenceToolCalls`
 * additionally fires the watchdog every N tool calls inside a turn, which is
 * how mid-turn scope drift becomes visible before the turn ends.
 */
export interface ReviewSettings {
	enabled: boolean;
	/** Target id the watchdog run is dispatched to; the session's active target when unset. */
	target?: string;
	/** Mid-turn cadence in tool calls; no mid-turn firing when unset. */
	cadenceToolCalls?: number;
}

export interface ModelSelectorSettings {
	/** Exact target/model refs cycled by Alt+J/Alt+K. */
	cycleSet: string[];
	/** Exact target/model refs shown in the focused model picker. */
	favorites: string[];
	/** Maximum number of recently selected target/model refs to retain. */
	recentLimit: number;
}

export interface ProjectResourcesSettings {
	trustProjectImports: boolean;
}

export interface GitIntegrationSettings {
	/** Evidence-aware role trailers on commits created through Clio. */
	commitAttribution: boolean;
}

export type DelegationToolGovernance = "clio-coder-policy" | "agent-managed" | "deny-all";

/**
 * Application-level ACP request bounds. Unlike the separate stall watchdog,
 * these values never use zero as a disable sentinel: connect, turn, and
 * permission requests must always settle within a finite window.
 */
export const DEFAULT_DELEGATION_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_DELEGATION_TURN_TIMEOUT_MS = 300_000;
export const DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS = 120_000;

export interface DelegationAgentConfig {
	/** Stable id used by /delegate and dispatch receipts. */
	id: string;
	/** ACP stdio command. Official ACP v1 stdio messages are newline-delimited JSON-RPC. */
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
	connectTimeoutMs?: number;
	turnTimeoutMs?: number;
	permissionTimeoutMs?: number;
	/**
	 * Event-inactivity stall window: when no session/update arrives for this
	 * long, the reconciler cancels the turn and finalizes the run as stalled.
	 * Defaults to 300000; <= 0 disables the check.
	 */
	stallTimeoutMs?: number;
	toolGovernance?: DelegationToolGovernance;
	/**
	 * Project context sent to this external agent as a dynamic message.
	 * Defaults to "none": repo conventions/invariants never leave the machine
	 * unless the operator opts this agent into the bounded projection.
	 */
	projectContext?: "none" | "bounded";
	labels?: Record<string, string>;
}

export interface DelegationDefaults {
	connectTimeoutMs: number;
	turnTimeoutMs: number;
	permissionTimeoutMs: number;
	toolGovernance: DelegationToolGovernance;
}

export interface ExternalAgentsSettings {
	entries: DelegationAgentConfig[];
	defaults: DelegationDefaults;
}

/**
 * Residency posture a remote worker launches with. "observe" (the default)
 * forbids the worker from evicting or swapping any model resident on its
 * node; "manage" is an explicit per-node opt-in to the normal reconciler.
 */
export type FleetNodeResidency = "observe" | "manage";

/**
 * One SSH-reachable worker node. The implicit `local` node always exists and
 * is never declared here. Nodes become dispatch-eligible only after the
 * doctor fleet preflight verifies reachability, a version-matched clio-coder, and
 * path parity for the project root (shared-filesystem assumption).
 */
export interface FleetNodeSettings {
	/** Stable node id used in placement, receipts, and operator surfaces. */
	id: string;
	/** SSH destination host (name or address). */
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	/** Remote worker-entry invocation; defaults to `clio-coder worker` on the remote PATH. */
	clioCoderEntry?: string;
	/** Advisory routing labels (e.g. gpu, high-memory). */
	labels?: string[];
	/** Per-node concurrent worker cap. */
	maxWorkers: number;
	residency?: FleetNodeResidency;
}

export interface FleetSettings extends FleetRouteSettings {
	nodes: FleetNodeSettings[];
	adaptiveRouting: AdaptiveRoutingSettings;
	permissions: FleetPermissionsSettings;
	concurrency: "auto" | number;
	retry: FleetRetrySettings;
	limits: FleetLimitsSettings;
	history: FleetHistorySettings;
}

/** Roles whose authority is narrow enough for Slice 9 active joint routing. */
export const ACTIVE_ROUTING_ROLES = ["researcher", "verifier", "reviewer", "judge"] as const;
export type ActiveRoutingRole = (typeof ACTIVE_ROUTING_ROLES)[number];

/** Manual is exact rather than adaptive, so it is never an activated posture. */
export const ACTIVE_ROUTING_POSTURES = ["quality", "balanced", "latency", "economy"] as const;
export type ActiveRoutingPosture = (typeof ACTIVE_ROUTING_POSTURES)[number];

export const ACTIVE_AGENT_AUTOMATION_ROLES = ["builder", "researcher", "verifier", "reviewer", "judge"] as const;
export type ActiveAgentAutomationRole = (typeof ACTIVE_AGENT_AUTOMATION_ROLES)[number];

export interface ActiveAgentRole {
	agentId: string;
	executionRole: ActiveAgentAutomationRole;
}

export interface AdaptiveRoutingSettings {
	roles: ActiveRoutingRole[];
	postures: ActiveRoutingPosture[];
	/** Exact pairs only; independent agent and role lists would authorize their cross-product. */
	agentRoles: ActiveAgentRole[];
}

/** Compatibility type name for the dispatch planner; its fields are the canonical v2 fields. */
export type RoutingActivationSettings = AdaptiveRoutingSettings;

export interface ChatSettings extends WorkerTarget {
	modelPicker: ModelSelectorSettings;
	maxOutputTokens: number;
	prewarm: boolean;
	retry: RetrySettings;
}

export interface MemorySettings {
	enabled: boolean;
	target: string | null;
	model: string | null;
	cadenceToolCalls: number;
	trajectorySteps: number;
	maxOutputTokens: number;
	timeoutMs: number;
}

export interface ContextSettings {
	toolResultMaxBytes: number;
	workingSet: WorkingSetSettings;
	compaction: DurableCompactionSettings;
	memory: MemorySettings;
}

export interface SafetySettings {
	autonomy: AutonomyLevel;
	limits: {
		sessionCostUsd: number;
		chatToolCallsPerTurn: number;
		readBytesPerCall: number;
		observationBytesPerTurn: number;
	};
	review: ReviewSettings;
}

export interface IntegrationsSettings {
	projectResources: ProjectResourcesSettings;
	externalAgents: ExternalAgentsSettings;
	runtimePlugins: string[];
	library: {
		catalog: string | null;
		remote: string | null;
		confirmedRemote: string | null;
		sync: boolean;
	};
	git: GitIntegrationSettings;
}

export const DEFAULT_SETTINGS = {
	version: 2 as const,
	targets: [] as TargetDescriptor[],
	chat: {
		target: null as string | null,
		model: null as string | null,
		thinkingLevel: "low" as ThinkingLevel,
		modelPicker: {
			cycleSet: [] as string[],
			favorites: [] as string[],
			recentLimit: 12,
		} as ModelSelectorSettings,
		maxOutputTokens: 0,
		prewarm: true,
		retry: {
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 2000,
			maxDelayMs: 60000,
			streamStallMs: 180000,
		} as RetrySettings,
	} as ChatSettings,
	fleet: {
		default: {
			target: null as string | null,
			model: null as string | null,
			thinkingLevel: "off" as ThinkingLevel,
		} as WorkerTarget,
		profiles: {} as WorkerProfiles,
		rosters: {} as WorkerRosters,
		agentProfiles: {} as FleetAgentProfiles,
		nodes: [] as FleetNodeSettings[],
		adaptiveRouting: {
			roles: [] as ActiveRoutingRole[],
			postures: [] as ActiveRoutingPosture[],
			agentRoles: [] as ActiveAgentRole[],
		} as AdaptiveRoutingSettings,
		permissions: {
			mode: "deny" as WorkerPermissionMode,
			escalation: { timeoutMs: 120000, fallback: "deny" } as WorkerEscalationSettings,
		},
		concurrency: "auto" as "auto" | number,
		retry: { maxRetries: 2, routeCooldownMs: 15000 },
		limits: {
			toolCallsPerRun: GUARDRAIL_DEFAULTS.workerToolCallCap,
			internalRunTimeoutMs: GUARDRAIL_DEFAULTS.internalDispatchTimeoutMs,
		},
		history: { maxRuns: GUARDRAIL_DEFAULTS.maxDispatchRuns, journal: true },
	} as FleetSettings,
	context: {
		toolResultMaxBytes: 65536,
		workingSet: DEFAULT_WORKING_SET_SETTINGS,
		compaction: {
			auto: true,
			threshold: 0.8,
		} as DurableCompactionSettings,
		memory: {
			enabled: true,
			target: null as string | null,
			model: null as string | null,
			cadenceToolCalls: 10,
			trajectorySteps: 8,
			maxOutputTokens: 2000,
			timeoutMs: 60_000,
		} as MemorySettings,
	} as ContextSettings,
	safety: {
		autonomy: "auto-edit" as AutonomyLevel,
		limits: {
			sessionCostUsd: 5,
			chatToolCallsPerTurn: GUARDRAIL_DEFAULTS.turnToolCallBudget,
			readBytesPerCall: GUARDRAIL_DEFAULTS.readMaxBytes,
			observationBytesPerTurn: GUARDRAIL_DEFAULTS.observationTurnBudgetBytes,
		},
		review: { enabled: false } as ReviewSettings,
	} as SafetySettings,
	interface: {
		terminalProgress: false,
		outputDetail: "default",
		mode: "regular",
		fullscreenScrollbar: "auto",
		smoothStreaming: "off",
		desktopNotifications: false,
		panes: {
			enabled: "off",
			notifications: "failures",
			layout: "off",
			workers: { ratio: 0.34 },
			files: {
				enabled: false,
				mode: "companion",
				profile: "managed",
				followCwd: true,
				ratio: 0.3,
			},
		} as PanesSettings,
		keybindings: {} as Record<string, string | string[]>,
	} as InterfaceSettings,
	integrations: {
		projectResources: { trustProjectImports: false },
		externalAgents: {
			entries: [] as DelegationAgentConfig[],
			defaults: {
				connectTimeoutMs: DEFAULT_DELEGATION_CONNECT_TIMEOUT_MS,
				turnTimeoutMs: DEFAULT_DELEGATION_TURN_TIMEOUT_MS,
				permissionTimeoutMs: DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS,
				toolGovernance: "clio-coder-policy" as DelegationToolGovernance,
			},
		} as ExternalAgentsSettings,
		runtimePlugins: [] as string[],
		library: {
			catalog: null as string | null,
			remote: null as string | null,
			confirmedRemote: null as string | null,
			sync: false,
		},
		git: { commitAttribution: true },
	} as IntegrationsSettings,
};

export type DefaultSettings = typeof DEFAULT_SETTINGS;

/**
 * Raw YAML document written to the resolved config directory's settings.yaml on
 * first install. Mirrors every field of DEFAULT_SETTINGS at the same key path.
 *
 * The settings file is machine-owned after this first write: programmatic
 * writers serialize the schema directly, and comments do not survive the
 * first programmatic write.
 */
export const DEFAULT_SETTINGS_YAML = `# Clio Coder settings. Written once on first install.
# This file uses the version-2 human information architecture.
# Docs: https://github.com/iowarp/clio-coder

version: 2

# Configured inference endpoints. Target descriptor leaves are unchanged in v2.
targets: []

chat:
  target: null
  model: null
  thinkingLevel: low
  modelPicker:
    cycleSet: []
    favorites: []
    recentLimit: 12
  maxOutputTokens: 0
  prewarm: true
  retry:
    enabled: true
    maxRetries: 3
    baseDelayMs: 2000
    maxDelayMs: 60000
    streamStallMs: 180000

fleet:
  default:
    target: null
    model: null
    thinkingLevel: off
  profiles: {}
  rosters: {}
  agentProfiles: {}
  adaptiveRouting:
    roles: []
    postures: []
    agentRoles: []
  nodes: []
  permissions:
    mode: deny
    escalation:
      timeoutMs: 120000
      fallback: deny
  concurrency: auto
  retry:
    maxRetries: 2
    routeCooldownMs: 15000
  limits:
    toolCallsPerRun: 150
    internalRunTimeoutMs: 900000
  history:
    maxRuns: 1000
    journal: true

context:
  toolResultMaxBytes: 65536
  workingSet:
    enabled: true
    policy: structural-v1
    target: 0.6
    protectLastTurns: 6
    minEvictableTokens: 200
  compaction:
    auto: true
    threshold: 0.8
  memory:
    enabled: true
    target: null
    model: null
    cadenceToolCalls: 10
    trajectorySteps: 8
    maxOutputTokens: 2000
    timeoutMs: 60000

safety:
  autonomy: auto-edit
  limits:
    sessionCostUsd: 5
    chatToolCallsPerTurn: 60
    readBytesPerCall: 51200
    observationBytesPerTurn: 196608
  review:
    enabled: false

interface:
  outputDetail: default
  smoothStreaming: off
  mode: regular
  fullscreenScrollbar: auto
  terminalProgress: false
  desktopNotifications: false
  panes:
    enabled: off
    notifications: failures
    layout: off
    workers:
      ratio: 0.34
    files:
      enabled: false
      mode: companion
      profile: managed
      followCwd: true
      ratio: 0.3
  keybindings: {}

integrations:
  projectResources:
    trustProjectImports: false
  externalAgents:
    entries: []
    defaults:
      connectTimeoutMs: 30000
      turnTimeoutMs: 300000
      permissionTimeoutMs: 120000
      toolGovernance: clio-coder-policy
  runtimePlugins: []
  library:
    catalog: null
    remote: null
    confirmedRemote: null
    sync: false
  git:
    commitAttribution: true
`;
