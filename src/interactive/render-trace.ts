import { appendFileSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Opt-in per-frame render instrument. Off unless CLIO_RENDER_TRACE names a
 * file, and it costs one `performance.now()` plus a buffered line per frame
 * when it is on.
 *
 * It exists because "the TUI is janky with a fast model" is not a number.
 * Two costs hide behind that sentence and they call for different fixes: time
 * spent building the frame (chat-panel render, markdown, wrapping) and time
 * spent writing it (bytes to the terminal, full redraws instead of diffs). A
 * row per frame carrying both, plus the gap since the previous frame, tells
 * them apart.
 */
export interface RenderTraceRow {
	/** ms since the trace opened. */
	at: number;
	/** ms since the previous frame's write, or null for the first. */
	sinceLastMs: number | null;
	/** Bytes handed to the terminal for this frame. */
	bytes: number;
	/** Chat-panel render time attributed to this frame, when one was recorded. */
	panelMs: number | null;
	panelCacheHit: boolean | null;
	panelEntries: number | null;
	/** Stream deltas applied since the previous frame. */
	deltas: number;
	/** ms from the first unrendered delta to this frame, or null when none arrived. */
	deltaLagMs: number | null;
}

export interface RenderTrace {
	recordPanelRender(metrics: { durationMs: number; cacheHit: boolean; entriesRendered: number }): void;
	/** One streamed text/thinking delta reached the panel. */
	recordDelta(): void;
	recordFrame(bytes: number): void;
	close(): void;
}

/**
 * Rows buffered before a synchronous append. Small enough that a session read
 * mid-run sees the frames it just produced, which the first measuring attempt
 * did not: a 64-row buffer that only ever flushed once described startup and
 * said nothing about the streaming turn it was opened for.
 */
const FLUSH_EVERY = 8;

export function renderTracePath(env: NodeJS.ProcessEnv = process.env): string | null {
	const raw = env.CLIO_RENDER_TRACE?.trim();
	return raw && raw.length > 0 ? raw : null;
}

export function createRenderTrace(path: string, now: () => number = () => performance.now()): RenderTrace {
	mkdirSync(dirname(path), { recursive: true });
	// Truncate on open so a trace is one session, never an append of several.
	writeSync(openSync(path, "w"), "");
	const openedAt = now();
	let lastFrameAt: number | null = null;
	// The panel renders during the frame that is about to be written, so its
	// metrics are held until that write attributes them.
	let pendingPanel: { durationMs: number; cacheHit: boolean; entriesRendered: number } | null = null;
	let pendingDeltas = 0;
	let firstPendingDeltaAt: number | null = null;
	let buffer: string[] = [];

	const flush = (): void => {
		if (buffer.length === 0) return;
		const payload = buffer.join("");
		buffer = [];
		try {
			appendFileSync(path, payload);
		} catch {
			// A trace that cannot be written must not take the session down.
		}
	};

	return {
		recordPanelRender(metrics): void {
			pendingPanel = metrics;
		},
		recordDelta(): void {
			pendingDeltas += 1;
			firstPendingDeltaAt ??= now() - openedAt;
		},
		recordFrame(bytes): void {
			const at = now() - openedAt;
			const row: RenderTraceRow = {
				at: Math.round(at * 1000) / 1000,
				sinceLastMs: lastFrameAt === null ? null : Math.round((at - lastFrameAt) * 1000) / 1000,
				bytes,
				panelMs: pendingPanel ? Math.round(pendingPanel.durationMs * 1000) / 1000 : null,
				panelCacheHit: pendingPanel ? pendingPanel.cacheHit : null,
				panelEntries: pendingPanel ? pendingPanel.entriesRendered : null,
				deltas: pendingDeltas,
				deltaLagMs: firstPendingDeltaAt === null ? null : Math.round((at - firstPendingDeltaAt) * 1000) / 1000,
			};
			lastFrameAt = at;
			pendingPanel = null;
			pendingDeltas = 0;
			firstPendingDeltaAt = null;
			buffer.push(`${JSON.stringify(row)}\n`);
			if (buffer.length >= FLUSH_EVERY) flush();
		},
		close(): void {
			flush();
		},
	};
}

/**
 * Wrap a terminal so every frame's byte count reaches the trace. pi-tui emits
 * exactly one `write` per rendered frame, so counting writes counts frames.
 */
export function traceTerminalWrites<TTerminal extends { write(data: string): void }>(
	terminal: TTerminal,
	trace: Pick<RenderTrace, "recordFrame">,
): TTerminal {
	const original = terminal.write.bind(terminal);
	terminal.write = (data: string): void => {
		trace.recordFrame(Buffer.byteLength(data, "utf8"));
		original(data);
	};
	return terminal;
}
