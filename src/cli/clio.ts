import { formatBootTrace } from "../core/boot-trace.js";
import { initializeClioHome } from "../core/init.js";
import { readLayeredSettings, readStrictLayeredSettings } from "../core/settings-layers.js";
import type { BootOptions } from "../entry/boot-options.js";
import { classifyDefaultTarget, describeVerdict } from "./default-target.js";

/** Headless and ACP keep their established non-TUI transports even when an
 * embedding process leaves the interactive marker in the environment. */
function terminalLeaseEligible(
	options: Pick<BootOptions, "headless" | "acp">,
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return !options.headless && !options.acp && env.CLIO_CODER_INTERACTIVE === "1";
}

export async function runClioCommand(options: BootOptions = {}): Promise<number> {
	// Bare `clio` (no subcommand) boots interactive mode implicitly, but only
	// when stdin is a real TTY. Piped or /dev/null stdin (used by verify.ts,
	// CI runners, and non-interactive scripts) should fall through to the
	// bannered non-interactive boot so those scripts do not hang on the TUI.
	// Explicit CLIO_CODER_INTERACTIVE=1 still forces interactive mode.
	if (!options.headless && !options.acp && process.env.CLIO_CODER_INTERACTIVE === undefined && process.stdin.isTTY) {
		process.env.CLIO_CODER_INTERACTIVE = "1";
	}
	let startupSettings: import("../core/config.js").ClioSettings | undefined;
	if (terminalLeaseEligible(options)) {
		initializeClioHome();
		// The user file remains a strict gate. Project layers retain their
		// established best-effort diagnostics, but every subsequent boot phase
		// consumes this same effective snapshot.
		startupSettings = readStrictLayeredSettings(process.cwd()).settings;
		const verdict = classifyDefaultTarget(startupSettings);
		if (verdict.kind === "missing-credential") {
			// Diagnosis without a detour. The session continues, because whether
			// the credential is actually required is the endpoint's answer to
			// give and not something Clio can settle from settings alone.
			process.stdout.write(
				`Target '${verdict.targetId}' has no stored credential under '${verdict.store}'.\n` +
					`Run \`clio-coder auth login ${verdict.store}\` if the endpoint requires one; local runtimes that ignore keys work as is.\n`,
			);
		} else if (verdict.kind !== "usable") {
			process.stdout.write(`${describeVerdict(verdict)} Starting \`clio-coder configure\`.\n`);
			const { runConfigureCommand } = await import("./configure.js");
			const configured = await runConfigureCommand([]);
			if (configured !== 0) return configured;
			startupSettings = readStrictLayeredSettings(process.cwd()).settings;
			const configuredVerdict = classifyDefaultTarget(startupSettings);
			if (configuredVerdict.kind !== "usable" && configuredVerdict.kind !== "missing-credential") {
				process.stderr.write(`${describeVerdict(configuredVerdict)} Configuration did not complete; startup cancelled.\n`);
				return 2;
			}
		}
	}
	let terminalLease: import("../interactive/terminal-lease.js").TerminalLease | undefined;
	try {
		if (terminalLeaseEligible(options)) {
			const { createProcessTerminalLease, instantShellEnabled } = await import("../interactive/terminal-lease.js");
			if (instantShellEnabled()) {
				let stage0FrameId: number | null = null;
				terminalLease = createProcessTerminalLease({
					settings: startupSettings ?? readLayeredSettings(process.cwd()).settings,
					onStage0Commit: (frameId) => {
						stage0FrameId = frameId;
					},
				});
				if (stage0FrameId !== null) {
					const line = formatBootTrace("Stage 0 shell commit", `frameId=${stage0FrameId}`);
					if (line) terminalLease.deferDiagnostic("stderr", line);
				}
			}
		}
		// Deterministic built-PTY interleaving seam. It is unavailable outside
		// NODE_ENV=test and bounded even under a malformed value.
		if (terminalLease && process.env.NODE_ENV === "test") {
			const requestedDelay = Number.parseInt(process.env.CLIO_CODER_TEST_STAGE1_DELAY_MS ?? "0", 10);
			const delayMs = Number.isFinite(requestedDelay) ? Math.max(0, Math.min(5_000, requestedDelay)) : 0;
			if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
			if (process.env.CLIO_CODER_TEST_STAGE1_FAIL === "1") {
				throw new Error("injected Stage 1 hydration failure");
			}
		}
		const { bootOrchestrator } = await import("../entry/orchestrator.js");
		const result = await bootOrchestrator({
			...options,
			...(startupSettings ? { startupSettings } : {}),
			...(terminalLease ? { terminalLease } : {}),
		});
		return result.exitCode;
	} catch (error) {
		try {
			await terminalLease?.fail();
		} catch (cleanupError) {
			// Preserve the established boot failure as the primary error. The lease
			// has already attempted every restoration step and reached `closed`.
			process.stderr.write(
				`Clio Coder: terminal cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
			);
		}
		throw error;
	}
}
