/**
 * The opt-in decision dataset: an append-only JSONL file per UTC day under
 * `<state>/systemone/`, the raw material for fitting cuts and comparing engine
 * builds.
 *
 * Three row kinds share a file, each starting with its own `kind` so a reader
 * can classify a line without parsing it:
 *
 *   decision  one call, with its redacted state, answers and policy outcome
 *   spec      one question spec, written once per hash per process and file
 *   outcome   what followed a decision, joined to it by `ref` at export
 *
 * Writes stay off the turn path. A row is queued when its call finishes and the
 * queue is redacted, encoded and appended on the next event-loop turn, in one
 * `appendFileSync` per day file. The precedent is the run event journal: an
 * async chain would need a timer that either keeps a finished process alive or
 * races finalization, so batches are written synchronously but deferred, and a
 * process `exit` hook writes whatever is still queued. A failed write drops its
 * batch, warns once and never reaches a caller.
 *
 * A decision whose call finished before any session existed (the first turn's
 * `turn` site runs before the user turn creates the session) has no session to
 * stamp, and the deferred write would fix that gap in the file as `session: null`
 * long before one exists. Such a decision is held instead until `adopt` names the
 * session that drains it, the same one that receives its ledger row. A process
 * that ends first writes it as it stands rather than losing it. An outcome that
 * names a held decision waits with it and is written right after it, so a reader
 * scanning the file in order never meets an outcome before the decision it joins.
 */

import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { clioStateDir, stateRootRemoved } from "../../../core/xdg.js";
import type { RedactionTally } from "../../evidence/redact.js";
import { createRedactionTally } from "../../evidence/redact.js";
import { specHash } from "../questions.js";
import type {
	Answer,
	CallOutcome,
	DecisionRecord,
	EngineKind,
	OutcomeRecord,
	Question,
	RouteRecord,
	SiteId,
} from "../types.js";
import { boundState, scrub, scrubbed } from "./scrub.js";
import type { RetentionLimits } from "./store.js";
import { DATASET_DIR_NAME, dayFileName, dayOf, pruneDataset } from "./store.js";

const PRUNE_INTERVAL_MS = 3_600_000;
/** A process that cannot write must not queue rows without bound. */
const MAX_QUEUED = 512;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface DatasetDecisionRow {
	readonly kind: "decision";
	readonly v: 1;
	readonly callId: string;
	readonly at: string;
	readonly session: string | null;
	readonly ref?: string;
	readonly site: SiteId;
	readonly siteVersion: string;
	readonly engine: string;
	/** The engine's kind. Named apart from the row `kind`, which classifies the line. */
	readonly engineKind: EngineKind;
	readonly target: string;
	readonly model: string | null;
	readonly build: string | null;
	readonly outcome: CallOutcome;
	readonly error?: string;
	readonly latencyMs: number;
	readonly deadlineMs: number;
	/** Redacted, and cut to its head when the serialized state passed the size bound. */
	readonly state: Readonly<Record<string, unknown>>;
	readonly stateTruncated?: true;
	/** sha256 of the unredacted serialized state. */
	readonly stateDigest: string;
	readonly redactions: number;
	/** Question id to the hash of its spec row. */
	readonly questions: Readonly<Record<string, string>>;
	readonly answers?: Readonly<Record<string, Answer>>;
	readonly usage?: { readonly input: number; readonly output: number };
	/** Why the readout is not the configured one; see `EngineReply.note`. */
	readonly note?: string;
	readonly fitted?: boolean;
	readonly policy?: Readonly<Record<string, string | number | boolean | null>>;
	/** Per-engine provenance, with the rendered questions a bounded renderer sent. */
	readonly routes?: ReadonlyArray<RouteRecord>;
}

export interface DatasetSpecRow {
	readonly kind: "spec";
	readonly hash: string;
	readonly spec: Question;
}

export interface DatasetOutcomeRow {
	readonly kind: "outcome";
	readonly v: 1;
	readonly ref: string;
	readonly source: OutcomeRecord["source"];
	readonly at: string;
	readonly facts: Readonly<Record<string, unknown>>;
}

export interface PendingDecision {
	readonly record: DecisionRecord;
	readonly session: string | null;
	/** The state as serialized once by the caller, so the digest and the row agree. */
	readonly serialized: string;
	readonly digest: string;
}

export interface DatasetWriter {
	/** A decision with no session is held until `adopt` or `flush`; any other is queued. */
	decision(item: PendingDecision): void;
	/** Queued at once, unless its `ref` names a held decision, which it then follows. */
	outcome(record: OutcomeRecord): void;
	/** Stamp the held decisions with `session` and queue them. */
	adopt(session: string): void;
	/** Write everything now, held decisions included as they stand. Also runs on process exit. */
	flush(): void;
}

export interface DatasetWriterDeps {
	limits(): RetentionLimits;
	/**
	 * Read when held decisions are about to be released, so turning recording off
	 * applies to a decision that was still waiting for its session.
	 */
	recording(): boolean;
	warn(message: string): void;
}

interface DayState {
	specs: Set<string>;
	/** The file ends mid-line, so the next append starts with a newline. */
	torn: boolean;
}

type Queued =
	| ({ readonly type: "decision" } & PendingDecision)
	| { readonly type: "outcome"; readonly record: OutcomeRecord };

const pendingWriters = new Set<DatasetWriter>();
let exitHooked = false;

function hookExit(): void {
	if (exitHooked) return;
	exitHooked = true;
	process.on("exit", () => {
		for (const writer of [...pendingWriters]) writer.flush();
	});
}

function encode(row: DatasetDecisionRow | DatasetSpecRow | DatasetOutcomeRow): string {
	return `${JSON.stringify(row)}\n`;
}

function plainState(serialized: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(serialized);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// Not JSON: the caller's serialization fell back to a sentinel, and there is no state to keep.
	}
	return {};
}

/** A short identifier field: a target, model or build name can carry a path or a URL with userinfo. */
function scrubText(value: string, tally: RedactionTally): string {
	return scrub(value, tally, false);
}

function decisionRow(item: PendingDecision, questions: Record<string, string>): DatasetDecisionRow {
	const { record } = item;
	const tally = createRedactionTally();
	const bounded = boundState(scrub(plainState(item.serialized), tally));
	const error = record.error === undefined ? undefined : scrub(record.error, tally);
	const policy = record.policy === undefined ? undefined : scrub(record.policy, tally);
	const answers = record.answers === undefined ? undefined : scrub(record.answers, tally, false);
	const routes = record.routes === undefined ? undefined : scrub(record.routes, tally, false);
	return {
		kind: "decision",
		v: 1,
		callId: record.callId,
		at: record.at,
		session: item.session,
		...(record.ref !== undefined ? { ref: record.ref } : {}),
		site: record.site,
		siteVersion: record.siteVersion,
		engine: record.engine,
		engineKind: record.kind,
		target: scrubText(record.target, tally),
		model: record.model === null ? null : scrubText(record.model, tally),
		build: record.build === null ? null : scrubText(record.build, tally),
		outcome: record.outcome,
		...(error !== undefined ? { error } : {}),
		latencyMs: record.latencyMs,
		deadlineMs: record.deadlineMs,
		state: bounded.state,
		...(bounded.truncated ? { stateTruncated: true as const } : {}),
		stateDigest: item.digest,
		redactions: tally.count,
		questions,
		...(answers !== undefined ? { answers } : {}),
		...(record.usage !== undefined ? { usage: record.usage } : {}),
		...(record.note !== undefined ? { note: record.note } : {}),
		...(record.fitted !== undefined ? { fitted: record.fitted } : {}),
		...(policy !== undefined ? { policy } : {}),
		...(routes !== undefined ? { routes } : {}),
	};
}

function outcomeRow(record: OutcomeRecord): DatasetOutcomeRow {
	return {
		kind: "outcome",
		v: 1,
		ref: record.ref,
		source: record.source,
		at: record.at,
		facts: scrubbed(record.facts).value,
	};
}

/**
 * Whether a day file ends mid-line, read from its last byte. Its spec hashes
 * are not collected: the file grows toward `maxMiB`, a full read would stall the
 * first write of each day, and export keys specs by hash, so a spec another
 * process already wrote costs one duplicate row.
 */
function loadDay(path: string): DayState {
	const state: DayState = { specs: new Set(), torn: false };
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return state;
		throw err;
	}
	try {
		const size = fstatSync(fd).size;
		if (size > 0) {
			const last = Buffer.alloc(1);
			readSync(fd, last, 0, 1, size - 1);
			state.torn = last[0] !== 0x0a;
		}
	} finally {
		closeSync(fd);
	}
	return state;
}

export function createDatasetWriter(deps: DatasetWriterDeps): DatasetWriter {
	let queue: Queued[] = [];
	/** Decisions whose call ended before any session existed, in the order they ended. */
	let held: PendingDecision[] = [];
	/** Outcomes whose `ref` names a decision in `held`, in the order they arrived. */
	let heldOutcomes: OutcomeRecord[] = [];
	let scheduled = false;
	let warned = false;
	let lastPrune: number | null = null;
	let preparedRoot: string | null = null;
	const days = new Map<string, DayState>();

	const fail = (stage: string, err: unknown): void => {
		if (warned) return;
		warned = true;
		const detail = err instanceof Error ? err.message : String(err);
		deps.warn(`System One dataset ${stage} failed (${detail}); rows may be lost. This notice is shown once.`);
	};

	const prepareRoot = (): string => {
		const root = join(clioStateDir(), DATASET_DIR_NAME);
		if (preparedRoot === root) return root;
		mkdirSync(root, { recursive: true, mode: DIR_MODE });
		try {
			// mkdir's mode does not tighten a directory an earlier version or the operator made.
			chmodSync(root, DIR_MODE);
		} catch {
			// Some filesystems have no modes; the files inside still carry 0600 where they do.
		}
		preparedRoot = root;
		return root;
	};

	const pruneIfDue = (root: string): void => {
		const clock = performance.now();
		if (lastPrune !== null && clock - lastPrune < PRUNE_INTERVAL_MS) return;
		lastPrune = clock;
		try {
			for (const day of pruneDataset(root, deps.limits(), Date.now())) days.delete(day);
		} catch (err) {
			fail("retention", err);
		}
	};

	const dayState = (root: string, day: string, checked: Set<string>): DayState => {
		const path = join(root, dayFileName(day));
		let state = days.get(day);
		// Another process's retention pass or an uninstall may have removed the file under a cached state.
		if (state !== undefined && !checked.has(day) && !existsSync(path)) state = undefined;
		checked.add(day);
		if (state === undefined) {
			state = loadDay(path);
			days.set(day, state);
		}
		return state;
	};

	const writeQueued = (): void => {
		// Held decisions still need the exit hook, which only reaches writers in this set.
		if (held.length === 0) pendingWriters.delete(writer);
		if (queue.length === 0) return;
		const batch = queue;
		queue = [];
		let root: string;
		try {
			// An uninstall removes the state root under live processes; a late write must not rebuild it.
			if (stateRootRemoved()) return;
			root = prepareRoot();
		} catch (err) {
			fail("setup", err);
			return;
		}
		pruneIfDue(root);
		const chunks = new Map<string, string[]>();
		const checked = new Set<string>();
		for (const item of batch) {
			try {
				const day = dayOf(item.record.at, Date.now());
				const chunk = chunks.get(day) ?? [];
				chunks.set(day, chunk);
				const state = dayState(root, day, checked);
				if (item.type === "outcome") {
					chunk.push(encode(outcomeRow(item.record)));
					continue;
				}
				const hashes: Record<string, string> = {};
				for (const [id, question] of Object.entries(item.record.questions)) {
					const hash = specHash(question);
					hashes[id] = hash;
					if (state.specs.has(hash)) continue;
					state.specs.add(hash);
					chunk.push(encode({ kind: "spec", hash, spec: scrub(question, createRedactionTally(), false) }));
				}
				chunk.push(encode(decisionRow(item, hashes)));
			} catch (err) {
				fail("encode", err);
			}
		}
		for (const [day, chunk] of chunks) {
			if (chunk.length === 0) continue;
			try {
				const state = days.get(day);
				appendFileSync(join(root, dayFileName(day)), `${state?.torn ? "\n" : ""}${chunk.join("")}`, { mode: FILE_MODE });
				if (state !== undefined) state.torn = false;
			} catch (err) {
				// Specs this batch marked as written may not have landed, and a partial append
				// leaves a torn line. Forgetting both costs a duplicate spec row; rereading the
				// file would cost a full read on every batch for as long as the disk refuses.
				days.set(day, { specs: new Set(), torn: true });
				fail("write", err);
			}
		}
	};

	const enqueue = (item: Queued): void => {
		queue.push(item);
		if (queue.length > MAX_QUEUED) queue = queue.slice(queue.length - MAX_QUEUED);
		pendingWriters.add(writer);
		hookExit();
		if (scheduled) return;
		scheduled = true;
		setImmediate(() => {
			scheduled = false;
			writeQueued();
		});
	};

	const hold = (item: PendingDecision): void => {
		held.push(item);
		if (held.length > MAX_QUEUED) {
			// Queued as it stands: a process that never adopts must not grow without
			// bound, and dropping the oldest would lose the row.
			const oldest = held.shift();
			if (oldest !== undefined) {
				enqueue({ type: "decision", ...oldest });
				// Its outcomes go with it, unless a younger held decision shares the ref and they still wait for that one.
				if (!held.some((other) => other.record.ref === oldest.record.ref)) {
					const own = heldOutcomes.filter((outcome) => outcome.ref === oldest.record.ref);
					heldOutcomes = heldOutcomes.filter((outcome) => outcome.ref !== oldest.record.ref);
					for (const record of own) enqueue({ type: "outcome", record });
				}
			}
		}
		pendingWriters.add(writer);
		hookExit();
	};

	const holdOutcome = (record: OutcomeRecord): void => {
		heldOutcomes.push(record);
		if (heldOutcomes.length > MAX_QUEUED) {
			// Past the bound the oldest is written ahead of its decision, which is a misordering and not a loss.
			const oldest = heldOutcomes.shift();
			if (oldest !== undefined) enqueue({ type: "outcome", record: oldest });
		}
	};

	/**
	 * The held rows in write order: each decision, then the outcomes that name its ref, placed
	 * after the last held decision sharing that ref. Empties both holds. Recording turned off
	 * drops the lot, outcomes included, since their decision is not going to be written.
	 */
	const takeHeld = (): Queued[] => {
		const waiting = held;
		const outcomes = heldOutcomes;
		held = [];
		heldOutcomes = [];
		if (!deps.recording()) return [];
		const lastFor = new Map<string, number>();
		waiting.forEach((item, index) => {
			if (item.record.ref !== undefined) lastFor.set(item.record.ref, index);
		});
		const rows: Queued[] = [];
		waiting.forEach((item, index) => {
			rows.push({ type: "decision", ...item });
			for (const record of outcomes) if (lastFor.get(record.ref) === index) rows.push({ type: "outcome", record });
		});
		for (const record of outcomes) if (!lastFor.has(record.ref)) rows.push({ type: "outcome", record });
		return rows;
	};

	// Retention is a promise about files already on disk, and writes are the only
	// other trigger, so an operator who turned recording off would keep every day
	// file past `retentionDays`. One deferred pass per process covers that.
	setImmediate(() => {
		try {
			if (stateRootRemoved()) return;
			lastPrune = performance.now();
			for (const day of pruneDataset(join(clioStateDir(), DATASET_DIR_NAME), deps.limits(), Date.now())) days.delete(day);
		} catch (err) {
			fail("retention", err);
		}
	}).unref();

	const writer: DatasetWriter = {
		decision: (item) => (item.session === null ? hold(item) : enqueue({ type: "decision", ...item })),
		outcome: (record) =>
			held.some((item) => item.record.ref === record.ref) ? holdOutcome(record) : enqueue({ type: "outcome", record }),
		adopt(session) {
			for (const item of takeHeld()) enqueue(item.type === "decision" ? { ...item, session } : item);
		},
		flush() {
			queue.push(...takeHeld());
			writeQueued();
		},
	};
	return writer;
}
