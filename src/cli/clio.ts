import { readSettings } from "../core/config.js";
import { initializeClioHome } from "../core/init.js";
import { openAuthStorage, resolveAuthTarget, targetRequiresAuth } from "../domains/providers/auth/index.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import { type BootOptions, bootOrchestrator } from "../entry/orchestrator.js";
import { runConfigureCommand } from "./configure.js";

function shouldRunInteractive(): boolean {
	return process.env.CLIO_INTERACTIVE === "1" || process.env.CLIO_PHASE1_INTERACTIVE === "1";
}

function hasUsableDefaultTarget(): boolean {
	const settings = readSettings();
	const targetId = settings.orchestrator.endpoint;
	if (!targetId) return false;
	const target = settings.endpoints.find((entry) => entry.id === targetId);
	if (!target) return false;
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const runtime = registry.get(target.runtime);
	if (!runtime) return false;
	if (runtime.kind === "subprocess") return true;
	if (!targetRequiresAuth(target, runtime)) return true;
	return openAuthStorage().statusForTarget(resolveAuthTarget(target, runtime), { includeFallback: false }).available;
}

export async function runClioCommand(options: BootOptions = {}): Promise<number> {
	// Bare `clio` (no subcommand) boots interactive mode implicitly, but only
	// when stdin is a real TTY. Piped or /dev/null stdin (used by verify.ts,
	// CI runners, and non-interactive scripts) should fall through to the
	// bannered non-interactive boot so those scripts do not hang on the TUI.
	// Explicit CLIO_INTERACTIVE=1 still forces interactive mode.
	if (process.env.CLIO_INTERACTIVE === undefined && process.stdin.isTTY) {
		process.env.CLIO_INTERACTIVE = "1";
	}
	if (shouldRunInteractive()) {
		initializeClioHome();
		if (!hasUsableDefaultTarget()) {
			process.stdout.write("No usable default target is configured. Starting `clio configure`.\n");
			const configured = await runConfigureCommand([]);
			if (configured !== 0) return configured;
		}
	}
	const result = await bootOrchestrator(options);
	return result.exitCode;
}
