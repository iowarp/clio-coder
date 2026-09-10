import { type Component, type OverlayHandle, type TUI, truncateToWidth } from "../engine/tui.js";
import type { LeaderKeyState, LeaderTarget } from "./leader-key.js";
import { showClioOverlayFrame } from "./overlay-frame.js";
import { clioTheme } from "./theme/index.js";

/** Noncapturing presentation: controller retains the underlying cancellation owner. */
export function createLeaderMenu(tui: TUI, scope: () => string, keyLabel: (id: LeaderTarget["id"]) => string) {
	let handle: OverlayHandle | null = null;
	let state: LeaderKeyState = { status: "idle" };
	let targets: ReadonlyArray<LeaderTarget> = [];
	const component: Component = {
		render(width) {
			if (state.status === "idle") return [];
			const selected = state.selected;
			const count = Math.max(1, Math.min(10, tui.terminal.rows - 8));
			const start = Math.max(0, Math.min(selected - Math.floor(count / 2), targets.length - count));
			return [
				`${scope()} · letters select actions · close, then /help for commands`,
				...targets.slice(start, start + count).map((entry, index) => {
					const text = `${start + index === selected ? "›" : " "} ${entry.key || "·"}  ${entry.label ?? entry.id}  ${keyLabel(entry.id)}${entry.disabledReason ? ` (${entry.disabledReason})` : ""}`;
					return truncateToWidth(start + index === selected ? clioTheme().fg("accent", text) : text, width);
				}),
				`${targets.length ? `${selected + 1}/${targets.length}` : "No actions in this scope"} · ${state.notice ?? "Up/Down select · Enter run · Esc close · Ctrl+C cancel"}`,
			].map((line) => truncateToWidth(line, width));
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
				footerHint: () => `${keyLabel("clio-coder.leader")} or Esc closes this menu`,
			});
		tui.requestRender();
	};
}
