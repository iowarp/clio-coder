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
	const originalAnchor = useRef<string | null>(null);

	const setFollow = useCallback(
		(next: boolean) => {
			followingRef.current = next;
			const element = scrollRef.current;
			if (element !== null) {
				originalAnchor.current ??= element.style.overflowAnchor;
				const anchor = originalAnchor.current;
				element.style.overflowAnchor = next ? "none" : anchor;
			}
			setFollowing((current) => (current === next ? current : next));
			if (next) setUnseen(false);
		},
		[scrollRef],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: activityKey is the trigger, not a read value; a changed key is what marks new output unseen.
	useEffect(() => {
		if (!followingRef.current) setUnseen(true);
	}, [activityKey]);

	useEffect(() => {
		const element = scrollRef.current;
		if (element === null || !enabled) return;
		originalAnchor.current ??= element.style.overflowAnchor;
		const anchor = originalAnchor.current;
		element.style.overflowAnchor = followingRef.current ? "none" : anchor;
		let viewportHeight = element.clientHeight;
		const atBottom = () => element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_TOLERANCE_PX;
		const pin = () => {
			element.scrollTop = element.scrollHeight;
			programmaticTop.current = element.scrollTop;
			viewportHeight = element.clientHeight;
		};
		const onScroll = () => {
			const top = element.scrollTop;
			const height = element.clientHeight;
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
			originalAnchor.current = null;
			element.removeEventListener("scroll", onScroll);
			observer?.disconnect();
			if (observer === null) window.removeEventListener("resize", pin);
			children?.disconnect();
		};
	}, [scrollRef, enabled, setFollow]);

	// Older browsers without ResizeObserver still follow streamed text, whose edits do not
	// necessarily change the transcript's child list. Pin before paint to avoid a visible jump.
	// biome-ignore lint/correctness/useExhaustiveDependencies: activityKey is the trigger, not a read value.
	useLayoutEffect(() => {
		if (!enabled || typeof ResizeObserver !== "undefined" || !followingRef.current) return;
		const element = scrollRef.current;
		if (element === null) return;
		element.scrollTop = element.scrollHeight;
		programmaticTop.current = element.scrollTop;
	}, [activityKey, enabled, scrollRef]);

	const snapshot = useCallback(
		(): ScrollPosition => ({ top: scrollRef.current?.scrollTop ?? 0, following: followingRef.current }),
		[scrollRef],
	);

	/** A non-following view returns to its offset and stays unpinned even if the new content fits. */
	const restore = useCallback(
		(position: ScrollPosition) => {
			const element = scrollRef.current;
			if (element === null) return;
			setFollow(position.following);
			element.scrollTop = position.following ? element.scrollHeight : position.top;
			programmaticTop.current = element.scrollTop;
		},
		[scrollRef, setFollow],
	);

	const jumpToLatest = useCallback(() => {
		const element = scrollRef.current;
		if (element === null) return;
		setFollow(true);
		// A smooth animation targets an old height and competes with ResizeObserver's
		// live-edge writes. Land once, synchronously, so its intermediate scroll events
		// cannot look like the operator scrolling away from newly arrived content.
		element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
		programmaticTop.current = element.scrollTop;
	}, [scrollRef, setFollow]);

	return { following, unseen, jumpToLatest, snapshot, restore };
}
