import { type RefObject, useEffect, useRef } from "react";
import { INVENTORY_PAGE_SIZE } from "./use-inventory-window.js";
import "./inventory-more.css";

export function InventoryMore({
	total,
	limit,
	label,
	list,
	onMore,
}: {
	total: number;
	limit: number;
	label: string;
	list: RefObject<HTMLElement | null>;
	onMore: () => void;
}) {
	const frame = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (frame.current !== null) cancelAnimationFrame(frame.current);
		},
		[],
	);
	return (
		<div className="inventory-more">
			<p role="status">
				Showing {Math.min(limit, total)} of {total} {label}
			</p>
			{total > limit ? (
				<button
					type="button"
					onClick={() => {
						onMore();
						frame.current = requestAnimationFrame(() => {
							frame.current = null;
							const next = list.current?.children[limit]?.querySelector<HTMLElement>("a, button");
							next?.focus({ preventScroll: true });
							next?.scrollIntoView({ block: "nearest" });
						});
					}}
				>
					Show {Math.min(INVENTORY_PAGE_SIZE, total - limit)} more {label}
				</button>
			) : null}
		</div>
	);
}
