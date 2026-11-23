import { GLYPH } from "../../core/glyphs.js";
import { motionEnabled } from "../../core/terminal-preferences.js";

/** The chrome glyph table lives in core so the pane process shares it; the TUI keeps the spinner. */
export { GLYPH };

export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

/** Shared presentation snapshot cadence. Most progress marks remain static. */
export const ANIMATION_STEP_MS = 120;
/** How often the one live-activity spinner steps. */
export const ACTIVITY_STEP_MS = 480;

export function animationStep(nowMs: number): number {
	return Math.floor(nowMs / ANIMATION_STEP_MS);
}

/** A steady mark unless the caller animates it; motion stays off when the terminal or the operator asks for none. */
export function spinnerFrame(tick: number, animate = false): string {
	if (!animate || !motionEnabled()) return GLYPH.running;
	const index = ((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}

/**
 * The lead of a rail whose model, tool or harness work is live. Motion says the work is moving, so it never marks a
 * wait on the operator: nothing moves there until they act, and that rail shows {@link GLYPH.phaseBlocked} instead.
 */
export function activityCue(nowMs: number, animate = true): string {
	return spinnerFrame(Math.floor(nowMs / ACTIVITY_STEP_MS), animate);
}
