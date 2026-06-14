import * as fs from "node:fs";
import * as readline from "node:readline";

export function setupSteerChannel(filePath: string, onLine: (line: string) => void): () => void {
	let closed = false;
	let watcher: fs.FSWatcher | null = null;
	let stream: fs.ReadStream | null = null;
	let rl: readline.Interface | null = null;

	try {
		const stats = fs.statSync(filePath);
		if (stats.isFIFO()) {
			// Named pipe: we can just read from the stream
			stream = fs.createReadStream(filePath);
			rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
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
		process.stderr.write(
			`clio run: failed to setup steer channel: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}

	return () => {
		closed = true;
		if (watcher) {
			watcher.close();
		}
		if (rl) {
			rl.close();
		}
		if (stream) {
			stream.destroy();
		}
	};
}
