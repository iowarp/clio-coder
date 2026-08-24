/**
 * The resource library's install confirmation, as an overlay.
 *
 * `clio-coder library add` prints every destination and SHA-256 hash and writes
 * nothing until `--yes` is present. This overlay is that same gate for the
 * Skills Hub: it states every path the install would write and the hash it
 * would write there, and nothing reaches disk until the operator presses Enter.
 * Esc leaves the plan unexecuted, so a cancelled confirmation is a run in which
 * no file changed.
 *
 * The body is a pure function of the subject so the wording is testable without
 * a TUI.
 */

import { type Component, type OverlayHandle, type TUI, truncateToWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { buildResponsiveHint, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, rule } from "../theme/index.js";

export const LIBRARY_INSTALL_CONFIRM_TITLE = "Library install";

const MIN_WIDTH = 48;
const MAX_WIDTH = 110;

/** One planned write, in the terms `library add` reports it. */
export interface LibraryInstallWrite {
	ref: string;
	path: string;
	sha256: string;
}

export interface LibraryInstallConfirmSubject {
	/** The typed reference the operator asked for, e.g. `fleet:release`. */
	entryRef: string;
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
			? `install ${subject.entryRef} with its requirements: ${subject.requirements.join(", ")}`
			: `install ${subject.entryRef}`;
	for (const line of wrapTextWithAnsi(theme.fg("accent", headline), contentWidth)) rows.push(line);
	rows.push(rule(theme, contentWidth));

	for (const write of subject.writes) {
		rows.push(theme.fg("muted", truncateToWidth(`${write.ref} → ${write.path}`, contentWidth, "…", false)));
		rows.push(theme.fg("dim", truncateToWidth(`    sha256 ${write.sha256}`, contentWidth, "…", false)));
	}

	rows.push(rule(theme, contentWidth));
	const satisfied = subject.satisfied.length > 0 ? subject.satisfied.join(", ") : "none";
	for (const line of wrapTextWithAnsi(theme.fg("info", `satisfied requirements: ${satisfied}`), contentWidth)) {
		rows.push(line);
	}
	for (const line of wrapTextWithAnsi(
		theme.fg("dim", `${subject.writes.length} file or files are written only after Enter; Esc writes nothing`),
		contentWidth,
	)) {
		rows.push(line);
	}
	return rows;
}

class LibraryInstallConfirmBody implements Component {
	constructor(private readonly subject: LibraryInstallConfirmSubject) {}

	render(width: number): string[] {
		return formatLibraryInstallConfirmBody(this.subject, width);
	}

	invalidate(): void {}
}

const KEY_ESC = "\x1b";

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

	const focus = new FocusBox(new LibraryInstallConfirmBody(options.subject), {
		onInput: (data: string): void => {
			if (settled) return;
			if (data === "\r" || data === "\n") {
				accept();
				return;
			}
			if (data === KEY_ESC) cancel();
		},
	});

	const handle = showClioOverlayFrame(tui, focus, {
		anchor: "center",
		width: confirmOverlayWidth(options.columns),
		title: LIBRARY_INSTALL_CONFIRM_TITLE,
		footerHint: buildResponsiveHint([{ key: "Enter", verb: "install" }], { key: "Esc", verb: "cancel" }),
	});

	return {
		...handle,
		hide(): void {
			cancel();
			handle.hide();
		},
	};
}
