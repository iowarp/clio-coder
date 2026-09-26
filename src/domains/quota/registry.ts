/**
 * Registry of quota adapters.
 *
 * Order is display order. BT-006 excludes implicit sibling accounts from
 * relocated homes before cache lookup or credential detection.
 */

import { isClioHomeRelocated } from "../../core/xdg.js";

import { createAnthropicMaxQuotaProvider } from "./anthropic-max-provider.js";
import { createAntigravityQuotaProvider } from "./antigravity-provider.js";
import { createClaudeCodeQuotaProvider } from "./claude-code-provider.js";
import { createCodexQuotaProvider } from "./codex-provider.js";
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
