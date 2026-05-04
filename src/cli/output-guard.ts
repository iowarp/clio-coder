interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

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

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	if (stdoutTakeoverState) {
		stdoutTakeoverState.rawStdoutWrite(text);
		return;
	}
	process.stdout.write(text);
}

export async function flushRawStdout(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const write = stdoutTakeoverState?.rawStdoutWrite ?? process.stdout.write.bind(process.stdout);
		write("", (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}
