import { randomUUID } from "node:crypto";
import type { Event, EventInput } from "../../contracts/events.js";

export class EventHub {
	readonly epoch = randomUUID();
	seq = 0;
	private ring: { event: Event; bytes: number }[] = [];
	private bytes = 0;
	private listeners = new Set<(event: Event) => void>();
	get size() {
		return this.ring.length;
	}
	get byteSize() {
		return this.bytes;
	}
	publish(input: EventInput): Event {
		const event = { ...input, v: 1 as const, epoch: this.epoch, seq: ++this.seq, at: new Date().toISOString() } as Event;
		const bytes = Buffer.byteLength(JSON.stringify(event));
		this.ring.push({ event, bytes });
		this.bytes += bytes;
		while (this.ring.length > 4096 || this.bytes > 8 * 1024 * 1024) {
			const oldest = this.ring.shift();
			if (oldest) this.bytes -= oldest.bytes;
		}
		for (const listener of this.listeners) listener(event);
		return event;
	}
	connect(cursor: string | undefined, receive: (event: Event) => void): () => void {
		const [epoch, sequence] = cursor?.split(":") ?? [];
		const seq = Number(sequence);
		const reason =
			cursor && epoch !== this.epoch
				? "epoch"
				: cursor && (!Number.isSafeInteger(seq) || seq > this.seq || seq < (this.ring[0]?.event.seq ?? this.seq + 1) - 1)
					? "evicted"
					: undefined;
		// Subscribe and replay in one synchronous step; no event can fall between them.
		this.listeners.add(receive);
		if (reason) receive(this.control("resync", reason));
		else if (cursor)
			for (const { event } of this.ring) {
				if (event.seq > seq) receive(event);
			}
		receive(this.control("hello"));
		return () => this.listeners.delete(receive);
	}
	private control(type: "hello" | "resync", reason: "epoch" | "evicted" = "epoch"): Event {
		const base = { v: 1 as const, epoch: this.epoch, seq: this.seq, at: new Date().toISOString() };
		return type === "hello"
			? { ...base, type, payload: { epoch: this.epoch, seq: this.seq } }
			: { ...base, type, payload: { epoch: this.epoch, seq: this.seq, reason } };
	}
}
