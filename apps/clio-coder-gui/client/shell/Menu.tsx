import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "../design/icons.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";

/** Place a floating panel beside its button, flipped above it when the space below runs out. */
function placeFloating(details: HTMLDetailsElement): void {
	const summary = details.querySelector("summary");
	const panel = details.querySelector<HTMLElement>(".wb-menu__panel");
	if (!summary || !panel) return;
	const anchor = summary.getBoundingClientRect();
	const box = panel.getBoundingClientRect();
	const below = anchor.bottom + 6;
	const top = below + box.height > window.innerHeight - 8 ? Math.max(8, anchor.top - 6 - box.height) : below;
	const left = Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8));
	// "Fixed" is relative to the window only while no ancestor is a containing block (a transform, a
	// filter, containment). A probe at 0,0 in the same layer finds where that layer really starts.
	const probe = document.createElement("span");
	probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden";
	details.append(probe);
	const origin = probe.getBoundingClientRect();
	probe.remove();
	panel.style.setProperty("--menu-top", `${Math.round(top - origin.top)}px`);
	panel.style.setProperty("--menu-left", `${Math.round(left - origin.left)}px`);
}

const MENU_ITEMS = '[role="menuitem"]:not([disabled])';

/** Arrow keys walk the items and wrap; Home and End jump to either end. Tab still moves as it does anywhere. */
function moveFocus(event: KeyboardEvent<HTMLElement>): void {
	const items = [...event.currentTarget.querySelectorAll<HTMLElement>(MENU_ITEMS)];
	if (items.length === 0) return;
	const at = items.indexOf(document.activeElement as HTMLElement);
	const last = items.length - 1;
	let next: number;
	if (event.key === "ArrowDown") next = at < 0 || at === last ? 0 : at + 1;
	else if (event.key === "ArrowUp") next = at <= 0 ? last : at - 1;
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = last;
	else return;
	event.preventDefault();
	items[next]?.focus();
}

/**
 * A `<details>` used as an action menu. It closes on an outside press, on Escape (returning focus to
 * its button) and after any item is chosen. Items are plain buttons or links with `role="menuitem"`.
 * A `float` menu opens in a fixed layer, for a button that sits inside a scrolling list.
 */
export function Menu({
	label,
	icon = "more",
	children,
	float = false,
}: {
	label: string;
	icon?: Parameters<typeof Icon>[0]["name"];
	children: ReactNode;
	float?: boolean;
}) {
	const ref = useRef<HTMLDetailsElement>(null);
	const [open, setOpen] = useState(false);
	useDetailsDismiss(ref, open);
	// A fixed panel does not follow a scrolling list, so it closes instead of drifting off its button. The
	// exception is the scroll that focusing one of its own items causes: that one moves it along.
	useEffect(() => {
		if (!float || !open) return;
		const close = () => {
			if (ref.current) ref.current.open = false;
		};
		const scrolled = () => {
			if (ref.current?.contains(document.activeElement)) placeFloating(ref.current);
			else close();
		};
		// The button can also move without a scroll: the rail re-sorts its rows as tasks change state and
		// animates its width. The fixed panel kept its first coordinates and opened hundreds of pixels
		// from its button, so it follows the button every frame while open, and closes if it goes away.
		let frame = 0;
		let at = "";
		const follow = () => {
			const details = ref.current;
			const anchor = details?.querySelector("summary")?.getBoundingClientRect();
			if (!details || !anchor || (anchor.width === 0 && anchor.height === 0)) {
				close();
				return;
			}
			const where = `${anchor.top} ${anchor.right}`;
			if (where !== at) {
				at = where;
				placeFloating(details);
			}
			frame = requestAnimationFrame(follow);
		};
		frame = requestAnimationFrame(follow);
		window.addEventListener("resize", close);
		document.addEventListener("scroll", scrolled, true);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("resize", close);
			document.removeEventListener("scroll", scrolled, true);
		};
	}, [float, open]);
	return (
		<details
			className="wb-menu"
			data-float={float ? "yes" : undefined}
			ref={ref}
			onToggle={(event) => {
				const details = event.currentTarget;
				setOpen(details.open);
				if (float && details.open) placeFloating(details);
				// A keyboard opening leaves the button focus-visible, a pointer one does not; only the keyboard
				// hands focus on to the first item.
				if (details.open && details.querySelector("summary")?.matches(":focus-visible"))
					details.querySelector<HTMLElement>(`.wb-menu__panel ${MENU_ITEMS}`)?.focus({ preventScroll: float });
			}}
		>
			<summary className="wb-icon" aria-label={label} title={label}>
				<Icon name={icon} />
			</summary>
			<div
				className="wb-menu__panel"
				role="menu"
				onKeyDown={moveFocus}
				onClick={(event) => {
					if (event.target instanceof Element && event.target.closest('[role="menuitem"]') && ref.current) {
						ref.current.open = false;
						// A dialog opened by a hidden menu item must return to the visible menu button.
						ref.current.querySelector("summary")?.focus();
					}
				}}
			>
				{children}
			</div>
		</details>
	);
}

export function MenuItem({
	icon,
	children,
	onClick,
	disabled,
	tone,
}: {
	icon: Parameters<typeof Icon>[0]["name"];
	children: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	tone?: "danger";
}) {
	return (
		<button
			type="button"
			role="menuitem"
			className="wb-menu__item"
			data-tone={tone}
			disabled={disabled}
			onClick={onClick}
		>
			<Icon name={icon} />
			<span>{children}</span>
		</button>
	);
}
