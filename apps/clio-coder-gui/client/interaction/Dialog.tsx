// The modal dialog and its slide-in drawer sibling. Both claim a keyboard layer, trap Tab, close on
// the declared Escape binding and restore focus to whatever opened them. A dialog opened on top of
// another (Report over Help) owns Escape and Tab alone until it closes.

import type { ReactNode, RefObject } from "react";
import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../design/icons.js";
import "./interaction.css";
import { useFocusTrap } from "./use-focus-trap.js";
import { isTopLayer, useShortcut, useShortcutLayer } from "./use-shortcut.js";

export function Dialog({
	title,
	eyebrow,
	children,
	onClose,
	size = "default",
	className = "",
	initialFocus,
	returnFocus,
	actions,
}: {
	title: string;
	eyebrow: string;
	children: ReactNode;
	onClose: () => void;
	size?: "default" | "wide";
	className?: string;
	/** Where focus lands on open. The close button is first in the DOM, which is rarely the answer. */
	initialFocus?: RefObject<HTMLElement | null>;
	/** The control that opened the dialog, when the caller knows it better than `document.activeElement`. */
	returnFocus?: HTMLElement | null;
	/** Header actions, placed before the close button. */
	actions?: ReactNode;
}) {
	const headingId = useId();
	const container = useRef<HTMLDivElement>(null);
	const layer = useShortcutLayer("dialog", true);
	useFocusTrap(container, true, initialFocus, { returnTo: returnFocus, owns: () => isTopLayer(layer) });
	useShortcut("escape", onClose, { layer });
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
				className={`dialog dialog--${size} ${className}`}
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
					<div className="dialog__actions">
						{actions}
						<button type="button" className="icon-button" onClick={onClose}>
							<Icon name="close" />
							<span className="sr-only">Close</span>
						</button>
					</div>
				</div>
				<div className="dialog__body">{children}</div>
			</div>
		</div>,
		document.body,
	);
}
