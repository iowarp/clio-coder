/**
 * The environment an arena contender inherits, by allowlist.
 *
 * A contender is the operator's own `clio-coder run`, so it needs the homes
 * and the credentials its target reads, but nothing else the operator's shell
 * holds: another target's key, a cloud login, an agent socket or a terminal
 * multiplexer's pane identity would otherwise reach a model run in yolo or in
 * a worktree it may write freely. Passed on top of the safe-exec allowlist
 * (PATH, HOME, USER, LANG, TMPDIR, the XDG base dirs and the Windows system
 * variables): Clio's own `CLIO_CODER_*`, locale, terminal, proxy and CA
 * variables, the operator's `safety.sandboxPassEnv`, and for the contender's
 * target only its declared key variable, its runtime's default, the engine's
 * known key names for its provider and the runtime's pass list below.
 */

import { CLAUDE_AUTH_ENV } from "../../core/claude-environment.js";
import { findEngineEnvKeys } from "../../engine/env-api-keys.js";
import { findBuiltinRuntimeBootMetadata } from "../providers/runtimes/boot-manifest.js";
import { referencedOpenCodeCredentials } from "../providers/runtimes/external-cli-policy.js";

export interface ArenaEnvPolicy {
	targets: ReadonlyArray<{
		id: string;
		runtime: string;
		auth?: { apiKeyEnvVar?: string; apiKeyRef?: string; oauthProfile?: string };
	}>;
	/** The operator's `safety.sandboxPassEnv`: names their own runs already hand to commands. */
	passEnv: ReadonlyArray<string>;
}

const BASE_NAMES = [
	"TERM",
	"COLORTERM",
	"SHELL",
	"TZ",
	"LANGUAGE",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"NODE_OPTIONS",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
];

const BASE_PREFIXES = ["CLIO_CODER_", "LC_"];

interface RuntimePass {
	names?: ReadonlyArray<string>;
	prefixes?: ReadonlyArray<string>;
	/** Names the runtime finds in its own configuration. */
	referenced?: (source: NodeJS.ProcessEnv) => ReadonlyArray<string>;
}

/**
 * What each runtime reads beyond its key. The subprocess runtimes forward the same names to their CLI; the SDK
 * runtimes hand their CLI the whole environment, so their families pass by prefix.
 */
const RUNTIME_PASS_ENV: Readonly<Record<string, RuntimePass>> = {
	"claude-code": { names: CLAUDE_AUTH_ENV },
	"claude-sdk": { names: CLAUDE_AUTH_ENV, prefixes: ["ANTHROPIC_", "CLAUDE_CODE_"] },
	"codex-cli": { names: ["CODEX_HOME"] },
	"opencode-cli": {
		names: ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"],
		referenced: (source) => Object.keys(referencedOpenCodeCredentials(source)),
	},
	"pi-cli": { names: ["PI_CODING_AGENT_DIR"] },
	"copilot-sdk": { names: ["GH_HOST", "GH_CONFIG_DIR", "DBUS_SESSION_BUS_ADDRESS"], prefixes: ["COPILOT_"] },
	bedrock: { prefixes: ["AWS_"] },
	google: {
		names: ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"],
	},
	ollama: { names: ["OLLAMA_API_KEY"] },
};

/** Never passed: a contender is its own pane-less process, and a forwarded pane id would report as the operator's. */
const NEVER_PREFIXES = ["HERDR_"];

function targetNames(
	policy: ArenaEnvPolicy,
	targetId: string,
	source: Readonly<Record<string, string>>,
): { names: string[]; prefixes: string[] } {
	const target = policy.targets.find((entry) => entry.id === targetId);
	if (target === undefined) return { names: [], prefixes: [] };
	const runtime = findBuiltinRuntimeBootMetadata(target.runtime);
	const runtimeId = runtime?.id ?? target.runtime;
	const pass = RUNTIME_PASS_ENV[runtimeId] ?? {};
	const providerId =
		target.auth?.oauthProfile?.trim() || target.auth?.apiKeyRef?.trim() || runtime?.oauthProviderId || runtimeId;
	const names = [
		target.auth?.apiKeyEnvVar?.trim() ?? "",
		runtime?.credentialsEnvVar ?? "",
		...(findEngineEnvKeys(providerId, source) ?? []),
		...(pass.names ?? []),
		...(pass.referenced?.(source) ?? []),
	].filter((name) => name.length > 0);
	return { names, prefixes: [...(pass.prefixes ?? [])] };
}

/**
 * The variables of `source` one contender is given; the safe-exec allowlist is added when it starts. Reads only the
 * runtime's own configuration. `targetId` null is the arena's own `verifiers dry-run`, which needs no credentials.
 */
export function arenaContenderEnv(
	source: Readonly<Record<string, string>>,
	policy: ArenaEnvPolicy,
	targetId: string | null,
): Record<string, string> {
	const scoped = targetId === null ? { names: [], prefixes: [] } : targetNames(policy, targetId, source);
	const names = new Set([...BASE_NAMES, ...policy.passEnv, ...scoped.names]);
	const prefixes = [...BASE_PREFIXES, ...scoped.prefixes];
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (NEVER_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
		if (names.has(name) || prefixes.some((prefix) => name.startsWith(prefix))) env[name] = value;
	}
	return env;
}
