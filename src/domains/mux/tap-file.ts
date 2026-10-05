import { closeSync, type FSWatcher, mkdirSync, openSync, readSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Backstop for filesystems that deliver no change events; the watcher is the fast path. */
const TAP_FILE_POLL_MS = 250;
/** Legacy taps are short words; structured consumers opt into a larger line bound. */
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
export function watchTapFile(path: string, onTap: (line: string) => void, maxLine = TAP_LINE_MAX): TapFileWatcher {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "");
	let offset = 0;
	let decoder = new StringDecoder("utf8");
	let partial = "";
	let discarding = false;
	let stopped = false;
	let interval: NodeJS.Timeout | null = null;
	let watcher: FSWatcher | null = null;

	const drain = (): void => {
		if (stopped) return;
		const size = statSync(path, { throwIfNoEntry: false })?.size;
		if (size === undefined) return;
		if (size < offset) {
			offset = 0;
			decoder = new StringDecoder("utf8");
			partial = "";
			discarding = false;
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
		const lines = (partial + decoder.write(bytes.subarray(0, read))).split("\n");
		partial = lines.pop() ?? "";
		if (discarding && lines.length > 0) {
			lines.shift();
			discarding = false;
		}
		if (partial.length > maxLine || discarding) {
			partial = "";
			discarding = true;
		}
		for (const line of lines) {
			if (line.length > maxLine) continue;
			const tap = line.trim();
			if (tap.length > 0 && tap.length <= maxLine) onTap(tap);
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
