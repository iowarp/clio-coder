/**
 * Capability manifest for CLI-tier runtime adapters.
 *
 * Each entry declares a supported external CLI by id, the binary name Clio
 * probes for on PATH, whether it streams output, whether it supports
 * structured output (JSON mode), and its telemetry tier. Capabilities are
 * static data consulted by CLI adapters and by diag-cli-runtimes; they carry
 * no runtime state.
 *
 * Telemetry tiers:
 *   gold   — full structured events (unused so far; reserved for first-party).
 *   silver — partial structure (text + exit code + optional json mode).
 *   bronze — best-effort text capture only.
 */

export type TelemetryTier = "gold" | "silver" | "bronze";

export interface CliCapability {
	/** Adapter id. Not a ProviderId; CLI adapters live alongside provider adapters but use their own id space. */
	id: string;
	/** Executable name probed on PATH. */
	binary: string;
	/** Optional env var name that enables the adapter when the binary is absent from PATH. */
	envCheck?: string;
	supportsStreaming: boolean;
	supportsStructuredOutput: boolean;
	telemetry: TelemetryTier;
	/** Flags used by the probe to obtain help/version output. */
	helpFlags: ReadonlyArray<string>;
}

export const CLI_CAPABILITIES: ReadonlyArray<CliCapability> = [
	{
		id: "pi-coding-agent",
		binary: "pi-coding-agent",
		supportsStreaming: true,
		supportsStructuredOutput: false,
		telemetry: "silver",
		helpFlags: ["--help"],
	},
	{
		id: "claude-code",
		binary: "claude-code",
		envCheck: "CLIO_CLI_CLAUDE_CODE_BIN",
		supportsStreaming: true,
		supportsStructuredOutput: true,
		telemetry: "silver",
		helpFlags: ["--help"],
	},
	{
		id: "codex",
		binary: "codex",
		supportsStreaming: true,
		supportsStructuredOutput: false,
		telemetry: "silver",
		helpFlags: ["--help"],
	},
	{
		id: "gemini",
		binary: "gemini",
		supportsStreaming: false,
		supportsStructuredOutput: false,
		telemetry: "bronze",
		helpFlags: ["--help"],
	},
	{
		id: "opencode",
		binary: "opencode",
		supportsStreaming: true,
		supportsStructuredOutput: false,
		telemetry: "silver",
		helpFlags: ["--help"],
	},
	{
		id: "copilot",
		binary: "copilot",
		envCheck: "CLIO_CLI_COPILOT_BIN",
		supportsStreaming: false,
		supportsStructuredOutput: false,
		telemetry: "bronze",
		helpFlags: ["--help"],
	},
];
