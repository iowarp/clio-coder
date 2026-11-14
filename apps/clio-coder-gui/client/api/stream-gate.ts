import type { Client } from "./client.js";

/** How long a read waits for an event stream that has not been opened at all. */
const UNSUBSCRIBED_WAIT_MS = 1_500;

interface Gate {
	open: boolean;
	waiters: Set<() => void>;
}

const gates = new WeakMap<Client, Gate>();

function gate(client: Client): Gate {
	let held = gates.get(client);
	if (!held) {
		held = { open: false, waiters: new Set() };
		gates.set(client, held);
	}
	return held;
}

/**
 * The event stream has said hello, or will not soon (it is retrying or refused). A read waiting in `afterStreamHello`
 * goes ahead; one the hello invalidated in the same frame was cancelled before it reached the network.
 */
export function releaseStreamReads(client: Client) {
	const held = gate(client);
	held.open = true;
	for (const wake of held.waiters) wake();
	held.waiters.clear();
}

/**
 * Waits until the client's event stream is open before a read whose result the stream's first hello would otherwise
 * supersede, so a page load asks once instead of asking, cancelling and asking again. A client that has no stream
 * within a moment (not signed in, or never subscribed) reads anyway.
 */
export function afterStreamHello(client: Client, signal?: AbortSignal): Promise<void> {
	if (!client.signedIn) return Promise.resolve();
	const held = gate(client);
	if (held.open) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const done = () => {
			clearTimeout(timer);
			held.waiters.delete(done);
			signal?.removeEventListener("abort", abort);
			if (signal?.aborted) reject(signal.reason);
			else resolve();
		};
		const abort = () => done();
		const timer = setTimeout(done, UNSUBSCRIBED_WAIT_MS);
		held.waiters.add(done);
		signal?.addEventListener("abort", abort, { once: true });
	});
}
