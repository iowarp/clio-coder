import type { EscapeLayers } from "./escape-layers.js";
import { escapeHintEntry } from "./escape-layers.js";
import type { HintEntry } from "./overlay-frame.js";

/**
 * The key that opens and closes local inspection of a parked mutation. It lives
 * here rather than beside the preview builder so the composer rail can name it
 * without pulling the diff machinery into the Stage 0 boot shell closure.
 */
export const MUTATION_PREVIEW_KEY = "alt+v";

/**
 * Whether this card has a mutation to read, and whether it is open.
 * `none` covers every ask with nothing local to inspect, including a worker
 * escalation, whose arguments never leave the worker.
 */
export type PermissionInspectionHint = "none" | "closed" | "open";

/** The key that folds and unfolds the standing approval terms on the card. */
export const PERMISSION_TERMS_KEY = "alt+t";

/** Alt+S belongs to send-now; this chord is free in the default keybinding registry. */
export const PERMISSION_STOP_KEY = "alt+x";

/** Whether the terms are open. The composer rail never shows this key, so it defaults closed there. */
export type PermissionTermsHint = "closed" | "open";

/**
 * The keys that answer a parked call, as data, so the dialog footer and the
 * composer rail render the same policy at any width.
 *
 * This is its own leaf because the composer is part of the Stage 0 boot shell
 * and the permission overlay is not: importing the overlay from the editor
 * pulled the safety domain's approval modules into the instant-shell closure.
 *
 * At 40 columns the old positional elider removed `[Alt+X] stop turn` and left
 * "allow once" and an ambiguous "close" in front of an operator trying to
 * refuse. The key kept working, so the layout was hiding a live safety action.
 * Allow and stop are marked critical, Esc is marked droppable, and
 * `fitHintEntries` shortens every label before it drops anything.
 *
 * Esc says `deny`, not `close`: the operator explicitly denies the call, and on the
 * one surface where a misread is a wrong decision about a tool call the key
 * names its effect. While the mutation is open Esc hides it instead, and the
 * entry says `hide details`, so backing out of the view never answers the call.
 *
 * With a draft in the composer, Enter is inert (issue #186): the habitual send
 * key must not resolve toward "allow" on a safety rail. The entry then says so
 * and names the key that clears the draft, which the router passes through.
 *
 * A parked `write` or `edit` adds the inspect key (issue #254). It is
 * droppable, and deliberately so: at 40 columns the four entries do not fit,
 * and the three keys that answer the call outrank the one that reads it. The
 * key keeps working at every width; the `/help` Autonomy & safety net topic is
 * where it is documented for the widths that cannot show it.
 */
export function permissionHintEntries(
	composerHasDraft = false,
	inspection: PermissionInspectionHint = "none",
	terms?: PermissionTermsHint,
	scrollable = false,
	stopVerb = "stop turn",
): HintEntry[] {
	return [
		composerHasDraft
			? { key: "Backspace", verb: "clear the draft to allow", short: "clear draft", critical: true }
			: { key: "Enter", verb: "allow", short: "allow", critical: true },
		// The terms key is the card's own and the most droppable entry: the folded
		// card already states what the keys do in one row. It sits before the
		// inspect key so the narrowing drops it first.
		// The terms key is inert while the mutation is open, so the rail does not offer it then.
		// Open, the terms close on Esc as well, and the Esc entry below already says so.
		...(terms === undefined || terms === "open" || inspection === "open"
			? []
			: [{ key: PERMISSION_TERMS_KEY, verb: "terms", short: "terms", critical: false }]),
		// A card taller than its rows scrolls (BT-005). The open mutation names the
		// same keys itself below.
		...(scrollable && inspection !== "open" ? [{ key: "↑↓", verb: "scroll", critical: false }] : []),
		...(inspection === "none"
			? []
			: inspection === "open"
				? [{ key: "↑↓", verb: "scroll", critical: false }]
				: [{ key: MUTATION_PREVIEW_KEY, verb: "inspect details", short: "inspect", critical: false }]),
		{ key: PERMISSION_STOP_KEY, verb: stopVerb, short: "stop", critical: true },
		// With a draft, deny and stop are the only immediate answers, so Esc
		// outranks the narrowing that would otherwise drop it first. With a view
		// open, Esc closes it and the rail says so; deny is one more Esc.
		escapeHintEntry(
			permissionEscapeLayers(inspection, terms ?? "closed", NO_ACTIONS),
			// An open view names its own way out in its rule, so on a narrow rail the answer keys outrank it.
			inspection === "open" || terms === "open" ? false : composerHasDraft,
		) ?? { key: "Esc", verb: "deny" },
	];
}

/** What the card's Esc backs out of, in the order it does: details, then terms, then the call itself. */
export interface PermissionEscapeActions {
	hideDetails(): void;
	hideTerms(): void;
	deny(): void;
}

const NO_ACTIONS: PermissionEscapeActions = { hideDetails: () => {}, hideTerms: () => {}, deny: () => {} };

/**
 * The card's layers for the shared Esc rule. Reading the change or the terms is
 * not an answer, so Esc closes those views first and the card is as it was; only
 * from the card itself does Esc deny, and every surface that names the key reads
 * its word from here: the rail, the choice rows and the held-timer line.
 */
export function permissionEscapeLayers(
	inspection: PermissionInspectionHint,
	terms: PermissionTermsHint,
	actions: PermissionEscapeActions,
): EscapeLayers {
	return [
		inspection === "open" && { verb: "hide details", short: "hide", back: actions.hideDetails },
		terms === "open" && { verb: "hide terms", back: actions.hideTerms },
		{ verb: "deny", back: actions.deny },
	];
}
