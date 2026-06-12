/**
 * Default settings shipped with Clio Coder. Written to the resolved config
 * directory's settings.yaml on first install if the file does not already
 * exist. Users edit the file directly or through TUI overlays.
 */

import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";

export type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
export type { AutonomyLevel } from "../domains/safety/autonomy.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface WorkerTarget {
	target: string | null;
	model: string | null;
	thinkingLevel: ThinkingLevel;
}

export type WorkerProfiles = Record<string, WorkerTarget>;

/**
 * Non-stall posture for dispatched native workers. A worker tool call that
 * requires interactive permission resolves within bounded time: "deny" turns
 * it into a structured tool denial and the run continues; "fail" finalizes
 * the run immediately with outcome failed/permission_required.
 */
export type WorkerPermissionMode = "deny" | "fail";

export interface WorkersSettings {
	default: WorkerTarget;
	profiles: WorkerProfiles;
	/** Bounded automatic retries for retryable run outcomes. 0 disables. */
	maxRetries: number;
	onPermission: WorkerPermissionMode;
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
 *     /compact still runs when auto=false.
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
 * Transient provider retry controls for the interactive chat loop. These are
 * intentionally small and mirror the session retry helper defaults.
 */
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export interface TerminalSettings {
	showTerminalProgress: boolean;
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

export type DelegationToolGovernance = "clio-policy" | "agent-managed" | "deny-all";

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

export const DEFAULT_SETTINGS = {
	version: 1 as const,
	identity: "clio",
	autonomy: "auto-edit" as AutonomyLevel,
	targets: [] as TargetDescriptor[],
	runtimePlugins: [] as string[],
	orchestrator: {
		target: null as string | null,
		model: null as string | null,
		thinkingLevel: "off" as ThinkingLevel,
	},
	workers: {
		default: {
			target: null as string | null,
			model: null as string | null,
			thinkingLevel: "off" as ThinkingLevel,
		} as WorkerTarget,
		profiles: {} as WorkerProfiles,
		maxRetries: 2,
		onPermission: "deny" as WorkerPermissionMode,
	} as WorkersSettings,
	scope: [] as string[],
	modelSelector: {
		favorites: [] as string[],
		recentLimit: 12,
	} as ModelSelectorSettings,
	budget: {
		sessionCeilingUsd: 5,
		concurrency: "auto" as "auto" | number,
	},
	theme: "default",
	terminal: {
		showTerminalProgress: false,
	} as TerminalSettings,
	skills: {
		trustProjectCompatRoots: false,
	} as SkillsSettings,
	delegation: {
		agents: [] as DelegationAgentConfig[],
		defaults: {
			connectTimeoutMs: 30000,
			turnTimeoutMs: 300000,
			permissionTimeoutMs: 120000,
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
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		maxDelayMs: 60000,
	} as RetrySettings,
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
# The file is machine-owned: \`clio configure\`, \`clio targets\`, and the TUI
# rewrite it whole, and comments (including these) do not survive that write.
# Docs: https://github.com/iowarp/clio-coder
#
# Default location:
#   Linux:   ~/.config/clio/settings.yaml
#   macOS:   ~/Library/Application Support/clio/config/settings.yaml
#   Windows: %APPDATA%/clio/config/settings.yaml
# Set CLIO_HOME for a single-tree install, or CLIO_CONFIG_DIR / CLIO_DATA_DIR /
# CLIO_STATE_DIR / CLIO_CACHE_DIR to override each directory separately.
#
# Common first run after installation:
#   1. Repair/create local state: clio doctor --fix
#   2. List runtimes: clio configure --list
#   3. Configure one target with your runtime/model (examples below).
#   4. Select and probe it: clio targets use <id> && clio targets --probe
#   5. Launch: clio

version: 1
identity: clio
autonomy: auto-edit         # read-only | suggest | auto-edit | full-auto

# Inference targets. Each entry becomes selectable for chat and workers.
# Add entries via \`clio configure\` or \`clio targets add\`
# or hand-edit. \`runtime\` must match an id registered in the runtime registry
# (cloud APIs, local HTTP engines, or third-party plugins in the \`runtimes/\`
# directory next to this file).
targets: []
# Local runtime examples (uncomment/adapt one; replace your-model-id):
#   clio configure --id local-lmstudio --runtime lmstudio-native --url http://localhost:1234 --model your-model-id --set-orchestrator --set-fleet-default
#   clio configure --id local-ollama --runtime ollama-native --url http://localhost:11434 --model your-model-id --set-orchestrator --set-fleet-default
#   clio configure --id local-llamacpp --runtime llamacpp --url http://127.0.0.1:8080 --model your-model-id --set-orchestrator --set-fleet-default
#   clio configure --id local-vllm --runtime vllm --url http://localhost:8000 --model your-model-id --set-orchestrator --set-fleet-default
#   clio configure --id local-sglang --runtime sglang --url http://localhost:30000 --model your-model-id --set-orchestrator --set-fleet-default
# Add --context-window <tokens>, --max-tokens <tokens>, or --reasoning true
# only when you have runtime/model-specific values to override probe results.
#
# Example target block equivalent to one configured local runtime:
# targets:
#   - id: local-lmstudio
#     runtime: lmstudio-native
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

# Worker targets for dispatch. \`default\` preserves the legacy behavior when a
# recipe or request does not specify an override. \`profiles\` are named worker
# choices that /run and clio run can select explicitly or by required capability.
workers:
  default:
    target: null
    model: null
    thinkingLevel: off
  profiles: {}
  # fast-local:
  #   target: local-lmstudio
  #   model: your-model-id
  #   thinkingLevel: off

# Alt+J / Alt+K cycling order: plain target ids or "target/model" refs.
scope: []

# /models focused picker. Favorites are exact "target/model" refs shown before
# the full search catalog. Recently selected models are runtime state and live
# in the state dir (recent-models.json), not in this file.
modelSelector:
  favorites: []
  recentLimit: 12

# Session budget guardrails.
budget:
  sessionCeilingUsd: 5
  concurrency: auto           # auto or a positive integer

theme: default
terminal:
  # OSC 9;4 terminal progress badges are opt-in; some terminals surface these
  # in taskbars/tabs and keep them visible for long-running agent work.
  showTerminalProgress: false

# Skills are local prompt resources. Project-local compatibility roots such as
# .agents/skills, .claude/skills, .codex/skills, .github/skills, and
# .opencode/skills stay hidden from model invocation unless this is true or
# CLIO_TRUST_PROJECT_SKILLS=1 is set for the process.
skills:
  trustProjectCompatRoots: false

# External coding agents that speak Agent Client Protocol v1 over stdio.
# These are delegated harnesses, not model targets, so they stay outside
# targets[], orchestrator, workers, and model pickers.
delegation:
  defaults:
    connectTimeoutMs: 30000
    turnTimeoutMs: 300000
    permissionTimeoutMs: 120000
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

keybindings: {}

# Context compaction controls.
#   auto              master switch for the pre-request compaction trigger.
#                     Manual /compact always runs the LLM summary.
#   threshold         pressure = estimated_tokens / context_window. Crossing
#                     it masks stale tool observations first, then runs a
#                     full LLM summary if pressure stays above the threshold.
#   excludeLastTurns  recent user turns protected from observation masking.
#   model             optional pattern (e.g. provider/summary-model-id) for a
#                     dedicated summarization model. Absent ⇒ orchestrator target.
#   systemPrompt      optional path to a prompt-override file.
compaction:
  auto: true
  threshold: 0.8
  excludeLastTurns: 6
  # model: provider/summary-model-id
  # systemPrompt: ~/.config/clio/prompts/compaction.md

# Transient provider/stream retry controls for interactive chat.
# Retryable errors include overloads, rate limits, 5xx responses, network
# resets, and timeouts. Context overflow uses compaction recovery instead.
retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000
  maxDelayMs: 60000
`;
