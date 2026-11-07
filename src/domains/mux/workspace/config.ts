/**
 * The herdr configuration Clio's private pane host runs under.
 *
 * Clio never edits the operator's own herdr config. The private host reads its
 * config from the path the platform layout chose (src/domains/mux/workspace/
 * platform.ts), so an operator who already uses herdr keeps their keys, theme
 * and sessions exactly as they were, and everybody else gets a pane host that
 * looks and reads like part of Clio without having configured anything.
 *
 * The file is Clio's output, not a place to keep edits. It is rewritten on
 * every launch, and again by the Clio in the pane when the operator changes
 * the output style, which is why the launch inputs the pane cannot see for
 * itself (whether this host is nested in another herdr) are kept beside it in
 * `clio-coder-workspace.json`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OutputStyle } from "../../../core/defaults.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { renderHerdrThemeBlock } from "../yazi/theme.js";
import { clioHostSessionOf, hostedInWorkspace } from "./exit-marker.js";
import { type MuxHostPlatform, muxHostPlatform, type PaneShellSettings } from "./platform.js";

export interface WorkspaceConfigInput {
	shell: PaneShellSettings;
	/** True when the host runs inside another herdr, whose prefix keeps `ctrl+b`. */
	nested: boolean;
	outputStyle: OutputStyle;
}

/** The prefix outside any other herdr: tmux's and herdr's own default. */
const PREFIX = "ctrl+b";
/**
 * The prefix when nested in the operator's own herdr, which keeps `ctrl+b`.
 * `ctrl+shift+b` is distinct only under the kitty keyboard protocol, so
 * `ctrl+]` (0x1d, unused by Clio, which takes `ctrl+_`) is the fallback every
 * terminal can send.
 */
const NESTED_PREFIX = ["ctrl+shift+b", "ctrl+]"] as const;

/**
 * herdr's own screens, which belong to herdr's UX rather than to Clio's panes:
 * its help and settings, workspace and worktree management, the goto picker,
 * config reload and notification jumps. Clio drives those surfaces itself.
 * Detach, pane and tab keys, copy mode, scrollback editing and the sidebar
 * toggle stay bound.
 */
const UNBOUND_KEYS = [
	"help",
	"settings",
	"new_workspace",
	"new_worktree",
	"open_worktree",
	"remove_worktree",
	"rename_workspace",
	"close_workspace",
	"workspace_picker",
	"goto",
	"reload_config",
	"open_notification_target",
] as const;

/** Pane chrome per Clio output style: compact stays bare, detailed frames everything. */
const CHROME: Readonly<
	Record<
		OutputStyle,
		{ borders: "auto" | "always" | "off"; outer: boolean; gaps: boolean; labels: boolean; scrollbars: boolean }
	>
> = {
	compact: { borders: "auto", outer: false, gaps: false, labels: false, scrollbars: false },
	standard: { borders: "auto", outer: false, gaps: true, labels: true, scrollbars: true },
	detailed: { borders: "always", outer: true, gaps: true, labels: true, scrollbars: true },
};

const toml = (value: string): string => JSON.stringify(value);

/**
 * The managed config, as text.
 *
 * Update checks are off because the binary is Clio's pin: herdr offering to
 * replace itself would move the host off the version Clio was verified
 * against. Onboarding, sounds and agent resumption are off because the
 * operator asked for Clio, not for herdr.
 */
export function renderWorkspaceConfig(input: WorkspaceConfigInput): string {
	const chrome = CHROME[input.outputStyle];
	const prefix = input.nested ? `[${NESTED_PREFIX.map(toml).join(", ")}]` : toml(PREFIX);
	const terminal = [
		"[terminal]",
		...(input.shell.defaultShell === null ? [] : [`default_shell = ${toml(input.shell.defaultShell)}`]),
		`shell_mode = ${toml(input.shell.shellMode)}`,
	];
	return `# Written by Clio Coder for its private pane host. Edits here are overwritten.
# Your own herdr config and sessions are never touched.
onboarding = false

[update]
version_check = false
manifest_check = false

[session]
resume_agents_on_restore = false

${terminal.join("\n")}

[keys]
prefix = ${prefix}
${UNBOUND_KEYS.map((key) => `${key} = ""`).join("\n")}

[ui]
window_title = "Clio Coder: {workspace}"
prompt_new_tab_name = false
hide_tab_bar_when_single_tab = true
sidebar_start_collapsed = true
pane_borders = ${toml(chrome.borders)}
pane_outer_borders = ${chrome.outer}
pane_gaps = ${chrome.gaps}
show_agent_labels_on_pane_borders = ${chrome.labels}
pane_scrollbars = ${chrome.scrollbars}

[ui.sound]
enabled = false

[theme]
name = "terminal"

${renderHerdrThemeBlock()
	.split("\n")
	.filter((line) => !line.startsWith("#"))
	.join("\n")}`;
}

function launchInputsPath(configPath: string): string {
	return join(dirname(configPath), "clio-coder-workspace.json");
}

/** Write the managed config and the launch inputs a later re-render needs. */
export function writeWorkspaceConfig(configPath: string, input: WorkspaceConfigInput): void {
	// Atomic, because a host starting or reloading while another launcher
	// rewrites this must read the whole file or the previous whole file.
	safeResourceWrite(configPath, renderWorkspaceConfig(input), { mode: 0o644 });
	safeResourceWrite(
		launchInputsPath(configPath),
		`${JSON.stringify({ version: 1, nested: input.nested, outputStyle: input.outputStyle }, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

/**
 * Re-render the managed config for a new output style, keeping what the launch
 * decided. False when the launch inputs are missing, in which case the file is
 * left as it is rather than guessed at.
 */
export function rerenderWorkspaceConfig(
	configPath: string,
	shell: PaneShellSettings,
	outputStyle: OutputStyle,
): boolean {
	let nested: boolean;
	try {
		const parsed = JSON.parse(readFileSync(launchInputsPath(configPath), "utf8")) as { nested?: unknown };
		if (typeof parsed.nested !== "boolean") return false;
		nested = parsed.nested;
	} catch {
		return false;
	}
	writeWorkspaceConfig(configPath, { shell, nested, outputStyle });
	return true;
}

/**
 * Called by the Clio inside its own private host when the output style
 * changes: re-render the host's config for the new style and make the server
 * re-read it, so pane chrome follows the style without a restart. Anywhere
 * else (a plain terminal, the operator's own herdr) it does nothing and
 * returns false.
 */
export async function reloadHostChrome(
	outputStyle: OutputStyle,
	reload: () => Promise<void>,
	env: NodeJS.ProcessEnv = process.env,
	platform: MuxHostPlatform = muxHostPlatform(),
): Promise<boolean> {
	const session = clioHostSessionOf(env.HERDR_SOCKET_PATH);
	if (session === null || !hostedInWorkspace(env)) return false;
	const layout = platform.hostLayout({ session, env });
	// The layout must name the socket this pane is on, or the config it points
	// at belongs to some other host.
	if (layout.socketPath !== env.HERDR_SOCKET_PATH) return false;
	if (!rerenderWorkspaceConfig(layout.configPath, layout.shell, outputStyle)) return false;
	await reload();
	return true;
}
