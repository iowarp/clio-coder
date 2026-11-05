import {
	type Component,
	type Keybinding,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../engine/tui.js";
import { dockBodyRows } from "./dock.js";
import type { LeaderKeyState, LeaderTarget } from "./leader-key.js";
import {
	buildResponsiveHint,
	centeredWindow,
	selectionLabel,
	selectionMark,
	showClioOverlayFrame,
} from "./overlay-frame.js";
import { clioTheme, GLYPH, padAnsi } from "./theme/index.js";

/** Noncapturing presentation: controller retains the underlying cancellation owner. */
export function createLeaderMenu(tui: TUI, scope: () => string, keyLabel: (id: Keybinding) => string) {
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
			// Two columns: the action, then its direct shortcut aligned beside the
			// longest action. A narrow menu drops the shortcut column, because the
			// letter already runs the action from here.
			const bindings = targets.map((entry) => (entry.id === undefined ? "" : keyLabel(entry.id)));
			const bindingWidth = Math.max(0, ...bindings.map((binding) => visibleWidth(binding)));
			const showBindings = bindingWidth > 0 && width >= 56;
			const labelOf = (entry: LeaderTarget): string =>
				`${entry.label ?? entry.id ?? ""}${entry.disabledReason ? ` (${entry.disabledReason})` : ""}`;
			const labelRoom = Math.max(1, width - 5 - (showBindings ? bindingWidth + 2 : 0));
			const labelWidth = Math.min(labelRoom, Math.max(1, ...targets.map((entry) => visibleWidth(labelOf(entry)))));
			const header =
				width >= 66
					? `${scope()} · letters select actions · close, then /help for commands`
					: width >= 44
						? `${scope()} · letters select actions`
						: "Letters select actions";
			return [
				theme.fg("annotation", header),
				...targets.slice(start, end).map((entry, index) => {
					const focused = start + index === selected;
					const label = entry.label ?? entry.id ?? "";
					const reason = entry.disabledReason ? theme.fg("annotation", ` (${entry.disabledReason})`) : "";
					// The selection rule: cursor and label in accent, nothing else recolored.
					// An unbound key is a blank, because `·` is the internal-run mark in a
					// board's first column and this is a first column.
					const mark = selectionMark(focused);
					const name = padAnsi(
						truncateToWidth(`${selectionLabel(focused, label)}${reason}`, labelWidth, GLYPH.ellipsis),
						labelWidth,
					);
					const binding = showBindings ? `  ${theme.fg("annotation", bindings[start + index] ?? "")}` : "";
					return `${mark} ${entry.key || " "}  ${name}${binding}`.replace(/ +$/u, "");
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
