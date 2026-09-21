/**
 * Registry of quota adapters.
 *
 * Order is display order. Every adapter is read-only and reports a missing
 * credential as a snapshot status, so listing one costs nothing when the
 * operator does not use that product.
 */

import { createAnthropicMaxQuotaProvider } from "./anthropic-max-provider.js";
import { createAntigravityQuotaProvider } from "./antigravity-provider.js";
import { createClaudeCodeQuotaProvider } from "./claude-code-provider.js";
import { createCodexQuotaProvider } from "./codex-provider.js";
import type { QuotaProvider } from "./types.js";

export function buildQuotaProviders(): QuotaProvider[] {
	return [
		createAnthropicMaxQuotaProvider(),
		createClaudeCodeQuotaProvider(),
		createCodexQuotaProvider(),
		createAntigravityQuotaProvider(),
		// The copilot adapter attaches here once its credential shape is confirmed.
	];
}
