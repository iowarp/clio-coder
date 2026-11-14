import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Where a view was left: its scroll offset and whether it was following the latest output. */
export interface ScrollPosition {
	readonly top: number;
	readonly following: boolean;
}

export interface FollowLatest {
	readonly following: boolean;
	/** Timeline activity arrived while the operator was scrolled away. */
	readonly unseen: boolean;
	jumpToLatest(): void;
	snapshot(): ScrollPosition;
	restore(position: ScrollPosition): void;
}

const BOTTOM_TOLERANCE_PX = 32;
/** How long after a wheel, touch, pointer or navigation key an upward scroll still counts as the reader's. */
const INTENT_MS = 1_000;
const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
/** How long a shrink a ResizeObserver pass saw can still explain a browser clamp: a clamp's scroll event lands a frame or two later. */
const CLAMP_WINDOW_MS = 250;
const CLAMP_SLACK_PX = 2;
/** How long after a send the dock and the new turn may reflow the viewport without ending follow. */
const SEND_HOLD_MS = 800;

/** A scroll event weighed against the hook's last write and the content it last measured. */
export interface ScrollReading {
	readonly top: number;
	/** The offset the hook last wrote. */
	readonly pinnedTop: number;
	readonly viewport: number;
	readonly following: boolean;
	readonly running: boolean;
	/** A wheel, touch, pointer, focus or navigation key came just before. */
	readonly intended: boolean;
	/** The smallest `scrollHeight - clientHeight` a recent ResizeObserver pass saw below `pinnedTop`, or null. */
	readonly shrunkTo: number | null;
	/** `scrollHeight` sampled in the scroll event, and when the hook last wrote. */
	readonly height?: number;
	readonly pinnedHeight?: number;
	/** `clientHeight` when the hook last wrote. */
	readonly pinnedViewport?: number;
	/** A prompt was just sent, so its reflow can clamp before the turn shows as running. */
	readonly held?: boolean;
}

/**
 * True when an upward move is the browser clamping scrollTop to a layout that changed under it, not
 * anyone leaving the live edge. The view follows, no reader input preceded it, the move lands within
 * one viewport of the last pin, a turn runs (or a prompt was just sent and its turn has not shown as
 * running yet), and the layout changed since the last pin: a ResizeObserver pass saw content shrink
 * (and the move lands no higher than that), `scrollHeight` sampled in the event dropped, or the
 * viewport itself changed height (the dock reflowing, which can clamp and recover between two
 * observations). Any other upward move (the reader, find-in-page, assistive technology or a script,
 * even just after a send) ends follow.
 */
export function browserClamp(reading: ScrollReading): boolean {
	if (
		!reading.following ||
		reading.intended ||
		reading.top >= reading.pinnedTop - 1 ||
		reading.pinnedTop - reading.top > reading.viewport
	)
		return false;
	if (!reading.running && reading.held !== true) return false;
	if (reading.shrunkTo !== null && reading.top <= reading.shrunkTo + CLAMP_SLACK_PX) return true;
	if (
		reading.height !== undefined &&
		reading.pinnedHeight !== undefined &&
		reading.height < reading.pinnedHeight - 1 &&
		reading.top <= reading.height - reading.viewport + CLAMP_SLACK_PX
	)
		return true;
	return reading.pinnedViewport !== undefined && reading.viewport !== reading.pinnedViewport;
}

/** The parts of a timeline item that say who wrote it; `snapshot.timeline` satisfies this. */
export interface ActivityItem {
	readonly id: string;
	readonly kind: string;
	readonly origin?: string;
}

/**
 * True when `next` is `previous` grown by a prompt the operator just sent: a live user item after
 * the last item `previous` ended on. Opening another task, or replaying history, is not a send.
 */
export function sentPrompt(previous: readonly ActivityItem[], next: readonly ActivityItem[]): boolean {
	const last = previous.at(-1);
	if (last === undefined || next === previous) return false;
	let sent = false;
	// A send lands at the end, so only the tail since the previous end is read.
	for (let index = next.length - 1; index >= Math.max(0, next.length - 64); index--) {
		const item = next[index];
		if (item === undefined) break;
		if (item.id === last.id) return sent;
		if (item.kind === "user" && item.origin !== "replay") sent = true;
	}
	return false;
}

function editable(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))
	);
}

/**
 * Keeps a scroll region pinned to its end while the operator is reading the
 * latest output, and stops the moment they scroll away. Growth is observed with
 * a ResizeObserver so no layout is read on the token path. A scroll event counts
 * as the operator's only when it moves above the last position this hook wrote,
 * so growth that lands between a write and its event never reads as a
 * scroll-away. `activityKey` changes whenever new activity arrives; that, not
 * layout growth, is what marks activity as unseen. Native scroll anchoring is
 * suspended while pinned, so a shrinking live header cannot move the viewport
 * above our last write and masquerade as the operator scrolling up. It resumes
 * when reading older content, where height changes must retain the reading edge.
 *
 * While a turn runs, an upward move with no reader input behind it, onto a layout that changed since
 * the last pin (content shrank, or the viewport resized), is the browser clamping scrollTop (a tool
 * group folding as the next paragraph arrives, the dock reflowing), not the reader leaving; it is
 * pinned back instead of ending follow (`browserClamp`). Any other upward move ends follow. Sending
 * a prompt from anywhere in the transcript returns to the live edge, where its answer will appear;
 * for `SEND_HOLD_MS` after it, a clamp counts as one even before the new turn shows as running.
 */
export function useFollowLatest(
	scrollRef: RefObject<HTMLElement | null>,
	enabled: boolean,
	activityKey: readonly ActivityItem[] | undefined,
	running = false,
): FollowLatest {
	const [following, setFollowing] = useState(true);
	const [unseen, setUnseen] = useState(false);
	const followingRef = useRef(true);
	const programmaticTop = useRef(0);
	/** `scrollHeight` and `clientHeight` when the hook last wrote. */
	const pinnedHeight = useRef(0);
	const pinnedViewport = useRef(0);
	const heldUntil = useRef(Number.NEGATIVE_INFINITY);
	const holdTimer = useRef<number | undefined>(undefined);
	const originalAnchor = useRef<string | null>(null);
	const wasRunning = useRef(running);
	const settling = useRef(false);
	const previousActivity = useRef(activityKey);
	const runningRef = useRef(running);
	runningRef.current = running;

	const markPinned = useCallback((element: HTMLElement) => {
		programmaticTop.current = element.scrollTop;
		pinnedHeight.current = element.scrollHeight;
		pinnedViewport.current = element.clientHeight;
	}, []);

	const endHold = useCallback(() => {
		heldUntil.current = Number.NEGATIVE_INFINITY;
		if (holdTimer.current !== undefined) clearTimeout(holdTimer.current);
		holdTimer.current = undefined;
		if (scrollRef.current !== null) delete scrollRef.current.dataset.followHold;
	}, [scrollRef]);

	const setFollow = useCallback(
		(next: boolean) => {
			followingRef.current = next;
			const element = scrollRef.current;
			if (element !== null) {
				originalAnchor.current ??= element.style.overflowAnchor;
				const anchor = originalAnchor.current;
				element.style.overflowAnchor = next ? "none" : anchor;
				// Read by follow-latest.css: a region the reader has left makes room for the jump control.
				element.dataset.followLatest = next ? "on" : "away";
			}
			setFollowing((current) => (current === next ? current : next));
			if (next) setUnseen(false);
		},
		[scrollRef],
	);

	useEffect(() => {
		const element = scrollRef.current;
		if (element === null || !enabled) return;
		originalAnchor.current ??= element.style.overflowAnchor;
		const anchor = originalAnchor.current;
		element.style.overflowAnchor = followingRef.current ? "none" : anchor;
		element.dataset.followLatest = followingRef.current ? "on" : "away";
		let viewportHeight = element.clientHeight;
		let intentAt = Number.NEGATIVE_INFINITY;
		let pressed = false;
		let shrunk: { readonly to: number; readonly at: number } | null = null;
		const shrunkTo = () => (shrunk !== null && performance.now() - shrunk.at < CLAMP_WINDOW_MS ? shrunk.to : null);
		const intended = () => pressed || performance.now() - intentAt < INTENT_MS;
		const atBottom = () => element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_TOLERANCE_PX;
		const pin = () => {
			element.scrollTop = element.scrollHeight;
			markPinned(element);
			viewportHeight = element.clientHeight;
		};
		const onScroll = () => {
			const top = element.scrollTop;
			const height = element.clientHeight;
			const contentHeight = element.scrollHeight;
			// Focusing a growing composer can nudge scrollTop a few pixels before
			// ResizeObserver pins the shorter viewport. Keep that resize at the live
			// edge; a larger upward move still belongs to the reader.
			if (
				followingRef.current &&
				height !== viewportHeight &&
				Math.abs(top - programmaticTop.current) <= BOTTOM_TOLERANCE_PX
			) {
				pin();
				return;
			}
			viewportHeight = height;
			if (atBottom()) {
				markPinned(element);
				setFollow(true);
				return;
			}
			if (followingRef.current && settling.current) return;
			if (
				browserClamp({
					top,
					pinnedTop: programmaticTop.current,
					viewport: height,
					following: followingRef.current,
					running: runningRef.current,
					intended: intended(),
					shrunkTo: shrunkTo(),
					height: contentHeight,
					pinnedHeight: pinnedHeight.current,
					pinnedViewport: pinnedViewport.current,
					held: performance.now() < heldUntil.current,
				})
			) {
				pin();
				return;
			}
			if (top < programmaticTop.current - 1 || !followingRef.current) {
				shrunk = null;
				setFollow(false);
			}
		};
		const readIntent = (event: Event) => {
			if (event instanceof KeyboardEvent && !NAV_KEYS.has(event.key)) return;
			if (event.target instanceof Node && element.contains(event.target)) {
				settling.current = false;
				endHold();
				intentAt = performance.now();
				if (event.type === "pointerdown") pressed = true;
			}
		};
		// Keys scroll the region last pointed at even while focus sits outside it, but not from a field.
		const readKey = (event: KeyboardEvent) => {
			if (NAV_KEYS.has(event.key) && !editable(event.target)) {
				intentAt = performance.now();
				endHold();
			}
		};
		const release = () => {
			pressed = false;
		};
		const intentEvents = ["wheel", "touchmove", "pointerdown", "keydown", "focusin"] as const;
		for (const type of intentEvents) element.addEventListener(type, readIntent, { passive: true, capture: true });
		window.addEventListener("keydown", readKey, { passive: true, capture: true });
		window.addEventListener("pointerup", release, { passive: true, capture: true });
		window.addEventListener("pointercancel", release, { passive: true, capture: true });
		element.addEventListener("scroll", onScroll, { passive: true });
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(() => {
						if (!followingRef.current) return;
						// Layout is fresh here, so this read costs nothing. Content that shrank below the last
						// pin lowers how far a browser clamp can move the view before the next pin lands.
						const max = element.scrollHeight - element.clientHeight;
						if (max < programmaticTop.current - 1) shrunk = { to: Math.min(max, shrunkTo() ?? max), at: performance.now() };
						pin();
					});
		// The viewport itself changes height as the dock grows, while its child changes
		// height as output arrives. Both must retain the live edge when follow is on.
		observer?.observe(element);
		if (observer === null) window.addEventListener("resize", pin);
		// The transcript element is replaced when a session opens or the route
		// changes, so the content observation follows whichever child is current.
		let observed: Element | null = null;
		const observeContent = () => {
			const content = element.firstElementChild;
			if (content === observed) return;
			if (observed !== null) observer?.unobserve(observed);
			observed = content;
			if (content !== null) observer?.observe(content);
		};
		observeContent();
		const children = typeof MutationObserver === "undefined" ? null : new MutationObserver(observeContent);
		children?.observe(element, { childList: true });
		return () => {
			element.style.overflowAnchor = anchor;
			delete element.dataset.followLatest;
			originalAnchor.current = null;
			for (const type of intentEvents) element.removeEventListener(type, readIntent, true);
			window.removeEventListener("keydown", readKey, true);
			window.removeEventListener("pointerup", release, true);
			window.removeEventListener("pointercancel", release, true);
			element.removeEventListener("scroll", onScroll);
			observer?.disconnect();
			if (observer === null) window.removeEventListener("resize", pin);
			children?.disconnect();
			endHold();
		};
	}, [scrollRef, enabled, setFollow, markPinned, endHold]);

	useLayoutEffect(() => {
		const finished = wasRunning.current && !running;
		wasRunning.current = running;
		if (!finished || !enabled || !followingRef.current) return;
		// Canonical Markdown and the live header can shrink then grow in one frame.
		// Let ResizeObserver pin that final height before classifying its browser
		// clamp as reading away. Reader input cancels this guard immediately.
		settling.current = true;
		let timer: number | undefined;
		const frame = requestAnimationFrame(() => {
			timer = window.setTimeout(() => {
				settling.current = false;
			}, 0);
		});
		return () => {
			cancelAnimationFrame(frame);
			if (timer !== undefined) clearTimeout(timer);
			settling.current = false;
		};
	}, [enabled, running]);

	// Older browsers without ResizeObserver still follow streamed text, whose edits do not
	// necessarily change the transcript's child list. Pin before paint to avoid a visible jump.
	// biome-ignore lint/correctness/useExhaustiveDependencies: activityKey is the trigger, not a read value.
	useLayoutEffect(() => {
		if (!enabled || typeof ResizeObserver !== "undefined" || !followingRef.current) return;
		const element = scrollRef.current;
		if (element === null) return;
		element.scrollTop = element.scrollHeight;
		markPinned(element);
	}, [activityKey, enabled, scrollRef, running, markPinned]);

	const snapshot = useCallback(
		(): ScrollPosition => ({ top: scrollRef.current?.scrollTop ?? 0, following: followingRef.current }),
		[scrollRef],
	);

	/** A non-following view returns to its offset and stays unpinned even if the new content fits. */
	const restore = useCallback(
		(position: ScrollPosition) => {
			const element = scrollRef.current;
			if (element === null) return;
			endHold();
			setFollow(position.following);
			element.scrollTop = position.following ? element.scrollHeight : position.top;
			markPinned(element);
		},
		[scrollRef, setFollow, markPinned, endHold],
	);

	const jumpToLatest = useCallback(() => {
		const element = scrollRef.current;
		if (element === null) return;
		setFollow(true);
		// A smooth animation targets an old height and competes with ResizeObserver's
		// live-edge writes. Land once, synchronously, so its intermediate scroll events
		// cannot look like the operator scrolling away from newly arrived content.
		element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
		markPinned(element);
	}, [scrollRef, setFollow, markPinned]);

	useLayoutEffect(() => {
		const previous = previousActivity.current;
		previousActivity.current = activityKey;
		// Restoring an existing transcript is not new activity below the reader.
		if (previous === undefined || activityKey === undefined || previous === activityKey) return;
		if (enabled && sentPrompt(previous, activityKey)) {
			// A send lands on the live edge, from wherever the reader was, and stays there while the
			// cleared composer, the status chip and the new turn reflow the viewport, even before the
			// turn shows as running.
			jumpToLatest();
			endHold();
			heldUntil.current = performance.now() + SEND_HOLD_MS;
			const element = scrollRef.current;
			// Read by browser-smoke, so its scripted move lands after the send's reflow.
			if (element !== null) element.dataset.followHold = "";
			holdTimer.current = window.setTimeout(endHold, SEND_HOLD_MS);
		} else if (!followingRef.current) setUnseen(true);
	}, [activityKey, enabled, jumpToLatest, endHold, scrollRef]);

	return { following, unseen, jumpToLatest, snapshot, restore };
}
