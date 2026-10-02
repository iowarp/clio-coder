import { CLIO_APP_KEYBINDINGS } from "../../domains/config/keybindings.js";
import { getKeybindings, visibleWidth } from "../../engine/tui.js";
import { formatKeyLabel } from "../keybinding-manager.js";

const HINT_SEPARATOR = " · ";

/**
 * Small rotating slices of the actual binding catalog; never invent an unbound shortcut.
 * Each page holds whole hints that fit `width`, so a narrow row drops trailing hints and
 * the dropped one leads the next page instead of ending a line cut mid-phrase. A hint
 * wider than the row on its own is never shown.
 */
export function footerKeyHint(now: number, narrow = false, width = Number.POSITIVE_INFINITY): string | null {
	const bindings = getKeybindings();
	const entries = [
		...bindings.getKeys("tui.input.submit").map((key) => `${formatKeyLabel(key)} send`),
		...bindings.getKeys("tui.input.newLine").map((key) => `${formatKeyLabel(key)} newline`),
		...Object.entries(CLIO_APP_KEYBINDINGS).flatMap(([id, spec]) => {
			if (spec.scope !== "composer") return [];
			const keys = bindings.getKeys(id as keyof typeof CLIO_APP_KEYBINDINGS);
			return keys.length ? [`${keys.map((key) => formatKeyLabel(key)).join("/")} ${spec.description}`] : [];
		}),
	];
	const count = narrow ? 1 : 2;
	const pages: string[] = [];
	for (let index = 0; index < entries.length; ) {
		const page: string[] = [];
		while (page.length < count && index < entries.length) {
			const entry = entries[index] as string;
			if (visibleWidth([...page, entry].join(HINT_SEPARATOR)) > width) break;
			page.push(entry);
			index += 1;
		}
		if (page.length === 0) index += 1;
		else pages.push(page.join(HINT_SEPARATOR));
	}
	if (pages.length === 0) return null;
	return pages[Math.floor(now / 12_000) % pages.length] ?? null;
}
