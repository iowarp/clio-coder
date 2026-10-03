/**
 * Lazy loader for the optional `@anthropic-ai/claude-agent-sdk` package.
 *
 * The SDK's platform package ships a 224MB proprietary binary, so it lives in
 * `optionalDependencies` and the installer skips it by default.
 * Nothing may import it at module scope: boot,
 * `doctor`, and every non-Claude runtime have to work on an install that never
 * fetched it. The one value the runtime needs (`query`) is reached through the
 * dynamic import below, at the moment a `claude-sdk` run actually starts, and a
 * missing package surfaces as a typed error naming the package and the install
 * command instead of an ESM resolution stack.
 */
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSdkUnavailableError } from "../../domains/lifecycle/claude-sdk-install.js";

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

/** Resolution failures that mean "the package is not on disk" rather than "the package is broken". */
const MISSING_MODULE_CODES: ReadonlySet<string> = new Set([
	"ERR_MODULE_NOT_FOUND",
	"MODULE_NOT_FOUND",
	"ERR_PACKAGE_PATH_NOT_EXPORTED",
]);

function isMissingModuleError(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && MISSING_MODULE_CODES.has(code);
}

export type ClaudeAgentSdkLoader = () => Promise<ClaudeAgentSdkModule>;

// The literal specifier is what keeps the SDK's types available here; the tsup
// `external` entry keeps esbuild from bundling it and leaves this as a real
// runtime `import()`.
const realLoader: ClaudeAgentSdkLoader = async () => await import("@anthropic-ai/claude-agent-sdk");

const loader: ClaudeAgentSdkLoader = realLoader;
let cached: ClaudeAgentSdkModule | null = null;

/**
 * Resolve the SDK, or fail with {@link ClaudeAgentSdkUnavailableError}. A load
 * error that is not a resolution failure (a broken install, a throwing module
 * top level) propagates unchanged, so a real fault is never mislabeled as an
 * absent package.
 */
export async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
	if (cached) return cached;
	try {
		cached = await loader();
		return cached;
	} catch (error) {
		if (isMissingModuleError(error)) throw new ClaudeAgentSdkUnavailableError(error);
		throw error;
	}
}
