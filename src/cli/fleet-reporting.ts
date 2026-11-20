import type { Writable } from "node:stream";

function closedPipe(error: NodeJS.ErrnoException): boolean {
	return error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED";
}

export function createFleetReporter(stdout: Writable = process.stdout, stderr: Writable = process.stderr) {
	const protect = (stream: Writable) => {
		let closed = false;
		const onError = (error: NodeJS.ErrnoException): void => {
			if (!closedPipe(error)) throw error;
			closed = true;
		};
		stream.on("error", onError);
		return {
			write(text: string): void {
				if (closed || stream.destroyed) return;
				try {
					stream.write(text);
				} catch (error) {
					if (!(error instanceof Error) || !closedPipe(error)) throw error;
					closed = true;
				}
			},
			closed: (): boolean => closed || stream.destroyed,
			dispose: () => stream.off("error", onError),
		};
	};
	const out = protect(stdout);
	const err = protect(stderr);
	return {
		stdout: out.write,
		stderr: err.write,
		/** stdout's reader went away; the fleet keeps running and its later output is dropped. */
		readerClosed: out.closed,
		async dispose(): Promise<void> {
			// Writes may emit EPIPE on the next tick, after the last report returns.
			await new Promise<void>((resolve) => setImmediate(resolve));
			out.dispose();
			err.dispose();
		},
	};
}
