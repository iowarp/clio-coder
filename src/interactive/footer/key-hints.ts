import { CLIO_APP_KEYBINDINGS } from "../../domains/config/keybindings.js";
import { getKeybindings, visibleWidth } from "../../engine/tui.js";
import { actionKeyLabel, formatKeyLabel } from "../keybinding-manager.js";
import { GLYPH } from "../theme/glyphs.js";

const HINT_SEPARATOR = ` ${GLYPH.dot} `;

/**
 * Who answers the keyboard, and what Enter does with what the composer holds now.
 * `surface` is a card, an interview, an overlay, an open suggestion list or a draft
 * addressed to a worker: its own legend is on the rail above the footer, so the row
 * names no composer binding at all (F03). The prefixed forms carry the command the
 * draft names, since that is the only true thing to say about its Enter.
 */
export type ComposerKeyContext =
	| "surface"
	| "idle"
	| "recover"
	| "send"
	| "send-shell"
	| "steer"
	| "steer-empty"
	| "hold"
	| "hold-empty"
	| "shell"
	| "shell-refused"
	| "stopping"
	| `command:${string}`
	| `run-command:${string}`
	| `usage:${string}`
	| `check:${string}`;

/** What is true right now that decides whether a learnable key would do anything. */
export interface KeyHintFacts {
	/** Off with interface.demo: the keys that answer this moment stay, the learning goes. */
	learning?: boolean;
	queued?: number;
	workers?: number;
	/**
	 * Whether the workers key opens the workers dock. Without a pane host it
	 * opens the Fleet Runs board instead, and the hint names that.
	 */
	workersDock?: boolean;
	thinkingCycles?: boolean;
	/** True when the operator already uses `feature` (`?` or `key:<action id>`); a learned key leaves the rotation. */
	learned?: (feature: string) => boolean;
}

/** The one shortcut an empty idle composer always offers; the rest are learned one at a time beside it. */
const IDLE_PINNED: keyof typeof CLIO_APP_KEYBINDINGS = "clio-coder.model.select";

/**
 * Nonessential learning, in the order it is worth knowing. Deliberately a short
 * list and not the catalog: exit and suspend are not lessons, and optional panes
 * such as music and files belong to /help because the keys only work when the
 * pane layer and the integration are on.
 */
function idleLearning(facts: KeyHintFacts): Array<keyof typeof CLIO_APP_KEYBINDINGS> {
	return [
		"clio-coder.library.toggle",
		"clio-coder.status.toggle",
		"clio-coder.output.cycle",
		...(facts.thinkingCycles === false ? [] : (["clio-coder.thinking.cycle"] as const)),
		"clio-coder.leader",
	];
}

/** The ways to reach or inspect a run, each offered only when it has something to act on. */
function runLearning(context: ComposerKeyContext, facts: KeyHintFacts): Array<keyof typeof CLIO_APP_KEYBINDINGS> {
	const queued = facts.queued === undefined || facts.queued > 0;
	const workers = facts.workers === undefined || facts.workers > 0;
	return [
		...(context === "steer" || queued ? (["clio-coder.message.interrupt"] as const) : []),
		...(queued ? (["clio-coder.queue.open"] as const) : []),
		"clio-coder.status.toggle",
		...(workers ? (["clio-coder.dispatchBoard.toggle"] as const) : []),
	];
}

function boundKeys(id: keyof typeof CLIO_APP_KEYBINDINGS): string {
	return actionKeyLabel(id) ?? "";
}

function firstKey(id: "tui.input.submit" | "tui.input.newLine" | "tui.select.cancel"): string | null {
	const key = getKeybindings().getKeys(id)[0];
	if (!key) return null;
	return key === "escape" ? "Esc" : formatKeyLabel(key);
}

function catalogEntry(id: keyof typeof CLIO_APP_KEYBINDINGS): string | null {
	const keys = boundKeys(id);
	return keys ? `${keys} ${CLIO_APP_KEYBINDINGS[id].label}` : null;
}

function catalogEntries(ids: ReadonlyArray<keyof typeof CLIO_APP_KEYBINDINGS>, facts: KeyHintFacts = {}): string[] {
	return ids.flatMap((id) => {
		if (id === "clio-coder.dispatchBoard.toggle" && facts.workersDock === false) {
			const keys = boundKeys(id);
			return keys ? [`${keys} Fleet runs`] : [];
		}
		return catalogEntry(id) ?? [];
	});
}

/** The keys that answer this moment. They hold still; only the learning beside them changes. */
function immediateEntries(context: ComposerKeyContext): string[] {
	const submit = firstKey("tui.input.submit");
	const cancel = firstKey("tui.select.cancel");
	const newline = firstKey("tui.input.newLine");
	const enter = (what: string): string[] => (submit ? [`${submit} ${what}`] : []);
	const esc = (what: string): string[] => (cancel ? [`${cancel} ${what}`] : []);
	const colon = context.indexOf(":");
	if (colon > 0) {
		const name = context.slice(colon + 1);
		if (context.startsWith("command:")) return enter(`runs ${name}`);
		if (context.startsWith("run-command:")) return [...enter(`runs ${name}`), ...esc("stops the run")];
		if (context.startsWith("usage:")) return enter(`shows what ${name} needs`);
		return enter(`checks ${name}`);
	}
	switch (context) {
		case "idle":
			return catalogEntries([IDLE_PINNED]);
		case "recover":
			// After a failed turn the two ways forward are the receipt's and the rail's, so the row states them too (N1).
			return ["↑ recalls your prompt", ...catalogEntries([IDLE_PINNED])];
		case "send":
			return [...enter("sends"), ...(newline ? [`${newline} newline`] : [])];
		case "send-shell":
			return enter("runs this shell command");
		case "steer":
			return [...enter("steers"), ...esc("stops the run")];
		case "steer-empty":
			return ["Type to steer", ...esc("stops the run")];
		case "hold":
			return [...enter("holds your message"), ...esc("stops")];
		case "hold-empty":
			return esc("stops");
		case "shell":
			return esc("stops the command");
		case "shell-refused":
			return esc("stops what is running, then Enter runs this");
		case "stopping":
			// Esc already went in; offering it again read as if the first press had not landed (HS18).
			return ["Stop sent, waiting for it to exit"];
		default:
			return [];
	}
}

function learningEntries(context: ComposerKeyContext, facts: KeyHintFacts): string[] {
	if (facts.learning === false) return [];
	const learned = facts.learned ?? (() => false);
	const unlearned = (ids: ReadonlyArray<keyof typeof CLIO_APP_KEYBINDINGS>) => ids.filter((id) => !learned(`key:${id}`));
	if (context === "idle") {
		const newline = firstKey("tui.input.newLine");
		return [
			...(learned("?") ? [] : ["? Keys"]),
			...(newline ? [`${newline} newline`] : []),
			...catalogEntries(unlearned(idleLearning(facts))),
		];
	}
	if (context === "steer" || context === "steer-empty")
		return catalogEntries(unlearned(runLearning(context, facts)), facts);
	return [];
}

/**
 * The hint row's policy. The keys that answer this moment are pinned and describe
 * what the composer holds now. While the composer is empty one learning hint may
 * sit beside them, changing only when its key is learned. A draft silences the learning, because
 * the operator is typing and the row is about their Enter. A key whose target does
 * not exist right now is never offered, and a hint wider than the row is never cut.
 */
export function footerKeyHint(
	_now: number,
	narrow = false,
	width = Number.POSITIVE_INFINITY,
	context: ComposerKeyContext = "send",
	facts: KeyHintFacts = {},
): string | null {
	if (context === "surface") return null;
	// Sending is the composer's plain meaning, so with guidance off it needs no reminding. Everything else is a surprise worth stating.
	if (facts.learning === false && (context === "idle" || context === "send")) return null;
	const pinned = fitWhole(immediateEntries(context), width);
	const lead = pinned.join(HINT_SEPARATOR);
	const room = pinned.length > 0 ? width - visibleWidth(lead) - visibleWidth(HINT_SEPARATOR) : width;
	const extras =
		narrow && pinned.length > 0 ? [] : learningEntries(context, facts).filter((entry) => visibleWidth(entry) <= room);
	// The first unlearned key holds until the operator uses it, so the row moves only when they learn something.
	const extra = extras[0];
	if (pinned.length === 0) return extra ?? null;
	return extra ? `${lead}${HINT_SEPARATOR}${extra}` : lead;
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
