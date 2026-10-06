/**
 * Registry of quota adapters.
 *
 * Order is display order. Relocated-home isolation excludes implicit sibling accounts from
 * relocated homes before cache lookup or credential detection.
 */

import { isClioHomeRelocated } from "../../core/xdg.js";

import { ANTHROPIC_MAX_QUOTA_PROVIDER_ID, createAnthropicMaxQuotaProvider } from "./anthropic-max-provider.js";
import { ANTIGRAVITY_QUOTA_PROVIDER_ID, createAntigravityQuotaProvider } from "./antigravity-provider.js";
import { CLAUDE_CODE_QUOTA_PROVIDER_ID, createClaudeCodeQuotaProvider } from "./claude-code-provider.js";
import { CODEX_QUOTA_PROVIDER_ID, createCodexQuotaProvider } from "./codex-provider.js";
import type { QuotaProvider } from "./types.js";

export function buildQuotaProviders(): QuotaProvider[] {
	return [
		createAnthropicMaxQuotaProvider(),
		...(!isClioHomeRelocated() || process.env.CLAUDE_CONFIG_DIR?.trim() ? [createClaudeCodeQuotaProvider()] : []),
		...(!isClioHomeRelocated() || process.env.CODEX_HOME?.trim() ? [createCodexQuotaProvider()] : []),
		...(!isClioHomeRelocated() || process.env.ANTIGRAVITY_HOME?.trim() ? [createAntigravityQuotaProvider()] : []),
		// The copilot adapter attaches here once its credential shape is confirmed.
	];
}

/**
 * The quota adapter that reads the account a runtime bills against. Codex CLI
 * and Clio's own Codex login spend the same ChatGPT plan windows; Claude Code
 * and the Claude SDK spend the Claude Code credential's.
 */
const QUOTA_PROVIDER_BY_RUNTIME: ReadonlyMap<string, string> = new Map([
	["anthropic-max", ANTHROPIC_MAX_QUOTA_PROVIDER_ID],
	["claude-code", CLAUDE_CODE_QUOTA_PROVIDER_ID],
	["claude-sdk", CLAUDE_CODE_QUOTA_PROVIDER_ID],
	["openai-codex", CODEX_QUOTA_PROVIDER_ID],
	["codex-cli", CODEX_QUOTA_PROVIDER_ID],
	["antigravity-code", ANTIGRAVITY_QUOTA_PROVIDER_ID],
]);

export function quotaProviderIdForRuntime(runtimeId: string): string | null {
	return QUOTA_PROVIDER_BY_RUNTIME.get(runtimeId) ?? null;
}
