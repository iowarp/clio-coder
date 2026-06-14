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
			const readNewContent = () => {
				try {
					const currentStats = fs.statSync(filePath);
					if (currentStats.size > bytesRead) {
						const fd = fs.openSync(filePath, "r");
						const buffer = Buffer.alloc(currentStats.size - bytesRead);
						fs.readSync(fd, buffer, 0, buffer.length, bytesRead);
						fs.closeSync(fd);
						bytesRead = currentStats.size;

						const text = buffer.toString("utf-8");
						const lines = text.split(/\r?\n/);
						for (const line of lines) {
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
