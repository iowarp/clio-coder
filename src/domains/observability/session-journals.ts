import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import type { CallLabel } from "../../core/telemetry/enums.js";
import type { SegmentHeader } from "../../core/telemetry/envelope.js";
import type { CallJournal } from "./call-journal.js";
import { openCallJournal } from "./call-journal.js";

export interface TelemetrySessionOrigin {
	id: string;
	cwdHash: string;
}
export interface TelemetrySessionLease {
	context: TelemetryContext;
	release(): Promise<void>;
}

interface Entry {
	users: number;
	journal: Promise<CallJournal | null>;
	closing?: Promise<void>;
	/** Pending close of a writer no work holds; the next lease cancels it (#434). */
	idle?: NodeJS.Timeout | undefined;
}

/**
 * How long a writer stays open after its last lease. Every lease cycle that
 * closed the writer reopened it on the next call: a full read and scan of the
 * journal plus a new segment header, 23 ms at 150 calls and 78 ms at 600 in a
 * probe, on the thread that runs the turn (#434).
 */
export const JOURNAL_IDLE_CLOSE_MS = 30_000;

/** Active work, rather than the selected UI session, owns the writer's lifetime (#434). */
export function createSessionJournals(stateDir: string, unavailable: () => void) {
	const entries = new Map<string, Entry>();
	let versions: Promise<SegmentHeader["writer"]> | undefined;
	const writer = () =>
		(versions ??= readFile(join(resolvePackageRoot(), "package.json"), "utf8").then((text) => {
			const pkg = JSON.parse(text) as { version?: string; dependencies?: Record<string, string> };
			return {
				clioVersion: pkg.version ?? "unknown",
				piVersion: pkg.dependencies?.["@earendil-works/pi-ai"] ?? "unknown",
			};
		}));
	const report = () => {
		try {
			unavailable();
		} catch {
			/* A diagnostic observer cannot change the call's result (#434). */
		}
	};
	const close = (id: string, entry: Entry): Promise<void> => {
		if (entry.idle) clearTimeout(entry.idle);
		entry.idle = undefined;
		entry.closing ??= entry.journal.then(async (journal) => {
			try {
				await journal?.close();
			} catch {
				report();
			} finally {
				if (entries.get(id) === entry) entries.delete(id);
			}
		});
		return entry.closing;
	};
	const acquire = async (
		origin: TelemetrySessionOrigin,
		label: CallLabel,
		turnId?: string,
	): Promise<TelemetrySessionLease> => {
		// Session ids and cwd hashes are existing path components; never reinterpret them as paths (#434).
		const context: TelemetryContext = { sessionId: origin.id, label, ...(turnId ? { turnId } : {}) };
		if (!/^[a-zA-Z0-9_-]+$/.test(origin.id) || !/^[a-zA-Z0-9_-]+$/.test(origin.cwdHash)) {
			report();
			return { context, async release() {} };
		}
		let entry = entries.get(origin.id);
		if (entry?.closing) {
			await entry.closing;
			return acquire(origin, label, turnId);
		}
		if (!entry) {
			entry = {
				users: 0,
				journal: Promise.resolve()
					.then(writer)
					.then((writer) =>
						openCallJournal({
							sessionDirectory: join(stateDir, "sessions", origin.cwdHash, origin.id),
							context,
							writer,
						}),
					)
					.catch(() => {
						report();
						return null;
					}),
			};
			entries.set(origin.id, entry);
		}
		if (entry.idle) clearTimeout(entry.idle);
		entry.idle = undefined;
		entry.users += 1;
		await entry.journal;
		const owned = entry;
		let released = false;
		return {
			context,
			async release() {
				if (released) return;
				released = true;
				owned.users -= 1;
				if (owned.users !== 0) return;
				// The settlement is durable before the caller continues; the writer itself stays open for the next call.
				try {
					await (await owned.journal)?.flush();
				} catch {
					report();
				}
				if (owned.users !== 0 || owned.closing || owned.idle) return;
				owned.idle = setTimeout(() => {
					owned.idle = undefined;
					if (owned.users === 0) void close(origin.id, owned);
				}, JOURNAL_IDLE_CLOSE_MS);
				owned.idle.unref();
			},
		};
	};
	return {
		acquire,
		async flush(): Promise<void> {
			await Promise.all(
				[...entries.values()].map(async (entry) => {
					try {
						if (entry.closing) await entry.closing;
						else await (await entry.journal)?.flush();
					} catch {
						report();
					}
				}),
			);
		},
		/** Shutdown: every writer closes and releases its lease, held leases included. */
		async closeAll(): Promise<void> {
			await Promise.all([...entries.entries()].map(([id, entry]) => close(id, entry)));
		},
	};
}
