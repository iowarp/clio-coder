import { type ReactNode, useEffect, useRef, useState } from "react";
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
	panel.style.setProperty("--menu-top", `${Math.round(top)}px`);
	panel.style.setProperty("--menu-left", `${Math.round(left)}px`);
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
	// A fixed panel does not follow a scrolling list, so it closes instead of drifting off its button.
	useEffect(() => {
		if (!float || !open) return;
		const close = () => {
			if (ref.current) ref.current.open = false;
		};
		window.addEventListener("resize", close);
		document.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("resize", close);
			document.removeEventListener("scroll", close, true);
		};
	}, [float, open]);
	return (
		<details
			className="wb-menu"
			data-float={float ? "yes" : undefined}
			ref={ref}
			onToggle={(event) => {
				setOpen(event.currentTarget.open);
				if (float && event.currentTarget.open) placeFloating(event.currentTarget);
			}}
		>
			<summary className="wb-icon" aria-label={label} title={label}>
				<Icon name={icon} />
			</summary>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the click only closes the menu after an item, whose own button handles the keyboard. */}
			<div
				className="wb-menu__panel"
				role="menu"
				onClick={(event) => {
					if (event.target instanceof Element && event.target.closest('[role="menuitem"]') && ref.current)
						ref.current.open = false;
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
