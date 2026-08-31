/**
 * The outward signal that a modal overlay owns the keyboard.
 *
 * Every framed Clio overlay captures input for as long as it is up, and until
 * now it announced that only by being on screen. An external driver feeding
 * keys into the pane, and herdr deciding whether the pane is idle, working, or
 * blocked, had to infer modality from whatever the overlay happened to draw:
 * its box title, its hint row, a footer pill. Those are per-overlay strings
 * that move on every reskin, and the tall modals cover the very rows a screen
 * scraper reads, so the signal is weakest exactly when a modal is largest.
 *
 * The marker publishes the fact out of band instead, as an OSC 0 terminal
 * title. Three properties make the title the reliable channel here:
 *
 *   1. It is not screen content. No overlay can composite over it, no
 *      transcript line can counterfeit it, and no terminal height changes
 *      whether it is readable.
 *   2. herdr already consumes it. `region = "osc_title"` is a first-class
 *      detection region (herdr `src/detect/manifest.rs`), fed from the pane's
 *      own emulator, and its rules outrank every screen rule.
 *   3. Clio has never written a title, so the channel carries exactly one
 *      meaning and nothing else contends for it.
 *
 * The grammar is fixed and machine-first:
 *
 *   clio                                 no modal owns the keys
 *   clio [modal:permission-confirm]      one modal, named
 *   clio [modal:library-install+2]       top modal named, two more beneath it
 *
 * Nothing is written until the first modal opens, so a Clio that never opens
 * an overlay leaves the pane's inherited title alone. From the first modal
 * onward the title toggles between the marker and the bare base, which is what
 * makes the absence of a marker a positive statement rather than an unknown.
 */

/** The write side of a terminal title. `ProcessTerminal` satisfies it structurally. */
export interface ModalMarkerSink {
	setTitle(title: string): void;
}

/** What the title reads when nothing modal owns the keyboard. */
export const MODAL_MARKER_BASE_TITLE = "clio";

/**
 * The one regular expression an external reader needs. Exported so Clio's own
 * contract test and herdr's manifest rule are written against the same shape
 * rather than two hand-copied spellings of it.
 */
export const MODAL_MARKER_TITLE_PATTERN = /^clio \[modal:([a-z0-9][a-z0-9-]*)(?:\+([1-9]\d*))?\]$/u;

/** Render the title for a modal stack, outermost first. */
export function formatModalMarkerTitle(stack: readonly string[]): string {
	const top = stack.at(-1);
	if (top === undefined) return MODAL_MARKER_BASE_TITLE;
	const beneath = stack.length - 1;
	return `${MODAL_MARKER_BASE_TITLE} [modal:${top}${beneath > 0 ? `+${beneath}` : ""}]`;
}

/** Read a marker title back. Returns null for the base title and for anything else. */
export function parseModalMarkerTitle(title: string): { id: string; depth: number } | null {
	const match = MODAL_MARKER_TITLE_PATTERN.exec(title);
	const id = match?.[1];
	if (id === undefined) return null;
	const beneath = match?.[2];
	return { id, depth: beneath === undefined ? 1 : 1 + Number.parseInt(beneath, 10) };
}

/** One modal's claim on the keyboard, released when the overlay goes away. */
export interface ModalMarkerHandle {
	/** Drop this modal from the stack. Idempotent; a second call is inert. */
	release(): void;
	/**
	 * Whether this modal currently owns keys. The engine's `setHidden` takes a
	 * visible overlay out of the focus order without destroying it, which is how
	 * a surface that shells out to a child process gets off the screen, so a
	 * hidden modal must stop claiming the keyboard without leaving the stack.
	 */
	setActive(active: boolean): void;
	/** Bring this modal back to the top of the stack, as `handle.focus()` does on screen. */
	raise(): void;
}

interface ModalMarkerRegistry {
	/**
	 * Push a modal. The sink is taken from the caller rather than installed at
	 * startup so the marker has no lifecycle of its own: it exists exactly when
	 * an overlay exists, and a stub terminal with no `setTitle` makes the whole
	 * mechanism inert instead of throwing.
	 */
	enter(id: string, sink?: ModalMarkerSink | null): ModalMarkerHandle;
	/** The ids that currently own keys, outermost first. */
	stack(): readonly string[];
}

interface ModalMarkerEntry {
	readonly id: string;
	active: boolean;
}

function createModalMarkerRegistry(): ModalMarkerRegistry {
	const entries: ModalMarkerEntry[] = [];
	let sink: ModalMarkerSink | null = null;
	let published: string | null = null;

	function activeIds(): string[] {
		return entries.filter((entry) => entry.active).map((entry) => entry.id);
	}

	function publish(): void {
		if (sink === null) return;
		const title = formatModalMarkerTitle(activeIds());
		// Before the first marker there is no stale claim to clear, so the pane
		// keeps whatever title the shell or the multiplexer gave it.
		if (published === null && title === MODAL_MARKER_BASE_TITLE) return;
		if (title === published) return;
		published = title;
		sink.setTitle(title);
	}

	function enter(id: string, nextSink?: ModalMarkerSink | null): ModalMarkerHandle {
		if (nextSink) sink = nextSink;
		const entry: ModalMarkerEntry = { id, active: true };
		entries.push(entry);
		publish();
		let released = false;
		return {
			release(): void {
				if (released) return;
				released = true;
				const index = entries.indexOf(entry);
				if (index !== -1) entries.splice(index, 1);
				publish();
			},
			setActive(active: boolean): void {
				if (released || entry.active === active) return;
				entry.active = active;
				publish();
			},
			raise(): void {
				if (released) return;
				entry.active = true;
				const index = entries.indexOf(entry);
				if (index !== -1 && index !== entries.length - 1) {
					entries.splice(index, 1);
					entries.push(entry);
				}
				publish();
			},
		};
	}

	return { enter, stack: (): readonly string[] => activeIds() };
}

let registry = createModalMarkerRegistry();

/** Push a modal onto the process-wide stack. See {@link ModalMarkerRegistry.enter}. */
export function enterModal(id: string, sink?: ModalMarkerSink | null): ModalMarkerHandle {
	return registry.enter(id, sink);
}

/** The ids that currently own keys, outermost first. */
export function modalMarkerStack(): readonly string[] {
	return registry.stack();
}

/** Drop every claim and forget the sink. Tests use it to isolate; nothing in the app does. */
export function resetModalMarker(): void {
	registry = createModalMarkerRegistry();
}
