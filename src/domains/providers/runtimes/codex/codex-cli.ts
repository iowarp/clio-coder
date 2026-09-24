import { boundedExternalDiagnostic } from "../../../../core/external-diagnostic.js";
import { runCommandVector } from "../../../../core/safe-exec.js";
import type { ProbeContext, ProbeResult } from "../../types/runtime-descriptor.js";
import { createExternalCliRuntime } from "../external-cli-descriptor.js";

/** Clio's configured-model slot; the CLI's own configuration chooses the wire model. */
export const CODEX_CLI_DEFAULT_MODEL = "codex-cli-default";

async function probeCodexCli(ctx: ProbeContext): Promise<ProbeResult> {
	const cwd = process.cwd();
	const env = process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {};
	const version = await runCommandVector("codex", ["--version"], {
		cwd,
		workspaceRoot: cwd,
		timeoutMs: Math.max(1, ctx.httpTimeoutMs),
		maxOutputBytes: 4096,
		env,
		...(ctx.signal ? { signal: ctx.signal } : {}),
	});
	if (version.exitCode !== 0) {
		return {
			ok: false,
			latencyMs: version.durationMs,
			failureKind: version.aborted ? "cancelled" : version.stderr.includes("ENOENT") ? "missing" : "generic",
			error: boundedExternalDiagnostic(version.stderr || "Codex CLI is unavailable; install `codex` and retry"),
		};
	}
	const login = await runCommandVector("codex", ["login", "status"], {
		cwd,
		workspaceRoot: cwd,
		timeoutMs: Math.max(1, ctx.httpTimeoutMs),
		maxOutputBytes: 4096,
		env,
		...(ctx.signal ? { signal: ctx.signal } : {}),
	});
	if (login.exitCode !== 0) {
		return {
			ok: false,
			latencyMs: version.durationMs + login.durationMs,
			serverVersion: version.stdout.trim(),
			failureKind: login.aborted ? "cancelled" : "authentication",
			error: "Codex CLI is installed but not signed in; run `codex login`",
		};
	}
	return {
		ok: true,
		latencyMs: version.durationMs + login.durationMs,
		serverVersion: version.stdout.trim(),
		models: [CODEX_CLI_DEFAULT_MODEL],
	};
}

const codexCliRuntime = createExternalCliRuntime({
	id: "codex-cli",
	displayName: "Codex CLI — managed headless delegation",
	authNotice: "Uses the installed `codex` command and its own login. Clio does not store Codex CLI credentials.",
	defaultModel: CODEX_CLI_DEFAULT_MODEL,
	binaryName: "codex",
	headlessCommand: "codex exec --json --ephemeral",
	outputParser: "codex-exec-jsonl",
	provider: "openai-codex",
	probe(_target, ctx) {
		return probeCodexCli(ctx);
	},
});

export default codexCliRuntime;
