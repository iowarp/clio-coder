import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { Client } from "../api/client.js";
import { sessionReadScope } from "../api/sessions.js";
import type { FollowLatest } from "../render/follow-latest.js";
import { createTranscriptViewStore, TRANSCRIPT_PAGE_SIZE, transcriptStart } from "./transcript-view-model.js";
import type { ChatTurn } from "./turns.js";

const clients = new WeakMap<Client, ReturnType<typeof createTranscriptViewStore>>();

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
	const start = transcriptStart(turns, anchor);
	const first = turns[start]?.turnId ?? null;
	const initialFirst = turns[Math.max(0, turns.length - TRANSCRIPT_PAGE_SIZE)]?.turnId ?? null;
	const latest = useRef({ first, follow });
	latest.current = { first, follow };
	const initialized = useRef<number | null>(null);
	const reveal = useRef(false);
	useLayoutEffect(() => {
		if (!ready || initialized.current === scope) return;
		initialized.current = scope;
		const saved = store.read(sessionId, scope);
		setAnchor(saved?.startTurnId ?? initialFirst);
		latest.current.follow.restore(saved ?? { top: 0, following: true });
	}, [ready, scope, store, sessionId, initialFirst]);
	useLayoutEffect(() => {
		if (anchor === null && first !== null) setAnchor(first);
	}, [anchor, first]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the changed anchor commits the newly revealed DOM before focus and scroll move.
	useLayoutEffect(() => {
		if (!reveal.current) return;
		reveal.current = false;
		follow.restore({ top: 0, following: false });
		scroll.current?.querySelector<HTMLElement>("[data-turn-id]")?.focus({ preventScroll: true });
	}, [anchor, follow.restore, scroll]);
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
		turns: turns.slice(start),
		earlier: () => {
			follow.restore({ ...follow.snapshot(), following: false });
			reveal.current = true;
			setAnchor(turns[Math.max(0, start - TRANSCRIPT_PAGE_SIZE)]?.turnId ?? null);
		},
		revealTurn: (turnId: string) => {
			const index = turns.findIndex((turn) => turn.turnId === turnId);
			if (index >= 0 && index < start) setAnchor(turnId);
		},
	};
}
