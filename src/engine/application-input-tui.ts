/**
 * Application-first keyboard ownership for Pi's two concrete renderers.
 *
 * Pi hands terminal input to its listener set in registration order, and
 * TuiAltScreen registers its viewport shortcuts (search, paging, scrolling)
 * from inside its own constructor. A listener added afterwards never sees a key
 * the viewport binds. These subclasses register one gate through the public
 * `addInputListener` before anything else on the instance, so the application
 * policy decides first and the viewport and focused widget only see what it
 * lets through.
 */

import type { TUI, TuiInputListener, TuiInputListenerResult, WheelScrollLines } from "@earendil-works/pi-tui";
import { isKeyRelease, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { WheelScrollAccelerator } from "@earendil-works/pi-tui/dist/wheel-scroll.js";

export type ApplicationInputPolicy = (data: string) => TuiInputListenerResult;

export interface ApplicationInputHost {
	/**
	 * Install the one application policy ahead of every other input listener.
	 * Key releases are dropped before it runs, and bracketed paste reaches it as
	 * literal data. A later call replaces the policy; the returned disposer
	 * removes only the policy it was returned for.
	 */
	setApplicationInputPolicy(policy: ApplicationInputPolicy): () => void;
}

export type ApplicationInputTui = TUI & ApplicationInputHost;

interface Gate {
	policy: ApplicationInputPolicy | undefined;
}

/**
 * Gate state lives here and not in a class field: TuiAltScreen calls the
 * `addInputListener` override below from inside `super()`, before any subclass
 * field exists, and an ES2022 field definition would reset the state when
 * `super()` returns.
 */
const gates = new WeakMap<object, Gate>();

/**
 * Register the gate once per TUI. TuiBase iterates its listeners in insertion
 * order, so the gate runs first exactly when this is called before the first
 * other `addInputListener`.
 */
function gateFor(
	tui: object,
	register: (listener: TuiInputListener) => () => void,
	preempt?: (data: string) => boolean,
): Gate {
	const existing = gates.get(tui);
	if (existing) return existing;
	const gate: Gate = { policy: undefined };
	gates.set(tui, gate);
	register((data) => {
		// Pi's isKeyRelease is already false for bracketed paste, so a paste that
		// contains release-looking bytes stays literal data. Everything else is the
		// policy's own TuiInputListenerResult: Pi's listener loop owns consume and
		// data rewriting.
		if (isKeyRelease(data) || preempt?.(data)) return { consume: true };
		return gate.policy?.(data);
	});
	return gate;
}

// An SGR mouse report: ESC [ < button ; column ; row (M press, m release).
const SGR_MOUSE = new RegExp(`^${String.fromCharCode(27)}\\[<(\\d+);\\d+;\\d+[Mm]$`);

function replacePolicy(gate: Gate, policy: ApplicationInputPolicy): () => void {
	gate.policy = policy;
	return () => {
		if (gate.policy === policy) gate.policy = undefined;
	};
}

export class ApplicationInputTuiAltScreen extends TuiAltScreen implements ApplicationInputHost {
	/** The wheel step past an overlay, set from the same option as Pi's own viewport step. */
	private readonly overlayWheel: WheelScrollAccelerator;

	constructor(...args: ConstructorParameters<typeof TuiAltScreen>) {
		super(...args);
		this.overlayWheel = new WheelScrollAccelerator(args[3]?.wheelScrollLines ?? 1);
	}

	override setWheelScrollLines(lines: WheelScrollLines): void {
		super.setWheelScrollLines(lines);
		this.overlayWheel.setLines(lines);
	}

	override addInputListener(listener: TuiInputListener): () => void {
		gateFor(
			this,
			(gateListener) => super.addInputListener(gateListener),
			(data) => this.scrollTranscriptPastOverlay(data),
		);
		return super.addInputListener(listener);
	}

	setApplicationInputPolicy(policy: ApplicationInputPolicy): () => void {
		return replacePolicy(
			gateFor(
				this,
				(gateListener) => super.addInputListener(gateListener),
				(data) => this.scrollTranscriptPastOverlay(data),
			),
			policy,
		);
	}

	/**
	 * Pi offers a wheel event to the overlay under the pointer first, and its
	 * SelectList and SettingsList turn the wheel into selection moves. Clio is
	 * keyboard first: while an overlay is up the wheel scrolls the transcript
	 * at the viewport's step (five times it with Alt), and choices move only
	 * on keys. A selection made on the overlay's cells holds screen rows, and
	 * the transcript scrolling under it would leave it on other text, so the
	 * scroll drops the selection; its copy was taken at release.
	 */
	private scrollTranscriptPastOverlay(data: string): boolean {
		const button = Number(SGR_MOUSE.exec(data)?.[1] ?? Number.NaN);
		if ((button & 64) === 0 || (button & 3) > 1 || !this.hasOverlay()) return false;
		const direction = (button & 3) === 0 ? -1 : 1;
		const lines = this.overlayWheel.next(direction, performance.now());
		this.resetTextSelection();
		this.scrollBy(direction * ((button & 8) !== 0 ? lines * 5 : lines));
		return true;
	}

	/**
	 * Run one pointer report through Pi's text selection alone, for a modal
	 * overlay that owns the keyboard. Pi's SelectList and SettingsList select
	 * on press and confirm on click, so the report never reaches overlay
	 * components; a drag still selects and copies the transcript beside the
	 * overlay, or the screen rows of the overlay itself. Pi treats a release
	 * that selected nothing as a click and offers it to the overlay, so that
	 * release is dropped, and a release that ends a selection is preceded by a
	 * motion report so it never counts as a click.
	 * A left press on the latest marker still returns to the live edge, as it
	 * does with no overlay up.
	 */
	selectPastOverlay(data: string): void {
		const event = this.parseSgrMouseEvent(data);
		if (!event || (event.button & 64) !== 0) return;
		if (!event.release && (event.button & 35) === 0 && this.latestMarkerAt(event.x, event.y)) {
			this.scrollToBottom();
			return;
		}
		if (event.release) {
			if (!this.hasActiveSelection()) return;
			this.handleSelectionMouseEvent({ ...event, button: event.button | 32, release: false });
		}
		this.handleSelectionMouseEvent(event);
	}

	/** Whether the last frame shows the latest marker at this 0-based cell, uncovered by an overlay. */
	private latestMarkerAt(x: number, y: number): boolean {
		// Pi keeps both rectangles private; they are written by the frame the pointer clicked on.
		const frame = this as unknown as {
			scrollToEndIndicatorRect?: { row: number; column: number; width: number };
			renderedOverlayLayouts?: readonly { row: number; col: number; width: number; height: number }[];
		};
		const marker = frame.scrollToEndIndicatorRect;
		if (!marker || y !== marker.row || x < marker.column || x >= marker.column + marker.width) return false;
		return !(frame.renderedOverlayLayouts ?? []).some(
			(card) => x >= card.col && x < card.col + card.width && y >= card.row && y < card.row + card.height,
		);
	}
}

export class ApplicationInputTuiMainScreen extends TuiMainScreen implements ApplicationInputHost {
	constructor(...args: ConstructorParameters<typeof TuiMainScreen>) {
		super(...args);
		// TuiMainScreen registers no listener of its own, so the first one is ours.
		gateFor(this, (gateListener) => super.addInputListener(gateListener));
	}

	setApplicationInputPolicy(policy: ApplicationInputPolicy): () => void {
		return replacePolicy(
			gateFor(this, (gateListener) => super.addInputListener(gateListener)),
			policy,
		);
	}
}
