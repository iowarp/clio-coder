/**
 * Agent ledger fan-out inside one orchestrator process.
 *
 * Local commits push immediately; a background refresh observes other processes. A worker keeps a local mirror fed by
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
	watermark: number;
}

const subscribers = new Map<string, Set<Subscriber>>();

/**
 * Subscribe one run and hand it the full current board immediately, so its
 * mirror is complete regardless of when it spawned. Returns the unsubscribe.
 */
export function subscribeAgentLedger(ledgerId: string, runId: string, deliver: AgentLedgerDeliver): () => void {
	const subscriber: Subscriber = { runId, deliver, watermark: 0 };
	const existing = subscribers.get(ledgerId) ?? new Set<Subscriber>();
	existing.add(subscriber);
	subscribers.set(ledgerId, existing);

	refreshLedger(ledgerId);
	startRefresh();

	return () => {
		const set = subscribers.get(ledgerId);
		if (set === undefined) return;
		set.delete(subscriber);
		if (set.size === 0) subscribers.delete(ledgerId);
		stopRefreshIfIdle();
	};
}

/**
 * Notify every subscriber of one newly admitted entry, including the author's
 * own run, so a worker's mirror carries its own attributed entries with the
 * ids and conflict stamps the orchestrator assigned.
 */
export function publishAgentLedgerEntry(ledgerId: string, _entry: AgentLedgerEntry): void {
	refreshLedger(ledgerId);
}

let refreshTimer: ReturnType<typeof setInterval> | undefined;

function stopRefreshIfIdle(): void {
	if (subscribers.size === 0 && refreshTimer !== undefined) {
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}
}

function startRefresh(): void {
	if (refreshTimer !== undefined || subscribers.size === 0) return;
	refreshTimer = setInterval(() => {
		for (const id of subscribers.keys()) refreshLedger(id);
	}, 500);
	refreshTimer.unref();
}

function refreshLedger(ledgerId: string): void {
	const set = subscribers.get(ledgerId);
	if (set === undefined) return;
	let entries: ReadonlyArray<AgentLedgerEntry>;
	try {
		entries = readAgentLedger(ledgerId)?.entries ?? [];
	} catch {
		// A transient read failure retries on the next background refresh.
		return;
	}
	for (const subscriber of [...set]) {
		const delta = entries.filter((entry) => entry.sequence > subscriber.watermark);
		if (delta.length === 0) continue;
		try {
			if (!subscriber.deliver(delta)) set.delete(subscriber);
			else subscriber.watermark = delta[delta.length - 1]?.sequence ?? subscriber.watermark;
		} catch {
			// Broken transports are retired; durable entries remain replayable.
			set.delete(subscriber);
		}
	}
	if (set.size === 0) subscribers.delete(ledgerId);
	stopRefreshIfIdle();
}
