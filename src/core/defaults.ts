/**
 * Default settings shipped with Clio. Written to ~/.clio/settings.yaml on first install
 * if the file does not already exist. Users edit the file directly or through TUI overlays.
 */

export interface EndpointSpec {
	url: string;
	default_model?: string;
	api_key?: string;
	headers?: Record<string, string>;
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
