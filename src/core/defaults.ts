/**
 * Default settings shipped with Clio. Written to ~/.clio/settings.yaml on first install
 * if the file does not already exist. Users edit the file directly or through TUI overlays.
 */

export type ThinkingFormat = "qwen" | "qwen-chat-template" | "openrouter" | "zai";

export interface EndpointSpec {
	url: string;
	default_model?: string;
	api_key?: string;
	headers?: Record<string, string>;
	reasoning?: boolean;
	thinking_format?: ThinkingFormat;
	context_window?: number;
	max_tokens?: number;
	supports_images?: boolean;
	compat?: Record<string, unknown>;
}

export interface LocalProviderConfig {
	endpoints: Record<string, EndpointSpec>;
}

export interface WorkerTargetConfig {
	provider?: string;
	endpoint?: string;
	model?: string;
}

export interface LocalProvidersSettings {
	llamacpp: LocalProviderConfig;
	lmstudio: LocalProviderConfig;
	ollama: LocalProviderConfig;
	"openai-compat": LocalProviderConfig;
}

export const DEFAULT_SETTINGS = {
	version: 1 as const,
	identity: "clio",
	defaultMode: "default" as "default" | "advise" | "super",
	safetyLevel: "auto-edit" as "suggest" | "auto-edit" | "full-auto",
	provider: {
		active: null as string | null,
		model: null as string | null,
	},
	providers: {
		llamacpp: { endpoints: {} },
		lmstudio: { endpoints: {} },
		ollama: { endpoints: {} },
		"openai-compat": { endpoints: {} },
	} as LocalProvidersSettings,
	orchestrator: {} as WorkerTargetConfig,
	workers: {
		default: {} as WorkerTargetConfig,
	},
	budget: {
		sessionCeilingUsd: 5,
		concurrency: "auto" as "auto" | number,
	},
	runtimes: {
		enabled: ["native"] as string[],
	},
	theme: "default",
	keybindings: {} as Record<string, string>,
	state: {
		lastMode: "default" as "default" | "advise" | "super",
	},
};

export type DefaultSettings = typeof DEFAULT_SETTINGS;

/**
 * Raw YAML document written to ~/.clio/settings.yaml on first install. Mirrors
 * every field of DEFAULT_SETTINGS at the same key path so settings migration
 * keeps working, and carries fully commented example endpoint blocks that a
 * new user can uncomment to point Clio at a local llama-server or LM Studio.
 *
 * The YAML library strips comments when round-tripping through stringify, so
 * first-install writes this raw string directly instead of going through
 * stringifyYaml(DEFAULT_SETTINGS).
 */
export const DEFAULT_SETTINGS_YAML = `# Clio settings. Written once on first install; edit freely.
# Docs: https://github.com/iowarp/clio-coder

version: 1
identity: clio
defaultMode: default        # default | advise | super
safetyLevel: auto-edit      # suggest | auto-edit | full-auto

# Active provider and model for the orchestrator loop. Leave null until
# you configure a provider and model below.
provider:
  active: null
  model: null

# Local inference engines. Each entry under endpoints becomes a selectable
# target. Replace endpoints: {} with one of the blocks below, then run
# clio doctor and clio providers to verify.
providers:
  llamacpp:
    endpoints: {}
    # Example: llama.cpp on the homelab.
    # Replace endpoints: {} above with the block below.
    # Replace the host and port with the values you pass to llama-server.
    # clio-example:start provider=llamacpp endpoint=mini
    # endpoints:
    #   mini:
    #     url: http://192.168.86.141:8080
    #     default_model: Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL
    #     # api_key: llama-no-auth
    #     context_window: 262144
    #     max_tokens: 16384
    # clio-example:end provider=llamacpp endpoint=mini

  lmstudio:
    endpoints: {}
    # Example: LM Studio on the homelab.
    # Replace endpoints: {} above with the block below.
    # Point at the LM Studio server on :1234 with the model loaded.
    # clio-example:start provider=lmstudio endpoint=dynamo
    # endpoints:
    #   dynamo:
    #     url: http://192.168.86.143:1234
    #     default_model: qwen3.6-35b-a3b
    #     # api_key: lm-studio
    #     context_window: 262144
    #     max_tokens: 16384
    # clio-example:end provider=lmstudio endpoint=dynamo

  ollama:
    endpoints: {}

  openai-compat:
    endpoints: {}

# Orchestrator target override. Leave empty to use the active provider.
orchestrator: {
  # Example: pin the orchestrator loop to the llamacpp mini endpoint above.
  # Uncomment the lines below after you uncomment the matching
  # provider.endpoints.mini example.
  # clio-example:start block=orchestrator
  # provider: llamacpp,
  # endpoint: mini,
  # model: Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL,
  # clio-example:end block=orchestrator
}

# Per-worker target overrides. default applies to every worker spec that
# does not declare its own target block.
workers:
  default: {
    # Example: route /run and clio run at the same llamacpp mini endpoint.
    # Uncomment the lines below after you uncomment the matching
    # provider.endpoints.mini example.
    # clio-example:start block=workers
    # provider: llamacpp,
    # endpoint: mini,
    # model: Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL,
    # clio-example:end block=workers
  }

# Session budget guardrails.
budget:
  sessionCeilingUsd: 5
  concurrency: auto           # auto or a positive integer

# Runtimes Clio will load. native is always available.
runtimes:
  enabled:
    - native

theme: default
keybindings: {}

# Transient session state. Clio rewrites this block; do not hand-edit.
state:
  lastMode: default
`;
