/**
 * Default settings shipped with Clio Coder. Written to the resolved config
 * directory's settings.yaml on first install if the file does not already
 * exist. Users edit the file directly or through TUI overlays.
 */

import type { EndpointDescriptor } from "../domains/providers/types/endpoint-descriptor.js";

export type { EndpointDescriptor } from "../domains/providers/types/endpoint-descriptor.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface WorkerTarget {
	endpoint: string | null;
	model: string | null;
	thinkingLevel: ThinkingLevel;
}

export type WorkerProfiles = Record<string, WorkerTarget>;

/**
 * Compaction controls the session domain reads at runtime. Ships as Phase 12
 * slice 12c. The structural type lives here so core/defaults.ts stays free
 * of a backward domain dependency; the engine-level defaults and the
 * companion DEFAULT_COMPACTION_SETTINGS value live alongside the rest of
 * the compaction engine in src/domains/session/compaction/defaults.ts.
 *
 * Fields:
 *   - thresholds: graduated pressure thresholds (0..1) for warning,
 *     progressive masking/pruning, and final LLM compaction.
 *   - auto: master switch for the chat-loop's pre-request trigger. Manual
 *     /compact still runs when auto=false.
 *   - excludeLastTurns: number of recent user turns protected from
 *     progressive masking/pruning.
 *   - model: optional pattern (e.g. "provider/summary-model-id") used to
 *     resolve a dedicated summarization model. Falls back to the orchestrator
 *     target when absent.
 *   - systemPrompt: optional path to a prompt-override file; resolved to
 *     text at call time, not at settings load.
 */
export interface CompactionThresholdSettings {
	warning: number;
	maskObservations: number;
	pruneObservations: number;
	maskDialogue: number;
	llmSummary: number;
}

export interface CompactionSettings {
	thresholds: CompactionThresholdSettings;
	auto: boolean;
	excludeLastTurns: number;
	/** Deprecated compatibility input. New settings should use thresholds.llmSummary. */
	threshold?: number;
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
	safetyLevel: "auto-edit" as "suggest" | "auto-edit" | "full-auto",
	endpoints: [] as EndpointDescriptor[],
	runtimePlugins: [] as string[],
	orchestrator: {
		endpoint: null as string | null,
		model: null as string | null,
		thinkingLevel: "off" as ThinkingLevel,
	},
	workers: {
		default: {
			endpoint: null as string | null,
			model: null as string | null,
			thinkingLevel: "off" as ThinkingLevel,
		} as WorkerTarget,
		profiles: {} as WorkerProfiles,
	},
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
	state: {
		recentModels: [] as string[],
	},
	compaction: {
		thresholds: {
			warning: 0.7,
			maskObservations: 0.8,
			pruneObservations: 0.85,
			maskDialogue: 0.9,
			llmSummary: 0.99,
		},
		auto: true,
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
 * so settings migration keeps working, and carries fully commented example
 * target blocks that a new user can uncomment to point Clio Coder at a local
 * llama-server or LM Studio.
 *
 * The YAML library strips comments when round-tripping through stringify, so
 * first-install writes this raw string directly instead of going through
 * stringifyYaml(DEFAULT_SETTINGS).
 */
export const DEFAULT_SETTINGS_YAML = `# Clio Coder settings. Written once on first install; edit freely.
# Docs: https://github.com/iowarp/clio-coder
#
# Default location:
#   Linux:   ~/.config/clio/settings.yaml
#   macOS:   ~/Library/Application Support/clio/settings.yaml
#   Windows: %APPDATA%/clio/settings.yaml
# Set CLIO_HOME for a single-tree install, or CLIO_CONFIG_DIR / CLIO_DATA_DIR /
# CLIO_CACHE_DIR to override config, data, and cache separately.
#
# Common first run after installation:
#   1. Repair/create local state: clio doctor --fix
#   2. List runtimes: clio configure --list
#   3. Configure one target with your runtime/model (examples below).
#   4. Select and probe it: clio targets use <id> && clio targets --probe
#   5. Launch: clio

version: 1
identity: clio
safetyLevel: auto-edit      # suggest | auto-edit | full-auto

# Inference targets. Each entry becomes selectable for chat and workers.
# Add entries via \`clio configure\` or \`clio targets add\`
# or hand-edit. \`runtime\` must match an id registered in the runtime registry
# (cloud APIs, local HTTP engines, or third-party plugins under
# ~/.clio/runtimes/).
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

# Ctrl+P cycling order: plain target ids or "target/model" refs.
scope: []

# /models focused picker. Favorites are exact "target/model" refs shown before
# the full search catalog. Recent models are stored under state.recentModels.
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

# Transient session state. Clio Coder rewrites this block; do not hand-edit.
state:
  recentModels: []

# Context compaction controls.
#   auto              master switch for pre-request graduated context pressure.
#                     Manual /compact always runs the LLM summary stage.
#   excludeLastTurns  recent user turns protected from progressive masking.
#   thresholds        pressure = estimated_tokens / context_window.
#                     Earlier stages reclaim context without an LLM call;
#                     llmSummary is the final full summarization stage.
#   model             optional pattern (e.g. provider/summary-model-id) for a
#                     dedicated summarization model. Absent ⇒ orchestrator target.
#   systemPrompt      optional path to a prompt-override file.
compaction:
  auto: true
  excludeLastTurns: 6
  thresholds:
    warning: 0.7
    maskObservations: 0.8
    pruneObservations: 0.85
    maskDialogue: 0.9
    llmSummary: 0.99
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
