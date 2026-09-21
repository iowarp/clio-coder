/**
 * A synchronous quota line for render paths, refreshed off the frame.
 *
 * The welcome banner and the footer are called on every frame and may not
 * await anything or touch the network. This feed answers instantly from the
 * last reading, and when that reading is missing or stale it starts one in
 * the background and calls `onUpdate` when a newer line is ready, which is
 * how a frame gets requested. That keeps the decision log's lazy refresh
 * rule: a read happens because a surface was looked at, never on a timer.
 */

import { quotaSummaryLine } from "./presentation.js";
import { createQuotaService, type QuotaService } from "./service.js";
import type { UsageSnapshot } from "./types.js";

export const QUOTA_SUMMARY_TTL_MS = 5 * 60_000;

export interface QuotaSummaryFeedOptions {
	service?: QuotaService;
	/** Called after a background read changed any snapshot detail. */
	onUpdate?: () => void;
	ttlMs?: number;
	now?: () => number;
}

export interface QuotaSummaryFeed {
	/** The current line, or null until the first reading lands. Never blocks. */
	peek(): string | null;
	peekSnapshots(): ReadonlyArray<UsageSnapshot>;
	/** Stop background reads from requesting frames after teardown. */
	dispose(): void;
}

export function createQuotaSummaryFeed(options: QuotaSummaryFeedOptions = {}): QuotaSummaryFeed {
	const service = options.service ?? createQuotaService();
	const ttlMs = options.ttlMs ?? QUOTA_SUMMARY_TTL_MS;
	const now = options.now ?? Date.now;

	let line: string | null = null;
	let snapshots: ReadonlyArray<UsageSnapshot> = [];
	let readAt: number | null = null;
	let inFlight = false;
	let disposed = false;

	const refresh = (): void => {
		if (inFlight || disposed) return;
		inFlight = true;
		void Promise.resolve()
			.then(() => (disposed ? snapshots : service.read()))
			.then((nextSnapshots) => {
				if (disposed) return;
				const next = quotaSummaryLine(nextSnapshots);
				const changed = JSON.stringify(nextSnapshots) !== JSON.stringify(snapshots);
				snapshots = nextSnapshots;
				readAt = now();
				if (changed) {
					line = next;
					options.onUpdate?.();
				}
			})
			.catch(() => {
				// A failed read leaves the previous line standing. Provider failures
				// already arrive as snapshot statuses, so reaching here means
				// something outside the adapters broke, and the banner should not
				// start flickering because of it.
				readAt = now();
			})
			.finally(() => {
				inFlight = false;
			});
	};

	return {
		peek(): string | null {
			if (!disposed && (readAt === null || now() - readAt >= ttlMs)) refresh();
			return line;
		},
		peekSnapshots(): ReadonlyArray<UsageSnapshot> {
			if (!disposed && (readAt === null || now() - readAt >= ttlMs)) refresh();
			return snapshots;
		},
		dispose(): void {
			disposed = true;
		},
	};
}
