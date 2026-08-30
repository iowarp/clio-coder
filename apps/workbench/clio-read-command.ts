/**
 * Process boundary shared by the GUI's public, read-only Clio adapters.
 *
 * Callers still own the command-specific projection. This runner only enforces
 * fixed argv execution, time and byte ceilings, process retirement, UTF-8, and
 * JSON framing. Raw stdout and stderr never leave the host through this API.
 */

export type ClioReadCommandFailure =
	| "spawn"
	| "timeout"
	| "byte-limit"
	| "read"
	| "status"
	| "exit"
	| "encoding"
	| "json"
	| "row-limit";

export class ClioReadCommandError extends Error {
	override readonly name = "ClioReadCommandError";

	constructor(
		readonly code: ClioReadCommandFailure,
		message: string,
		/** Host-only bounded diagnostic. Adapters must never copy it into a DTO. */
		readonly diagnostic = "",
		readonly exitCode: number | null = null,
	) {
		super(message);
	}
}

export interface ClioReadCommandRunnerOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs: number;
	readonly maximumStdoutBytes: number;
	readonly maximumStderrBytes: number;
}

class OutputLimitError extends Error {}

function positiveBound(value: number, label: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}.`);
	}
	return value;
}

function commandPart(value: string, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new TypeError(`${label} must be a non-empty command argument without NUL bytes.`);
	}
	return value;
}

async function readBounded(stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maximumBytes) throw new OutputLimitError();
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function decodeDiagnostic(value: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(value);
	} catch {
		return "";
	}
}

export class ClioReadCommandRunner {
	readonly #executable: string;
	readonly #prefixArgs: readonly string[];
	readonly #timeoutMs: number;
	readonly #maximumStdoutBytes: number;
	readonly #maximumStderrBytes: number;

	constructor(options: ClioReadCommandRunnerOptions) {
		this.#executable = commandPart(options.executable ?? "clio-coder", "executable");
		this.#prefixArgs = (options.prefixArgs ?? []).map((argument, index) =>
			commandPart(argument, `prefixArgs[${index}]`)
		);
		this.#timeoutMs = positiveBound(options.timeoutMs, "timeoutMs", 60_000);
		this.#maximumStdoutBytes = positiveBound(options.maximumStdoutBytes, "maximumStdoutBytes", 8 * 1024 * 1024);
		this.#maximumStderrBytes = positiveBound(options.maximumStderrBytes, "maximumStderrBytes", 256 * 1024);
	}

	async runJson(cwd: string, fixedArgs: readonly string[]): Promise<unknown> {
		const text = await this.#runText(cwd, fixedArgs);
		try {
			return JSON.parse(text);
		} catch {
			throw new ClioReadCommandError("json", "Clio returned invalid JSON for a read-only command.");
		}
	}

	async runJsonLines(cwd: string, fixedArgs: readonly string[], maximumRows: number): Promise<readonly unknown[]> {
		const rowLimit = positiveBound(maximumRows, "maximumRows", 10_000);
		const text = await this.#runText(cwd, fixedArgs);
		if (text.length === 0) return [];
		const lines = text.split(/\r?\n/u);
		if (lines.at(-1) === "") lines.pop();
		if (lines.length > rowLimit) {
			throw new ClioReadCommandError("row-limit", "The read-only Clio command exceeded the GUI's row bound.");
		}
		const rows: unknown[] = [];
		for (const line of lines) {
			if (line.trim().length === 0) {
				throw new ClioReadCommandError("json", "Clio returned a blank row in JSONL output.");
			}
			try {
				rows.push(JSON.parse(line));
			} catch {
				throw new ClioReadCommandError("json", "Clio returned invalid JSONL for a read-only command.");
			}
		}
		return rows;
	}

	async #runText(cwd: string, fixedArgs: readonly string[]): Promise<string> {
		const args = fixedArgs.map((argument, index) => commandPart(argument, `fixedArgs[${index}]`));
		if (args.length === 0) throw new TypeError("fixedArgs must contain at least one command argument.");

		let child: Deno.ChildProcess;
		try {
			child = new Deno.Command(this.#executable, {
				args: [...this.#prefixArgs, ...args],
				cwd,
				stdin: "null",
				stdout: "piped",
				stderr: "piped",
			}).spawn();
		} catch {
			throw new ClioReadCommandError("spawn", "The GUI could not start the read-only Clio command.");
		}

		let timedOut = false;
		let stopping = false;
		let hardStop: ReturnType<typeof setTimeout> | null = null;
		const stop = () => {
			if (stopping) return;
			stopping = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// The command may already have exited.
			}
			hardStop = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// The command may already have exited.
				}
			}, 300);
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			stop();
		}, this.#timeoutMs);
		const stdout = readBounded(child.stdout, this.#maximumStdoutBytes).catch((error) => {
			stop();
			throw error;
		});
		const stderr = readBounded(child.stderr, this.#maximumStderrBytes).catch((error) => {
			stop();
			throw error;
		});
		const [statusResult, stdoutResult, stderrResult] = await Promise.allSettled([child.status, stdout, stderr]);
		clearTimeout(timeout);
		if (hardStop !== null) clearTimeout(hardStop);

		if (timedOut) {
			throw new ClioReadCommandError("timeout", "The read-only Clio command did not finish in time.");
		}
		if (stdoutResult.status === "rejected" || stderrResult.status === "rejected") {
			const exceeded = (stdoutResult.status === "rejected" && stdoutResult.reason instanceof OutputLimitError) ||
				(stderrResult.status === "rejected" && stderrResult.reason instanceof OutputLimitError);
			throw new ClioReadCommandError(
				exceeded ? "byte-limit" : "read",
				exceeded
					? "The read-only Clio command exceeded the GUI's byte bound."
					: "The GUI could not read the read-only Clio command.",
			);
		}
		if (statusResult.status === "rejected") {
			throw new ClioReadCommandError("status", "The GUI could not observe the read-only Clio command.");
		}
		const diagnostic = decodeDiagnostic(stderrResult.value);
		if (!statusResult.value.success) {
			throw new ClioReadCommandError(
				"exit",
				"The read-only Clio command did not complete successfully.",
				diagnostic,
				statusResult.value.code,
			);
		}

		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(stdoutResult.value);
		} catch {
			throw new ClioReadCommandError("encoding", "Clio returned non-text output for a read-only command.");
		}
		return text;
	}
}
