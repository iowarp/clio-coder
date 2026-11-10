interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;
/** Set once `run`'s stdout failed (reader gone, device full): later writes and flushes are no-ops. */
let stdoutDead = false;
let onStdoutFailure: ((error: NodeJS.ErrnoException) => void) | undefined;

export function isStdoutDead(): boolean {
	return stdoutDead;
}

/**
 * `run` owns its stdout errors (S-50): a closed reader ends it with SIGPIPE status and a full device with one line,
 * both through `shutdown`, so the turn is canceled, children stop and the run record and session settle.
 */
export function handleRunStdoutErrors(shutdown: (code: number) => unknown): void {
	if (onStdoutFailure) return;
	onStdoutFailure = (error) => {
		if (stdoutDead) return;
		stdoutDead = true;
		if (error.code !== "EPIPE") process.stderr.write(`clio-coder run: cannot write output: ${error.message}\n`);
		void shutdown(error.code === "EPIPE" ? 141 : 1);
	};
	process.stdout.on("error", onStdoutFailure);
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) return;
	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStdoutWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		return rawStderrWrite(String(chunk), cb);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = { rawStdoutWrite, originalStdoutWrite };
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) return;
	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function writeRawStdout(text: string): void {
	if (stdoutDead) return;
	if (stdoutTakeoverState) {
		stdoutTakeoverState.rawStdoutWrite(text);
		return;
	}
	process.stdout.write(text);
}

export async function flushRawStdout(): Promise<void> {
	if (stdoutDead) return;
	await new Promise<void>((resolve, reject) => {
		const write = stdoutTakeoverState?.rawStdoutWrite ?? process.stdout.write.bind(process.stdout);
		write("", (err) => {
			if (err && onStdoutFailure) {
				// Settle the failure before the caller's own exit code can reach shutdown first.
				onStdoutFailure(err);
				resolve();
			} else if (err) reject(err);
			else resolve();
		});
	});
}
