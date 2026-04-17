/**
 * Default settings shipped with Clio. Written to ~/.clio/settings.yaml on first install
 * if the file does not already exist. Users edit the file directly or through TUI overlays.
 */

export const DEFAULT_SETTINGS = {
	version: 1,
	identity: "clio",
	defaultMode: "default" as const,
	safetyLevel: "auto-edit" as const,
	provider: {
		active: null as string | null,
		model: null as string | null,
	},
	budget: {
		sessionCeilingUsd: 5,
		concurrency: "auto" as const,
	},
	runtimes: {
		enabled: ["native"],
	},
	theme: "default",
	keybindings: {},
	state: {
		lastMode: "default" as const,
	},
} as const;

export type DefaultSettings = typeof DEFAULT_SETTINGS;
