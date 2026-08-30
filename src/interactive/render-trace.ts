import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TuiRenderObserver, TuiRenderPhase } from "../engine/tui.js";

/** The trace format is append-only JSONL so partial sessions remain readable. */
export const RENDER_TRACE_VERSION = 2;

export type RenderInputAction = "editor" | "overlay" | "scroll" | "submit" | "no-visual-change";
export type VisibleEventKind = "text" | "thinking";

export interface RenderTraceCommit {
	writeId: number;
	at: number;
	bytes: number;
	enqueueMs: number;
	returned: boolean;
	backpressured: boolean;
}

export interface RenderTraceFrameRecord {
	type: "frame";
	version: typeof RENDER_TRACE_VERSION;
	frameId: number;
	mode: "regular" | "fullscreen";
	columns: number;
	rows: number;
	beginAt: number;
	endAt: number;
	durationMs: number;
	sinceLastCommitMs: number | null;
	panelHighWater: number;
	inputHighWater: number;
	panel: { durationMs: number; cacheHit: boolean; entriesRendered: number } | null;
	pipeline: {
		componentMs: number;
		overlayCompositionMs: number;
		normalizationMs: number;
		cursorExtractionMs: number;
		/** Viewport selection, diffing, ANSI construction, and cursor work not exposed as narrower pi-tui hooks. */
		viewportDiffAnsiCursorMs: number;
		terminalEnqueueMs: number;
	};
	commits: RenderTraceCommit[];
}

export type RenderTraceRecord =
	| { type: "trace_start"; version: typeof RENDER_TRACE_VERSION; at: number }
	| {
			type: "event_ingress";
			version: typeof RENDER_TRACE_VERSION;
			eventSeq: number;
			generation: number;
			kind: VisibleEventKind;
			contentIndex: number;
			at: number;
			codeUnitStart: number;
			codeUnitEnd: number;
			graphemeStart: number;
			graphemeEnd: number;
			bytes: number;
	  }
	| {
			type: "queue";
			version: typeof RENDER_TRACE_VERSION;
			eventSeq: number;
			action: "admit" | "dequeue";
			at: number;
			depth: number;
	  }
	| {
			type: "panel";
			version: typeof RENDER_TRACE_VERSION;
			eventSeq: number;
			at: number;
			highWater: number;
	  }
	| {
			type: "input_ingress";
			version: typeof RENDER_TRACE_VERSION;
			inputSeq: number;
			action: RenderInputAction;
			at: number;
			bytes: number;
			visualExpected: boolean;
	  }
	| RenderTraceFrameRecord
	| {
			type: "terminal_write";
			version: typeof RENDER_TRACE_VERSION;
			writeId: number;
			frameId: number | null;
			at: number;
			bytes: number;
			enqueueMs: number;
			returned: boolean;
			backpressured: boolean;
	  }
	| {
			type: "terminal_drain";
			version: typeof RENDER_TRACE_VERSION;
			writeId: number;
			frameId: number | null;
			at: number;
			waitMs: number;
	  }
	| { type: "trace_drop"; version: typeof RENDER_TRACE_VERSION; at: number; records: number };

/** One byte-level delivery from the stdin reader to the application listener. */
export type RenderTraceInputIngressRecord = Extract<RenderTraceRecord, { type: "input_ingress" }>;

/**
 * How many `input_ingress` records and how many committed frame records the
 * always-on ring keeps, each. 256 keystrokes and 256 committed frames cover the
 * last stretch of interaction an operator would still be describing when they
 * kill a wedged pane, and cost about 200 KB of process memory in the worst case
 * (a frame record carries its terminal-write commits).
 */
export const INPUT_WEDGE_RING_CAPACITY = 256;

/** Subdirectory of the state directory that holds SIGTERM wedge dumps. */
export const INPUT_WEDGE_DUMP_DIRNAME = "input-wedge";

/** Dumps kept in that directory; older ones are removed as new ones land. */
export const INPUT_WEDGE_DUMP_RETAINED = 5;

/**
 * Which half of the input pipeline was still moving when the dump was taken.
 *
 * `input-not-committed` is the consumer's failure: bytes reached the
 * application listener and no frame that carries them ever reached stdout.
 * `no-input-recorded` is the reader's: nothing was delivered at all, so an
 * operator who was typing was typing into a reader that had stopped.
 * `input-committed` says neither half of this pipeline was stuck.
 */
export type InputWedgeClassification = "no-input-recorded" | "input-not-committed" | "input-committed";

export interface InputWedgeSnapshot {
	version: typeof RENDER_TRACE_VERSION;
	capacity: number;
	pid: number;
	/** Wall clock at trace open, so a record's relative `at` maps onto real time. */
	openedAtEpochMs: number;
	atEpochMs: number;
	/** Milliseconds since trace open, the same clock every record's `at` uses. */
	at: number;
	classification: InputWedgeClassification;
	msSinceLastInputIngress: number | null;
	msSinceLastCommittedFrame: number | null;
	inputIngress: RenderTraceInputIngressRecord[];
	frames: RenderTraceFrameRecord[];
}

/** Bounded FIFO that overwrites its oldest entry rather than growing. */
function createRing<T>(capacity: number): { push(value: T): void; toArray(): T[] } {
	const slots: T[] = [];
	let next = 0;
	return {
		push(value): void {
			if (slots.length < capacity) slots.push(value);
			else slots[next] = value;
			next = (next + 1) % capacity;
		},
		toArray(): T[] {
			if (slots.length < capacity) return [...slots];
			return [...slots.slice(next), ...slots.slice(0, next)];
		},
	};
}

/**
 * Read the two rings the way the ticket asks the wedge to be read: the newest
 * input the operator should have seen, against the newest frame that reached
 * stdout carrying it.
 */
function classifyInputWedge(
	inputIngress: ReadonlyArray<RenderTraceInputIngressRecord>,
	frames: ReadonlyArray<RenderTraceFrameRecord>,
): InputWedgeClassification {
	const newest = [...inputIngress].reverse().find((record) => record.visualExpected) ?? inputIngress.at(-1);
	if (newest === undefined) return "no-input-recorded";
	return frames.some((frame) => frame.inputHighWater >= newest.inputSeq) ? "input-committed" : "input-not-committed";
}

/**
 * Write one snapshot under `<stateDir>/input-wedge/`, newest-first by name, and
 * drop everything past the retention bound. Synchronous on purpose: the caller
 * is a signal handler on a process that is about to end.
 */
export function writeInputWedgeDump(stateDir: string, snapshot: InputWedgeSnapshot): string {
	const directory = join(stateDir, INPUT_WEDGE_DUMP_DIRNAME);
	mkdirSync(directory, { recursive: true });
	const stamp = new Date(snapshot.atEpochMs).toISOString().replace(/[:.]/gu, "-");
	const path = join(directory, `${stamp}-${snapshot.pid}.json`);
	writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
	try {
		const existing = readdirSync(directory)
			.filter((name) => name.endsWith(".json"))
			.sort();
		for (const name of existing.slice(0, Math.max(0, existing.length - INPUT_WEDGE_DUMP_RETAINED))) {
			rmSync(join(directory, name), { force: true });
		}
	} catch {
		// Retention is housekeeping; a dump that landed is worth more than a tidy directory.
	}
	return path;
}

interface TraceWriter {
	enqueue(record: RenderTraceRecord): void;
	close(): Promise<void>;
}

interface AsyncTraceWriterOptions {
	maxRecords?: number;
	batchRecords?: number;
	append?: (path: string, payload: string) => Promise<void>;
	recordTime?: () => number;
	appendTimeoutMs?: number;
}

/**
 * One bounded producer queue and at most one asynchronous append in flight.
 * JSON serialization is the only render-stack work; filesystem I/O never runs
 * in a render callback, and a slow disk cannot grow an unbounded promise chain.
 */
function createAsyncTraceWriter(path: string, options: AsyncTraceWriterOptions = {}): TraceWriter {
	const maxRecords = options.maxRecords ?? 4_096;
	const batchRecords = options.batchRecords ?? 128;
	const append = options.append ?? ((target, payload) => appendFile(target, payload, "utf8"));
	const recordTime = options.recordTime ?? (() => performance.now());
	// Stage 0 deliberately commits immediately before a large synchronous ESM
	// evaluation. A 500 ms timer could become runnable before the already-finished
	// append callback when that evaluation held the event loop, falsely disabling
	// the trace after its first frame. Five seconds still bounds a genuinely
	// wedged filesystem while surviving boot-time callback starvation.
	const appendTimeoutMs = options.appendTimeoutMs ?? 5_000;
	const pending: string[] = [];
	let dropped = 0;
	let inFlight = false;
	let scheduled = false;
	let failed = false;
	let closing = false;
	let closePromise: Promise<void> | null = null;
	let resolveClose: (() => void) | null = null;

	const settleClose = (): void => {
		if (closing && !inFlight && pending.length === 0) resolveClose?.();
	};
	const pump = (): void => {
		scheduled = false;
		if (failed || inFlight || pending.length === 0) {
			settleClose();
			return;
		}
		inFlight = true;
		const payload = pending.splice(0, batchRecords).join("");
		let appendTimer: NodeJS.Timeout | null = null;
		const appendDeadline = new Promise<never>((_resolve, reject) => {
			appendTimer = setTimeout(() => reject(new Error("render trace append timed out")), appendTimeoutMs);
		});
		void Promise.race([append(path, payload), appendDeadline])
			.catch(() => {
				failed = true;
				pending.length = 0;
			})
			.finally(() => {
				if (appendTimer) clearTimeout(appendTimer);
				inFlight = false;
				if (pending.length > 0 && !failed) queueMicrotask(pump);
				else settleClose();
			});
	};
	const schedule = (): void => {
		if (scheduled || inFlight || failed) return;
		scheduled = true;
		queueMicrotask(pump);
	};

	return {
		enqueue(record): void {
			if (failed || closing) return;
			if (pending.length >= maxRecords) {
				pending.shift();
				dropped += 1;
			}
			pending.push(`${JSON.stringify(record)}\n`);
			schedule();
		},
		close(): Promise<void> {
			if (closePromise) return closePromise;
			if (dropped > 0 && !failed) {
				pending.push(
					`${JSON.stringify({ type: "trace_drop", version: RENDER_TRACE_VERSION, at: recordTime(), records: dropped })}\n`,
				);
			}
			closing = true;
			closePromise = new Promise((resolve) => {
				resolveClose = resolve;
			});
			if (failed) {
				pending.length = 0;
				resolveClose?.();
			} else {
				schedule();
				settleClose();
			}
			return closePromise;
		},
	};
}

interface FrameState {
	frameId: number;
	mode: "regular" | "fullscreen";
	columns: number;
	rows: number;
	beginAt: number;
	panelHighWater: number;
	inputHighWater: number;
	panel: { durationMs: number; cacheHit: boolean; entriesRendered: number } | null;
	phases: Record<"component" | TuiRenderPhase, number>;
	commits: RenderTraceCommit[];
}

export interface RenderTrace extends TuiRenderObserver {
	recordPanelRender(metrics: { durationMs: number; cacheHit: boolean; entriesRendered: number }): void;
	beginGeneration(): void;
	recordVisibleEvent(fields: { kind: VisibleEventKind; contentIndex: number; delta: string }): number;
	recordQueue(eventSeq: number, action: "admit" | "dequeue"): void;
	recordPanelApplied(eventSeq: number): void;
	recordInputIngress(action: RenderInputAction, bytes: number, visualExpected?: boolean): number;
	beginComponentRender(): unknown;
	endComponentRender(token: unknown): void;
	recordTerminalWrite(fields: { bytes: number; enqueueMs: number; returned: boolean }): number;
	recordTerminalDrain(writeId: number): void;
	currentFrameId(): number | null;
	onFirstFrameCommit(listener: (frameId: number) => void): void;
	/** The always-on ring as it stands, classified. Allocates; call it once, on the way out. */
	snapshotInputWedge(): InputWedgeSnapshot;
	close(): Promise<void>;
}

function rounded(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function graphemeCount(text: string): number {
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	let count = 0;
	for (const _part of segmenter.segment(text)) count += 1;
	return count;
}

export function renderTracePath(env: NodeJS.ProcessEnv = process.env): string | null {
	const raw = env.CLIO_CODER_RENDER_TRACE?.trim();
	return raw && raw.length > 0 ? raw : null;
}

/**
 * One tracer, two sinks. The JSONL file is the armed sink: it exists only when
 * `CLIO_CODER_RENDER_TRACE` named a path, and it keeps every record. The
 * bounded in-memory ring is the always-on sink: it keeps the last
 * {@link INPUT_WEDGE_RING_CAPACITY} `input_ingress` records and the same number
 * of committed frames, so the SIGTERM that recovers a wedged pane can still say
 * which half of the input pipeline stopped (#224). A null `path` is the
 * ring-only mode, and there the recorders that only ever fed the file keep
 * their counters and skip building a record nothing would read.
 */
export function createRenderTrace(
	path: string | null,
	now: () => number = () => performance.now(),
	writerOptions: AsyncTraceWriterOptions = {},
): RenderTrace {
	// Initialization happens before the terminal/TUI starts, never in a frame.
	if (path !== null) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "", "utf8");
	}
	const openedAt = now();
	const openedAtEpochMs = Date.now();
	const at = (): number => rounded(now() - openedAt);
	const writer = path === null ? null : createAsyncTraceWriter(path, { ...writerOptions, recordTime: at });
	const inputRing = createRing<RenderTraceInputIngressRecord>(INPUT_WEDGE_RING_CAPACITY);
	const frameRing = createRing<RenderTraceFrameRecord>(INPUT_WEDGE_RING_CAPACITY);
	let frameSeq = 0;
	let writeSeq = 0;
	let eventSeq = 0;
	let inputSeq = 0;
	let generation = 0;
	let panelHighWater = 0;
	let inputHighWater = 0;
	let queueDepth = 0;
	let currentFrame: FrameState | null = null;
	let pendingPanel: FrameState["panel"] = null;
	let lastCommitAt: number | null = null;
	let firstCommitListener: ((frameId: number) => void) | null = null;
	let firstCommitDelivered = false;
	const ranges = new Map<string, { codeUnits: number; graphemes: number }>();
	const pendingDrains = new Map<number, { frameId: number | null; at: number }>();

	writer?.enqueue({ type: "trace_start", version: RENDER_TRACE_VERSION, at: 0 });

	const trace: RenderTrace = {
		recordPanelRender(metrics): void {
			pendingPanel = metrics;
		},
		beginGeneration(): void {
			generation += 1;
			ranges.clear();
		},
		recordVisibleEvent(fields): number {
			eventSeq += 1;
			// The ring keeps no provider deltas, so ring-only mode does not pay for
			// grapheme segmentation on every token of every stream.
			if (writer === null) return eventSeq;
			const key = `${generation}:${fields.kind}:${fields.contentIndex}`;
			const previous = ranges.get(key) ?? { codeUnits: 0, graphemes: 0 };
			const graphemes = graphemeCount(fields.delta);
			const next = { codeUnits: previous.codeUnits + fields.delta.length, graphemes: previous.graphemes + graphemes };
			ranges.set(key, next);
			writer?.enqueue({
				type: "event_ingress",
				version: RENDER_TRACE_VERSION,
				eventSeq,
				generation,
				kind: fields.kind,
				contentIndex: fields.contentIndex,
				at: at(),
				codeUnitStart: previous.codeUnits,
				codeUnitEnd: next.codeUnits,
				graphemeStart: previous.graphemes,
				graphemeEnd: next.graphemes,
				bytes: Buffer.byteLength(fields.delta, "utf8"),
			});
			return eventSeq;
		},
		recordQueue(sequence, action): void {
			queueDepth = Math.max(0, queueDepth + (action === "admit" ? 1 : -1));
			writer?.enqueue({
				type: "queue",
				version: RENDER_TRACE_VERSION,
				eventSeq: sequence,
				action,
				at: at(),
				depth: queueDepth,
			});
		},
		recordPanelApplied(sequence): void {
			panelHighWater = Math.max(panelHighWater, sequence);
			writer?.enqueue({
				type: "panel",
				version: RENDER_TRACE_VERSION,
				eventSeq: sequence,
				at: at(),
				highWater: panelHighWater,
			});
		},
		recordInputIngress(action, bytes, visualExpected = action !== "no-visual-change"): number {
			inputSeq += 1;
			if (visualExpected) inputHighWater = inputSeq;
			const record: RenderTraceInputIngressRecord = {
				type: "input_ingress",
				version: RENDER_TRACE_VERSION,
				inputSeq,
				action,
				at: at(),
				bytes,
				visualExpected,
			};
			inputRing.push(record);
			writer?.enqueue(record);
			return inputSeq;
		},
		beginFrame(fields): FrameState {
			frameSeq += 1;
			const frame: FrameState = {
				frameId: frameSeq,
				...fields,
				beginAt: at(),
				panelHighWater,
				inputHighWater,
				panel: pendingPanel,
				phases: { component: 0, overlay: 0, normalization: 0, cursor: 0 },
				commits: [],
			};
			pendingPanel = null;
			currentFrame = frame;
			return frame;
		},
		endFrame(frameToken): void {
			const frame = frameToken as FrameState;
			const endAt = at();
			const terminalEnqueueMs = frame.commits.reduce((sum, commit) => sum + commit.enqueueMs, 0);
			const measured =
				frame.phases.component +
				frame.phases.overlay +
				frame.phases.normalization +
				frame.phases.cursor +
				terminalEnqueueMs;
			const record: RenderTraceFrameRecord = {
				type: "frame",
				version: RENDER_TRACE_VERSION,
				frameId: frame.frameId,
				mode: frame.mode,
				columns: frame.columns,
				rows: frame.rows,
				beginAt: frame.beginAt,
				endAt,
				durationMs: rounded(Math.max(0, endAt - frame.beginAt)),
				sinceLastCommitMs:
					lastCommitAt === null || frame.commits.length === 0
						? null
						: rounded(Math.max(0, (frame.commits[0]?.at ?? endAt) - lastCommitAt)),
				panelHighWater: frame.panelHighWater,
				inputHighWater: frame.inputHighWater,
				panel: frame.panel,
				pipeline: {
					componentMs: rounded(frame.phases.component),
					overlayCompositionMs: rounded(frame.phases.overlay),
					normalizationMs: rounded(frame.phases.normalization),
					cursorExtractionMs: rounded(frame.phases.cursor),
					viewportDiffAnsiCursorMs: rounded(Math.max(0, endAt - frame.beginAt - measured)),
					terminalEnqueueMs: rounded(terminalEnqueueMs),
				},
				commits: frame.commits,
			};
			writer?.enqueue(record);
			if (frame.commits.length > 0) {
				// Only a frame that reached stdout answers the question the ring exists
				// for, which is whether the consumer half is still painting.
				frameRing.push(record);
				lastCommitAt = frame.commits.at(-1)?.at ?? endAt;
				if (!firstCommitDelivered) {
					firstCommitDelivered = true;
					firstCommitListener?.(frame.frameId);
				}
			}
			if (currentFrame === frame) currentFrame = null;
		},
		beginPhase(_frame, _phase): number {
			return now();
		},
		endPhase(frameToken, phase, phaseToken): void {
			const frame = frameToken as FrameState;
			frame.phases[phase] += Math.max(0, now() - (phaseToken as number));
		},
		beginComponentRender(): number | null {
			return currentFrame ? now() : null;
		},
		endComponentRender(token): void {
			if (currentFrame === null || token === null) return;
			currentFrame.phases.component += Math.max(0, now() - (token as number));
		},
		recordTerminalWrite(fields): number {
			writeSeq += 1;
			const frameId = currentFrame?.frameId ?? null;
			const commit: RenderTraceCommit = {
				writeId: writeSeq,
				at: at(),
				bytes: fields.bytes,
				enqueueMs: rounded(fields.enqueueMs),
				returned: fields.returned,
				backpressured: !fields.returned,
			};
			currentFrame?.commits.push(commit);
			if (writer === null) return writeSeq;
			writer.enqueue({ type: "terminal_write", version: RENDER_TRACE_VERSION, frameId, ...commit });
			if (!fields.returned) pendingDrains.set(writeSeq, { frameId, at: commit.at });
			return writeSeq;
		},
		recordTerminalDrain(writeId): void {
			const pending = pendingDrains.get(writeId);
			if (!pending) return;
			pendingDrains.delete(writeId);
			const drainAt = at();
			writer?.enqueue({
				type: "terminal_drain",
				version: RENDER_TRACE_VERSION,
				writeId,
				frameId: pending.frameId,
				at: drainAt,
				waitMs: rounded(Math.max(0, drainAt - pending.at)),
			});
		},
		currentFrameId: () => currentFrame?.frameId ?? null,
		onFirstFrameCommit(listener): void {
			firstCommitListener = listener;
		},
		snapshotInputWedge(): InputWedgeSnapshot {
			const inputIngress = inputRing.toArray();
			const frames = frameRing.toArray();
			const nowAt = at();
			const lastIngressAt = inputIngress.at(-1)?.at;
			const lastFrame = frames.at(-1);
			const lastFrameCommitAt = lastFrame?.commits.at(-1)?.at ?? lastFrame?.endAt;
			return {
				version: RENDER_TRACE_VERSION,
				capacity: INPUT_WEDGE_RING_CAPACITY,
				pid: process.pid,
				openedAtEpochMs,
				atEpochMs: Date.now(),
				at: nowAt,
				classification: classifyInputWedge(inputIngress, frames),
				msSinceLastInputIngress: lastIngressAt === undefined ? null : rounded(nowAt - lastIngressAt),
				msSinceLastCommittedFrame: lastFrameCommitAt === undefined ? null : rounded(nowAt - lastFrameCommitAt),
				inputIngress,
				frames,
			};
		},
		close: () => writer?.close() ?? Promise.resolve(),
	};
	return trace;
}

/** Time the root component without replacing its identity or layout markers. */
export function traceComponentRenders<TComponent extends { render(width: number): string[] }>(
	component: TComponent,
	trace: Pick<RenderTrace, "beginComponentRender" | "endComponentRender">,
): () => void {
	const original = component.render;
	const wrapped = function (this: TComponent, width: number): string[] {
		const token = trace.beginComponentRender();
		try {
			return original.call(this, width);
		} finally {
			trace.endComponentRender(token);
		}
	};
	component.render = wrapped;
	return () => {
		if (component.render === wrapped) component.render = original;
	};
}

/**
 * Observe the real Node stdout boundary. This catches writes made by terminal
 * helpers that bypass `Terminal.write()` and records the Writable boolean plus
 * the matching `drain`, while preserving Node's overloaded write contract.
 */
export function traceProcessStdout(
	trace: Pick<RenderTrace, "recordTerminalWrite" | "recordTerminalDrain">,
	now: () => number = () => performance.now(),
	stdout: Pick<typeof process.stdout, "write" | "once"> = process.stdout,
): () => void {
	const original = stdout.write;
	const pendingDrainWrites: number[] = [];
	let drainListening = false;
	const wrapped = function (this: typeof stdout, ...args: unknown[]): boolean {
		const chunk = args[0];
		const start = now();
		const returned = Reflect.apply(original, this, args) as boolean;
		const enqueueMs = Math.max(0, now() - start);
		let bytes = 0;
		try {
			bytes = Buffer.isBuffer(chunk)
				? chunk.byteLength
				: ArrayBuffer.isView(chunk)
					? chunk.byteLength
					: Buffer.byteLength(String(chunk), typeof args[1] === "string" ? (args[1] as BufferEncoding) : "utf8");
		} catch {
			bytes = Buffer.byteLength(String(chunk), "utf8");
		}
		const writeId = trace.recordTerminalWrite({ bytes, enqueueMs, returned });
		if (!returned) {
			pendingDrainWrites.push(writeId);
			if (!drainListening) {
				drainListening = true;
				stdout.once("drain", () => {
					drainListening = false;
					for (const pendingWriteId of pendingDrainWrites.splice(0)) trace.recordTerminalDrain(pendingWriteId);
				});
			}
		}
		return returned;
	} as typeof stdout.write;
	stdout.write = wrapped;
	return () => {
		if (stdout.write === wrapped) stdout.write = original;
	};
}
