/**
 * The one line the first interactive launch after an upgrade says.
 *
 * `install.json` is refreshed silently on every boot, so without this the
 * operator who installed 0.3.0 and ran `npm install -g` again would never be
 * told the version moved or that anything at the keyboard changed. This is one
 * sentence per release, for changes an interactive operator meets by typing
 * (a command that now opens elsewhere, a skill that no longer answers), and a
 * pointer to the shipped CHANGELOG for the rest. It is not a release-notes
 * system: a release without a keyboard-facing change gets no entry and the
 * generic line.
 */

import type { UpgradeTransition } from "./state.js";

const KEYBOARD_FACING_CHANGES: Readonly<Record<string, string>> = Object.freeze({
	"0.3.1":
		"/targets, /fleet, and /scoped-models now open inside /settings; " +
		"the commit-crafting, create-pr, investigate-issue, and review-changes skills are retired in favour of file-ticket, fix-issue, and ship; " +
		"artifact defaults write under .clio-coder/artifacts/.",
});

/**
 * Word choice is load-bearing: the footer classifies a plain string by its
 * text, and "changed" is what makes this a sticky, dismissable notice rather
 * than one that fades in twelve seconds while the operator is still reading.
 */
export function describeUpgradeNotice(transition: UpgradeTransition): string {
	const changes = KEYBOARD_FACING_CHANGES[transition.to];
	const head = `clio-coder: upgraded ${transition.from} → ${transition.to}.`;
	const tail = `Full notes: CHANGELOG.md, section ${transition.to}.`;
	return changes === undefined
		? `${head} What changed is in CHANGELOG.md, section ${transition.to}.`
		: `${head} What changed at the keyboard: ${changes} ${tail}`;
}
