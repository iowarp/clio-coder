import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";
import { redactUrlCredentials } from "../domains/safety/redaction.js";
import { writeFrame } from "./modes/jsonl.js";
import type { RunJsonRunEndFrame, RunJsonTerminalTurnEndFrame } from "./modes/run-json-schema.js";
import { flushRawStdout, isStdoutDead } from "./output-guard.js";

interface RunFailureState {
	pending: boolean;
	diagnostic?: string;
}

const runFailureState = new AsyncLocalStorage<RunFailureState>();

/** A full-mode `run --json` stream ends with exactly one `run_end` (S-51); the headless run notes the one it wrote. */
let runEndWritten = false;

export function noteRunEndWritten(): void {
	runEndWritten = true;
}

export function writeRunDiagnostic(text: string): void {
	// A diagnostic can quote a failure's message, and it reaches stderr and a turn_end frame's error alike (#446).
	const shown = redactUrlCredentials(text);
	const state = runFailureState.getStore();
	if (state?.pending) state.diagnostic = shown.trim();
	process.stderr.write(shown);
}

export function startRunOutput(): void {
	const state = runFailureState.getStore();
	if (state) state.pending = false;
}

export async function withRunFailureReporting(
	json: boolean,
	run: () => Promise<number>,
	fullMainStream = false,
): Promise<number> {
	if (!json) return run();
	const state: RunFailureState = { pending: true };
	const startedAt = new Date().toISOString();
	runEndWritten = false;
	const runEndFrame = (exitCode: number): RunJsonRunEndFrame => ({
		type: "run_end",
		startedAt,
		endedAt: new Date().toISOString(),
		exitCode,
		error: state.diagnostic || `clio-coder run failed (exit ${exitCode})`,
		outcome: exitCode === 124 ? "timed_out" : "failed",
	});
	const runEndOwed = (exitCode: number): boolean => {
		if (!fullMainStream || exitCode === 0 || isStdoutDead() || runEndWritten) return false;
		runEndWritten = true;
		return true;
	};
	const failureFrame = (exitCode: number): RunJsonTerminalTurnEndFrame => ({
		type: "turn_end",
		startedAt,
		endedAt: new Date().toISOString(),
		exitCode,
		text: "",
		error: state.diagnostic || `clio-coder run failed before output started (exit ${exitCode})`,
		outcome: exitCode === 124 ? "timed_out" : "failed",
	});
	// Audit finding 9: coordinated boot shutdown calls process.exit, which cannot await a stdout flush.
	const onExit = (exitCode: number): void => {
		if (exitCode === 0 || isStdoutDead()) return;
		if (state.pending) {
			state.pending = false;
			writeSync(1, `${JSON.stringify(failureFrame(exitCode))}\n`);
		}
		if (runEndOwed(exitCode)) writeSync(1, `${JSON.stringify(runEndFrame(exitCode))}\n`);
	};
	process.once("exit", onExit);
	return runFailureState.run(state, async () => {
		try {
			const code = await run();
			let wrote = false;
			if (state.pending && code !== 0) {
				state.pending = false;
				writeFrame(failureFrame(code));
				wrote = true;
			}
			if (runEndOwed(code)) {
				writeFrame(runEndFrame(code));
				wrote = true;
			}
			if (wrote) await flushRawStdout();
			return code;
		} catch (error) {
			const diagnostic = redactUrlCredentials(error instanceof Error ? error.message : String(error));
			if (state.pending) {
				state.pending = false;
				state.diagnostic = diagnostic;
				writeFrame(failureFrame(1));
			}
			if (runEndOwed(1)) writeFrame({ ...runEndFrame(1), error: state.diagnostic || diagnostic });
			if (!isStdoutDead()) await flushRawStdout();
			throw error;
		} finally {
			process.off("exit", onExit);
		}
	});
}
