/**
 * Lazy loader for the optional `@anthropic-ai/claude-agent-sdk` package.
 *
 * The SDK's platform package ships a 224MB proprietary binary, so it is provisioned
 * separately and is a development dependency for types only.
 * Nothing may import it at module scope: boot,
 * `doctor`, and every non-Claude runtime have to work on an install that never
 * fetched it. The one value the runtime needs (`query`) is reached through the
 * dynamic import below, at the moment a `claude-sdk` run actually starts, and a
 * missing package surfaces as a typed error naming the package and the install
 * command instead of an ESM resolution stack.
 */
import { pathToFileURL } from "node:url";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import {
	ClaudeAgentSdkUnavailableError,
	resolveClaudeAgentSdkEntry,
} from "../../domains/lifecycle/claude-sdk-install.js";

export {
	CLAUDE_AGENT_SDK_INSTALL_COMMAND,
	CLAUDE_AGENT_SDK_PACKAGE,
	CLAUDE_AGENT_SDK_VERSION,
	ClaudeAgentSdkUnavailableError,
} from "../../domains/lifecycle/claude-sdk-install.js";

/** The slice of the SDK surface the worker runtime calls. */
export interface ClaudeAgentSdkModule {
	query: typeof query;
}

/** The component location is resolved before import; dependency/link/evaluation failures propagate. */
export async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
	const entry = resolveClaudeAgentSdkEntry();
	if (!entry) throw new ClaudeAgentSdkUnavailableError();
	const sdk: ClaudeAgentSdkModule = await import(pathToFileURL(entry).href);
	if (typeof sdk.query !== "function") throw new Error(`Claude SDK at ${entry} does not export query.`);
	return sdk;
}
