/**
 * Registry of quota adapters.
 *
 * Order is display order. Relocated-home isolation excludes implicit sibling accounts from
 * relocated homes before cache lookup or credential detection. Adapters that read Clio's own
 * stored logins stay registered everywhere, because those credentials live in Clio's home.
 */

import { explicitAgentHome, interopDisabled, isClioHomeRelocated } from "../../core/xdg.js";

import { ANTHROPIC_MAX_QUOTA_PROVIDER_ID, createAnthropicMaxQuotaProvider } from "./anthropic-max-provider.js";
import { ANTIGRAVITY_QUOTA_PROVIDER_ID, createAntigravityQuotaProvider } from "./antigravity-provider.js";
import { CLAUDE_CODE_QUOTA_PROVIDER_ID, createClaudeCodeQuotaProvider } from "./claude-code-provider.js";
import { CODEX_CLI_QUOTA_PROVIDER_ID, createCodexCliQuotaProvider } from "./codex-cli-provider.js";
import { CODEX_QUOTA_PROVIDER_ID, createCodexQuotaProvider } from "./codex-provider.js";
import type { QuotaProvider } from "./types.js";

export function buildQuotaProviders(): QuotaProvider[] {
	// CLIO_CODER_INTEROP_HOME=none turns off sibling accounts as it does every foreign user root.
	const implicit = !isClioHomeRelocated() && !interopDisabled();
	return [
		createAnthropicMaxQuotaProvider(),
		...(implicit || explicitAgentHome("CLAUDE_CONFIG_DIR") ? [createClaudeCodeQuotaProvider()] : []),
		createCodexQuotaProvider(),
		...(implicit || explicitAgentHome("CODEX_HOME") ? [createCodexCliQuotaProvider()] : []),
		...(implicit || explicitAgentHome("ANTIGRAVITY_HOME") ? [createAntigravityQuotaProvider()] : []),
		// The copilot adapter attaches here once its credential shape is confirmed.
	];
}

/**
 * Quota adapter identity for each runtime. Native Codex spends Clio's own
 * `openai-codex` login, which can differ from the sibling CLI's, so the two
 * runtimes read separate adapters (#423, #434). Claude Code and the SDK use
 * Claude Code credentials.
 */
const QUOTA_PROVIDER_BY_RUNTIME: ReadonlyMap<string, string> = new Map([
	["anthropic-max", ANTHROPIC_MAX_QUOTA_PROVIDER_ID],
	["claude-code", CLAUDE_CODE_QUOTA_PROVIDER_ID],
	["claude-sdk", CLAUDE_CODE_QUOTA_PROVIDER_ID],
	["openai-codex", CODEX_QUOTA_PROVIDER_ID],
	["codex-cli", CODEX_CLI_QUOTA_PROVIDER_ID],
	["antigravity-code", ANTIGRAVITY_QUOTA_PROVIDER_ID],
]);

export function quotaProviderIdForRuntime(runtimeId: string): string | null {
	return QUOTA_PROVIDER_BY_RUNTIME.get(runtimeId) ?? null;
}
