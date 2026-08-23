import type { HintEntry } from "./overlay-frame.js";

/**
 * The keys that answer a parked call, as data, so the dialog footer and the
 * composer rail render the same policy at any width.
 *
 * This is its own leaf because the composer is part of the Stage 0 boot shell
 * and the permission overlay is not: importing the overlay from the editor
 * pulled the safety domain's approval modules into the instant-shell closure.
 *
 * At 40 columns the old positional elider removed `[s] stop turn` and left
 * "allow once" and an ambiguous "close" in front of an operator trying to
 * refuse. The key kept working, so the layout was hiding a live safety action.
 * Allow and stop are marked critical, Esc is marked droppable, and
 * `fitHintEntries` shortens every label before it drops anything.
 *
 * Esc says `deny`, not `close`: closing the dialog denies the call, and on the
 * one surface where a misread is a wrong decision about a tool call the key
 * names its effect.
 *
 * With a draft in the composer, Enter is inert (issue #186): the habitual send
 * key must not resolve toward "allow" on a safety rail. The entry then says so
 * and names the key that clears the draft, which the router passes through.
 */
export function permissionHintEntries(composerHasDraft = false): HintEntry[] {
	return [
		composerHasDraft
			? { key: "Backspace", verb: "clear the draft to allow", short: "clear draft", critical: true }
			: { key: "Enter", verb: "allow once", short: "allow", critical: true },
		{ key: "s", verb: "stop turn", short: "stop", critical: true },
		// With a draft, deny and stop are the only immediate answers, so Esc
		// outranks the narrowing that would otherwise drop it first.
		{ key: "Esc", verb: "deny", critical: composerHasDraft },
	];
}
