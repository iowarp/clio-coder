import { CLIO_APP_KEYBINDINGS } from "../../domains/config/keybindings.js";
import { getKeybindings, visibleWidth } from "../../engine/tui.js";
import { formatKeyLabel } from "../keybinding-manager.js";

const HINT_SEPARATOR = " · ";

/**
 * Who answers the keyboard, and what Enter means to it. `surface` is a card, an
 * interview, an overlay or an open suggestion list: its own legend is on the rail
 * above the footer, so the row names no composer binding at all (F03).
 */
export type ComposerKeyContext = "surface" | "send" | "steer" | "hold" | "shell";

/** Bindings with nothing to act on while no run or queue exists. */
const NEEDS_LIVE_RUN: ReadonlySet<string> = new Set([
	"clio-coder.message.interrupt",
	"clio-coder.message.dequeue",
	"clio-coder.queue.open",
	"clio-coder.dispatch.background",
]);

/** What is worth learning while a run holds the composer: the ways to reach or inspect that run. */
const RUN_BINDINGS: ReadonlyArray<keyof typeof CLIO_APP_KEYBINDINGS> = [
	"clio-coder.message.interrupt",
	"clio-coder.queue.open",
	"clio-coder.status.toggle",
	"clio-coder.dispatchBoard.toggle",
];

/** The name before its aside: `Send now: interrupt the run…` reads `Send now`. Help keeps the sentence. */
function shortDescription(description: string): string {
	return description.split(/:\s| \(| with /u)[0] ?? description;
}

function boundKeys(id: string): string {
	const keys = getKeybindings().getKeys(id as keyof typeof CLIO_APP_KEYBINDINGS);
	return keys.map((key) => formatKeyLabel(key)).join("/");
}

function firstKey(id: "tui.input.submit" | "tui.input.newLine" | "tui.select.cancel"): string | null {
	const key = getKeybindings().getKeys(id)[0];
	if (!key) return null;
	return key === "escape" ? "Esc" : formatKeyLabel(key);
}

function catalogEntry(id: keyof typeof CLIO_APP_KEYBINDINGS): string | null {
	const keys = boundKeys(id);
	return keys ? `${keys} ${shortDescription(CLIO_APP_KEYBINDINGS[id].description)}` : null;
}

function catalogEntries(ids: ReadonlyArray<keyof typeof CLIO_APP_KEYBINDINGS>): string[] {
	return ids.flatMap((id) => catalogEntry(id) ?? []);
}

/** Every composer binding that has something to act on without a live run. */
function idleBindings(): Array<keyof typeof CLIO_APP_KEYBINDINGS> {
	return (Object.keys(CLIO_APP_KEYBINDINGS) as Array<keyof typeof CLIO_APP_KEYBINDINGS>).filter(
		(id) => CLIO_APP_KEYBINDINGS[id].scope === "composer" && !NEEDS_LIVE_RUN.has(id),
	);
}

/** The keys that answer this moment. They hold still; only the learning beside them rotates. */
function immediateEntries(context: ComposerKeyContext): string[] {
	const submit = firstKey("tui.input.submit");
	const cancel = firstKey("tui.select.cancel");
	if (context === "steer")
		return [submit ? `${submit} steers` : "", cancel ? `${cancel} stops the run` : ""].filter(Boolean);
	if (context === "hold")
		return [submit ? `${submit} holds your message` : "", cancel ? `${cancel} stops` : ""].filter(Boolean);
	if (context === "shell") return cancel ? [`${cancel} stops the command`] : [];
	return [];
}

/**
 * Small rotating slices of the actual binding catalog; never invent an unbound shortcut.
 * Each page holds whole hints that fit `width`, so a narrow row drops trailing hints and
 * the dropped one leads the next page instead of ending a line cut mid-phrase. A hint
 * wider than the row on its own is never shown.
 */
export function footerKeyHint(
	now: number,
	narrow = false,
	width = Number.POSITIVE_INFINITY,
	context: ComposerKeyContext = "send",
): string | null {
	if (context === "surface") return null;
	const submit = firstKey("tui.input.submit");
	const newline = firstKey("tui.input.newLine");
	const fixed = immediateEntries(context);
	const entries =
		context === "send"
			? [
					...(submit ? [`${submit} send`] : []),
					...(newline ? [`${newline} newline`] : []),
					...catalogEntries(idleBindings()),
				]
			: catalogEntries(RUN_BINDINGS);
	const count = narrow ? 1 : 2;
	const pinned = fitWhole(fixed, width);
	if (pinned.length > 0) {
		const lead = pinned.join(HINT_SEPARATOR);
		const room = width - visibleWidth(lead) - visibleWidth(HINT_SEPARATOR);
		const extras = narrow ? [] : entries.filter((entry) => visibleWidth(entry) <= room);
		const extra = extras.length > 0 ? extras[Math.floor(now / 12_000) % extras.length] : undefined;
		return extra ? `${lead}${HINT_SEPARATOR}${extra}` : lead;
	}
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

/** The leading entries that fit whole. */
function fitWhole(entries: readonly string[], width: number): string[] {
	const kept: string[] = [];
	for (const entry of entries) {
		if (visibleWidth([...kept, entry].join(HINT_SEPARATOR)) > width) break;
		kept.push(entry);
	}
	return kept;
}
