import { type Component, type OverlayHandle, type TUI, truncateToWidth } from "../engine/tui.js";
import { dockBodyRows } from "./dock.js";
import type { LeaderKeyState, LeaderTarget } from "./leader-key.js";
import {
	buildResponsiveHint,
	centeredWindow,
	selectionLabel,
	selectionMark,
	showClioOverlayFrame,
} from "./overlay-frame.js";
import { clioTheme, GLYPH } from "./theme/index.js";

/** Noncapturing presentation: controller retains the underlying cancellation owner. */
export function createLeaderMenu(tui: TUI, scope: () => string, keyLabel: (id: LeaderTarget["id"]) => string) {
	let handle: OverlayHandle | null = null;
	let state: LeaderKeyState = { status: "idle" };
	let targets: ReadonlyArray<LeaderTarget> = [];
	const component: Component = {
		render(width) {
			if (state.status === "idle") return [];
			const selected = state.selected;
			const count = Math.max(1, Math.min(10, dockBodyRows(tui) - 2));
			const [start, end] = centeredWindow(targets.length, selected, count);
			const theme = clioTheme();
			return [
				`${scope()} · letters select actions · close, then /help for commands`,
				...targets.slice(start, end).map((entry, index) => {
					const focused = start + index === selected;
					const label = entry.label ?? entry.id;
					const reason = entry.disabledReason ? theme.fg("dim", ` (${entry.disabledReason})`) : "";
					// The selection rule: cursor and label in accent, nothing else recolored.
					// An unbound key is a blank, because `·` is the internal-run mark in a
					// board's first column and this is a first column.
					const mark = selectionMark(focused);
					const name = selectionLabel(focused, label);
					return `${mark} ${entry.key || " "}  ${name}  ${theme.fg("dim", keyLabel(entry.id))}${reason}`;
				}),
				`${targets.length ? `${selected + 1}/${targets.length}` : "No actions in this scope"}${state.notice ? ` · ${state.notice}` : ""}`,
			].map((line) => truncateToWidth(line, width, GLYPH.ellipsis));
		},
		invalidate() {},
	};
	return (next: LeaderKeyState, entries: ReadonlyArray<LeaderTarget>): void => {
		state = next;
		targets = entries;
		if (state.status === "idle") {
			handle?.hide();
			handle = null;
		} else if (!handle)
			handle = showClioOverlayFrame(tui, component, {
				title: "Actions",
				markerId: "keyboard-actions",
				anchor: "top-center",
				width: 88,
				nonCapturing: true,
				footerHint: buildResponsiveHint(
					[
						{ key: "↑↓", verb: "select" },
						{ key: "Enter", verb: "run" },
						{ key: "Ctrl+C", verb: "cancel" },
						{ key: `${keyLabel("clio-coder.leader")}/Esc`, verb: "close", critical: true },
					],
					null,
				),
			});
		tui.requestRender();
	};
}
