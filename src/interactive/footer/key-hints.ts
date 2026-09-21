import { CLIO_APP_KEYBINDINGS } from "../../domains/config/keybindings.js";
import { getKeybindings } from "../../engine/tui.js";

/** Small rotating slices of the actual binding catalog; never invent an unbound shortcut. */
export function footerKeyHint(now: number, narrow = false): string | null {
	const bindings = getKeybindings();
	const entries = [
		...bindings.getKeys("tui.input.submit").map((key) => `${key} send`),
		...bindings.getKeys("tui.input.newLine").map((key) => `${key} newline`),
		...Object.entries(CLIO_APP_KEYBINDINGS).flatMap(([id, spec]) => {
			if (spec.scope !== "composer") return [];
			const keys = bindings.getKeys(id as keyof typeof CLIO_APP_KEYBINDINGS);
			return keys.length ? [`${keys.join("/")} ${spec.description}`] : [];
		}),
	];
	const count = narrow ? 1 : 2;
	if (!entries.length) return null;
	const page = Math.floor(now / 12_000) % Math.ceil(entries.length / count);
	const start = page * count;
	return entries.slice(start, start + count).join(" · ");
}
