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

import type { TUI, TuiInputListener, TuiInputListenerResult } from "@earendil-works/pi-tui";
import { isKeyRelease, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";

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

const SGR_MOUSE = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

function replacePolicy(gate: Gate, policy: ApplicationInputPolicy): () => void {
	gate.policy = policy;
	return () => {
		if (gate.policy === policy) gate.policy = undefined;
	};
}

export class ApplicationInputTuiAltScreen extends TuiAltScreen implements ApplicationInputHost {
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
	 * at Pi's step (one line, five with Alt), and choices move only on keys.
	 */
	private scrollTranscriptPastOverlay(data: string): boolean {
		const button = Number(SGR_MOUSE.exec(data)?.[1] ?? Number.NaN);
		if ((button & 64) === 0 || (button & 3) > 1 || !this.hasOverlay()) return false;
		this.scrollBy(((button & 3) === 0 ? -1 : 1) * ((button & 8) !== 0 ? 5 : 1));
		return true;
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
