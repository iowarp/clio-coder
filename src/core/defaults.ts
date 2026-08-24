/**
 * Default settings shipped with Clio Coder. Written to the resolved config
 * directory's settings.yaml on first install if the file does not already
 * exist. Users edit the file directly or through TUI overlays.
 */

import { DEFAULT_WORKING_SET_SETTINGS } from "../domains/context/working-set/defaults.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import { GUARDRAIL_DEFAULTS, type GuardrailValues } from "./guardrails.js";

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
/** Map of agent id -> workers.profiles key. Empty means no agent is pinned to a profile. */
export type WorkerAgentBindings = Record<string, string>;

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

export interface WorkersSettings {
	default: WorkerTarget;
	profiles: WorkerProfiles;
	agentBindings: WorkerAgentBindings;
	/**
	 * Bounded automatic retries for a dispatched worker run whose outcome is
	 * retryable. 0 disables. This is the sole governor of a dispatch assignment's
	 * retry chain; the unrelated top-level `retry` block governs the interactive
	 * session's own provider calls.
	 */
	maxRetries: number;
	onPermission: WorkerPermissionMode;
	/** Escalate-posture bounds; defaults 120000 ms with a deny fallback. */
	escalation?: WorkerEscalationSettings;
	resilienceCooldownMs?: number;
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
 *   - excludeLastTurns: number of recent user turns protected from
 *     observation masking.
 *   - model: optional pattern (e.g. "provider/summary-model-id") used to
 *     resolve a dedicated summarization model. Falls back to the orchestrator
 *     target when absent.
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
 * Transient provider retry controls for the interactive chat loop. These are
 * intentionally small and mirror the session retry helper defaults. Dispatched
 * worker runs are governed by `workers.maxRetries` instead; the two never meet.
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

export interface TerminalSettings {
	showTerminalProgress: boolean;
	/** Transcript detail: collapsed, balanced, or fully transparent. */
	outputVerbosity: OutputVerbosity;
	/** Regular scrollback-preserving renderer or alternate-screen sticky layout. */
	tuiMode: TuiMode;
	/** Fullscreen transcript scrollbar visibility. */
	fullscreenScrollbar: FullscreenScrollbar;
	/** Presentation-only pacing for streamed assistant text and thinking. */
	smoothStreaming: SmoothStreaming;
	/**
	 * Content-free desktop notifications on turn end, detached batch settlement,
	 * and a parked approval. Interactive TTY runs only; headless, ACP, and
	 * non-TTY runs never emit one.
	 */
	notify: boolean;
}

/**
 * The opt-in turn-end watchdog. Off by default: it spends a worker run per
 * mutating turn, and an operator who has not asked for that must not pay for
 * it. `target` routes the run somewhere cheap, typically a local model, and
 * falls back to the session's active target when unset. `cadenceToolCalls`
 * additionally fires the watchdog every N tool calls inside a turn, which is
 * how mid-turn scope drift becomes visible before the turn ends.
 */
export interface WatchdogSettings {
	enabled: boolean;
	/** Target id the watchdog run is dispatched to; the session's active target when unset. */
	target?: string;
	/** Mid-turn cadence in tool calls; no mid-turn firing when unset. */
	cadenceToolCalls?: number;
}

export interface ModelSelectorSettings {
	/** Exact target/model refs shown in the focused model picker. */
	favorites: string[];
	/** Maximum number of recently selected target/model refs to retain. */
	recentLimit: number;
}

export interface SkillsSettings {
	trustProjectCompatRoots: boolean;
}

export interface AttributionSettings {
	/** Evidence-aware role trailers on commits created through Clio. */
	gitCommits: boolean;
}

export type DelegationToolGovernance = "clio-policy" | "agent-managed" | "deny-all";

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

export interface DelegationSettings {
	agents: DelegationAgentConfig[];
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

export interface FleetSettings {
	nodes: FleetNodeSettings[];
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

export interface AgentAutomationActivationSettings {
	/** Exact pairs only; independent agent and role lists would authorize their cross-product. */
	activeAgentRoles: ActiveAgentRole[];
}

export interface RoutingActivationSettings {
	activeRoles: ActiveRoutingRole[];
	activePostures: ActiveRoutingPosture[];
	agentAutomation: AgentAutomationActivationSettings;
}

export const DEFAULT_SETTINGS = {
	version: 1 as const,
	autonomy: "auto-edit" as AutonomyLevel,
	targets: [] as TargetDescriptor[],
	runtimePlugins: [] as string[],
	orchestrator: {
		target: null as string | null,
		model: null as string | null,
		thinkingLevel: "off" as ThinkingLevel,
	},
	// Optional small-model plane for task-memory maintenance. An unset target
	// keeps proactive memory in its deterministic rules-only tier.
	background: {
		target: null as string | null,
		model: null as string | null,
		thinkingLevel: "off" as ThinkingLevel,
	},
	memory: {
		intervention: {
			enabled: true,
			everyNTools: 10,
			windowSteps: 8,
			maxTokens: 400,
			// A memory step runs detached from the turn that triggered it, so a
			// generous deadline costs no interactive latency. Measured steps on a
			// small local route ranged past two minutes, and a deadline shorter than
			// the model discards finished work as a timeout.
			timeoutMs: 180_000,
		},
	},
	watchdog: { enabled: false } as WatchdogSettings,
	workers: {
		default: {
			target: null as string | null,
			model: null as string | null,
			thinkingLevel: "off" as ThinkingLevel,
		} as WorkerTarget,
		profiles: {} as WorkerProfiles,
		agentBindings: {} as WorkerAgentBindings,
		maxRetries: 2,
		onPermission: "deny" as WorkerPermissionMode,
		escalation: { timeoutMs: 120000, fallback: "deny" } as WorkerEscalationSettings,
		resilienceCooldownMs: 15000,
	} as WorkersSettings,
	fleet: {
		nodes: [] as FleetNodeSettings[],
	} as FleetSettings,
	routing: {
		activeRoles: [] as ActiveRoutingRole[],
		activePostures: [] as ActiveRoutingPosture[],
		agentAutomation: { activeAgentRoles: [] as ActiveAgentRole[] },
	} as RoutingActivationSettings,
	scope: [] as string[],
	modelSelector: {
		favorites: [] as string[],
		recentLimit: 12,
	} as ModelSelectorSettings,
	budget: {
		sessionCeilingUsd: 5,
		concurrency: "auto" as "auto" | number,
	},
	defaults: {
		// Output tokens requested per turn, applied to every target. The value is
		// always clamped down to the model's known max-output cap and the
		// remaining context window at request time, so a model that supports less
		// automatically gets less. 0 disables the global default and falls back to
		// per-model caps only.
		maxTokens: 32768,
	},
	theme: "default",
	terminal: {
		showTerminalProgress: false,
		outputVerbosity: "default",
		tuiMode: "regular",
		fullscreenScrollbar: "auto",
		smoothStreaming: "off",
		notify: false,
	} as TerminalSettings,
	skills: {
		trustProjectCompatRoots: false,
	} as SkillsSettings,
	attribution: {
		gitCommits: true,
	} as AttributionSettings,
	delegation: {
		agents: [] as DelegationAgentConfig[],
		defaults: {
			connectTimeoutMs: DEFAULT_DELEGATION_CONNECT_TIMEOUT_MS,
			turnTimeoutMs: DEFAULT_DELEGATION_TURN_TIMEOUT_MS,
			permissionTimeoutMs: DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS,
			toolGovernance: "clio-policy" as DelegationToolGovernance,
		},
	} as DelegationSettings,
	// User keybinding overrides. Each id maps to a single KeyId string or a
	// list of KeyIds. The interactive keybinding manager reads this table
	// and layers it on top of CLIO_KEYBINDINGS defaults (src/domains/config/
	// keybindings.ts).
	keybindings: {} as Record<string, string | string[]>,
	compaction: {
		auto: true,
		threshold: 0.8,
		excludeLastTurns: 6,
	} as CompactionSettings,
	context: {
		workingSet: DEFAULT_WORKING_SET_SETTINGS,
	},
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		maxDelayMs: 60000,
		streamStallMs: 180000,
	} as RetrySettings,
	// Numeric backstops that bound runaway agent behavior. Settings are the
	// primary home; each value also has a per-process env override for CI and
	// one-off experiments (core/guardrails.ts documents both).
	guardrails: { ...GUARDRAIL_DEFAULTS } as GuardrailValues,
};

export type DefaultSettings = typeof DEFAULT_SETTINGS;

/**
 * Raw YAML document written to the resolved config directory's settings.yaml on
 * first install. Mirrors every field of DEFAULT_SETTINGS at the same key path
 * and carries fully commented example target blocks that a new user can
 * uncomment to point Clio Coder at a local llama-server or LM Studio.
 *
 * The settings file is machine-owned after this first write: programmatic
 * writers serialize the schema directly, and comments do not survive the
 * first programmatic write.
 */
export const DEFAULT_SETTINGS_YAML = `# Clio Coder settings. Written once on first install.
# The file is machine-owned: \`clio-coder configure\`, \`clio-coder targets\`, and the TUI
# rewrite it whole, and comments (including these) do not survive that write.
# Docs: https://github.com/iowarp/clio-coder
#
# Default location:
#   Linux:   ~/.config/clio-coder/settings.yaml
#   macOS:   ~/Library/Application Support/clio-coder/config/settings.yaml
#   Windows: %APPDATA%/clio-coder/config/settings.yaml
# Set CLIO_CODER_HOME for a single-tree install, or CLIO_CODER_CONFIG_DIR / CLIO_CODER_DATA_DIR /
# CLIO_CODER_STATE_DIR / CLIO_CODER_CACHE_DIR to override each directory separately.
#
# Common first run after installation:
#   1. Repair/create local state: clio-coder doctor --fix
#   2. List runtimes: clio-coder configure --list
#   3. Configure one target with your runtime/model (examples below).
#   4. Select and probe it: clio-coder targets use <id> && clio-coder targets --probe
#   5. Launch: clio-coder

version: 1
autonomy: auto-edit         # read-only | suggest | auto-edit | full-auto

# Inference targets. Each entry becomes selectable for chat and workers.
# Add entries via \`clio-coder configure\` or \`clio-coder targets add\`
# or hand-edit. \`runtime\` must match an id registered in the runtime registry
# (cloud APIs, local HTTP engines, or third-party plugins in the \`runtimes/\`
# directory next to this file).
targets: []
# Local runtime examples (uncomment/adapt one; replace your-model-id):
#   clio-coder configure --id local-lmstudio --runtime lmstudio --url http://localhost:1234 --model your-model-id --set-orchestrator --set-fleet-default
#   clio-coder configure --id local-ollama --runtime ollama-native --url http://localhost:11434 --model your-model-id --set-orchestrator --set-fleet-default
#   clio-coder configure --id local-llamacpp --runtime llamacpp --url http://127.0.0.1:8080 --model your-model-id --set-orchestrator --set-fleet-default
#   clio-coder configure --id local-vllm --runtime vllm --url http://localhost:8000 --model your-model-id --set-orchestrator --set-fleet-default
#   clio-coder configure --id local-sglang --runtime sglang --url http://localhost:30000 --model your-model-id --set-orchestrator --set-fleet-default
# Add --context-window <tokens>, --max-tokens <tokens>, or --reasoning true
# only when you have runtime/model-specific values to override probe results.
#
# Example target block equivalent to one configured local runtime:
# targets:
#   - id: local-lmstudio
#     runtime: lmstudio
#     url: http://localhost:1234
#     defaultModel: your-model-id
#     capabilities:
#       reasoning: true

# Optional npm packages that export clioRuntimes: RuntimeDescriptor[].
runtimePlugins: []

# Orchestrator target for the interactive loop. \`target\` refers to
# targets[].id; \`model\` is the wire model id to request.
# Keep thinkingLevel off unless a target/model supports explicit reasoning levels.
orchestrator:
  target: null
  model: null
  thinkingLevel: off

# Optional background target for proactive task memory. Leave unset for the
# zero-cost rules-only tier; setting it opts this session into LLM memory steps.
background:
  target: null
  model: null
  thinkingLevel: off

memory:
  intervention:
    enabled: true
    everyNTools: 10
    windowSteps: 8
    maxTokens: 400
    timeoutMs: 180000

# Opt-in turn-end watchdog. When enabled, a turn that changed the tree is
# reviewed by one read-only verifier run briefed with the turn's coalesced diff
# and the task board's current scope; its blockers become one transcript notice
# and nothing else. Set target to route the run at a cheap local model. Set
# cadenceToolCalls to also fire every N tool calls inside a turn. Headless and
# ACP runs never fire it.
watchdog:
  enabled: false
  # target: local-lmstudio
  # cadenceToolCalls: 20

# Worker targets for dispatch. \`default\` preserves the legacy behavior when a
# recipe or request does not specify an override. \`profiles\` are named
# target/model/thinking choices. \`agentBindings\` pins native Clio agents,
# including shadow agents such as scout/researcher/provenance, to a profile.
workers:
  default:
    target: null
    model: null
    thinkingLevel: off
  profiles: {}
  # Example profile entry:
  # profiles:
  #   fast-local:
  #     target: local-lmstudio
  #     model: your-model-id
  #     thinkingLevel: off
  # agentBindings maps agent id -> profiles key, e.g. scout: fast-local.
  agentBindings: {}
  maxRetries: 2
  # onPermission: what a worker does when a tool call needs interactive
  # permission. "deny" turns it into a structured tool denial and the run
  # continues; "fail" finalizes the run as failed/permission_required;
  # "escalate" hands the ask to the interactive operator (timeout fallback
  # below keeps the run non-stall).
  onPermission: deny
  # escalation: bounds for the escalate posture. A parked ask with no operator
  # decision within timeoutMs applies the fallback deny/fail.
  escalation:
    timeoutMs: 120000
    fallback: deny
  resilienceCooldownMs: 15000

# Fleet worker nodes reachable over SSH. The implicit \`local\` node always
# exists and is never declared. A node becomes dispatch-eligible only after
# \`clio-coder doctor\` verifies SSH reachability, a version-matched clio-coder, path
# parity for the project root (shared filesystem), and a writable state dir.
# residency defaults to observe: remote workers never evict models resident
# on their node (set manage per node to opt into the reconciler).
fleet:
  nodes: []
  # - id: node-a
  #   host: node-a.example.net
  #   user: me
  #   identityFile: ~/.ssh/id_fleet
  #   labels: [cpu]
  #   maxWorkers: 2
  # - id: node-b
  #   host: node-b.example.net
  #   maxWorkers: 1
  #   residency: observe

# Joint route selection is shadow-only unless both the execution role and the
# requested posture are named here. Manual pins remain exact and fail closed.
routing:
  activeRoles: []       # researcher | verifier | reviewer | judge
  activePostures: []    # quality | balanced | latency | economy
  # Agent changes remain advisory unless the concrete agent/role pair appears
  # here. Exact pairs avoid implicitly approving an agents × roles cross-product.
  agentAutomation:
    activeAgentRoles: []

# Alt+J / Alt+K cycling order: plain target ids or "target/model" refs.
scope: []

# /model focused picker. Favorites are exact "target/model" refs shown before
# the full search catalog. Recently selected models are runtime state and live
# in the state dir (recent-models.json), not in this file.
modelSelector:
  favorites: []
  recentLimit: 12

# Session budget guardrails.
budget:
  sessionCeilingUsd: 5
  concurrency: auto           # auto or a positive integer

# Global request defaults applied to every target.
#   maxTokens  output tokens requested per turn. Always clamped down to the
#              model's known max-output cap and the remaining context window,
#              so models that support less automatically get less. Set 0 to
#              fall back to per-model caps only.
defaults:
  maxTokens: 32768

theme: default
terminal:
  # OSC 9;4 terminal progress badges are opt-in; some terminals surface these
  # in taskbars/tabs and keep them visible for long-running agent work.
  showTerminalProgress: false
  # Transcript detail: minimal, default, or verbose. Also changeable with /output.
  outputVerbosity: default
  # regular preserves terminal scrollback; fullscreen keeps the editor/footer
  # sticky above an independently scrollable alternate-screen transcript.
  tuiMode: regular
  # hidden, auto (visible while scrolling), or always in fullscreen mode.
  fullscreenScrollbar: auto
  # off preserves immediate 16ms coalescing; auto paces only on a capable,
  # accessibility-safe local TTY; on requests pacing but still honors stdout
  # backpressure. CLIO_CODER_SMOOTH_STREAM overrides this for one process.
  smoothStreaming: off
  # Content-free desktop notification (OSC 777, or OSC 9 on iTerm2, Windows
  # Terminal, and ConEmu) when a turn ends, a detached batch settles, or an
  # approval parks. Interactive TTY runs only; the body never carries prompt
  # text, file paths, or model output.
  notify: false

# Skills are local prompt resources. Project-local compatibility roots such as
# .agents/skills, .claude/skills, .codex/skills, .github/skills, and
# .opencode/skills stay hidden from model invocation unless this is true or
# CLIO_CODER_TRUST_PROJECT_SKILLS=1 is set for the process.
skills:
  trustProjectCompatRoots: false

# Evidence-aware Git commit provenance. The identity and trailer semantics are
# compiled into Clio; this switch only enables or disables attribution.
attribution:
  gitCommits: true

# External coding agents that speak Agent Client Protocol v1 over stdio.
# These are delegated harnesses, not model targets, so they stay outside
# targets[], orchestrator, workers, and model pickers.
delegation:
  defaults:
    connectTimeoutMs: ${DEFAULT_DELEGATION_CONNECT_TIMEOUT_MS}
    turnTimeoutMs: ${DEFAULT_DELEGATION_TURN_TIMEOUT_MS}
    permissionTimeoutMs: ${DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS}
    toolGovernance: clio-policy   # clio-policy | agent-managed | deny-all
  agents: []
  # OpenCode native ACP:
  # - id: opencode
  #   command: opencode
  #   args: [acp, --cwd, .]
  #   toolGovernance: clio-policy
  #   labels:
  #     specialty: coding
  #
  # Codex via an ACP adapter:
  # - id: codex
  #   command: npx
  #   args: [-y, "@agentclientprotocol/codex-acp"]
  #   toolGovernance: clio-policy
  #   labels:
  #     specialty: coding
  #
  # Claude Code via its ACP adapter (runs on your Claude Pro/Max subscription;
  # the claude CLI has no ACP of its own, so this adapter bridges the Claude
  # Code SDK). Tool calls are gated by Clio safety under clio-policy; switch to
  # agent-managed to let Claude Code govern its own tools.
  # - id: claude-code
  #   command: npx
  #   args: [-y, "@zed-industries/claude-code-acp"]
  #   toolGovernance: clio-policy
  #   labels:
  #     specialty: coding

keybindings: {}

# Context compaction controls.
#   auto              master switch for the pre-request compaction trigger.
#                     Manual /context compact always runs the LLM summary.
#   threshold         pressure = estimated_tokens / context_window. Crossing
#                     it evicts from the working set first, then runs a full
#                     LLM summary if pressure stays above the threshold.
#   excludeLastTurns  recent turns protected only by the temporary legacy mask.
#   model             optional pattern (e.g. provider/summary-model-id) for a
#                     dedicated summarization model. Absent ⇒ orchestrator target.
#   systemPrompt      optional path to a prompt-override file.
compaction:
  auto: true
  threshold: 0.8
  excludeLastTurns: 6
  # model: provider/summary-model-id
  # systemPrompt: ~/.config/clio-coder/prompts/compaction.md

# Non-destructive working-set eviction before summary compaction.
#   enabled             false skips eviction and goes directly to the summary stage.
#   policy              structural-v1 evicts by what the session did since
#                       (re-reads, edits, resolved failures, consumed listings)
#                       and falls back to age only under pressure;
#                       age-horizon is the previous age-based selection.
#   target              pressure ratio an applied eviction batches down to.
#   protectLastTurns    recent user turns whose observations remain in the working set.
#   minEvictableTokens  entries below this estimate remain in the working set.
context:
  workingSet:
    enabled: true
    policy: structural-v1
    target: 0.6
    protectLastTurns: 6
    minEvictableTokens: 200

# Transient provider/stream retry controls for interactive chat.
# Retryable errors include overloads, rate limits, 5xx responses, network
# resets, and timeouts. Context overflow uses compaction recovery instead.
# Dispatched worker runs retry under workers.maxRetries, not this block.
retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000
  maxDelayMs: 60000
  streamStallMs: 180000

# Guardrails: numeric backstops that bound runaway agent behavior.
#   turnToolCallBudget          orchestrator per-turn soft tool-call budget;
#                               the hard interrupt ceiling sits 15 above it.
#   workerToolCallCap           ceiling on tool calls a dispatched worker may
#                               execute; the agent recipe's own budget is what
#                               normally binds, and refused calls never spend it.
#   maxDispatchRuns             dispatch run-ledger retention cap.
#   readMaxBytes                per-call byte cap for the read tool.
#   observationTurnBudgetBytes  shared per-turn byte pool for observation tools.
#   internalDispatchTimeoutMs   wall-clock cap for one internal generator
#                               dispatch (wiki documenter, bootstrap scout).
# Each value also has a per-process env override (CLIO_CODER_TURN_TOOL_CALL_BUDGET,
# CLIO_CODER_WORKER_TOOL_CALL_CAP, CLIO_CODER_MAX_DISPATCH_RUNS, CLIO_CODER_READ_MAX_BYTES,
# CLIO_CODER_OBSERVATION_TURN_BUDGET_BYTES, CLIO_CODER_INTERNAL_DISPATCH_TIMEOUT_MS) meant
# for CI and one-off experiments.
guardrails:
  turnToolCallBudget: 60
  workerToolCallCap: 150
  maxDispatchRuns: 1000
  readMaxBytes: 51200
  observationTurnBudgetBytes: 196608
  internalDispatchTimeoutMs: 900000
`;
