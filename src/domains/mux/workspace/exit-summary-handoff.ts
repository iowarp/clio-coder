/**
 * The clean-exit summary a hosted Clio hands to its launcher.
 *
 * A Clio in its private pane host prints its exit summary inside the pane,
 * and the launcher closes that pane's workspace as soon as Clio quits, so the
 * summary and its `/resume <id>` line would vanish with it. The interactive
 * shutdown holds the text here, and the exit marker (exit-marker.ts) carries
 * it to the launcher, which prints it in the operator's own terminal once the
 * host is gone. Nothing is imported, so the interactive session can hold the
 * text without loading any hosting code.
 */

let held: string | null = null;

export function holdExitSummaryForLauncher(text: string): void {
	held = text;
}

export function heldExitSummary(): string | null {
	return held;
}
