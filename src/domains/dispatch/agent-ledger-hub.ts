/**
 * Agent ledger fan-out inside one orchestrator process.
 *
 * Deltas are pushed, never polled. A worker keeps a local mirror fed by
 * `ledger_delta` stdin frames and answers its own reads from it, so no tool
 * call ever blocks on a round trip and no worker has a reason to spin.
 *
 * This registry is in-memory and deliberately not persisted. The store holds
 * the durable board; the hub only knows which live subscribers to notify.
 */

import type { AgentLedgerEntry } from "../../worker/protocol.js";
import { readAgentLedger } from "./agent-ledger-store.js";

/** Returns false when the worker is unreachable, which retires the subscriber. */
export type AgentLedgerDeliver = (entries: ReadonlyArray<AgentLedgerEntry>) => boolean;

interface Subscriber {
	runId: string;
	deliver: AgentLedgerDeliver;
}

const subscribers = new Map<string, Set<Subscriber>>();

/**
 * Subscribe one run and hand it the full current board immediately, so its
 * mirror is complete regardless of when it spawned. Returns the unsubscribe.
 */
export function subscribeAgentLedger(ledgerId: string, runId: string, deliver: AgentLedgerDeliver): () => void {
	const subscriber: Subscriber = { runId, deliver };
	const existing = subscribers.get(ledgerId) ?? new Set<Subscriber>();
	existing.add(subscriber);
	subscribers.set(ledgerId, existing);

	const record = readAgentLedger(ledgerId);
	if (record !== null && record.entries.length > 0) {
		if (!deliver(record.entries)) {
			existing.delete(subscriber);
			return () => {};
		}
	}

	return () => {
		const set = subscribers.get(ledgerId);
		if (set === undefined) return;
		set.delete(subscriber);
		if (set.size === 0) subscribers.delete(ledgerId);
	};
}

/**
 * Notify every subscriber of one newly admitted entry, including the author's
 * own run, so a worker's mirror carries its own attributed entries with the
 * ids and conflict stamps the orchestrator assigned.
 */
export function publishAgentLedgerEntry(ledgerId: string, entry: AgentLedgerEntry): void {
	const set = subscribers.get(ledgerId);
	if (set === undefined) return;
	for (const subscriber of [...set]) {
		let reachable = false;
		try {
			reachable = subscriber.deliver([entry]);
		} catch {
			reachable = false;
		}
		// An unreachable worker is dropped silently. Staleness is declared by the
		// mirror's watermark and no receipt depends on a mirror.
		if (!reachable) set.delete(subscriber);
	}
	if (set.size === 0) subscribers.delete(ledgerId);
}
