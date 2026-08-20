/**
 * A real pseudo-terminal for the surfaces that only behave differently when
 * one is attached.
 *
 * Piping stdout reports no width, so every width-sensitive path collapses to
 * the 80-column fallback and the interesting sizes are never exercised. The
 * TUI additionally refuses to start without a TTY, and raw mode, the alternate
 * screen, and SIGINT have no meaning off one. `node-pty` is a devDependency,
 * so this stays a test-only tool and never reaches the package.
 */
import { platform } from "node:process";

export interface PtyInputStep {
	/** Milliseconds after the input schedule starts to type this. */
	afterMs: number;
	data: string;
}

export interface PtyRunOptions {
	cols: number;
	rows: number;
	cwd: string;
	env: Record<string, string>;
	input?: ReadonlyArray<PtyInputStep>;
	/**
	 * Hold the input schedule until the output first matches, then measure
	 * `afterMs` from that moment. A fixed sleep long enough for the slowest
	 * machine is the alternative, and it costs that sleep on every machine.
	 */
	readyWhen?: RegExp;
	/** Give up and kill the child after this long. Default 20s. */
	timeoutMs?: number;
	/** Kill the child once the accumulated visible output matches. */
	until?: RegExp;
}

export interface PtyRunResult {
	output: string;
	exitCode: number;
	signal: number;
	/** True when the child had to be killed rather than exiting on its own. */
	timedOut: boolean;
	/** True when `until` matched and the child was stopped deliberately. */
	matched: boolean;
}

export interface PtySessionOptions {
	cols: number;
	rows: number;
	cwd: string;
	env: Record<string, string>;
}

export interface PtyExitResult {
	exitCode: number;
	signal: number;
}

export type PtyOutputMatcher = string | RegExp | ((output: string) => boolean);

/**
 * A controllable real PTY. Every wait is bounded, and cleanup resolves only
 * after node-pty reports that the child has exited.
 */
export interface PtySession {
	readonly pid: number;
	readonly output: string;
	readonly exited: boolean;
	write(data: string | Buffer): void;
	resize(cols: number, rows: number): void;
	pauseOutput(): void;
	resumeOutput(): void;
	waitForOutput(matcher: PtyOutputMatcher, timeoutMs?: number): Promise<string>;
	waitForExit(timeoutMs?: number): Promise<PtyExitResult>;
	killAndWaitForExit(timeoutMs?: number): Promise<PtyExitResult>;
}

const ANSI_PATTERN = new RegExp(
	[
		// CSI. The parameter-byte class is 0x30-0x3F, which includes `<=>` and not
		// just digits: the kitty keyboard protocol push and pop are `\e[>7u` and
		// `\e[<u`, and a digits-only class leaves four visible characters behind
		// on the first and last line of every capture.
		"\\u001B\\[[0-9:;<=>?]*[ -/]*[@-~]",
		"\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)", // OSC
		"\\u001B[()][A-Za-z0-9]", // charset designation
		"\\u001B[=>NOc78MD]", // single-byte escapes the TUI emits
	].join("|"),
	"g",
);

/** Strip ANSI so assertions read the text a user would see. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

/**
 * SGR parameters that set a foreground or background color, as opposed to the
 * bold/dim/italic/underline attributes `NO_COLOR` leaves alone. Assembled from
 * parts because an escape byte written into a regex literal is a control
 * character in source.
 */
const COLOR_SEQUENCE = new RegExp(
	["\\u001B\\[", "(?:[0-9;]*;)?", "(?:3[0-79]|4[0-79]|9[0-7]|10[0-7]|38|48)", "[;m]"].join(""),
	"g",
);

/** Every foreground/background sequence in the capture, for a `NO_COLOR` assertion. */
export function colorSequences(output: string): string[] {
	return output.match(COLOR_SEQUENCE) ?? [];
}

/** Visible lines with trailing whitespace dropped, which is what width assertions want. */
export function visibleLines(output: string): string[] {
	// Split on a bare carriage return as well as a newline. The TUI uses `\r`
	// to return to column 0 without advancing, so two lines that each fit the
	// terminal read as one line twice as wide unless it counts as a break.
	return stripAnsi(output)
		.split(/\r\n|\n|\r/)
		.map((line) => line.replace(/\s+$/, ""));
}

export const ptySupported = platform !== "win32";

function outputMatches(output: string, matcher: PtyOutputMatcher): boolean {
	if (typeof matcher === "string") return output.includes(matcher);
	if (matcher instanceof RegExp) {
		matcher.lastIndex = 0;
		return matcher.test(output);
	}
	return matcher(output);
}

/** Open a PTY whose input, dimensions, output flow, and lifetime the test controls. */
export async function openPty(
	command: string,
	args: ReadonlyArray<string>,
	options: PtySessionOptions,
): Promise<PtySession> {
	const { spawn } = await import("node-pty");
	const child = spawn(command, [...args], {
		name: "xterm-256color",
		cols: options.cols,
		rows: options.rows,
		cwd: options.cwd,
		env: options.env,
	});
	let output = "";
	let exitResult: PtyExitResult | null = null;
	let killStarted = false;
	let resolveExit: ((result: PtyExitResult) => void) | null = null;
	const exit = new Promise<PtyExitResult>((resolve) => {
		resolveExit = resolve;
	});
	const outputListeners = new Set<() => void>();

	const dataDisposable = child.onData((chunk) => {
		output += chunk;
		for (const listener of [...outputListeners]) listener();
	});
	const exitDisposable = child.onExit(({ exitCode, signal }) => {
		if (exitResult) return;
		exitResult = { exitCode, signal: signal ?? 0 };
		resolveExit?.(exitResult);
		for (const listener of [...outputListeners]) listener();
		outputListeners.clear();
		dataDisposable.dispose();
		exitDisposable.dispose();
	});

	const bounded = async <T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> => {
		let timeout: NodeJS.Timeout | null = null;
		try {
			return await Promise.race([
				promise,
				new Promise<T>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	};

	return {
		pid: child.pid,
		get output(): string {
			return output;
		},
		get exited(): boolean {
			return exitResult !== null;
		},
		write(data): void {
			if (exitResult) throw new Error(`PTY ${child.pid} has already exited`);
			child.write(data);
		},
		resize(cols, rows): void {
			if (exitResult) throw new Error(`PTY ${child.pid} has already exited`);
			child.resize(cols, rows);
		},
		pauseOutput(): void {
			if (!exitResult) child.pause();
		},
		resumeOutput(): void {
			if (!exitResult) child.resume();
		},
		async waitForOutput(matcher, timeoutMs = 10_000): Promise<string> {
			if (outputMatches(output, matcher)) return output;
			if (exitResult) throw new Error(`PTY ${child.pid} exited before the expected output appeared`);
			let listener: (() => void) | null = null;
			const matched = new Promise<string>((resolve, reject) => {
				listener = (): void => {
					if (outputMatches(output, matcher)) {
						if (listener) outputListeners.delete(listener);
						resolve(output);
					} else if (exitResult) {
						if (listener) outputListeners.delete(listener);
						reject(new Error(`PTY ${child.pid} exited before the expected output appeared`));
					}
				};
				outputListeners.add(listener);
			});
			try {
				return await bounded(matched, timeoutMs, "PTY output wait");
			} finally {
				if (listener) outputListeners.delete(listener);
			}
		},
		waitForExit(timeoutMs = 10_000): Promise<PtyExitResult> {
			return bounded(exit, timeoutMs, "PTY exit wait");
		},
		async killAndWaitForExit(timeoutMs = 10_000): Promise<PtyExitResult> {
			if (!exitResult && !killStarted) {
				killStarted = true;
				try {
					child.kill();
				} catch {
					// The exit event may be crossing this call; settlement below is canonical.
				}
			}
			return await bounded(exit, timeoutMs, "PTY cleanup");
		},
	};
}

export async function runInPty(
	command: string,
	args: ReadonlyArray<string>,
	options: PtyRunOptions,
): Promise<PtyRunResult> {
	const child = await openPty(command, args, options);
	return await new Promise<PtyRunResult>((resolve) => {
		let settled = false;
		let matched = false;
		const inputTimers: NodeJS.Timeout[] = [];
		const finish = (exitCode: number, signal: number, timedOut: boolean, matched: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			for (const handle of inputTimers) clearTimeout(handle);
			resolve({ output: child.output, exitCode, signal, timedOut, matched });
		};
		const timer = setTimeout(async () => {
			try {
				const result = await child.killAndWaitForExit();
				finish(result.exitCode, result.signal, true, false);
			} catch {
				finish(-1, 0, true, false);
			}
		}, options.timeoutMs ?? 20_000);
		const scheduleInput = (): void => {
			for (const step of options.input ?? []) {
				inputTimers.push(
					setTimeout(() => {
						try {
							child.write(step.data);
						} catch {
							// The child exited before this keystroke. Nothing to type into.
						}
					}, step.afterMs),
				);
			}
		};
		let inputScheduled = options.readyWhen === undefined;
		if (inputScheduled) scheduleInput();
		const observeOutput = async (): Promise<void> => {
			const visible = stripAnsi(child.output);
			if (!inputScheduled && options.readyWhen && outputMatches(visible, options.readyWhen)) {
				inputScheduled = true;
				scheduleInput();
			}
			if (!matched && options.until && outputMatches(visible, options.until)) {
				matched = true;
				const result = await child.killAndWaitForExit();
				finish(result.exitCode, result.signal, false, true);
			}
		};
		void child
			.waitForExit(options.timeoutMs ?? 20_000)
			.then(({ exitCode, signal }) => finish(exitCode, signal, false, matched))
			.catch(() => {});
		const poll = (): void => {
			if (settled) return;
			void observeOutput()
				.catch(() => {})
				.finally(() => {
					if (!settled) setTimeout(poll, 10);
				});
		};
		poll();
	});
}
