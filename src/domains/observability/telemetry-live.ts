import type {
	HealthV1,
	QuotaStateV1,
	SessionTelemetryV1,
	TelemetryTopic,
	TelemetryUpdateV1,
} from "../../core/telemetry/dto.js";
import { parseFactRef, TELEMETRY_DTO_VERSION, TELEMETRY_TOPICS } from "../../core/telemetry/dto.js";
import type { SegmentHeader, TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact } from "../../core/telemetry/fact.js";
import { telemetryProducerHealth } from "../../core/telemetry/producer.js";
import { renderFact } from "../../core/telemetry/render.js";
import { observedQuotaReadings } from "../quota/observed.js";
import type { CallJournalRead, PersistedTelemetry } from "./call-journal.js";
import {
	appendPersistedTelemetry,
	openCallJournalHealth,
	subscribeAllPersistedTelemetry,
	subscribePersistedTelemetry,
} from "./call-journal.js";
import type { TelemetryReadModel, TelemetryView } from "./contract.js";
import { TELEMETRY_FOLD_VERSION } from "./folds.js";
import type { JournalSource, SessionSource } from "./read-model.js";
import {
	cacheReport,
	callsReport,
	continueSource,
	costReport,
	explain,
	journalSourceFromRead,
	prepareSource,
	quantityOf,
	runsReport,
	runTelemetry,
	sessionTelemetry,
	timeline,
	whyStopped,
} from "./read-model.js";

/**
 * The live telemetry read model (#434 §11). It never reads a journal on a render path and never folds per token:
 * binding a session subscribes to every writer's persisted batches first, then seeds from the same cold loader the
 * CLI runs, off the event loop's critical path, and merges the batches that landed meanwhile by record id. From then
 * on each fsync'd batch is decoded with the reader's own decoder, so `live()` equals a cold read of the same files.
 * Until the seed merges, `live()` is the hub-buffered view with its journal marked `seeding`, never null.
 */

type Mode = SegmentHeader["mode"];

interface TelemetrySourceLoader {
	loadSessionTelemetrySourceAsync(stateDir: string, sessionId: string): Promise<SessionSource | null>;
	loadRunTelemetrySourceAsync(stateDir: string, runId: string): Promise<JournalSource>;
}
export interface LiveTelemetryOptions {
	stateDir: () => string;
	/** The session domain's cold loader, imported on first seed so it stays off startup. */
	loader?: () => Promise<TelemetrySourceLoader>;
}
export interface LiveTelemetryModel extends TelemetryReadModel {
	bind(sessionId: string | null): void;
	stop(): void;
}

/** One update per 100 ms at most: the subscribe contract is 10 Hz and never per token (#434 §11). */
const MIN_UPDATE_MS = 100;
const SEED_ATTEMPTS = 3;
const SESSION_TOPICS: readonly TelemetryTopic[] = ["session", "calls", "cost", "cache", "timeline"];
const RUN_TOPICS: readonly TelemetryTopic[] = ["runs", "session", "calls", "cost", "timeline"];
const UNREADABLE: JournalSource = { present: false, records: [], modes: [], skipped: 1, damaged: 0 };
const EMPTY_LEGACY: SessionSource["legacy"] = { records: [], aggregates: 0 };
const sessionOwner = (sessionId: string) => `session:${sessionId}`;
const runOwner = (runId: string) => `run:${runId}`;

export function telemetryView(source: SessionSource): TelemetryView {
	let session: SessionTelemetryV1 | undefined;
	return {
		sessionId: source.sessionId,
		seeding: source.journal.seeding === true,
		session: () => (session ??= sessionTelemetry(source)),
		calls: (filter) => callsReport(source, filter),
		cost: (groupBy) => costReport(source, groupBy),
		cache: () => cacheReport(source),
		timeline: (range) => timeline(source, range ?? null),
		runs: () => runsReport(source),
		run: (runId) => {
			const run = source.runs.get(runId);
			return run ? runTelemetry(runId, run) : null;
		},
		whyStopped: () => whyStopped(source),
		explain: (ref) => explain(ref, { session: source }),
		quantity: (ref) => quantityOf(ref, source),
	};
}

/** One owner's journal as a cold reader would hold it, plus what arrived while its cold read was in flight. */
interface Owned {
	runId: string | undefined;
	present: boolean;
	records: TelemetryRecord[];
	modes: Mode[];
	skipped: number;
	damaged: number;
	seeding: boolean;
	/** Each batch that arrived while seeding, whole: the cold read holds a batch entirely or not at all. */
	batches: Array<readonly TelemetryRecord[]>;
	/**
	 * Record ids of the merged cold read while a published batch may still be one the read already held: bytes are
	 * readable once written but publish only after fsync. Cleared by the first batch the read could not have seen.
	 */
	overlap: ReadonlySet<string> | null;
	appendedWhileSeeding: boolean;
	rewrittenWhileSeeding: boolean;
	version: number;
	snapshot?: { version: number; source: JournalSource };
}
interface Node {
	sessionId: string;
	journal: Owned;
	legacy: SessionSource["legacy"];
	runIds: Set<string>;
	parent: { sessionId: string; turnId: string; at: string; node: Node | null } | null;
	snapshot?: { journal: JournalSource; runs: JournalSource[]; parent: SessionSource | null; source: SessionSource };
}
interface Binding {
	sessionId: string;
	owners: Map<string, Owned>;
	/** Null while seeding. */
	root: Node | null;
	nodes: Map<string, Node>;
	off: Array<() => void>;
	version: number;
	view?: { version: number; view: TelemetryView };
}

function owned(owner: string): Owned {
	return {
		runId: owner.startsWith("run:") ? owner.slice(4) : undefined,
		present: false,
		records: [],
		modes: [],
		skipped: 0,
		damaged: 0,
		seeding: true,
		batches: [],
		overlap: null,
		appendedWhileSeeding: false,
		rewrittenWhileSeeding: false,
		version: 0,
	};
}

function journalOf(entry: Owned | undefined): JournalSource {
	if (!entry) return { present: false, records: [], modes: [], skipped: 0, damaged: 0, seeding: true };
	if (entry.snapshot?.version === entry.version) return entry.snapshot.source;
	const source: JournalSource = {
		present: entry.present,
		records: entry.records.slice(),
		modes: entry.modes.slice(),
		skipped: entry.skipped,
		damaged: entry.damaged,
		...(entry.seeding ? { seeding: true } : {}),
	};
	entry.snapshot = { version: entry.version, source };
	return source;
}

/** Decode one durable batch with the cold reader's decoder; a run journal keeps only its run's records. */
function append(entry: Owned, event: Extract<PersistedTelemetry, { kind: "appended" }>): readonly TelemetryRecord[] {
	const read: CallJournalRead = { records: [], skipped: 0, damaged: 0 };
	appendPersistedTelemetry(read, event);
	const batch = journalSourceFromRead(read, true, entry.runId);
	entry.present = true;
	if (entry.seeding) {
		entry.batches.push(batch.records);
		entry.appendedWhileSeeding = true;
	} else if (entry.overlap) {
		const first = batch.records[0];
		// A batch with no record of this owner's adds only a segment mode, which the read already counted.
		if (first === undefined || entry.overlap.has(first.id)) return [];
		entry.overlap = null;
	}
	for (const record of batch.records) entry.records.push(record);
	entry.modes.push(...batch.modes);
	entry.skipped += batch.skipped;
	entry.damaged += batch.damaged;
	entry.version += 1;
	return batch.records;
}

/** The cold read is a prefix of the append stream, so a buffered batch is either inside it or entirely after it. */
function merge(entry: Owned, cold: JournalSource): void {
	const ids = new Set(cold.records.map((record) => record.id));
	const after = entry.batches.filter((batch) => batch[0] !== undefined && !ids.has(batch[0].id)).flat();
	entry.records = [...cold.records, ...after];
	entry.modes = [...cold.modes, ...entry.modes];
	entry.skipped += cold.skipped;
	entry.damaged += cold.damaged;
	entry.present ||= cold.present;
	entry.batches = [];
	entry.overlap = after.length > 0 ? null : ids;
	entry.seeding = false;
	entry.version += 1;
}

function referencedRuns(records: readonly TelemetryRecord[]): string[] {
	return records.flatMap((record) => (record.k === "call.ref" || record.k === "run.ref" ? [record.data.runId] : []));
}

function topicsFor(owner: string, root: string, records: readonly TelemetryRecord[]): Set<TelemetryTopic> {
	if (owner.startsWith("run:")) return new Set(RUN_TOPICS);
	// An ancestor's batches move only the lineage totals the session DTO carries.
	if (owner !== root) return new Set<TelemetryTopic>(["session"]);
	const topics = new Set<TelemetryTopic>();
	for (const record of records) {
		if (record.k === "call.started" || record.k === "call.settled") for (const topic of SESSION_TOPICS) topics.add(topic);
		else if (record.k === "call.ref" || record.k === "run.ref") for (const topic of RUN_TOPICS) topics.add(topic);
		else if (record.k === "gap") {
			topics.add("session");
			topics.add("health");
		} else {
			topics.add("session");
			topics.add("timeline");
		}
	}
	return topics;
}

const utc = (value: string | null | undefined): string | null => {
	const ms = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const localCount = (value: number) => {
	const fact: Fact<number> = { kind: "measured", value, source: "local-count" };
	return { fact, display: renderFact(fact) };
};

export function createLiveTelemetryModel(options: LiveTelemetryOptions): LiveTelemetryModel {
	const load = options.loader ?? (() => import("../session/telemetry-source.js"));
	/** The session `bind` named; nothing subscribes or reads until a reader first asks (`activate`). */
	let bound: string | null = null;
	let current: Binding | null = null;
	const listeners = new Map<TelemetryTopic, Set<{ listener: (update: TelemetryUpdateV1) => void }>>();
	const dirty = new Set<TelemetryTopic>();
	let timer: NodeJS.Timeout | undefined;
	let lastEmit = Number.NEGATIVE_INFINITY;
	let seq = 0;

	const emit = () => {
		timer = undefined;
		lastEmit = performance.now();
		const topics = TELEMETRY_TOPICS.filter((topic) => dirty.has(topic));
		dirty.clear();
		if (topics.length === 0) return;
		seq += 1;
		const update: TelemetryUpdateV1 = {
			v: TELEMETRY_DTO_VERSION,
			kind: "telemetry_update",
			sessionId: current?.sessionId ?? null,
			seq,
			generatedAt: new Date().toISOString(),
			topics,
		};
		const notified = new Set<(update: TelemetryUpdateV1) => void>();
		for (const topic of topics)
			for (const { listener } of listeners.get(topic) ?? []) {
				if (notified.has(listener)) continue;
				notified.add(listener);
				try {
					listener(update);
				} catch {
					// One surface's failure cannot starve the others of updates.
				}
			}
	};
	const markDirty = (topics: Iterable<TelemetryTopic>) => {
		for (const topic of topics) if (listeners.get(topic)?.size) dirty.add(topic);
		if (dirty.size === 0 || timer) return;
		timer = setTimeout(emit, Math.max(0, lastEmit + MIN_UPDATE_MS - performance.now()));
		timer.unref();
	};

	const unbind = () => {
		const binding = current;
		current = null;
		for (const off of binding?.off ?? []) off();
	};

	const onEvent = (binding: Binding) => (owner: string, event: PersistedTelemetry) => {
		if (current !== binding) return;
		if (event.kind === "failed") {
			markDirty(["health"]);
			return;
		}
		const seeding = binding.root === null;
		let entry = binding.owners.get(owner);
		if (!entry) {
			// Once seeded, only subscribed owners arrive; while seeding, any owner may turn out to be in the graph.
			if (!seeding) return;
			entry = owned(owner);
			binding.owners.set(owner, entry);
		}
		if (event.kind === "rewritten") {
			// A torn-tail repair replaced bytes a cold read holds; only a fresh read stays equal to the CLI.
			if (entry.seeding) entry.rewrittenWhileSeeding = true;
			else reseed(binding.sessionId);
			return;
		}
		const records = append(entry, event);
		binding.version += 1;
		if (!seeding) {
			const node = binding.nodes.get(owner);
			if (node) for (const runId of referencedRuns(records)) track(binding, node, runId);
		}
		markDirty(topicsFor(owner, sessionOwner(binding.sessionId), records));
	};

	/** Merge a run's cold read into what its subscription buffered; a read that raced a batch reads again. */
	const readRun = async (binding: Binding, entry: Owned, runId: string) => {
		for (let attempt = 1; attempt <= SEED_ATTEMPTS; attempt += 1) {
			const cold = await load()
				.then((loader) => loader.loadRunTelemetrySourceAsync(options.stateDir(), runId))
				.catch(() => UNREADABLE);
			if (current !== binding || !entry.seeding) return;
			const raced = entry.rewrittenWhileSeeding || (cold.damaged > 0 && entry.appendedWhileSeeding);
			entry.rewrittenWhileSeeding = false;
			entry.appendedWhileSeeding = false;
			if (raced && attempt < SEED_ATTEMPTS) continue;
			merge(entry, cold);
			binding.version += 1;
			markDirty(RUN_TOPICS);
			return;
		}
	};
	/** A run first referenced after the seed: subscribe, then cold-read it, so no batch falls between the two. */
	const track = (binding: Binding, node: Node, runId: string) => {
		node.runIds.add(runId);
		const owner = runOwner(runId);
		if (binding.owners.has(owner)) return;
		const entry = owned(owner);
		binding.owners.set(owner, entry);
		binding.off.push(subscribePersistedTelemetry(owner, onEvent(binding)));
		void readRun(binding, entry, runId);
	};

	const install = (binding: Binding, source: SessionSource) => {
		const keep = new Set<string>();
		const adopt = (owner: string, cold: JournalSource): Owned => {
			const entry = binding.owners.get(owner) ?? owned(owner);
			binding.owners.set(owner, entry);
			// A run two sessions in the lineage both reference merges its cold read once.
			if (!keep.has(owner)) merge(entry, cold);
			keep.add(owner);
			return entry;
		};
		const build = (src: SessionSource): Node => {
			const owner = sessionOwner(src.sessionId);
			const node: Node = {
				sessionId: src.sessionId,
				journal: adopt(owner, src.journal),
				legacy: src.legacy,
				runIds: new Set(src.runs.keys()),
				parent: null,
			};
			binding.nodes.set(owner, node);
			for (const [runId, run] of src.runs) adopt(runOwner(runId), run);
			const parent = src.parent;
			if (parent)
				node.parent = {
					sessionId: parent.sessionId,
					turnId: parent.turnId,
					at: parent.at,
					node: parent.source && !binding.nodes.has(sessionOwner(parent.sessionId)) ? build(parent.source) : null,
				};
			return node;
		};
		binding.root = build(source);
		// Batches that landed after the cold read may reference runs it never saw; their buffers are kept and read.
		const late: Array<{ entry: Owned; runId: string }> = [];
		for (const node of binding.nodes.values())
			for (const runId of referencedRuns(node.journal.records)) {
				if (node.runIds.has(runId)) continue;
				node.runIds.add(runId);
				const owner = runOwner(runId);
				if (keep.has(owner)) continue;
				const entry = binding.owners.get(owner) ?? owned(owner);
				binding.owners.set(owner, entry);
				keep.add(owner);
				late.push({ entry, runId });
			}
		for (const owner of [...binding.owners.keys()]) if (!keep.has(owner)) binding.owners.delete(owner);
		// Subscribe each owner, then drop the any-owner listener; nothing can arrive between the two on one thread.
		const listener = onEvent(binding);
		const wildcard = binding.off.splice(0);
		for (const owner of keep) binding.off.push(subscribePersistedTelemetry(owner, listener));
		for (const off of wildcard) off();
		for (const { entry, runId } of late) void readRun(binding, entry, runId);
		binding.version += 1;
		markDirty(TELEMETRY_TOPICS);
	};

	const seed = async (binding: Binding) => {
		const absent = (journal: JournalSource): SessionSource => ({
			sessionId: binding.sessionId,
			journal,
			legacy: EMPTY_LEGACY,
			runs: new Map(),
			parent: null,
		});
		for (let attempt = 1; attempt <= SEED_ATTEMPTS; attempt += 1) {
			let source: SessionSource | null;
			try {
				source = await (await load()).loadSessionTelemetrySourceAsync(options.stateDir(), binding.sessionId);
			} catch {
				if (attempt < SEED_ATTEMPTS) continue;
				if (current !== binding) return;
				// The CLI would fail this read outright; live keeps the batches it has and calls the rest unknown.
				install(binding, absent(UNREADABLE));
				return;
			}
			if (current !== binding) return;
			// A read that met a half-written line or a repaired tail while batches landed reads again.
			const raced = (owner: string, cold: JournalSource) => {
				const entry = binding.owners.get(owner);
				return entry !== undefined && (entry.rewrittenWhileSeeding || (cold.damaged > 0 && entry.appendedWhileSeeding));
			};
			let retry = false;
			for (let node = source; node && !retry; node = node.parent?.source ?? null) {
				retry ||= raced(sessionOwner(node.sessionId), node.journal);
				for (const [runId, run] of node.runs) retry ||= raced(runOwner(runId), run);
			}
			if (retry && attempt < SEED_ATTEMPTS) {
				for (const entry of binding.owners.values()) {
					entry.rewrittenWhileSeeding = false;
					entry.appendedWhileSeeding = false;
				}
				continue;
			}
			// No session directory yet: a new session's writer has not opened, so the hub holds everything there is.
			install(binding, source ?? absent({ present: false, records: [], modes: [], skipped: 0, damaged: 0 }));
			// The whole-session fold runs once here, in the seed's own task, never on the first render after it.
			if (binding.root) prepareSource(snapshot(binding, binding.root));
			return;
		}
	};

	const bindTo = (sessionId: string) => {
		const binding: Binding = { sessionId, owners: new Map(), root: null, nodes: new Map(), off: [], version: 0 };
		current = binding;
		binding.off.push(subscribeAllPersistedTelemetry(onEvent(binding)));
		markDirty(TELEMETRY_TOPICS);
		// Started on a later turn of the event loop so binding never adds a read to the caller's path.
		setImmediate(() => void seed(binding));
	};
	const reseed = (sessionId: string) => {
		unbind();
		bindTo(sessionId);
	};
	// A headless run or worker that never reads live telemetry never subscribes, so its appends publish nothing.
	const activate = () => {
		if (bound !== null && current === null) bindTo(bound);
	};

	const snapshot = (binding: Binding, node: Node): SessionSource => {
		const parent = node.parent?.node ? snapshot(binding, node.parent.node) : null;
		const runIds = [...node.runIds].sort();
		const runs = runIds.map((runId) => journalOf(binding.owners.get(runOwner(runId))));
		const journal = journalOf(node.journal);
		const cached = node.snapshot;
		if (
			cached &&
			cached.journal === journal &&
			cached.parent === parent &&
			cached.runs.length === runs.length &&
			cached.runs.every((run, index) => run === runs[index])
		)
			return cached.source;
		const source: SessionSource = {
			sessionId: node.sessionId,
			journal,
			legacy: node.legacy,
			runs: new Map(runIds.map((runId, index) => [runId, runs[index] as JournalSource])),
			parent: node.parent
				? { sessionId: node.parent.sessionId, turnId: node.parent.turnId, at: node.parent.at, source: parent }
				: null,
		};
		// The node's journal only grows by appending after its seed, so the read model folds just the new batch (#434).
		if (cached) continueSource(source, cached.source);
		node.snapshot = { journal, runs, parent, source };
		return source;
	};
	/** Before the seed merges: only what the writers persisted since binding, every sum marked partial. */
	const buffered = (binding: Binding): SessionSource => {
		const journal = journalOf(binding.owners.get(sessionOwner(binding.sessionId)));
		const runIds = [...new Set(referencedRuns(journal.records))].sort();
		return {
			sessionId: binding.sessionId,
			journal: { ...journal, seeding: true },
			legacy: EMPTY_LEGACY,
			runs: new Map(runIds.map((runId) => [runId, { ...journalOf(binding.owners.get(runOwner(runId))), seeding: true }])),
			parent: null,
		};
	};

	const live = (): TelemetryView | null => {
		activate();
		const binding = current;
		if (!binding) return null;
		if (binding.view?.version === binding.version) return binding.view.view;
		const view = telemetryView(binding.root ? snapshot(binding, binding.root) : buffered(binding));
		binding.view = { version: binding.version, view };
		return view;
	};
	const open = async (sessionId: string): Promise<TelemetryView | null> => {
		const source = await (await load()).loadSessionTelemetrySourceAsync(options.stateDir(), sessionId);
		return source ? telemetryView(source) : null;
	};

	return {
		bind(sessionId) {
			if (sessionId === bound) return;
			unbind();
			bound = sessionId;
			if ([...listeners.values()].some((set) => set.size > 0)) activate();
		},
		stop() {
			unbind();
			bound = null;
			if (timer) clearTimeout(timer);
			timer = undefined;
			dirty.clear();
			listeners.clear();
		},
		live,
		open,
		async run(runId) {
			return runTelemetry(runId, await (await load()).loadRunTelemetrySourceAsync(options.stateDir(), runId));
		},
		async explain(ref) {
			const parsed = parseFactRef(ref);
			if (!parsed) return null;
			const view = live();
			if (view && (parsed.scope === "run" ? view.run(parsed.owner) !== null : parsed.owner === view.sessionId))
				return view.explain(ref);
			if (parsed.scope === "run") {
				const run = await (await load()).loadRunTelemetrySourceAsync(options.stateDir(), parsed.owner);
				return explain(ref, { runId: parsed.owner, run });
			}
			return (await open(parsed.owner))?.explain(ref) ?? null;
		},
		quota(provider) {
			const now = Date.now();
			// The process's own readings: every quota cache reports here, and stream observations land here (#423).
			const readings = observedQuotaReadings(now).filter(
				(reading) => provider === undefined || reading.snapshot.providerId === provider,
			);
			return {
				v: TELEMETRY_DTO_VERSION,
				foldVersion: TELEMETRY_FOLD_VERSION,
				generatedAt: new Date(now).toISOString(),
				kind: "quota",
				providers: readings
					.map(({ snapshot, stale, source }) => ({
						provider: snapshot.providerId,
						source,
						observedAt: utc(snapshot.fetchedAt),
						stale,
						windows: snapshot.windows.map((window) => {
							const fact: Fact<number> =
								Number.isFinite(window.usedPct) && window.usedPct >= 0 && window.usedPct <= 100
									? { kind: "measured", value: window.usedPct, source: "provider" }
									: { kind: "unknown", reason: "unsupported" };
							return {
								key: window.key,
								label: window.label.length > 0 ? window.label : null,
								usedPct: { fact, display: renderFact(fact, "percent") },
								resetsAt: utc(window.resetsAt),
							};
						}),
					}))
					.sort((a, b) => a.provider.localeCompare(b.provider) || a.source.localeCompare(b.source)),
			} satisfies QuotaStateV1;
		},
		health() {
			const producer = telemetryProducerHealth();
			// Loop lag stays unknown until a health.window record measures it (#434 §14).
			const unobserved: Fact<number> = { kind: "unknown", reason: "not-observed" };
			const lag = { fact: unobserved, display: renderFact(unobserved, "duration") };
			return {
				v: TELEMETRY_DTO_VERSION,
				foldVersion: TELEMETRY_FOLD_VERSION,
				generatedAt: new Date().toISOString(),
				kind: "health",
				journals: openCallJournalHealth()
					.sort((a, b) => a.owner.localeCompare(b.owner))
					.map(({ owner, health }) => ({
						owner,
						queueDepth: localCount(health.queueDepth),
						persisted: localCount(health.persisted),
						dropped: localCount(health.dropped),
						invalid: localCount(health.invalid),
						filtered: localCount(health.filtered),
						writeErrors: localCount(health.writeErrors),
					})),
				producer: {
					unownedRecords: localCount(producer.unownedRecords),
					sinkFailures: localCount(producer.sinkFailures),
				},
				loopLag: { p50: lag, p99: lag, max: lag },
			} satisfies HealthV1;
		},
		subscribe(topic, listener) {
			let set = listeners.get(topic);
			if (!set) {
				set = new Set();
				listeners.set(topic, set);
			}
			const entry = { listener };
			set.add(entry);
			activate();
			return () => {
				set.delete(entry);
			};
		},
	};
}
