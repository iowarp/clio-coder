/** Claude's selected account/profile must survive the generic tool environment filter. */
const CLAUDE_AUTH_ENV = [
	"CLAUDE_CONFIG_DIR",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_EXECUTABLE",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_BEDROCK_BASE_URL",
	"ANTHROPIC_VERTEX_BASE_URL",
	"ANTHROPIC_VERTEX_PROJECT_ID",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"ANTHROPIC_FOUNDRY_RESOURCE",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"ANTHROPIC_PROFILE",
	"AWS_PROFILE",
	"AWS_REGION",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"CLOUD_ML_REGION",
] as const;

export function claudeAuthEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	return Object.fromEntries(CLAUDE_AUTH_ENV.flatMap((key) => (source[key] !== undefined ? [[key, source[key]]] : [])));
}

export function hasExternalClaudeAuth(source: NodeJS.ProcessEnv): boolean {
	return (
		[
			"CLAUDE_CONFIG_DIR",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"ANTHROPIC_PROFILE",
		].some((key) => Boolean(source[key]?.trim())) ||
		["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(
			(key) => source[key] === "1" || source[key] === "true",
		)
	);
}

/** An explicitly resolved Clio credential takes precedence over ambient account selectors. */
export function withClaudeCredential(env: NodeJS.ProcessEnv, credential?: string): NodeJS.ProcessEnv {
	if (!credential) return env;
	const selected = { ...env };
	for (const key of [
		"CLAUDE_CODE_OAUTH_TOKEN",
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_PROFILE",
		"CLAUDE_CODE_USE_BEDROCK",
		"CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY",
	]) {
		delete selected[key];
	}
	selected[credential.startsWith("sk-ant-oat") ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] = credential;
	return selected;
}
