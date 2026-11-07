/**
 * Whether bare `clio-coder` opens Clio's private pane host.
 *
 * The decision is made in the outer process before anything boots, and it is a
 * list of reasons not to: every case where taking over the terminal with a pane
 * host would surprise somebody returns null, and the caller boots Clio in the
 * plain terminal exactly as it always has. Nothing here prompts.
 *
 * The pane host is part of Clio, not an option of it. It always runs Clio's
 * own vendored herdr pin, never a herdr on PATH, so the operator's own herdr,
 * its config and its sessions are left exactly as they are. When the pin is
 * missing (an install that skipped it, a wiped data directory, an upgrade that
 * moved the pin) it is installed here with one line of status, and when that
 * fails Clio says so in one line and carries on in the plain terminal.
 *
 * Inside the operator's own herdr, Clio opens its own host nested in that pane
 * with a prefix that does not collide with the outer one. Inside Clio's own
 * host it never opens another: that Clio is the one the host was started for.
 * `--with-panes` keeps its meaning of joining the current host as a guest, so
 * it never opens a host either.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClioSettings } from "../core/config.js";
import { relaunchScript } from "../core/relaunch-script.js";
import type { BootOptions } from "../entry/boot-options.js";

/** Multiplexers Clio will not nest a pane host inside. */
const HOST_MULTIPLEXER_ENV = ["TMUX", "ZELLIJ", "STY"] as const;

export interface WorkspaceEligibilityInput {
	options: Pick<BootOptions, "headless" | "acp" | "panes">;
	env: Readonly<Record<string, string | undefined>>;
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	/** Whether `env.HERDR_SOCKET_PATH` names a host Clio started. */
	insideClioHost: boolean;
}

export type WorkspaceEligibility = { kind: "plain"; reason: string } | { kind: "open"; nested: boolean };

/** Whether this boot opens the private host, and nested in another herdr or not. */
export function workspaceEligibility(input: WorkspaceEligibilityInput): WorkspaceEligibility {
	const plain = (reason: string): WorkspaceEligibility => ({ kind: "plain", reason });
	if (input.options.headless || input.options.acp) return plain("not an interactive session");
	if (input.options.panes === "with") return plain("--with-panes joins the current pane host");
	if (!input.stdinIsTTY || !input.stdoutIsTTY) return plain("not a terminal");
	if (input.env.TERM === "dumb") return plain("TERM is dumb");
	for (const name of HOST_MULTIPLEXER_ENV) {
		if (input.env[name]) return plain(`already inside a terminal multiplexer (${name})`);
	}
	const inHerdr = input.env.HERDR_ENV === "1";
	if (inHerdr && input.insideClioHost) return plain("already inside Clio's pane host");
	return { kind: "open", nested: inHerdr };
}

/** The command line that starts this same Clio inside the pane. */
function clioArgv(): string[] {
	const script = process.argv[1];
	const args = process.argv.slice(2);
	return script === undefined ? [process.execPath, ...args] : [process.execPath, relaunchScript(script), ...args];
}

/** A launch waits this long for the download; the installers and `tools install` keep the full timeout. */
const LAUNCH_INSTALL_TIMEOUT_MS = 30_000;
/** After a failed launch-time install, launches skip the retry this long for the same pin. */
const INSTALL_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

function installFailureStamp(stateDir: string): string {
	return join(stateDir, "mux", "herdr-install-failed.json");
}

function recentInstallFailure(stamp: string, version: string, now: number): boolean {
	try {
		const record = JSON.parse(readFileSync(stamp, "utf8")) as { version?: unknown; at?: unknown };
		return record.version === version && typeof record.at === "number" && now - record.at < INSTALL_RETRY_AFTER_MS;
	} catch {
		return false;
	}
}

/**
 * Clio's own pinned herdr, installed on the spot when it is missing. On a
 * platform with no pinned herdr build, panes are silently unavailable. A failed
 * install warns once and is not retried at launch for a day, or until the pin
 * moves; the installers, `tools install herdr` and doctor always try.
 */
async function vendoredHerdr(): Promise<{ binaryPath: string; version: string } | null> {
	const { currentToolPlatform, findPinnedTool, installTool, resolveVendoredBinary } = await import(
		"../domains/toolchain/index.js"
	);
	const present = resolveVendoredBinary("herdr");
	if (present !== null) return present;
	const entry = findPinnedTool("herdr");
	const platform = currentToolPlatform();
	if (entry === null || platform === null || entry.downloads[platform] === undefined) return null;
	const { clioStateDir } = await import("../core/xdg.js");
	const stamp = installFailureStamp(clioStateDir());
	if (recentInstallFailure(stamp, entry.version, Date.now())) return null;
	process.stderr.write("Clio Coder: setting up terminal panes (one time)...\n");
	const installed = await installTool("herdr", { timeoutMs: LAUNCH_INSTALL_TIMEOUT_MS });
	const resolved = installed.ok ? resolveVendoredBinary("herdr") : null;
	if (resolved === null) {
		const why = installed.ok ? "the installed binary was not found" : installed.message.split("\n")[0];
		process.stderr.write(
			`Clio Coder: terminal panes unavailable (${why}). Continuing in this terminal; run \`clio-coder panes install\` to retry.\n`,
		);
		try {
			mkdirSync(dirname(stamp), { recursive: true, mode: 0o700 });
			writeFileSync(stamp, `${JSON.stringify({ version: entry.version, at: Date.now() })}\n`, { mode: 0o600 });
		} catch {
			// Without the stamp the next launch simply tries again.
		}
	} else {
		rmSync(stamp, { force: true });
	}
	return resolved;
}

/**
 * Open the private pane host when this boot is eligible. Returns the process
 * exit code when the terminal was handed over and has come back, or null when
 * the caller should boot Clio here.
 */
export async function maybeLaunchWorkspace(
	options: Pick<BootOptions, "headless" | "acp" | "panes">,
	settings: ClioSettings,
): Promise<number | null> {
	const { isClioHostSocket } = await import("../domains/mux/workspace/platform.js");
	const eligibility = workspaceEligibility({
		options,
		env: process.env,
		stdinIsTTY: Boolean(process.stdin.isTTY),
		stdoutIsTTY: Boolean(process.stdout.isTTY),
		insideClioHost: isClioHostSocket(process.env.HERDR_SOCKET_PATH),
	});
	if (eligibility.kind === "plain") return null;

	const herdr = await vendoredHerdr();
	if (herdr === null) return null;

	const { launchWorkspace } = await import("../domains/mux/workspace/launch.js");
	const { clioPaneEnv } = await import("../domains/mux/child-env.js");
	const result = await launchWorkspace({
		herdrPath: herdr.binaryPath,
		herdrVersion: herdr.version,
		nested: eligibility.nested,
		outputStyle: settings.interface.outputDetail,
		cwd: process.cwd(),
		clioArgv: clioArgv(),
		clioEnv: clioPaneEnv(process.env, settings.targets),
	});
	if (result.status === "fallback") {
		process.stderr.write(`Clio Coder: terminal panes unavailable (${result.reason}). Continuing in this terminal.\n`);
		return null;
	}
	// The pane that printed the exit summary is gone; this is the terminal the operator reads.
	if (result.exitSummary !== null) process.stdout.write(result.exitSummary);
	if (result.workspaceLeftRunning) {
		process.stdout.write("Clio workspaces are still open. Run `clio-coder` to return to them.\n");
	}
	return result.exitCode;
}
