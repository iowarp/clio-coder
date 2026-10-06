/**
 * Whether bare `clio-coder` opens a workspace, and the one question it asks.
 *
 * The decision is made in the outer process before anything boots, and it is a
 * list of reasons not to: every case where taking over the terminal with a pane
 * host would surprise somebody returns null, and the caller boots Clio in the
 * plain terminal exactly as it always has. None of those cases prompts.
 *
 * Opening a workspace is never automatic the first time. The operator is asked
 * once, whether the pane host is already installed or would have to be
 * downloaded, and the answer is remembered. It is remembered in Clio's state
 * directory, not in settings.yaml: the settings file is the operator's own and
 * an `off` written there is never rewritten. An `off` is an answer, so a home
 * that carries it is never invited; only a home without the key is asked.
 *
 * The pane host is found before it is fetched. A copy the operator already has
 * on PATH is used when it clears the registry floor, then the pinned copy the
 * installer placed, and only when neither exists does accepting include a
 * download.
 */

import type { ClioSettings } from "../core/config.js";
import type { BootOptions } from "../entry/boot-options.js";

/** Multiplexers Clio will not nest a pane host inside. */
const HOST_MULTIPLEXER_ENV = ["TMUX", "ZELLIJ", "STY"] as const;

interface WorkspaceEligibilityInput {
	options: Pick<BootOptions, "headless" | "acp" | "panes">;
	setting: ClioSettings["interface"]["panes"]["enabled"];
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
}

/** Null when a workspace may open; otherwise the reason this boot stays in the plain terminal. */
function workspaceIneligibility(input: WorkspaceEligibilityInput): string | null {
	if (input.options.headless || input.options.acp) return "not an interactive session";
	if (input.options.panes === "without") return "--no-panes";
	// `auto` is a chosen meaning, "join a pane host, never start one", so it is
	// neither opened nor invited. `off` is decided by workspaceOutcome: never
	// invited, and opened only after an explicit `panes workspace on`.
	if (input.setting === "auto") return "interface.panes.enabled is auto";
	if (!input.stdinIsTTY || !input.stdoutIsTTY) return "not a terminal";
	if (input.env.TERM === "dumb") return "TERM is dumb";
	if (input.env.HERDR_ENV === "1") return "already inside a pane host";
	for (const name of HOST_MULTIPLEXER_ENV) {
		if (input.env[name]) return `already inside a terminal multiplexer (${name})`;
	}
	// The pin installs on Windows, but the launcher and the pane client speak
	// Unix sockets and herdr serves named pipes there.
	if (input.platform === "win32") return "workspaces are not available on Windows yet";
	return null;
}

/** The command line that starts this same Clio inside the pane. */
function clioArgv(): string[] {
	const script = process.argv[1];
	const args = process.argv.slice(2);
	return script === undefined ? [process.execPath, ...args] : [process.execPath, script, ...args];
}

/**
 * Open the workspace when this boot is eligible and the operator has said yes.
 * Returns the process exit code when the terminal was handed over and has come
 * back, or null when the caller should boot Clio here.
 */
export async function maybeLaunchWorkspace(
	options: Pick<BootOptions, "headless" | "acp" | "panes">,
	settings: ClioSettings,
): Promise<number | null> {
	const setting = settings.interface.panes.enabled;
	const reason = workspaceIneligibility({
		options,
		setting,
		env: process.env,
		platform: process.platform,
		stdinIsTTY: Boolean(process.stdin.isTTY),
		stdoutIsTTY: Boolean(process.stdout.isTTY),
	});
	if (reason !== null) return null;

	const { readWorkspaceConsent, workspaceOutcome, writeWorkspaceConsent } = await import("./workspace-consent.js");
	const consent = await readWorkspaceConsent();
	if (workspaceOutcome(setting, consent).kind === "plain") return null;

	const { resolveToolBinary, findPinnedTool, currentToolPlatform, describeFloorRejection, toolStatus } = await import(
		"../domains/toolchain/index.js"
	);
	let resolution = resolveToolBinary("herdr");
	const entry = findPinnedTool("herdr");
	const platform = currentToolPlatform();
	const downloadable = entry !== null && platform !== null && entry.downloads[platform] !== undefined;
	// No pane host and none to fetch for this machine: there is nothing to offer.
	if (resolution.binaryPath === null && !downloadable) return null;
	// A PATH copy below the floor is named, never reported as absent.
	const rejection = entry === null ? null : describeFloorRejection(toolStatus(entry));
	const needsDownload = resolution.binaryPath === null;

	if (consent === null || needsDownload) {
		const { promptSelect } = await import("./select.js");
		const firstTime = consent === null;
		const answer = await promptSelect({
			heading: [
				"",
				firstTime ? "Open Clio Coder in a workspace?" : "Download the workspace pane host?",
				"",
				...(firstTime
					? [
							"A workspace keeps your session beside terminal panes for files, workers and shells.",
							"Each project gets its own. Quitting Clio returns you to this terminal.",
						]
					: []),
				needsDownload
					? `It is powered by herdr ${entry?.version ?? ""} (${entry?.license ?? ""}), which Clio downloads once into its own data directory.`
					: `It is powered by the herdr already on this machine (${resolution.version ?? "version unread"}, ${resolution.binaryPath}).`,
				...(needsDownload && rejection !== null
					? [`Your ${rejection}, so Clio uses its own copy and leaves yours alone.`]
					: []),
				...(firstTime ? ["You are asked this once. Change it later with `clio-coder panes workspace on|off|ask`."] : []),
				"",
			],
			choices: [
				{ value: true, label: needsDownload ? "Yes, download and open the workspace" : "Yes, open the workspace" },
				{ value: false, label: "No, stay in this terminal" },
			],
			initialIndex: 0,
			backLabel: "cancel",
			clearOnExit: true,
		});
		// Leaving the question unanswered is not an answer; it is asked again next time.
		if (answer.kind !== "selected") return null;
		let remembered = !firstTime;
		if (firstTime) {
			try {
				await writeWorkspaceConsent(answer.value ? "accepted" : "declined", setting);
				remembered = true;
			} catch (error) {
				process.stderr.write(
					`Clio Coder: could not remember this answer (${error instanceof Error ? error.message : String(error)}), so it will be asked again.\n`,
				);
			}
		}
		if (!answer.value) {
			// The promise not to ask again is only made when the answer was stored.
			if (firstTime && remembered) {
				process.stdout.write(
					"Staying in this terminal. Clio will not ask again; `clio-coder panes workspace on` turns workspaces on.\n",
				);
			}
			return null;
		}
	}

	if (needsDownload) {
		const { installTool } = await import("../domains/toolchain/index.js");
		const installed = await installTool("herdr", {
			onProgress: (message) => process.stdout.write(`  ${message}\n`),
		});
		if (!installed.ok) {
			process.stderr.write(`Clio Coder: ${installed.message}\nContinuing in this terminal.\n`);
			return null;
		}
		resolution = resolveToolBinary("herdr");
		if (resolution.binaryPath === null) return null;
	}
	if (resolution.binaryPath === null) return null;

	const { launchWorkspace } = await import("../domains/mux/workspace/launch.js");
	const { clioPaneEnv } = await import("../domains/mux/child-env.js");
	const result = await launchWorkspace({
		herdrPath: resolution.binaryPath,
		herdrVersion: resolution.version,
		cwd: process.cwd(),
		clioArgv: clioArgv(),
		clioEnv: clioPaneEnv(process.env, settings.targets),
	});
	if (result.status === "fallback") {
		process.stderr.write(`Clio Coder: ${result.reason}. Continuing in this terminal.\n`);
		return null;
	}
	if (result.workspaceLeftRunning) {
		process.stdout.write("Clio workspaces are still open. Run `clio-coder` to return to them.\n");
	}
	return result.exitCode;
}
