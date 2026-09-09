/**
 * The resource library's install confirmation, as an overlay.
 *
 * `clio-coder library install --dry-run` reports the same destinations and
 * SHA-256 hashes. This overlay writes only after the operator presses Enter.
 * Esc leaves the plan unexecuted, so a cancelled confirmation is a run in which
 * no file changed.
 *
 * The body is a pure function of the subject so the wording is testable without
 * a TUI.
 */

import {
	type Component,
	isKeyRelease,
	matchesKey,
	type OverlayHandle,
	type TUI,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { buildResponsiveHint, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, rule } from "../theme/index.js";

export const LIBRARY_INSTALL_CONFIRM_TITLE = "Library install";

const MIN_WIDTH = 48;
const MAX_WIDTH = 110;

/** One planned write, in the terms `library install --dry-run` reports it. */
export interface LibraryInstallWrite {
	ref: string;
	path: string;
	sha256: string;
	sourceUrl?: string;
}

export interface LibraryInstallConfirmSubject {
	/** The typed reference the operator asked for, e.g. `fleet:release`. */
	entryRef: string;
	action?: "install" | "update" | "remove";
	/** Every write, in dependency order, the requested entry last. */
	writes: ReadonlyArray<LibraryInstallWrite>;
	/** Requirements this confirmation would install alongside the entry. */
	requirements: ReadonlyArray<string>;
	/** Requirements already on disk, named so the plan accounts for all of them. */
	satisfied: ReadonlyArray<string>;
}

export interface OpenLibraryInstallConfirmOverlayOptions {
	subject: LibraryInstallConfirmSubject;
	/** Live terminal width, so the box tracks the window it opened in. */
	columns: number;
	/** Enter: perform exactly the writes this body named. */
	onAccept: () => void;
	/** Esc: nothing is written. */
	onCancel: () => void;
}

function confirmOverlayWidth(columns: number): number {
	return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns - 4));
}

/** Render the plan: what is being installed, alongside what, and to where. */
export function formatLibraryInstallConfirmBody(subject: LibraryInstallConfirmSubject, width: number): string[] {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	const rows: string[] = [];

	const headline =
		subject.requirements.length > 0
			? `${subject.action ?? "install"} ${subject.entryRef} with its requirements: ${subject.requirements.join(", ")}`
			: `${subject.action ?? "install"} ${subject.entryRef}`;
	for (const line of wrapTextWithAnsi(theme.fg("accent", headline), contentWidth)) rows.push(line);
	rows.push(rule(theme, contentWidth));

	for (const write of subject.writes) {
		if (write.sourceUrl) rows.push(...wrapTextWithAnsi(theme.fg("dim", `source: ${write.sourceUrl}`), contentWidth));
		rows.push(...wrapTextWithAnsi(theme.fg("muted", `${write.ref} → ${write.path}`), contentWidth));
		rows.push(...wrapTextWithAnsi(theme.fg("dim", `    sha256 ${write.sha256}`), contentWidth));
	}

	rows.push(rule(theme, contentWidth));
	const satisfied = subject.satisfied.length > 0 ? subject.satisfied.join(", ") : "none";
	for (const line of wrapTextWithAnsi(theme.fg("info", `satisfied requirements: ${satisfied}`), contentWidth)) {
		rows.push(line);
	}
	for (const line of wrapTextWithAnsi(
		theme.fg(
			"dim",
			`${subject.writes.length} resource destination(s) are ${subject.action === "remove" ? "removed" : "written"} only after Enter; Esc changes nothing`,
		),
		contentWidth,
	)) {
		rows.push(line);
	}
	return rows;
}

class LibraryInstallConfirmBody implements Component {
	private scroll = 0;
	private maxScroll = 0;
	private rows = 12;
	handleInput(data: string): void {
		const down = matchesKey(data, "pageDown") || matchesKey(data, "down");
		const up = matchesKey(data, "pageUp") || matchesKey(data, "up");
		if (down || up) this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + (down ? this.rows : -this.rows)));
	}
	constructor(private readonly subject: LibraryInstallConfirmSubject) {}

	render(width: number): string[] {
		const body = formatLibraryInstallConfirmBody(this.subject, width);
		this.rows = Math.max(4, (process.stdout.rows || 30) - 10);
		this.maxScroll = Math.max(0, body.length - this.rows);
		this.scroll = Math.min(this.scroll, this.maxScroll);
		const shown = body.slice(this.scroll, this.scroll + this.rows);
		if (this.maxScroll) shown.push(`(${this.scroll + 1}-${this.scroll + shown.length}/${body.length}) PgUp/PgDn`);
		return shown;
	}

	invalidate(): void {}
}

export function openLibraryInstallConfirmOverlay(
	tui: TUI,
	options: OpenLibraryInstallConfirmOverlayOptions,
): OverlayHandle {
	let settled = false;

	const accept = (): void => {
		if (settled) return;
		settled = true;
		options.onAccept();
	};
	const cancel = (): void => {
		if (settled) return;
		settled = true;
		options.onCancel();
	};

	const body = new LibraryInstallConfirmBody(options.subject);
	const focus = new FocusBox(body, {
		// Keys are matched by name, never by raw bytes: under the kitty keyboard
		// protocol Esc arrives as CSI 27 u, and a byte comparison against "\x1b"
		// left the overlay unanswerable. Everything unmatched is swallowed.
		onInput: (data: string): void => {
			if (settled || isKeyRelease(data)) return;
			if (matchesKey(data, "enter")) {
				accept();
				return;
			}
			if (matchesKey(data, "escape")) cancel();
			else {
				body.handleInput(data);
				tui.requestRender();
			}
		},
	});

	const handle = showClioOverlayFrame(tui, focus, {
		anchor: "center",
		width: confirmOverlayWidth(options.columns),
		markerId: "library-install",
		title: options.subject.action ? `Library ${options.subject.action}` : LIBRARY_INSTALL_CONFIRM_TITLE,
		footerHint: buildResponsiveHint([{ key: "Enter", verb: options.subject.action ?? "install" }], {
			key: "Esc",
			verb: "cancel",
		}),
	});

	return {
		...handle,
		hide(): void {
			cancel();
			handle.hide();
		},
	};
}
