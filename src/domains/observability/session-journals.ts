import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { TelemetryCapture } from "../../core/telemetry/capture.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import type { CallLabel } from "../../core/telemetry/enums.js";
import type { SegmentHeader } from "../../core/telemetry/envelope.js";
import { recordTelemetry } from "../../core/telemetry/producer.js";
import type { CallStarted } from "../../core/telemetry/schemas.js";
import type { CallJournal } from "./call-journal.js";
import { openCallJournal } from "./call-journal.js";
import { storeTelemetryObject, telemetryPromptStructure } from "./objects.js";

export interface TelemetrySessionOrigin {
	id: string;
	cwdHash: string;
}
export interface TelemetrySessionLease {
	context: TelemetryContext;
	/** Cold request preparation, before beginCall enters the enqueue-only lane (#434). */
	storeRequestObjects?(input: {
		/** `systemPrompt` is content: it is kept only under research content capture (#434). */
		prompt?: Parameters<typeof telemetryPromptStructure>[0] & { systemPrompt?: string };
		tools?: unknown;
	}): Promise<NonNullable<CallStarted["objects"]>>;
	release(): Promise<void>;
}

/** What a session's writer captures; `prepare` refreshes it on the cold path before each lease (#434). */
export interface SessionCapture {
	prepare?(origin: TelemetrySessionOrigin, sessionDirectory: string): Promise<void>;
	current(origin: TelemetrySessionOrigin): TelemetryCapture;
}

interface Entry {
	users: number;
	origin: TelemetrySessionOrigin;
	journal: Promise<CallJournal | null>;
	/** Prompt texts this writer already recorded, by digest, so a repeated prompt costs no research bytes. */
	promptTexts: Set<string>;
	/** Set once the writer has opened, until it starts closing. */
	open?: boolean;
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
export function createSessionJournals(
	stateDir: string,
	unavailable: () => void,
	capture?: SessionCapture,
	/** Runs once per writer open, before any lease proceeds, so its records lead the writer's first batch (#434). */
	opened?: (origin: TelemetrySessionOrigin, sessionDirectory: string) => Promise<void>,
) {
	const entries = new Map<string, Entry>();
	let versions: Promise<SegmentHeader["writer"]> | undefined;
	const writer = () =>
		(versions ??= readFile(join(resolvePackageRoot(), "package.json"), "utf8").then((text) => {
			const pkg = JSON.parse(text) as { version?: string; dependencies?: Record<string, string> };
			return {
				clioCoderVersion: pkg.version ?? "unknown",
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
		entry.open = false;
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
		const directory = join(stateDir, "sessions", origin.cwdHash, origin.id);
		try {
			await capture?.prepare?.(origin, directory);
		} catch {
			// A failed refresh keeps the previous capture; consent is never granted by an error (#434).
			report();
		}
		let entry = entries.get(origin.id);
		if (entry?.closing) {
			await entry.closing;
			return acquire(origin, label, turnId);
		}
		if (!entry) {
			const created: Entry = {
				users: 0,
				origin,
				promptTexts: new Set(),
				journal: Promise.resolve()
					.then(writer)
					.then((writer) =>
						openCallJournal({
							sessionDirectory: directory,
							context,
							writer,
							...(capture ? { capture: () => capture.current(origin) } : {}),
						}),
					)
					.then(async (journal) => {
						try {
							await opened?.(origin, directory);
						} catch {
							report();
						}
						if (!created.closing) created.open = true;
						return journal;
					})
					.catch(() => {
						report();
						return null;
					}),
			};
			entry = created;
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
			async storeRequestObjects(input) {
				const refs: NonNullable<CallStarted["objects"]> = {};
				const journal = released ? null : await owned.journal;
				if (!journal) return refs;
				for (const subject of ["prompt-structure", "tool-schemas"] as const) {
					try {
						if (subject === "prompt-structure" && input.prompt !== undefined)
							refs.promptStructure = await storeTelemetryObject(directory, subject, telemetryPromptStructure(input.prompt));
						else if (subject === "tool-schemas" && input.tools !== undefined)
							refs.toolSchemas = await storeTelemetryObject(directory, subject, input.tools);
					} catch {
						// Object capture never blocks the request or claims a missing preimage resolves (#434).
						report();
					}
				}
				const text = input.prompt?.systemPrompt;
				if (text !== undefined && journal.admits("prompt.text")) {
					const digest = createHash("sha256").update(text).digest("hex");
					if (!owned.promptTexts.has(digest) && journal.reserveResearchBytes(Buffer.byteLength(text))) {
						try {
							const stored = await storeTelemetryObject(directory, "prompt-text", { text });
							owned.promptTexts.add(digest);
							recordTelemetry(
								"prompt.text",
								{
									...(refs.promptStructure ? { structure: refs.promptStructure } : {}),
									text: stored,
									bytes: Buffer.byteLength(text),
								},
								context,
							);
						} catch {
							report();
						}
					}
				}
				return refs;
			},
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
		/** Sessions whose writer is open now; a closed writer records its settings again when it reopens (#434). */
		openSessions(): Array<{ origin: TelemetrySessionOrigin; sessionDirectory: string }> {
			return [...entries.values()]
				.filter((entry) => entry.open === true)
				.map(({ origin }) => ({ origin, sessionDirectory: join(stateDir, "sessions", origin.cwdHash, origin.id) }));
		},
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
