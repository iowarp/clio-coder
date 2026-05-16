/**
 * Canonical pi-mono package names. The engine barrel is the sole place in
 * the codebase where the literal `@earendil-works/*` strings are allowed to
 * appear; domains and core must import these constants instead.
 */

export const PI_MONO_PACKAGES = {
	agentCore: "@earendil-works/pi-agent-core",
	ai: "@earendil-works/pi-ai",
	tui: "@earendil-works/pi-tui",
} as const;

export type PiMonoPackageName = (typeof PI_MONO_PACKAGES)[keyof typeof PI_MONO_PACKAGES];
