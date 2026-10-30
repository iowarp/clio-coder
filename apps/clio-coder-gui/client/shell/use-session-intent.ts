import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import type { Client } from "../api/client.js";
import { sessionQuery } from "../api/session-query.js";

/** Warm only the task the reader pauses on. No runtime is started and no saved task is loaded. */
export function useSessionIntent(client: Client, sessionId: string, enabled = true) {
	const queries = useQueryClient();
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancel = useCallback(() => {
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = null;
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: changing the destination cancels its previous intent timer.
	useEffect(() => cancel, [sessionId, enabled, cancel]);
	const warm = () => {
		cancel();
		if (!enabled) return;
		timer.current = setTimeout(() => {
			timer.current = null;
			if (queries.isFetching({ queryKey: ["session"] })) return;
			void queries.prefetchQuery(sessionQuery(client, sessionId));
		}, 120);
	};
	return { onPointerEnter: warm, onPointerLeave: cancel, onFocus: warm, onBlur: cancel };
}
