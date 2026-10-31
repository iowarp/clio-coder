import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import { captureAdmits, STANDARD_CAPTURE } from "../../core/telemetry/capture.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import { newProcessId } from "../../core/telemetry/ids.js";
import type { PendingTelemetry, TelemetrySink } from "../../core/telemetry/producer.js";
import { registerProcessTelemetrySink } from "../../core/telemetry/producer.js";
import type { CallJournal } from "./call-journal.js";
import { openCallJournal } from "./call-journal.js";
import { telemetryProcessDirectory } from "./paths.js";

let processId: string | undefined;

/** This process's telemetry id, `prc_<uuidv7>`, minted on first use and stable for the process's life (#434). */
function telemetryProcessId(): string {
	processId ??= newProcessId();
	return processId;
}

/** Records the journal may hold before its writer opens; past it they drop and the writer records a gap. */
const PENDING_LIMIT = 4096;

export interface ProcessJournal {
	/** Flush what reached the writer. */
	flush(): Promise<void>;
	/** Write `process.exited` when the journal opened, then release it; a journal that never opened stays absent. */
	close(exitCode: number): Promise<void>;
}

/**
 * The process scope's journal (#434). It owns every record whose context names neither a session nor a run, and
 * opens only on the first such record, so a process that never produces one, such as a read-only CLI command,
 * creates nothing. Its first record is `process.started`; a clean stop closes it with `process.exited`.
 */
export function createProcessJournal(stateDir: string, unavailable: () => void): ProcessJournal {
	const context: TelemetryContext = { sessionId: null, processId: telemetryProcessId(), label: "main" };
	const pending: PendingTelemetry[] = [];
	let dropped = 0;
	let writer: Promise<CallJournal | null> | undefined;
	let closed = false;
	/** The opened writer, null once opening failed. */
	let ready: CallJournal | null | undefined;
	const stamp = (kind: "process.started" | "process.exited", data: PendingTelemetry["data"]): PendingTelemetry =>
		({ kind, data, ctx: context, wallMs: Date.now(), mono: performance.now() }) as PendingTelemetry;
	const open = (): Promise<CallJournal | null> =>
		(writer ??= readFile(join(resolvePackageRoot(), "package.json"), "utf8")
			.then((text) => {
				const pkg = JSON.parse(text) as { version?: string; dependencies?: Record<string, string> };
				return openCallJournal({
					directory: telemetryProcessDirectory(stateDir, context.processId),
					context,
					writer: {
						clioCoderVersion: pkg.version ?? "unknown",
						piVersion: pkg.dependencies?.["@earendil-works/pi-ai"] ?? "unknown",
					},
				});
			})
			.then((journal) => {
				ready = journal;
				journal.enqueue(stamp("process.started", {}));
				for (const record of pending.splice(0)) journal.enqueue(record);
				return journal;
			})
			.catch(() => {
				ready = null;
				pending.length = 0;
				try {
					unavailable();
				} catch {
					// A diagnostic observer cannot change what the process journal recorded (#434).
				}
				return null;
			}));
	const sink: TelemetrySink = {
		enqueue(record) {
			if (closed) return false;
			if (ready) return ready.enqueue(record);
			if (ready === null) return false;
			if (pending.length >= PENDING_LIMIT) {
				dropped += 1;
				return false;
			}
			pending.push(record);
			// Opening is cold work; the producer only enqueues and returns (#434, rule13).
			void open();
			return true;
		},
		admits(kind) {
			return ready ? ready.admits(kind) : captureAdmits(STANDARD_CAPTURE, kind);
		},
	};
	const unregister = registerProcessTelemetrySink(context, sink);
	return {
		async flush() {
			await (await writer)?.flush();
		},
		async close(exitCode) {
			if (closed) return;
			closed = true;
			unregister();
			const journal = await writer;
			if (!journal) return;
			if (dropped > 0) unavailable();
			journal.enqueue(stamp("process.exited", { exitCode }));
			await journal.close();
		},
	};
}
