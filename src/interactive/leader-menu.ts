import { tierPolicy } from "../core/presentation-tier.js";
import {
	type Component,
	type Keybinding,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../engine/tui.js";
import { dockGrowthRows } from "./dock.js";
import type { LeaderKeyState, LeaderTarget } from "./leader-key.js";
import {
	buildResponsiveHint,
	centeredWindow,
	selectionLabel,
	selectionMark,
	showClioOverlayFrame,
} from "./overlay-frame.js";
import { clioTheme, GLYPH, padAnsi, positionRow } from "./theme/index.js";

/** Rows the menu shows: every entry when the dock can grow to hold them. */
export function leaderMenuRows(tui: TUI, entries: number): number {
	return Math.max(1, Math.min(entries, dockGrowthRows(tui) - 2));
}

/** Noncapturing presentation: controller retains the underlying cancellation owner. */
export function createLeaderMenu(tui: TUI, scope: () => string, keyLabel: (id: Keybinding) => string) {
	let handle: OverlayHandle | null = null;
	let state: LeaderKeyState = { status: "idle" };
	let targets: ReadonlyArray<LeaderTarget> = [];
	const component: Component = {
		render(width) {
			if (state.status === "idle") return [];
			const selected = state.selected;
			const count = leaderMenuRows(tui, targets.length);
			const [start, end] = centeredWindow(targets.length, selected, count);
			const theme = clioTheme();
			// Compact lists the actions; standard and detailed add how the menu works and each action's aside.
			const described = tierPolicy().listDescriptions === "all";
			// The action, then its direct shortcut at the row's right edge. A row with no shortcut gives the
			// action the whole row, and a row too narrow for both drops the shortcut before it cuts the
			// action, because the letter already runs the action from here.
			const bindings = targets.map((entry) => (entry.id === undefined ? "" : keyLabel(entry.id)));
			const bindingWidth = Math.max(0, ...bindings.map((binding) => visibleWidth(binding)));
			const reasonOf = (entry: LeaderTarget): string =>
				entry.disabledReason ? ` (${entry.disabledReason.charAt(0).toLowerCase()}${entry.disabledReason.slice(1)})` : "";
			// A trailing aside (`(twice quickly closes)`) is the row's description; a disabled reason is its state.
			const briefOf = (entry: LeaderTarget): string => (entry.label ?? entry.id ?? "").replace(/ \([^()]*\)$/u, "");
			const nameOf = (entry: LeaderTarget): string =>
				described || entry.disabledReason ? (entry.label ?? entry.id ?? "") : briefOf(entry);
			const labelOf = (entry: LeaderTarget): string => `${nameOf(entry)}${reasonOf(entry)}`;
			// Shortcuts sit in one column beside the longest action when the menu is wide enough for that.
			const widest = Math.max(1, ...targets.map((entry) => visibleWidth(labelOf(entry))));
			const aligned = width - 5 >= widest + 2 + bindingWidth ? widest : null;
			const sep = ` ${GLYPH.sep} `;
			const header = !described
				? scope()
				: width >= 66
					? `${scope()}${sep}press a letter to run its action${sep}/help lists commands`
					: width >= 44
						? `${scope()}${sep}press a letter to run its action`
						: "Press a letter to run its action";
			const shown = targets.slice(start, end);
			return [
				theme.fg("annotation", header),
				...shown.map((entry, index) => {
					const focused = start + index === selected;
					const whole = nameOf(entry);
					const binding = bindings[start + index] ?? "";
					// A trailing aside gives way before the shortcut does; /help keeps it.
					const brief = briefOf(entry);
					const label =
						!entry.disabledReason &&
						binding.length > 0 &&
						visibleWidth(whole) + 2 + visibleWidth(binding) > width - 5 &&
						brief !== whole
							? brief
							: whole;
					const reason = entry.disabledReason ? theme.fg("annotation", reasonOf(entry)) : "";
					// The selection rule: cursor and label in accent, nothing else recolored.
					// An unbound key is a blank, because `·` is the internal-run mark in a
					// board's first column and this is a first column.
					const mark = selectionMark(focused);
					const room = Math.max(1, width - 5);
					const fullName = `${selectionLabel(focused, label)}${reason}`;
					const fits = binding.length > 0 && visibleWidth(`${label}${reasonOf(entry)}`) + 2 + visibleWidth(binding) <= room;
					if (!fits)
						return `${mark} ${entry.key || " "}  ${truncateToWidth(fullName, room, GLYPH.ellipsis)}`.replace(/ +$/u, "");
					const nameWidth = aligned ?? room - visibleWidth(binding) - 2;
					return `${mark} ${entry.key || " "}  ${padAnsi(fullName, nameWidth)}  ${theme.fg("annotation", binding)}`;
				}),
				`${
					targets.length === 0
						? "No actions in this scope"
						: shown.length < targets.length
							? positionRow(theme, { start: start + 1, end, total: targets.length, unit: "actions" }, width)
							: `${targets.length} ${targets.length === 1 ? "action" : "actions"}`
				}${state.notice ? `${sep}${state.notice}` : ""}`,
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
				adaptiveHeight: true,
				footerHint: buildResponsiveHint(
					[
						{ key: `${GLYPH.up}${GLYPH.down}`, verb: "select", critical: true },
						{ key: "Enter", verb: "run" },
						// Ctrl+C closes it too, as it does every menu; one way out keeps the rail short and unambiguous.
						{ key: `${keyLabel("clio-coder.leader")}/Esc`, verb: "close", critical: true },
					],
					null,
				),
			});
		tui.requestRender();
	};
}
