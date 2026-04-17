import { bootOrchestrator } from "../entry/orchestrator.js";

export async function runClioCommand(): Promise<number> {
	// Bare `clio` (no subcommand) boots interactive mode implicitly, but only
	// when stdin is a real TTY. Piped or /dev/null stdin (used by verify.ts,
	// CI runners, and non-interactive scripts) should fall through to the
	// bannered non-interactive boot so those scripts do not hang on the TUI.
	// Explicit CLIO_INTERACTIVE=1 still forces interactive mode.
	if (process.env.CLIO_INTERACTIVE === undefined && process.stdin.isTTY) {
		process.env.CLIO_INTERACTIVE = "1";
	}
	const result = await bootOrchestrator();
	return result.exitCode;
}
