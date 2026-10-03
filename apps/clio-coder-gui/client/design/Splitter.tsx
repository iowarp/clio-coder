import { useCallback, useLayoutEffect, useRef, useState } from "react";
import "./splitter.css";

export interface SplitterSpec {
	/** localStorage key for this browser's chosen width. */
	readonly storageKey: string;
	/** The CSS custom property the layout reads, written on the host element. */
	readonly cssVar: string;
	readonly min: number;
	readonly max: number;
	readonly initial: number;
	/** The panel never takes more than this share of the host's width. */
	readonly maxShare: number;
}

export const LEFT_SIDEBAR: SplitterSpec = {
	storageKey: "clio-coder-gui-sidebar-width",
	cssVar: "--wb-side",
	min: 216,
	max: 420,
	initial: 268,
	maxShare: 0.34,
};

export const TASK_PANE: SplitterSpec = {
	storageKey: "clio-coder-gui-pane-width",
	cssVar: "--pane-w",
	min: 320,
	max: 720,
	initial: 400,
	maxShare: 0.55,
};

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;
/** Dragging this far past the minimum asks the owner to collapse the panel instead. */
const COLLAPSE_SLACK = 72;

export function clampWidth(spec: SplitterSpec, width: number, hostWidth: number): number {
	const ceiling = Math.max(spec.min, Math.min(spec.max, hostWidth > 0 ? hostWidth * spec.maxShare : spec.max));
	return Math.round(Math.min(ceiling, Math.max(spec.min, width)));
}

export function storedWidth(spec: SplitterSpec): number | null {
	try {
		const value = Number(localStorage.getItem(spec.storageKey));
		return Number.isFinite(value) && value >= spec.min ? Math.min(value, spec.max) : null;
	} catch {
		return null;
	}
}

function remember(spec: SplitterSpec, width: number | null): void {
	try {
		if (width === null) localStorage.removeItem(spec.storageKey);
		else localStorage.setItem(spec.storageKey, String(width));
	} catch {
		// The width holds for this tab.
	}
}

/**
 * The grip on one edge of a resizable panel. `edge` is the panel side the grip sits on: "end" for a
 * left-hand panel (the grip is its right edge), "start" for a right-hand one.
 */
export function Splitter({
	spec,
	edge,
	label,
	host,
	onCollapse,
}: {
	spec: SplitterSpec;
	edge: "start" | "end";
	label: string;
	/** Selector for the ancestor whose CSS variable sizes the panel. */
	host: string;
	onCollapse?: () => void;
}) {
	const grip = useRef<HTMLDivElement>(null);
	// Found from the grip itself: a parent's ref is not attached yet when this layout effect runs.
	const hostElement = useCallback(() => grip.current?.closest<HTMLElement>(host) ?? null, [host]);
	const [width, setWidth] = useState(() => storedWidth(spec) ?? spec.initial);
	const current = useRef(width);
	const frame = useRef(0);

	const write = useCallback(
		(next: number) => {
			current.current = next;
			cancelAnimationFrame(frame.current);
			frame.current = requestAnimationFrame(() => hostElement()?.style.setProperty(spec.cssVar, `${next}px`));
		},
		[hostElement, spec.cssVar],
	);
	const commit = useCallback(
		(next: number) => {
			write(next);
			setWidth(next);
			remember(spec, next);
		},
		[spec, write],
	);
	/** Forget the chosen width so the layout's default applies again, then report what it is. */
	const reset = useCallback(() => {
		cancelAnimationFrame(frame.current);
		// The reset snaps: an animating column would be measured mid-flight.
		const root = document.documentElement;
		root.dataset.resizing = "true";
		hostElement()?.style.removeProperty(spec.cssVar);
		remember(spec, null);
		const measured = Math.round(grip.current?.parentElement?.getBoundingClientRect().width ?? spec.initial);
		delete root.dataset.resizing;
		current.current = measured;
		setWidth(measured);
	}, [hostElement, spec]);

	// Before the first paint, so a stored width never flashes from the default. Without one, the
	// layout's own default (which may follow the viewport) is the width the grip reports.
	useLayoutEffect(() => {
		const stored = storedWidth(spec);
		if (stored !== null) hostElement()?.style.setProperty(spec.cssVar, `${stored}px`);
		else {
			const measured = Math.round(grip.current?.parentElement?.getBoundingClientRect().width ?? 0);
			if (measured > 0) {
				current.current = measured;
				setWidth(measured);
			}
		}
	}, [hostElement, spec]);

	return (
		// biome-ignore lint/a11y/useSemanticElements: a separator that can be focused and moved is the window-splitter pattern.
		<div
			ref={grip}
			className="splitter"
			data-edge={edge}
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuemin={spec.min}
			aria-valuemax={spec.max}
			aria-valuenow={width}
			title={`${label}. Double-click to reset.`}
			tabIndex={0}
			onDoubleClick={reset}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				const node = event.currentTarget;
				node.setPointerCapture(event.pointerId);
				const startX = event.clientX;
				// The panel's real width, which a viewport-relative default may have moved since mount.
				const startWidth = Math.round(node.parentElement?.getBoundingClientRect().width ?? current.current);
				const hostWidth = hostElement()?.clientWidth ?? 0;
				const root = document.documentElement;
				root.dataset.resizing = "true";
				let collapse = false;
				const move = (moved: PointerEvent) => {
					const delta = moved.clientX - startX;
					const raw = edge === "end" ? startWidth + delta : startWidth - delta;
					collapse = onCollapse !== undefined && raw < spec.min - COLLAPSE_SLACK;
					node.dataset.collapse = collapse ? "true" : "false";
					write(clampWidth(spec, raw, hostWidth));
				};
				const stop = () => {
					node.removeEventListener("pointermove", move);
					node.removeEventListener("pointerup", stop);
					node.removeEventListener("pointercancel", stop);
					delete root.dataset.resizing;
					delete node.dataset.collapse;
					if (collapse) {
						write(startWidth);
						onCollapse?.();
						return;
					}
					commit(current.current);
				};
				node.addEventListener("pointermove", move);
				node.addEventListener("pointerup", stop);
				node.addEventListener("pointercancel", stop);
			}}
			onKeyDown={(event) => {
				const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
				const grow = edge === "end" ? "ArrowRight" : "ArrowLeft";
				const shrink = edge === "end" ? "ArrowLeft" : "ArrowRight";
				const hostWidth = hostElement()?.clientWidth ?? 0;
				let next: number | null;
				if (event.key === grow) next = current.current + step;
				else if (event.key === shrink) next = current.current - step;
				else if (event.key === "Home") next = spec.min;
				else if (event.key === "End") next = spec.max;
				else if (event.key === "Enter") next = null;
				else return;
				event.preventDefault();
				if (next === null) reset();
				else commit(clampWidth(spec, next, hostWidth));
			}}
		/>
	);
}
