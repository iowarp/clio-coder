/**
 * Tap classification for the dock keys (Alt+E files, Alt+W workers, Alt+A music).
 *
 * The first tap acts at once: it shows a hidden dock and hides a visible one,
 * with no delay waiting to see whether a second tap follows. A second tap on
 * the same key inside the window means "close it for real" and runs the
 * `double` handler. Work for one slot is serialized, so a double tap that lands
 * while the first tap's pane move is still in flight closes the dock after the
 * move settles instead of racing it.
 *
 * A leaf with no imports: the interactive application reaches it without
 * pulling the mux domain into the plain boot chunk.
 */

/** How soon after one tap a second one counts as a double tap. */
export const DOCK_DOUBLE_TAP_MS = 400;

export interface DockKeyHandlers {
	/** A first tap: show a hidden dock, hide a visible one. */
	single: () => Promise<void> | void;
	/** A second tap inside the window: close the dock for real. */
	double: () => Promise<void> | void;
}

export interface DockKeyGate {
	/** Classify this tap and run the matching handler after any earlier work for the slot. */
	press(slot: string, handlers: DockKeyHandlers): Promise<void>;
}

export function createDockKeyGate(options: { now?: () => number; windowMs?: number } = {}): DockKeyGate {
	const now = options.now ?? Date.now;
	const windowMs = options.windowMs ?? DOCK_DOUBLE_TAP_MS;
	const lastTapAt = new Map<string, number>();
	const tails = new Map<string, Promise<void>>();

	return {
		press(slot, handlers): Promise<void> {
			const at = now();
			const previous = lastTapAt.get(slot);
			const isDouble = previous !== undefined && at - previous <= windowMs;
			// A double tap spends both taps, so a third quick tap starts a fresh pair.
			if (isDouble) lastTapAt.delete(slot);
			else lastTapAt.set(slot, at);
			const handler = isDouble ? handlers.double : handlers.single;
			const run = (tails.get(slot) ?? Promise.resolve()).then(async () => {
				try {
					await handler();
				} catch {
					// Handlers report their own failures to the operator; a throw must not
					// wedge the slot's queue for every later tap.
				}
			});
			tails.set(slot, run);
			return run;
		},
	};
}
