/**
 * Unattended resolution of attended waits (#407, #419, #421). An operator who
 * starts a long job and walks away used to come back to a session parked on an
 * approval card or an ask_user question. After `safety.unattendedAfterSeconds`
 * with no keystroke, at any autonomy level, Clio answers the wait itself and the turn continues: a
 * parked call is denied, never approved, and an unanswered question takes its
 * recommended option. Every such answer is recorded so the operator can see
 * what Clio decided while they were away.
 */

/** `decidedBy` on the `PermissionResolved` event of a card nobody answered in time. */
export const UNATTENDED_DECIDED_BY = "unattended";

/** The countdown window in milliseconds; 0 means wait for the operator forever. */
export function unattendedWindowMs(seconds: number | undefined): number {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return 0;
	return Math.floor(seconds) * 1000;
}

/** At yolo a question never waits forever: a 0 window reads as this, the shipped default (#421). */
export const YOLO_ASK_WINDOW_FLOOR_SECONDS = 300;
/** Once a window lapsed with no key pressed since, later questions wait at most this long. */
export const AWAY_ASK_WINDOW_MS = 30_000;

/**
 * How long an ask_user round waits for the operator before Clio answers it.
 * Yolo asks like default does, but keeps the window bounded so a long run
 * never parks on a question; an operator observed away (a window lapsed and
 * no key since) gets a short window until they type again.
 */
export function askUserWindowMs(seconds: number | undefined, context: { yolo: boolean; away: boolean }): number {
	let ms = unattendedWindowMs(seconds);
	if (ms === 0 && context.yolo) ms = YOLO_ASK_WINDOW_FLOOR_SECONDS * 1000;
	return ms > 0 && context.away ? Math.min(ms, AWAY_ASK_WINDOW_MS) : ms;
}

/**
 * What the model reads for a parked call the operator did not answer. It goes
 * back to the model as an ordinary denial, so the turn continues: unlike the
 * operator's Stop it ends nothing, and unlike an operator's Deny there is nobody
 * to ask what to do instead.
 */
export function unattendedPermissionReason(tool: string, seconds: number): string {
	return [
		`The operator did not answer this ${tool} approval within ${seconds} s, so Clio denied it automatically; the call did not run.`,
		"Nobody is at the terminal to approve it: do not wait or ask again. Take another route that needs no approval, or record this open decision for your final reply and continue with the rest of the task.",
	].join("\n");
}

/** The denial account's remedy for an unattended refusal (`ToolDenial.allowedBy`). */
export const UNATTENDED_ALLOWED_BY =
	"an operator at the terminal must approve it, and nobody answered in time; continue without it and name it as an open decision in your final reply.";
