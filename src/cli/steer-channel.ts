import * as fs from "node:fs";
import { Socket } from "node:net";
import * as readline from "node:readline";
import { StringDecoder } from "node:string_decoder";

/** `lineNumber` is the 1-based index of the line in the channel, blank lines included, so one writer can correlate. */
export function setupSteerChannel(filePath: string, onLine: (line: string, lineNumber: number) => void): () => void {
	let closed = false;
	let lineNumber = 0;
	let watcher: fs.FSWatcher | null = null;
	let stream: Socket | null = null;
	let rl: readline.Interface | null = null;
	let finishFile: (() => void) | undefined;
	const cleanup = () => {
		if (closed) return;
		closed = true;
		watcher?.close();
		finishFile?.();
		rl?.close();
		stream?.destroy();
	};
	const reportError = (err: unknown) => {
		if (closed) return;
		process.stderr.write(
			`clio-coder run: failed to setup steer channel: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		cleanup();
	};

	try {
		const stats = fs.statSync(filePath);
		if (stats.isFIFO()) {
			// A blocking fs read cannot be cancelled while a FIFO writer stays
			// open. Socket uses readiness-driven pipe reads that destroy() closes.
			// Keep read-only access and the existing first-writer-EOF behavior.
			const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
			try {
				stream = new Socket({ fd, readable: true, writable: false });
			} catch (err) {
				// Ownership transfers to Socket only after successful construction.
				fs.closeSync(fd);
				throw err;
			}
			stream.on("error", reportError);
			rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
			rl.on("error", reportError);
			rl.on("line", (line) => {
				if (closed) return;
				lineNumber += 1;
				const trimmed = line.trim();
				if (trimmed.length > 0) {
					onLine(trimmed, lineNumber);
				}
			});
		} else {
			// Regular file: read current contents, and watch for appends
			let bytesRead = 0;
			let leftover = "";
			const decoder = new StringDecoder("utf8");
			const readNewContent = (final = false) => {
				if (closed && !final) return;
				try {
					const currentStats = fs.statSync(filePath);
					if (currentStats.size > bytesRead) {
						let fd: number | undefined;
						const buffer = Buffer.alloc(currentStats.size - bytesRead);
						let actualBytesRead = 0;
						try {
							fd = fs.openSync(filePath, "r");
							actualBytesRead = fs.readSync(fd, buffer, 0, buffer.length, bytesRead);
						} finally {
							if (fd !== undefined) fs.closeSync(fd);
						}
						bytesRead += actualBytesRead;

						const text = `${leftover}${decoder.write(buffer.subarray(0, actualBytesRead))}`;
						const lines = text.split(/\r?\n/);
						leftover = lines.pop() ?? "";
						for (const line of lines) {
							if (closed && !final) return;
							lineNumber += 1;
							const trimmed = line.trim();
							if (trimmed.length > 0) {
								onLine(trimmed, lineNumber);
							}
						}
					}
				} catch (_err) {
					// Ignore transient read errors
				}
			};
			// Finding 13: regular files stay open for appends until explicit cleanup.
			finishFile = () => {
				readNewContent(true);
				const trimmed = `${leftover}${decoder.end()}`.trim();
				leftover = "";
				if (trimmed.length > 0) onLine(trimmed, lineNumber + 1);
			};

			// Read initial content
			readNewContent();

			// Watch for changes
			watcher = fs.watch(filePath, (event) => {
				if (event === "change") {
					readNewContent();
				}
			});
		}
	} catch (err) {
		reportError(err);
	}

	return cleanup;
}

export type SteerLineStatus = "accepted" | "queued" | "refused";

/** What a steer intake needs from the chat it steers. */
interface SteerTarget {
	steer(text: string): boolean;
	onEvent(handler: (event: { type: string }) => void): () => void;
}

const NO_TURN = "no turn was streaming to take the line";
const SETTLED = "the run settled before a turn took the line";

/**
 * Hands channel lines to the chat. A caller may write its first line at once: a line read before the first turn
 * streams is held, noted `queued`, and handed over in channel order as soon as that turn can take it. Once a turn
 * has streamed, a line no turn takes is refused. `close` refuses whatever is still held.
 */
export function createSteerIntake(
	target: SteerTarget,
	note: (lineNumber: number, status: SteerLineStatus, reason?: string) => void,
): { take: (line: string, lineNumber: number) => void; close: () => void } {
	const held: Array<{ line: string; lineNumber: number }> = [];
	let streamed = false;
	let closed = false;
	const flush = (): void => {
		while (!closed && held[0] !== undefined && target.steer(held[0].line)) {
			const taken = held.shift();
			streamed = true;
			if (taken !== undefined) note(taken.lineNumber, "accepted");
		}
	};
	const unsubscribe = target.onEvent((event) => {
		if (event.type === "agent_start") streamed = true;
		// Hand held lines over after the event's own listeners ran, never from inside the emit.
		if (held.length > 0) queueMicrotask(flush);
	});
	return {
		take(line, lineNumber) {
			if (closed) return;
			if (held.length === 0 && target.steer(line)) {
				streamed = true;
				note(lineNumber, "accepted");
				return;
			}
			// A held line keeps its place: later lines wait behind it.
			if (!streamed || held.length > 0) {
				held.push({ line, lineNumber });
				note(lineNumber, "queued");
				return;
			}
			note(lineNumber, "refused", NO_TURN);
		},
		close() {
			if (closed) return;
			closed = true;
			unsubscribe();
			for (const left of held.splice(0)) note(left.lineNumber, "refused", SETTLED);
		},
	};
}
