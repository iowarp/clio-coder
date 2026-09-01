/**
 * Lazy loader for the optional `@anthropic-ai/claude-agent-sdk` package.
 *
 * The SDK's platform package ships a 224MB proprietary binary, so it lives in
 * `optionalDependencies` and a default install skips it under
 * `npm install --omit=optional`. Nothing may import it at module scope: boot,
 * `doctor`, and every non-Claude runtime have to work on an install that never
 * fetched it. The one value the runtime needs (`query`) is reached through the
 * dynamic import below, at the moment a `claude-sdk` run actually starts, and a
 * missing package surfaces as a typed error naming the package and the install
 * command instead of an ESM resolution stack.
 */
import type { query } from "@anthropic-ai/claude-agent-sdk";

/** The optional package this module resolves. */
export const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * Version the checkout pins in `optionalDependencies`. A contract test keeps
 * the two in step so the install command quoted in the diagnostic never drifts
 * from the version the runtime was built against.
 */
export const CLAUDE_AGENT_SDK_VERSION = "0.3.186";

/** Exact command an operator can paste to make the Claude SDK runtime usable. */
export const CLAUDE_AGENT_SDK_INSTALL_COMMAND = `npm install ${CLAUDE_AGENT_SDK_PACKAGE}@${CLAUDE_AGENT_SDK_VERSION}`;

/** The slice of the SDK surface the worker runtime calls. */
export interface ClaudeAgentSdkModule {
	query: typeof query;
}

/** Thrown when a `claude-sdk` run starts on an install that omitted the optional package. */
export class ClaudeAgentSdkUnavailableError extends Error {
	readonly code = "CLAUDE_AGENT_SDK_UNAVAILABLE";
	readonly packageName = CLAUDE_AGENT_SDK_PACKAGE;
	readonly installCommand = CLAUDE_AGENT_SDK_INSTALL_COMMAND;

	constructor(cause?: unknown) {
		super(
			`The claude-sdk runtime needs the optional package ${CLAUDE_AGENT_SDK_PACKAGE}, which is not installed. ` +
				`Install it with \`${CLAUDE_AGENT_SDK_INSTALL_COMMAND}\` (or reinstall clio-coder without \`--omit=optional\`), ` +
				`then select the target again. Every other runtime works without it.`,
			cause === undefined ? undefined : { cause },
		);
		this.name = "ClaudeAgentSdkUnavailableError";
	}
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
