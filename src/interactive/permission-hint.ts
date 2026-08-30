import type { HintEntry } from "./overlay-frame.js";

/**
 * The key that opens and closes local inspection of a parked mutation. It lives
 * here rather than beside the preview builder so the composer rail can name it
 * without pulling the diff machinery into the Stage 0 boot shell closure.
 */
export const MUTATION_PREVIEW_KEY = "v";

/**
 * Whether this card has a mutation to read, and whether it is open.
 * `none` covers every ask with nothing local to inspect, including a worker
 * escalation, whose arguments never leave the worker.
 */
export type PermissionInspectionHint = "none" | "closed" | "open";

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
 * names its effect. It keeps that meaning while the mutation is open, so the
 * inspect key is what puts the mutation away again.
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
): HintEntry[] {
	return [
		composerHasDraft
			? { key: "Backspace", verb: "clear the draft to allow", short: "clear draft", critical: true }
			: { key: "Enter", verb: "allow once", short: "allow", critical: true },
		...(inspection === "none"
			? []
			: inspection === "open"
				? [
						{ key: "↑↓", verb: "scroll", critical: false },
						{ key: MUTATION_PREVIEW_KEY, verb: "hide mutation", short: "hide", critical: false },
					]
				: [{ key: MUTATION_PREVIEW_KEY, verb: "inspect mutation", short: "inspect", critical: false }]),
		{ key: "s", verb: "stop turn", short: "stop", critical: true },
		// With a draft, deny and stop are the only immediate answers, so Esc
		// outranks the narrowing that would otherwise drop it first.
		{ key: "Esc", verb: "deny", critical: composerHasDraft },
	];
}
