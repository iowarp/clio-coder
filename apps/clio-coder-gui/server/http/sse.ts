import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { type Event, EventCursor } from "../../contracts/events.js";
import type { EventHub } from "../services/event-hub.js";
import { parse } from "./validate.js";

export function events(context: Context, hub: EventHub, after?: string) {
	const cursor = context.req.header("Last-Event-ID") ?? after;
	if (cursor !== undefined) parse(EventCursor, cursor);
	return streamSSE(context, async (stream) => {
		let queuedBytes = 0;
		let pending = Promise.resolve();
		let finish: () => void = () => {};
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let stopped = false;
		const stop = () => {
			stopped = true;
			finish();
		};
		stream.onAbort(stop);
		const receive = (event: Event) => {
			if (stopped) return;
			const data = JSON.stringify(event),
				bytes = Buffer.byteLength(data);
			queuedBytes += bytes;
			// A retained replay can be the full 8 MiB ring before the first async
			// write drains. Reserve that burst plus 512 KiB for concurrent live work.
			if (queuedBytes > 8 * 1024 * 1024 + 512 * 1024) {
				stop();
				stream.abort();
				return;
			}
			pending = pending
				.then(async () => {
					if (!stopped) await stream.writeSSE({ id: `${event.epoch}:${event.seq}`, event: event.type, data });
					queuedBytes -= bytes;
				})
				.catch(stop);
		};
		const unsubscribe = hub.connect(cursor, receive);
		const heartbeat = setInterval(() => {
			if (queuedBytes === 0 && !stopped)
				pending = pending
					.then(async () => {
						await stream.write(": heartbeat\n\n");
					})
					.catch(stop);
		}, 15_000);
		try {
			await done;
		} finally {
			clearInterval(heartbeat);
			unsubscribe();
		}
	});
}
