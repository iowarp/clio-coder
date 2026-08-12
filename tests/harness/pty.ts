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
	return stripAnsi(output)
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+$/, ""));
}

export const ptySupported = platform !== "win32";

export async function runInPty(
	command: string,
	args: ReadonlyArray<string>,
	options: PtyRunOptions,
): Promise<PtyRunResult> {
	const { spawn } = await import("node-pty");
	const child = spawn(command, [...args], {
		name: "xterm-256color",
		cols: options.cols,
		rows: options.rows,
		cwd: options.cwd,
		env: options.env,
	});
	return await new Promise<PtyRunResult>((resolve) => {
		let output = "";
		let settled = false;
		const inputTimers: NodeJS.Timeout[] = [];
		const finish = (exitCode: number, signal: number, timedOut: boolean, matched: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			for (const handle of inputTimers) clearTimeout(handle);
			resolve({ output, exitCode, signal, timedOut, matched });
		};
		const kill = (): void => {
			try {
				child.kill();
			} catch {
				// Already gone. The exit handler will not fire twice.
			}
		};
		const timer = setTimeout(() => {
			kill();
			finish(-1, 0, true, false);
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
		child.onData((chunk) => {
			output += chunk;
			const visible = stripAnsi(output);
			if (!inputScheduled && options.readyWhen?.test(visible)) {
				inputScheduled = true;
				scheduleInput();
			}
			if (options.until?.test(visible)) {
				kill();
				finish(0, 0, false, true);
			}
		});
		child.onExit(({ exitCode, signal }) => finish(exitCode, signal ?? 0, false, false));
	});
}
