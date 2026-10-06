import { formatBootTrace } from "../core/boot-trace.js";
import { initializeClioHome } from "../core/init.js";
import { isRestartHandoff } from "../core/restart-status.js";
import { readLayeredSettings, readStrictLayeredSettings } from "../core/settings-layers.js";
import type { BootOptions } from "../entry/boot-options.js";
import { classifyDefaultTarget, describeKeptChatRoute, describeVerdict, homeIsReturning } from "./default-target.js";

/** Headless and ACP keep their established non-TUI transports even when an
 * embedding process leaves the interactive marker in the environment. */
function terminalLeaseEligible(
	options: Pick<BootOptions, "headless" | "acp">,
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return !options.headless && !options.acp && env.CLIO_CODER_INTERACTIVE === "1";
}

export interface ClioCommandDependencies {
	bootOrchestrator: typeof import("../entry/orchestrator.js").bootOrchestrator;
}

const DEFAULT_DEPENDENCIES: ClioCommandDependencies = {
	bootOrchestrator: async (options) => {
		const { bootOrchestrator } = await import("../entry/orchestrator.js");
		return bootOrchestrator(options);
	},
};

export async function runClioCommand(
	options: BootOptions = {},
	dependencies: Partial<ClioCommandDependencies> = {},
): Promise<number> {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	// Bare `clio` (no subcommand) boots interactive mode implicitly, but only
	// when stdin is a real TTY. Piped or /dev/null stdin (used by verify.ts,
	// CI runners, and non-interactive scripts) should fall through to the
	// bannered non-interactive boot so those scripts do not hang on the TUI.
	// Explicit CLIO_CODER_INTERACTIVE=1 still forces interactive mode.
	if (!options.headless && !options.acp && process.env.CLIO_CODER_INTERACTIVE === undefined && process.stdin.isTTY) {
		process.env.CLIO_CODER_INTERACTIVE = "1";
	}
	if (!options.headless && !options.acp) {
		const { confirmStartupWorkspace } = await import("./workspace-check.js");
		if (!(await confirmStartupWorkspace())) return 1;
	}
	let startupSettings: import("../core/config.js").ClioSettings | undefined;
	if (terminalLeaseEligible(options)) {
		const existingHome = homeIsReturning();
		initializeClioHome();
		// A background update leaves the previous release's state for this launch to convert, and the strict settings read below needs it converted.
		await (await import("../domains/lifecycle/boot-migrations.js")).applyPendingMigrationsAtBoot();
		// The user file remains a strict gate. Project layers retain their
		// established best-effort diagnostics, but every subsequent boot phase
		// consumes this same effective snapshot.
		startupSettings = readStrictLayeredSettings(process.cwd()).settings;
		const verdict = classifyDefaultTarget(startupSettings);
		let detected = false;
		// A saved chat route stays the user's choice when it cannot be used: no
		// other target is borrowed for the session. One that only lacks its
		// credential still opens, unavailable; one that cannot drive a session at
		// all stops here with the reason. An unset route keeps discovery below.
		const keptRoute = existingHome && verdict.kind !== "usable" && verdict.kind !== "no-target";
		if (keptRoute) {
			if (verdict.kind !== "missing-credential") {
				process.stderr.write(
					`${describeVerdict(verdict)} Your saved chat route is kept and no other target is used. Run \`clio-coder configure\` to fix it.\n`,
				);
				return 2;
			}
			process.stdout.write(`${describeKeptChatRoute(startupSettings, verdict)}\n`);
		} else if (existingHome && verdict.kind !== "usable") {
			const { adoptDetectedChatRoute, describeAdoptedRoute } = await import("./detect-chat-routes.js");
			const adopted = await adoptDetectedChatRoute(startupSettings);
			if (adopted) {
				startupSettings = adopted.settings;
				detected = true;
				process.stdout.write(`${describeAdoptedRoute(adopted)} Change it with /config.\n`);
			}
		}
		if (!detected && !keptRoute && verdict.kind !== "usable") {
			process.stdout.write(`${describeVerdict(verdict)} Starting \`clio-coder configure\`.\n`);
			const { runConfigureCommand } = await import("./configure.js");
			const configured = await runConfigureCommand([], process.stdin, process.stdout, true);
			if (configured !== 0) return configured;
			startupSettings = readStrictLayeredSettings(process.cwd()).settings;
			const configuredVerdict = classifyDefaultTarget(startupSettings);
			if (configuredVerdict.kind !== "usable" && configuredVerdict.kind !== "missing-credential") {
				process.stderr.write(`${describeVerdict(configuredVerdict)} Configuration did not complete; startup cancelled.\n`);
				return 2;
			}
		}
	}
	if (startupSettings) {
		// The workspace launcher runs after the configuration gate, so a first
		// run answers its questions in the plain terminal, and before the lease,
		// so nothing has claimed the terminal the pane host is about to take.
		const { maybeLaunchWorkspace } = await import("./workspace-launch.js");
		const launched = await maybeLaunchWorkspace(options, startupSettings);
		if (launched !== null) return launched;
	}
	if (terminalLeaseEligible(options) && process.env.HERDR_ENV === "1") {
		// Hosted in a Clio workspace: a clean quit tells the launcher this pane is
		// done so it can hand the operator's own terminal back. Interactive
		// shutdown ends the process itself, so the exit event is the one place
		// every clean path passes through.
		const { clearWorkspaceExit, hostedInWorkspace, markWorkspaceExit } = await import(
			"../domains/mux/workspace/exit-marker.js"
		);
		if (hostedInWorkspace()) {
			clearWorkspaceExit();
			process.once("exit", (code) => {
				if (code === 0 && !isRestartHandoff()) markWorkspaceExit();
			});
		}
	}
	let terminalLease: import("../interactive/terminal-lease.js").TerminalLease | undefined;
	try {
		if (terminalLeaseEligible(options)) {
			// Ask for the background before the lease owns stdin and before the
			// theme is created, so the palette matches a dark or light terminal.
			const { probeTerminalBackground } = await import("../core/terminal-background.js");
			await probeTerminalBackground();
			const { createProcessTerminalLease, instantShellEnabled } = await import("../interactive/terminal-lease.js");
			if (instantShellEnabled()) {
				let stage0FrameId: number | null = null;
				const effectiveSettings = startupSettings ?? readLayeredSettings(process.cwd()).settings;
				const shellSettings =
					options.demo === undefined
						? effectiveSettings
						: {
								...effectiveSettings,
								interface: { ...effectiveSettings.interface, demo: options.demo },
							};
				terminalLease = createProcessTerminalLease({
					settings:
						options.autonomy === undefined
							? shellSettings
							: { ...shellSettings, safety: { ...shellSettings.safety, autonomy: options.autonomy } },
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
		const result = await deps.bootOrchestrator({
			...options,
			...(startupSettings ? { startupSettings } : {}),
			...(terminalLease ? { terminalLease } : {}),
		});
		return result.exitCode;
	} catch (error) {
		// Ctrl+C or a signal closed the lease while Stage 1 was hydrating, and boot
		// stopped at its next phase boundary. The shutdown that closed the lease
		// restores the terminal and sets the process exit code.
		if (terminalLease?.abortSignal.aborted && error === terminalLease.abortSignal.reason) return 0;
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
