/**
 * cwd-fallback overlay (Phase 12 slice 12d).
 *
 * Two-choice overlay shown after `session.resume(...)` when the recorded
 * cwd no longer exists on disk (see src/domains/session/cwd-fallback.ts).
 * Continue uses the terminal's current cwd; Cancel returns the user to
 * whatever session was current before the resume and closes the overlay.
 *
 * The overlay is intentionally simple: a SelectList with two rows whose
 * descriptions carry the context (session cwd, reason). Rich header text
 * and fancy styling are out of scope for 12d.
 */

import {
	Box,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
} from "../../engine/tui.js";
import { showClioOverlayFrame } from "../overlay-frame.js";

export const CWD_FALLBACK_OVERLAY_WIDTH = 88;

const IDENTITY = (s: string): string => s;

const CWD_FALLBACK_THEME: SelectListTheme = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

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

function reasonPhrase(reason: CwdFallbackReason, sessionCwd: string): string {
	if (reason === "no-cwd") return "session has no recorded cwd";
	if (reason === "missing") return `session cwd ${sessionCwd} is missing`;
	return `session cwd ${sessionCwd} is not a directory`;
}

/**
 * Pure builder. Exposed so tests can assert row shape without booting the TUI.
 * Two rows: Continue (uses process cwd) and Cancel (returns to picker).
 */
export function buildCwdFallbackItems(args: {
	currentCwd: string;
	sessionCwd: string;
	reason: CwdFallbackReason;
}): SelectItem[] {
	const why = reasonPhrase(args.reason, args.sessionCwd);
	return [
		{
			value: "continue",
			label: `Continue in ${args.currentCwd}`,
			description: `${why}; use this terminal's cwd instead`,
		},
		{
			value: "cancel",
			label: "Cancel",
			description: "close this overlay and return to the session picker",
		},
	];
}

class CwdFallbackOverlayBox extends Box {
	constructor(private readonly list: SelectList) {
		super(1, 0);
	}
	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export function openCwdFallbackOverlay(tui: TUI, deps: OpenCwdFallbackOverlayDeps): OverlayHandle {
	const items = buildCwdFallbackItems({
		currentCwd: deps.currentCwd,
		sessionCwd: deps.sessionCwd,
		reason: deps.reason,
	});
	const list = new SelectList(items, items.length, CWD_FALLBACK_THEME);
	list.onSelect = (item: SelectItem): void => {
		if (item.value === "continue") {
			deps.onContinue();
		} else {
			deps.onCancel();
		}
		deps.onClose();
	};
	list.onCancel = (): void => {
		deps.onCancel();
		deps.onClose();
	};
	const box = new CwdFallbackOverlayBox(list);
	box.addChild(list);
	return showClioOverlayFrame(tui, box, { anchor: "center", width: CWD_FALLBACK_OVERLAY_WIDTH, title: "Session cwd" });
}
