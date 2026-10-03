import { closeSync, type FSWatcher, mkdirSync, openSync, readSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Backstop for filesystems that deliver no change events; the watcher is the fast path. */
const TAP_FILE_POLL_MS = 250;
/** A tap is one short word. A longer line is someone else's write and is skipped whole. */
const TAP_LINE_MAX = 64;

export interface TapFileWatcher {
	stop(): void;
}

/**
 * Calls `onTap` once per line appended to `path`, with the line's text.
 *
 * A program running inside a dock pane cannot reach Clio's key handler, so it
 * appends a line to a file only this session reads: cliamp's dock plugin and
 * the workers dashboard both do. The file is emptied when the watch starts,
 * which drops taps a dead session left behind. Change events make a tap
 * arrive in milliseconds; a slow interval catches the rest.
 */
export function watchTapFile(path: string, onTap: (line: string) => void): TapFileWatcher {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "");
	let offset = 0;
	let partial = "";
	let stopped = false;
	let interval: NodeJS.Timeout | null = null;
	let watcher: FSWatcher | null = null;

	const drain = (): void => {
		if (stopped) return;
		const size = statSync(path, { throwIfNoEntry: false })?.size;
		if (size === undefined) return;
		if (size < offset) {
			offset = 0;
			partial = "";
		}
		const remaining = size - offset;
		if (remaining <= 0) return;
		const bytes = Buffer.allocUnsafe(remaining);
		let read = 0;
		const fd = openSync(path, "r");
		try {
			read = readSync(fd, bytes, 0, remaining, offset);
		} finally {
			closeSync(fd);
		}
		offset += read;
		const lines = (partial + bytes.subarray(0, read).toString("utf8")).split("\n");
		partial = lines.pop() ?? "";
		if (partial.length > TAP_LINE_MAX) partial = "";
		for (const line of lines) {
			const tap = line.trim();
			if (tap.length > 0 && tap.length <= TAP_LINE_MAX) onTap(tap);
		}
	};

	const tick = (): void => {
		try {
			drain();
		} catch {
			// A read that races the writer is retried on the next event or tick.
		}
	};
	interval = setInterval(tick, TAP_FILE_POLL_MS);
	interval.unref();
	try {
		watcher = watch(path, { persistent: false }, tick);
		watcher.on("error", () => undefined);
	} catch {
		// No change events here; the interval still delivers every tap.
	}
	return {
		stop(): void {
			stopped = true;
			if (interval) clearInterval(interval);
			interval = null;
			watcher?.close();
			watcher = null;
		},
	};
}
