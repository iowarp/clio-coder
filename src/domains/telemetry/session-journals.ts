import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { TelemetryCapture } from "../../core/telemetry/capture.js";
import type { TelemetryAgent, TelemetryContext } from "../../core/telemetry/context.js";
import { mainAgent } from "../../core/telemetry/context.js";
import type { SegmentHeader } from "../../core/telemetry/envelope.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import type { CallStarted, ObjectRef } from "../../core/telemetry/schemas.js";
import type { CallJournal, JournalHealth } from "./call-journal.js";
import { openCallJournal } from "./call-journal.js";
import { type storeTelemetryObject, telemetryPromptStructure } from "./objects.js";
import { telemetrySessionDirectory } from "./paths.js";

export interface TelemetrySessionOrigin {
	id: string;
	cwdHash: string;
}
export interface TelemetrySessionLease {
	context: TelemetryContext;
	/**
	 * Whether the session's writer opened. Without it records under this lease reach no sink, so a side call mints
	 * no call id no journal holds; the writer reports the gap (#434).
	 */
	journaled: boolean;
	/** Cold request preparation, before beginCall enters the enqueue-only lane (#434). */
	storeRequestObjects?(input: {
		/** `systemPrompt` is content: it is kept only under research content capture (#434). */
		prompt?: Parameters<typeof telemetryPromptStructure>[0] & { systemPrompt?: string };
		tools?: unknown;
	}): Promise<NonNullable<CallStarted["objects"]>>;
	/**
	 * prompt.compiled for the first call of this writer to cite a prompt structure; ctx names that call. A writer
	 * reopened after an idle close records it again, so a reader keeps the earliest per structure (#434).
	 */
	recordPromptCompiled?(
		structure: ObjectRef,
		facts: Omit<EventPayload<"prompt.compiled">, "structure">,
		ctx: TelemetryContext,
	): void;
	/**
	 * Ask for the session's seal at its close. The seal lands when the session's last lease releases and its writes
	 * drain, never while another lease is live (#434).
	 */
	requestSeal?(): void;
	/** A resume makes the session live again: it withdraws a close's seal that has not landed yet (#434). */
	cancelSeal?(): void;
	/** Store a session object through the writer, so it never lands behind the session's seal (#434). */
	storeObject?(subject: Parameters<typeof storeTelemetryObject>[1], value: unknown): Promise<ObjectRef>;
	release(): Promise<void>;
}

/** What a session's writer captures; `prepare` refreshes it on the cold path before each lease (#434). */
export interface SessionCapture {
	prepare?(origin: TelemetrySessionOrigin): Promise<void>;
	current(origin: TelemetrySessionOrigin): TelemetryCapture;
}

interface Entry {
	users: number;
	origin: TelemetrySessionOrigin;
	journal: Promise<CallJournal | null>;
	/** Prompt texts this writer already recorded, by digest, so a repeated prompt costs no research bytes. */
	promptTexts: Set<string>;
	/** Prompt structures this writer already announced as prompt.compiled, by object id. */
	promptStructures: Set<string>;
	/** Set once the writer has opened, until it starts closing. */
	open?: boolean;
	/** The opened writer, read synchronously by health windows (#434). */
	writer?: CallJournal;
	closing?: Promise<void>;
	/** Pending close of a writer no work holds; the next lease cancels it (#434). */
	idle?: NodeJS.Timeout | undefined;
	/** The session closed; its last release seals the scope and closes the writer instead of idling (#434). */
	sealRequested?: boolean;
}

/**
 * How long a writer stays open after its last lease. Every lease cycle that
 * closed the writer reopened it on the next call: a full read and scan of the
 * journal plus a new segment header, 23 ms at 150 calls and 78 ms at 600 in a
 * probe, on the thread that runs the turn (#434).
 */
export const JOURNAL_IDLE_CLOSE_MS = 30_000;
/** Sessions whose origin a writer set remembers for reopening; an ACP server hosts a few at most. */
const KNOWN_ORIGINS = 256;

/** Active work, rather than the selected UI session, owns the writer's lifetime (#434). */
export function createSessionJournals(
	stateDir: string,
	unavailable: () => void,
	capture?: SessionCapture,
	/** Runs once per writer open, before any lease proceeds, so its records lead the writer's first batch (#434). */
	opened?: (origin: TelemetrySessionOrigin, sessionDirectory: string, journal: CallJournal) => Promise<void>,
) {
	const entries = new Map<string, Entry>();
	/** Sessions this process has leased, so a session fact naming one can reopen its writer (#434). */
	const origins = new Map<string, TelemetrySessionOrigin>();
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
	/** `seal` seals the scope first; closing is set at once, so no new lease reaches the writer meanwhile. */
	const close = (id: string, entry: Entry, seal = false): Promise<void> => {
		if (entry.idle) clearTimeout(entry.idle);
		entry.idle = undefined;
		entry.open = false;
		entry.closing ??= entry.journal.then(async (journal) => {
			try {
				// Sealing and closing are one writer operation, so a held lease cannot append or store in between (#434).
				if (seal && journal) {
					if (!(await journal.sealAndClose())) report();
				} else await journal?.close();
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
		agent: TelemetryAgent,
		turnId?: string,
	): Promise<TelemetrySessionLease> => {
		// Session ids are existing path components; never reinterpret them as paths (#434).
		const context: TelemetryContext = { sessionId: origin.id, agent, ...(turnId ? { turnId } : {}) };
		if (!/^[a-zA-Z0-9_-]+$/.test(origin.id)) {
			report();
			return { context, journaled: false, async release() {} };
		}
		const directory = telemetrySessionDirectory(stateDir, origin.id);
		origins.delete(origin.id);
		origins.set(origin.id, origin);
		if (origins.size > KNOWN_ORIGINS) origins.delete(origins.keys().next().value as string);
		try {
			await capture?.prepare?.(origin);
		} catch {
			// A failed refresh keeps the previous capture; consent is never granted by an error (#434).
			report();
		}
		let entry = entries.get(origin.id);
		if (entry?.closing) {
			await entry.closing;
			return acquire(origin, agent, turnId);
		}
		if (!entry) {
			const created: Entry = {
				users: 0,
				origin,
				promptTexts: new Set(),
				promptStructures: new Set(),
				journal: Promise.resolve()
					.then(writer)
					.then((writer) =>
						openCallJournal({
							directory,
							// The journal's own records (gaps, segment closes) are the session's, whoever opened it (#434).
							context: { sessionId: origin.id, agent: mainAgent(origin.id) },
							writer,
							...(capture ? { capture: () => capture.current(origin) } : {}),
						}),
					)
					.then(async (journal) => {
						try {
							await opened?.(origin, directory, journal);
						} catch {
							report();
						}
						created.writer = journal;
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
		const journaled = (await entry.journal) !== null;
		const owned = entry;
		let released = false;
		return {
			context,
			journaled,
			async storeRequestObjects(input) {
				const refs: NonNullable<CallStarted["objects"]> = {};
				const journal = released ? null : await owned.journal;
				if (!journal) return refs;
				for (const subject of ["prompt-structure", "tool-schemas"] as const) {
					try {
						if (subject === "prompt-structure" && input.prompt !== undefined)
							refs.promptStructure = await journal.storeObject(subject, telemetryPromptStructure(input.prompt));
						else if (subject === "tool-schemas" && input.tools !== undefined)
							refs.toolSchemas = await journal.storeObject(subject, input.tools);
					} catch {
						// Object capture never blocks the request or claims a missing preimage resolves (#434).
						report();
					}
				}
				const text = input.prompt?.systemPrompt;
				if (text !== undefined && journal.admits("prompt.text_captured")) {
					const digest = createHash("sha256").update(text).digest("hex");
					if (!owned.promptTexts.has(digest) && journal.reserveResearchBytes(Buffer.byteLength(text))) {
						try {
							const stored = await journal.storeObject("prompt-text", { text });
							owned.promptTexts.add(digest);
							telemetryHub().emit(
								"prompt.text_captured",
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
			requestSeal() {
				if (!released) owned.sealRequested = true;
			},
			cancelSeal() {
				if (!released) owned.sealRequested = false;
			},
			async storeObject(subject, value) {
				const journal = released ? null : await owned.journal;
				if (!journal) throw new Error("session telemetry writer is not open");
				return journal.storeObject(subject, value);
			},
			recordPromptCompiled(structure, facts, callContext) {
				if (released || owned.promptStructures.has(structure.id)) return;
				if (telemetryHub().emit("prompt.compiled", { ...facts, structure }, callContext))
					owned.promptStructures.add(structure.id);
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
				if (owned.sealRequested) {
					// The last lease drained: seal and close at once, since an idle writer still receives health samples
					// and any later record would make the closed session live again (#434).
					owned.sealRequested = false;
					await close(origin.id, owned, true);
					return;
				}
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
		/** The origin of a session this process leased recently, or undefined for one it never wrote. */
		knownOrigin: (sessionId: string): TelemetrySessionOrigin | undefined => origins.get(sessionId),
		/** Sessions whose writer is open now; a closed writer records its settings again when it reopens (#434). */
		openSessions(): Array<{
			origin: TelemetrySessionOrigin;
			sessionDirectory: string;
			health: JournalHealth;
			journal: CallJournal;
		}> {
			return [...entries.values()].flatMap(({ open, origin, writer }) =>
				open === true && writer
					? [
							{
								origin,
								sessionDirectory: telemetrySessionDirectory(stateDir, origin.id),
								health: writer.health(),
								journal: writer,
							},
						]
					: [],
			);
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
		/**
		 * Shutdown: every writer closes and releases its lease, held leases included. Shutdown tears those leases down,
		 * so a session whose close requested its seal is sealed now; nothing else is (#434).
		 */
		async closeAll(): Promise<void> {
			await Promise.all([...entries.entries()].map(([id, entry]) => close(id, entry, entry.sealRequested === true)));
		},
	};
}
