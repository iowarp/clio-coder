/**
 * The herdr configuration a Clio workspace runs under.
 *
 * Clio never edits the operator's own `~/.config/herdr/config.toml`. The
 * workspace session is started with `HERDR_CONFIG_PATH` pointing at this file
 * instead, so an operator who already uses herdr keeps their keys, theme and
 * default session exactly as they were, and everybody else gets a pane host
 * that looks and reads like part of Clio without having configured anything.
 *
 * The file is regenerated on every launch. It is Clio's output, not a place to
 * keep edits: an operator who wants their own herdr setup runs Clio inside
 * their own herdr session, where Clio joins as a guest and this file is unused.
 */

import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { clioConfigDir } from "../../../core/xdg.js";
import { renderHerdrThemeBlock } from "../yazi/theme.js";

/**
 * The managed config, as text.
 *
 * Update checks are off because the binary is Clio's pin: herdr offering to
 * replace itself would move the workspace off the version Clio was verified
 * against. herdr's own first-run onboarding is off for the same reason the
 * session exists at all, which is that the operator asked for Clio.
 */
function renderWorkspaceConfig(): string {
	return `# Written by Clio Coder on every workspace launch. Edits here are overwritten.
# This file configures only the herdr sessions Clio Coder hosts for its
# workspaces; your own herdr config and sessions are never touched.
onboarding = false

[update]
version_check = false
manifest_check = false

[ui]
window_title = "Clio Coder: {workspace}"
prompt_new_tab_name = false
hide_tab_bar_when_single_tab = true

[theme]
name = "terminal"

${renderHerdrThemeBlock()
	.split("\n")
	.filter((line) => !line.startsWith("#"))
	.join("\n")}`;
}

/** Write the managed config and return its path. */
export function writeWorkspaceConfig(): string {
	const path = join(clioConfigDir(), "workspace", "herdr.toml");
	// Atomic, because a pane host starting while another launcher rewrites this
	// must read the whole file or the previous whole file.
	safeResourceWrite(path, renderWorkspaceConfig(), { mode: 0o644 });
	return path;
}
