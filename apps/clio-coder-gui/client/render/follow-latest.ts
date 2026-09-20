import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

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
const SETTLE_TIMEOUT_MS = 1_200;

/**
 * Keeps a scroll region pinned to its end while the operator is reading the
 * latest output, and stops the moment they scroll away. Growth is observed with
 * a ResizeObserver so no layout is read on the token path. A scroll event counts
 * as the operator's only when it moves above the last position this hook wrote,
 * so growth that lands between a write and its event never reads as a
 * scroll-away. `activityKey` changes whenever new activity arrives; that, not
 * layout growth, is what marks activity as unseen.
 */
export function useFollowLatest(
	scrollRef: RefObject<HTMLElement | null>,
	enabled: boolean,
	activityKey: unknown,
): FollowLatest {
	const [following, setFollowing] = useState(true);
	const [unseen, setUnseen] = useState(false);
	const followingRef = useRef(true);
	const programmaticTop = useRef(0);
	const settling = useRef<{ lastTop: number; startedAt: number } | null>(null);

	const setFollow = useCallback((next: boolean) => {
		followingRef.current = next;
		setFollowing((current) => (current === next ? current : next));
		if (next) setUnseen(false);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: activityKey is the trigger, not a read value; a changed key is what marks new output unseen.
	useEffect(() => {
		if (!followingRef.current) setUnseen(true);
	}, [activityKey]);

	useEffect(() => {
		const element = scrollRef.current;
		if (element === null || !enabled) return;
		const atBottom = () => element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_TOLERANCE_PX;
		const pin = () => {
			element.scrollTop = element.scrollHeight;
			programmaticTop.current = element.scrollTop;
		};
		const onScroll = () => {
			const top = element.scrollTop;
			const settle = settling.current;
			if (settle !== null) {
				const movedUp = top < settle.lastTop - 1;
				const expired = Date.now() - settle.startedAt > SETTLE_TIMEOUT_MS;
				if (atBottom()) {
					settling.current = null;
					programmaticTop.current = top;
					setFollow(true);
					return;
				}
				if (!movedUp && !expired) {
					settle.lastTop = top;
					return;
				}
				settling.current = null;
			}
			if (atBottom()) {
				programmaticTop.current = top;
				setFollow(true);
				return;
			}
			if (top < programmaticTop.current - 1 || !followingRef.current) setFollow(false);
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(() => {
						if (followingRef.current) pin();
					});
		// The transcript element is replaced when a session opens or the route
		// changes, so the size observation follows whichever child is current.
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
			element.removeEventListener("scroll", onScroll);
			observer?.disconnect();
			children?.disconnect();
		};
	}, [scrollRef, enabled, setFollow]);

	const snapshot = useCallback(
		(): ScrollPosition => ({ top: scrollRef.current?.scrollTop ?? 0, following: followingRef.current }),
		[scrollRef],
	);

	/** A non-following view returns to its offset and stays unpinned even if the new content fits. */
	const restore = useCallback(
		(position: ScrollPosition) => {
			const element = scrollRef.current;
			if (element === null) return;
			settling.current = null;
			setFollow(position.following);
			element.scrollTop = position.following ? element.scrollHeight : position.top;
			programmaticTop.current = element.scrollTop;
		},
		[scrollRef, setFollow],
	);

	const jumpToLatest = useCallback(() => {
		const element = scrollRef.current;
		if (element === null) return;
		const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
		setFollow(true);
		if (reduced) {
			element.scrollTop = element.scrollHeight;
			programmaticTop.current = element.scrollTop;
			return;
		}
		settling.current = { lastTop: element.scrollTop, startedAt: Date.now() };
		element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
	}, [scrollRef, setFollow]);

	return { following, unseen, jumpToLatest, snapshot, restore };
}
