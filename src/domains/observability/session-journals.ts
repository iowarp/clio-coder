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
}

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
				owned.closing = owned.journal.then(async (journal) => {
					try {
						await journal?.close();
					} catch {
						report();
					} finally {
						if (entries.get(origin.id) === owned) entries.delete(origin.id);
					}
				});
				await owned.closing;
			},
		};
	};
	return {
		acquire,
		async flush(): Promise<void> {
			await Promise.all(
				[...entries.values()].map(async (entry) => {
					try {
						await (await entry.journal)?.flush();
					} catch {
						report();
					}
				}),
			);
		},
	};
}
