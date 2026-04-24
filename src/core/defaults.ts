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
 *   - threshold: fraction (0..1) of the orchestrator's contextWindow at
 *     which auto-compaction fires. 12c persists it; 12d wires the check.
 *   - auto: master switch for the chat-loop's pre-request trigger. Manual
 *     /compact still runs when auto=false.
 *   - model: optional pattern (e.g. "openai/gpt-5-mini") used to resolve
 *     a dedicated summarization model. Falls back to the orchestrator
 *     target when absent.
 *   - systemPrompt: optional path to a prompt-override file; resolved to
 *     text at call time, not at settings load.
 */
export interface CompactionSettings {
	threshold: number;
	auto: boolean;
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

export const DEFAULT_SETTINGS = {
	version: 1 as const,
	identity: "clio",
	defaultMode: "default" as "default" | "advise" | "super",
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
	budget: {
		sessionCeilingUsd: 5,
		concurrency: "auto" as "auto" | number,
	},
	theme: "default",
	// User keybinding overrides. Each id maps to a single KeyId string or a
	// list of KeyIds. The interactive keybinding manager reads this table
	// and layers it on top of CLIO_KEYBINDINGS defaults (src/domains/config/
	// keybindings.ts).
	keybindings: {} as Record<string, string | string[]>,
	state: {
		lastMode: "default" as "default" | "advise" | "super",
	},
	compaction: {
		threshold: 0.8,
		auto: true,
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
# Common first run:
#   1. Run: clio
#   2. Follow the configuration wizard if no usable target exists.
#   3. Inspect targets later with: clio targets

version: 1
identity: clio
defaultMode: default        # default | advise | super
safetyLevel: auto-edit      # suggest | auto-edit | full-auto

# Inference targets. Each entry becomes selectable for chat and workers.
# Add entries via \`clio configure\` or \`clio targets add\`
# or hand-edit. \`runtime\` must match an id registered in the runtime registry
# (cloud APIs, local HTTP engines, CLI adapters, or third-party plugins under
# ~/.clio/runtimes/).
targets: []
# Recommended self-development layout:
#   clio configure --runtime openai-codex --id codex-pro --model gpt-5.4 --set-orchestrator --set-worker-default --worker-profile codex-mini --worker-profile-model gpt-5.4-mini
#   clio configure --runtime claude-code-sdk --id claude-sdk-opus --model claude-opus-4-7 --worker-profile claude-opus
#   clio configure --runtime copilot-cli --id copilot-sonnet --model claude-sonnet-4.6 --worker-profile copilot-sonnet
#   clio configure --runtime gemini-cli --id gemini-flash --model gemini-3-flash-preview --worker-profile gemini-flash
#   clio targets add --runtime openai-compat --id mini --url http://mini:8080 --model Qwen3.6-35B-A3B-UD-Q4_K_XL --context-window 262144 --max-tokens 65536 --reasoning true
#   clio targets add --runtime lmstudio-native --id dynamo --url http://dynamo:1234 --model gemma-4-26B-A4B-it-Q4_K_M --context-window 262144 --max-tokens 65536 --reasoning true
#
# Example targets:
# targets:
#   - id: codex-pro
#     runtime: openai-codex
#     defaultModel: gpt-5.4
#     auth:
#       oauthProfile: openai-codex
#     wireModels:
#       - gpt-5.4
#       - gpt-5.4-mini
#   - id: mini
#     runtime: openai-compat
#     url: http://mini:8080
#     defaultModel: Qwen3.6-35B-A3B-UD-Q4_K_XL
#     capabilities:
#       contextWindow: 262144
#       maxTokens: 65536
#       reasoning: true
#       thinkingFormat: qwen-chat-template
#   - id: dynamo
#     runtime: lmstudio-native
#     url: http://dynamo:1234
#     defaultModel: gemma-4-26B-A4B-it-Q4_K_M
#     capabilities:
#       contextWindow: 262144
#       maxTokens: 65536
#       reasoning: true

# Optional npm packages that export clioRuntimes: RuntimeDescriptor[].
runtimePlugins: []

# Orchestrator target for the interactive loop. \`target\` refers to
# targets[].id; \`model\` is the wire model id to request.
# thinkingLevel valid values: off | minimal | low | medium | high | xhigh.
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
  # codex-mini:
  #   target: codex-pro
  #   model: gpt-5.4-mini
  #   thinkingLevel: off

# Ctrl+P cycling order: plain target ids or "target/model" refs.
scope: []

# Session budget guardrails.
budget:
  sessionCeilingUsd: 5
  concurrency: auto           # auto or a positive integer

theme: default
keybindings: {}

# Transient session state. Clio Coder rewrites this block; do not hand-edit.
state:
  lastMode: default

# Context compaction controls (Phase 12).
#   threshold    fraction (0..1) of the orchestrator's contextWindow at which
#                auto-compaction fires. 0.8 leaves 20% headroom for the next
#                assistant turn before trimming.
#   auto         master switch. true ⇒ the chat loop may compact on threshold;
#                false disables the pre-request trigger (manual /compact still
#                works).
#   model        optional pattern (e.g. openai/gpt-5-mini) for a dedicated
#                summarization model. Absent ⇒ the engine uses the orchestrator
#                target.
#   systemPrompt optional path to a prompt-override file.
compaction:
  threshold: 0.8
  auto: true
  # model: openai/gpt-5-mini
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
