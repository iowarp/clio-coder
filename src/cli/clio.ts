import { initializeClioHome } from "../core/init.js";
import { type BootOptions, bootOrchestrator } from "../entry/orchestrator.js";
import { runConfigureCommand } from "./configure.js";
import { classifyDefaultTarget, describeVerdict } from "./default-target.js";

export async function runClioCommand(options: BootOptions = {}): Promise<number> {
	// Bare `clio` (no subcommand) boots interactive mode implicitly, but only
	// when stdin is a real TTY. Piped or /dev/null stdin (used by verify.ts,
	// CI runners, and non-interactive scripts) should fall through to the
	// bannered non-interactive boot so those scripts do not hang on the TUI.
	// Explicit CLIO_INTERACTIVE=1 still forces interactive mode.
	if (!options.headless && !options.acp && process.env.CLIO_INTERACTIVE === undefined && process.stdin.isTTY) {
		process.env.CLIO_INTERACTIVE = "1";
	}
	if (process.env.CLIO_INTERACTIVE === "1") {
		initializeClioHome();
		const verdict = classifyDefaultTarget();
		if (verdict.kind === "missing-credential") {
			// Diagnosis without a detour. The session continues, because whether
			// the credential is actually required is the endpoint's answer to
			// give and not something Clio can settle from settings alone.
			process.stdout.write(
				`Target '${verdict.targetId}' has no stored credential under '${verdict.store}'.\n` +
					`Run \`clio auth login ${verdict.store}\` if the endpoint requires one; local runtimes that ignore keys work as is.\n`,
			);
		} else if (verdict.kind !== "usable") {
			process.stdout.write(`${describeVerdict(verdict)} Starting \`clio configure\`.\n`);
			const configured = await runConfigureCommand([]);
			if (configured !== 0) return configured;
		}
	}
	const result = await bootOrchestrator(options);
	return result.exitCode;
}
