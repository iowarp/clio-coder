import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Client } from "../api/client.js";
import { sessionReadScope } from "../api/sessions.js";
import type { FollowLatest } from "../render/follow-latest.js";
import {
	createTranscriptViewStore,
	TRANSCRIPT_PAGE_SIZE,
	TRANSCRIPT_SLICE_SIZE,
	transcriptStart,
} from "./transcript-view-model.js";
import type { ChatTurn } from "./turns.js";

const clients = new WeakMap<Client, ReturnType<typeof createTranscriptViewStore>>();

/**
 * Which turns of a conversation are mounted. `start` is where the page begins; the mounted turns
 * reach it a slice per frame, newest first, so opening a page never mounts all of it in one task.
 */
export function useTranscriptView(
	client: Client,
	sessionId: string,
	turns: readonly ChatTurn[],
	ready: boolean,
	scroll: RefObject<HTMLElement | null>,
	follow: FollowLatest,
) {
	let store = clients.get(client);
	if (!store) {
		store = createTranscriptViewStore();
		clients.set(client, store);
	}
	const scope = sessionReadScope(sessionId);
	const [anchor, setAnchor] = useState(() => store.read(sessionId, scope)?.startTurnId ?? null);
	// The first turn mounted while a page is still being revealed; null once all of it is.
	const [shown, setShown] = useState<string | null>(null);
	const initialized = useRef<number | null>(null);
	const start = transcriptStart(turns, anchor);
	const shownIndex = shown === null ? -1 : turns.findIndex((turn) => turn.turnId === shown);
	// A view that opens at the live edge mounts its newest slice first; one returning to a saved
	// place mounts the whole page, which is what that place was measured against.
	const opening = initialized.current !== scope && (store.read(sessionId, scope)?.following ?? true);
	const mounted = Math.max(start, opening ? turns.length - TRANSCRIPT_SLICE_SIZE : shownIndex);
	const first = turns[start]?.turnId ?? null;
	const initialFirst = turns[Math.max(0, turns.length - TRANSCRIPT_PAGE_SIZE)]?.turnId ?? null;
	const latest = useRef({ first, follow, turns });
	latest.current = { first, follow, turns };
	const reveal = useRef(false);
	useLayoutEffect(() => {
		if (!ready || initialized.current === scope) return;
		initialized.current = scope;
		const saved = store.read(sessionId, scope);
		const position = saved ?? { top: 0, following: true };
		const all = latest.current.turns;
		setAnchor(saved?.startTurnId ?? initialFirst);
		setShown(position.following ? (all[Math.max(0, all.length - TRANSCRIPT_SLICE_SIZE)]?.turnId ?? null) : null);
		latest.current.follow.restore(position);
	}, [ready, scope, store, sessionId, initialFirst]);
	useLayoutEffect(() => {
		if (anchor === null && first !== null) setAnchor(first);
	}, [anchor, first]);
	// Streamed deltas replace `turns` many times a frame; the next slice waits on indexes only.
	useEffect(() => {
		if (shown === null) return;
		if (shownIndex <= start) {
			setShown(null);
			return;
		}
		const frame = requestAnimationFrame(() => {
			setShown(latest.current.turns[Math.max(start, shownIndex - TRANSCRIPT_SLICE_SIZE)]?.turnId ?? null);
		});
		return () => cancelAnimationFrame(frame);
	}, [shown, shownIndex, start]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the last slice commits the revealed page before focus and scroll move.
	useLayoutEffect(() => {
		if (!reveal.current || shown !== null) return;
		reveal.current = false;
		follow.restore({ top: 0, following: false });
		scroll.current?.querySelector<HTMLElement>("[data-turn-id]")?.focus({ preventScroll: true });
	}, [anchor, shown, follow.restore, scroll]);
	useLayoutEffect(
		() => () => {
			if (initialized.current !== scope) return;
			store.remember(sessionId, scope, {
				...latest.current.follow.snapshot(),
				startTurnId: latest.current.first,
			});
		},
		[scope, store, sessionId],
	);
	return {
		start,
		turns: turns.slice(mounted),
		earlier: () => {
			const target = Math.max(0, start - TRANSCRIPT_PAGE_SIZE);
			follow.restore({ ...follow.snapshot(), following: false });
			reveal.current = true;
			setShown(turns[Math.max(target, mounted - TRANSCRIPT_SLICE_SIZE)]?.turnId ?? null);
			setAnchor(turns[target]?.turnId ?? null);
		},
		revealTurn: (turnId: string) => {
			const index = turns.findIndex((turn) => turn.turnId === turnId);
			if (index < 0 || index >= mounted) return;
			// The outline lands on the turn two frames later, so its page mounts at once and the
			// outline, not the page reveal, places the reader.
			reveal.current = false;
			setShown(null);
			if (index < start) setAnchor(turnId);
		},
	};
}
