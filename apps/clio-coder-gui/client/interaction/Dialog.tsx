// The modal dialog and its slide-in drawer sibling. Both claim a keyboard layer, trap Tab, close on
// the declared Escape binding and restore focus to whatever opened them.

import { type ReactNode, type RefObject, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../design/icons.js";
import "./interaction.css";
import { useFocusTrap } from "./use-focus-trap.js";
import { useShortcut, useShortcutLayer } from "./use-shortcut.js";

export function Dialog({
	title,
	eyebrow,
	children,
	onClose,
	size = "default",
	initialFocus,
}: {
	title: string;
	eyebrow: string;
	children: ReactNode;
	onClose: () => void;
	size?: "default" | "wide";
	/** Where focus lands on open. The close button is first in the DOM, which is rarely the answer. */
	initialFocus?: RefObject<HTMLElement | null>;
}) {
	const headingId = useId();
	const container = useRef<HTMLDivElement>(null);
	useShortcutLayer("dialog", true);
	useFocusTrap(container, true, initialFocus);
	useShortcut("escape", onClose);
	// Portaled to the body: the shell marks the page behind a layer `inert`, which would otherwise
	// disable a dialog opened from inside a page.
	return createPortal(
		// biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is presentational; Escape and the close button are the keyboard paths.
		<div
			className="dialog-backdrop"
			role="presentation"
			// mousedown, not click: a text selection that starts inside the dialog and ends on the
			// backdrop must not dismiss it.
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				className={`dialog dialog--${size}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby={headingId}
				ref={container}
				tabIndex={-1}
			>
				<div className="dialog__header">
					<div>
						<p className="eyebrow">{eyebrow}</p>
						<h2 id={headingId}>{title}</h2>
					</div>
					<button type="button" className="icon-button" onClick={onClose}>
						<Icon name="close" />
						<span className="sr-only">Close</span>
					</button>
				</div>
				<div className="dialog__body">{children}</div>
			</div>
		</div>,
		document.body,
	);
}

/**
 * A slide-in panel. The scrim is `aria-hidden` and is not a button: Escape and the panel's own close
 * control are the keyboard paths, and the scrim exists for the pointer.
 */
export function Drawer({
	title,
	children,
	onClose,
	side = "start",
}: {
	title: string;
	children: ReactNode;
	onClose: () => void;
	side?: "start" | "end";
}) {
	const headingId = useId();
	const container = useRef<HTMLDivElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	useShortcutLayer("dialog", true);
	useFocusTrap(container, true, close);
	useShortcut("escape", onClose);
	return (
		<div className={`drawer-layer drawer-layer--${side}`}>
			{/* The scrim is not a button: Escape and the panel close button are the keyboard paths. */}
			<div className="drawer-scrim" aria-hidden="true" onClick={onClose} />
			<div className="drawer" role="dialog" aria-modal="true" aria-labelledby={headingId} ref={container} tabIndex={-1}>
				<div className="dialog__header">
					<h2 id={headingId}>{title}</h2>
					<button type="button" className="icon-button" ref={close} onClick={onClose}>
						<Icon name="close" />
						<span className="sr-only">Close</span>
					</button>
				</div>
				<div className="dialog__body">{children}</div>
			</div>
		</div>
	);
}
