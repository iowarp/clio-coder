import { type ReactNode, useRef, useState } from "react";
import { Icon } from "../design/icons.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";

/**
 * A `<details>` used as an action menu. It closes on an outside press, on Escape (returning focus to
 * its button) and after any item is chosen. Items are plain buttons or links with `role="menuitem"`.
 */
export function Menu({
	label,
	icon = "more",
	children,
}: {
	label: string;
	icon?: Parameters<typeof Icon>[0]["name"];
	children: ReactNode;
}) {
	const ref = useRef<HTMLDetailsElement>(null);
	const [open, setOpen] = useState(false);
	useDetailsDismiss(ref, open);
	return (
		<details className="wb-menu" ref={ref} onToggle={(event) => setOpen(event.currentTarget.open)}>
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
