/**
 * cwd-fallback overlay (Phase 12 slice 12d).
 *
 * Two-choice overlay shown after `session.resume(...)` when the recorded
 * cwd no longer exists on disk (see src/domains/session/cwd-fallback.ts).
 * Continue uses the terminal's current cwd; Cancel returns the user to
 * whatever session was current before the resume and closes the overlay.
 *
 * The overlay stays intentionally small: a SelectList owns behavior while the
 * rendered rows follow the shared dialog grammar.
 */

import {
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../../engine/tui.js";
import { buildHint, DEFAULT_SELECT_THEME, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme } from "../theme/index.js";

export const CWD_FALLBACK_OVERLAY_WIDTH = 88;
const ELLIPSIS = "…";

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

function singleLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ").trim();
}

function buildSelectPresentation(items: ReadonlyArray<SelectItem>): {
	items: SelectItem[];
	layout: SelectListLayoutOptions;
} {
	const descriptions = new Map(items.map((item) => [item.value, singleLine(item.description ?? "")]));
	return {
		items: items.map((item) => ({ value: item.value, label: item.label })),
		layout: {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 38,
			truncatePrimary: ({ text, maxWidth, item, isSelected }) => {
				const label = singleLine(text);
				const description = descriptions.get(item.value) ?? "";
				if (description.length === 0 || maxWidth < 32) {
					return truncateToWidth(label, maxWidth, ELLIPSIS, true);
				}

				const theme = clioTheme();
				const preferredLabelWidth = Math.max(24, Math.min(38, visibleWidth(label) + 2));
				const labelWidth = Math.max(1, Math.min(preferredLabelWidth, maxWidth - 12));
				const fittedLabel = truncateToWidth(label, labelWidth, ELLIPSIS, true);
				const spacing = " ".repeat(Math.max(1, labelWidth + 2 - visibleWidth(fittedLabel)));
				const descWidth = Math.max(1, maxWidth - visibleWidth(fittedLabel) - visibleWidth(spacing));
				const fittedDescription = truncateToWidth(description, descWidth, ELLIPSIS, true);
				const body = `${fittedLabel}${spacing}${fittedDescription}`;
				return isSelected ? body : `${fittedLabel}${theme.fg("muted", `${spacing}${fittedDescription}`)}`;
			},
		},
	};
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

export function openCwdFallbackOverlay(tui: TUI, deps: OpenCwdFallbackOverlayDeps): OverlayHandle {
	const items = buildCwdFallbackItems({
		currentCwd: deps.currentCwd,
		sessionCwd: deps.sessionCwd,
		reason: deps.reason,
	});
	const presentation = buildSelectPresentation(items);
	const list = new SelectList(presentation.items, items.length, DEFAULT_SELECT_THEME, presentation.layout);
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
	const box = new FocusBox(list);
	return showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: CWD_FALLBACK_OVERLAY_WIDTH,
		title: "Session cwd",
		footerHint: buildHint("commit", [{ key: "Enter", verb: "select" }]),
	});
}
