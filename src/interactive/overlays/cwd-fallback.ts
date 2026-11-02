/**
 * cwd-fallback overlay.
 *
 * Two-choice overlay shown after `session.resume(...)` when the recorded
 * cwd no longer exists on disk (see src/domains/session/cwd-fallback.ts).
 * Continue uses the terminal's current cwd; Cancel returns the user to
 * whatever session was current before the resume and closes the overlay.
 *
 * The facts lead: what the session recorded, why it cannot be used, and
 * where this terminal is. The two choices follow, each with its consequence.
 */

import type { OverlayHandle, TUI } from "../../engine/tui.js";
import { buildHint, createChoiceList, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, collapseHomePath, factRows, statusChip } from "../theme/index.js";

export const CWD_FALLBACK_OVERLAY_WIDTH = 88;
/** Reasons surfaced by resolveSessionCwd. Overlay maps each to a description line. */
export type CwdFallbackReason = "no-cwd" | "missing" | "not-a-directory";

export interface OpenCwdFallbackOverlayDeps {
	/** Absolute path the resumed session recorded in meta.cwd. May be empty when reason="no-cwd". */
	sessionCwd: string;
	/** Absolute path of the terminal's current working directory. */
	currentCwd: string;
	/** Why the session cwd failed to resolve. */
	reason: CwdFallbackReason;
	/** Invoked when the user picks Continue. */
	onContinue: () => void;
	/**
	 * Invoked when the user picks Cancel or presses Esc. The caller should
	 * restore the prior session (if any) or re-open the /resume overlay.
	 */
	onCancel: () => void;
	/** Close the overlay. Always fires before onContinue/onCancel returns. */
	onClose: () => void;
}

function reasonPhrase(reason: CwdFallbackReason): string {
	if (reason === "no-cwd") return "the session recorded no working directory";
	if (reason === "missing") return "the session's working directory no longer exists";
	return "the session's working directory is not a directory";
}

export function openCwdFallbackOverlay(tui: TUI, deps: OpenCwdFallbackOverlayDeps): OverlayHandle {
	const list = createChoiceList({
		items: [
			{
				value: "continue",
				label: "Continue here",
				description: "resume the session in this terminal's directory",
			},
			{ value: "cancel", label: "Cancel", description: "return to the session picker" },
		],
		lead: (width) => {
			const theme = clioTheme();
			return [
				statusChip(theme, "warning", reasonPhrase(deps.reason)),
				...factRows(
					theme,
					[
						...(deps.sessionCwd.length > 0 ? [{ label: "session", value: collapseHomePath(deps.sessionCwd) }] : []),
						{ label: "terminal", value: collapseHomePath(deps.currentCwd) },
					],
					width,
				),
			];
		},
		onSelect: (item) => {
			if (item.value === "continue") deps.onContinue();
			else deps.onCancel();
			deps.onClose();
		},
		onCancel: () => {
			deps.onCancel();
			deps.onClose();
		},
	});
	return showClioOverlayFrame(tui, new FocusBox(list), {
		anchor: "center",
		width: CWD_FALLBACK_OVERLAY_WIDTH,
		markerId: "cwd-fallback",
		title: "Session Working Directory",
		footerHint: buildHint([{ key: "Enter", verb: "select" }]),
	});
}
