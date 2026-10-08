import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { routes } from "../../../contracts/routes.js";
import type { TraceEvent } from "../../../contracts/traces.js";
import { onTokenRejected, tokenRejected } from "../../api/auth-state.js";
import { type Client, emptyInput } from "../../api/client.js";
import { lastRowid, mergeTraceEvents, runIsLive, type TraceLiveState } from "./trace-live-model.js";

const eventsKey = (runId: string) => ["trace-events", runId] as const;

/**
 * Tails a live run's events over `routes.traceLive` and appends them to the `trace-events` query.
 * EventSource cannot send headers, so the launch token rides in the query as it does for the app
 * stream. A dropped connection resumes from the held rowid: the browser's own retry sends
 * Last-Event-ID, and a closed source reopens with `after` set to the last cached row.
 */
export function useTraceLive(client: Client, runId: string, eventsReady: boolean, status: string | undefined) {
	const queries = useQueryClient();
	const [state, setState] = useState<TraceLiveState>("idle");
	const enabled = eventsReady && runIsLive(status);
	const terminal = eventsReady && (status === "success" || status === "fail" || state === "finished");
	useEffect(() => {
		if (!enabled) {
			setState((current) => (current === "finished" ? current : "idle"));
			return;
		}
		return tail(client, queries, runId, setState);
	}, [client, queries, runId, enabled]);
	useEffect(() => {
		if (!terminal) return;
		// Initial events must land before this refresh; invalidating a pending read can reuse its
		// unfinished snapshot. Either terminal signal then reconciles rows and header facts once.
		void queries.invalidateQueries({ queryKey: ["trace-events", runId] });
		void queries.invalidateQueries({ queryKey: ["trace-detail", runId] });
	}, [queries, runId, terminal]);
	return state;
}

function tail(client: Client, queries: QueryClient, runId: string, setState: (state: TraceLiveState) => void) {
	let source: EventSource | null = null,
		retryTimer: ReturnType<typeof setTimeout> | null = null,
		flushTimer: ReturnType<typeof setTimeout> | null = null,
		retryMs = 1_000,
		disposed = false;
	const pending: TraceEvent[] = [];
	// Coalesces a burst of rows into one cache write, so a busy run re-renders a few times a second.
	const flush = () => {
		if (flushTimer !== null) clearTimeout(flushTimer);
		flushTimer = null;
		if (!pending.length) return;
		const rows = pending.splice(0);
		queries.setQueryData<TraceEvent[]>(eventsKey(runId), (previous) => mergeTraceEvents(previous, rows));
	};
	const stop = (state: TraceLiveState) => {
		flush();
		source?.close();
		source = null;
		setState(state);
	};
	const connect = () => {
		retryTimer = null;
		if (disposed || tokenRejected()) return;
		const query = new URLSearchParams({
			after: String(lastRowid(queries.getQueryData<TraceEvent[]>(eventsKey(runId)))),
			token: client.token,
		});
		const opened = new EventSource(`${routes.traceLive.path.replace(":runId", encodeURIComponent(runId))}?${query}`);
		source = opened;
		const current = () => !disposed && source === opened;
		opened.addEventListener("ready", () => {
			if (!current()) return;
			retryMs = 1_000;
			setState("live");
		});
		opened.addEventListener("trace.event", (message) => {
			if (!current()) return;
			pending.push(JSON.parse((message as MessageEvent<string>).data) as TraceEvent);
			flushTimer ??= setTimeout(flush, 100);
		});
		opened.addEventListener("finished", () => {
			if (!current()) return;
			stop("finished");
		});
		// The server reports a failed read once and ends the stream; polling covers the page from here.
		opened.addEventListener("problem", () => {
			if (current()) stop("unavailable");
		});
		opened.onerror = () => {
			if (!current()) return;
			flush();
			setState("reconnecting");
			// The browser retries a CONNECTING source itself, sending Last-Event-ID.
			if (opened.readyState !== EventSource.CLOSED) return;
			opened.close();
			source = null;
			// The stream hides its HTTP status; an ordinary read lets the client notice a refused token.
			void client.call(routes.meta, emptyInput).catch(() => {});
			retryTimer = setTimeout(connect, retryMs);
			retryMs = Math.min(retryMs * 2, 30_000);
		};
	};
	setState("connecting");
	connect();
	const stopWatching = onTokenRejected(() => {
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
		stop("unavailable");
	});
	return () => {
		disposed = true;
		stopWatching();
		if (retryTimer !== null) clearTimeout(retryTimer);
		flush();
		source?.close();
		source = null;
	};
}
