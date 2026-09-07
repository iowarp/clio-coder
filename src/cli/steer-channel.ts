import * as fs from "node:fs";
import { Socket } from "node:net";
import * as readline from "node:readline";

export function setupSteerChannel(filePath: string, onLine: (line: string) => void): () => void {
	let closed = false;
	let watcher: fs.FSWatcher | null = null;
	let stream: Socket | null = null;
	let rl: readline.Interface | null = null;
	const cleanup = () => {
		if (closed) return;
		closed = true;
		watcher?.close();
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
				const trimmed = line.trim();
				if (trimmed.length > 0) {
					onLine(trimmed);
				}
			});
		} else {
			// Regular file: read current contents, and watch for appends
			let bytesRead = 0;
			let leftover = "";
			const readNewContent = () => {
				if (closed) return;
				try {
					const currentStats = fs.statSync(filePath);
					if (currentStats.size > bytesRead) {
						let fd: number | undefined;
						const buffer = Buffer.alloc(currentStats.size - bytesRead);
						try {
							fd = fs.openSync(filePath, "r");
							fs.readSync(fd, buffer, 0, buffer.length, bytesRead);
						} finally {
							if (fd !== undefined) fs.closeSync(fd);
						}
						bytesRead = currentStats.size;

						const text = `${leftover}${buffer.toString("utf-8")}`;
						const lines = text.split(/\r?\n/);
						leftover = lines.pop() ?? "";
						for (const line of lines) {
							if (closed) return;
							const trimmed = line.trim();
							if (trimmed.length > 0) {
								onLine(trimmed);
							}
						}
					}
				} catch (_err) {
					// Ignore transient read errors
				}
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
