import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";
import { redactUrlCredentials } from "../domains/safety/redaction.js";
import { writeFrame } from "./modes/jsonl.js";
import type { RunJsonTerminalTurnEndFrame } from "./modes/run-json-schema.js";
import { flushRawStdout, isStdoutDead } from "./output-guard.js";

interface RunFailureState {
	pending: boolean;
	diagnostic?: string;
}

const runFailureState = new AsyncLocalStorage<RunFailureState>();

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

export async function withRunFailureReporting(json: boolean, run: () => Promise<number>): Promise<number> {
	if (!json) return run();
	const state: RunFailureState = { pending: true };
	const startedAt = new Date().toISOString();
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
		if (!state.pending || exitCode === 0 || isStdoutDead()) return;
		state.pending = false;
		writeSync(1, `${JSON.stringify(failureFrame(exitCode))}\n`);
	};
	process.once("exit", onExit);
	return runFailureState.run(state, async () => {
		try {
			const code = await run();
			if (state.pending && code !== 0) {
				state.pending = false;
				writeFrame(failureFrame(code));
				await flushRawStdout();
			}
			return code;
		} catch (error) {
			if (state.pending) {
				state.pending = false;
				state.diagnostic = redactUrlCredentials(error instanceof Error ? error.message : String(error));
				writeFrame(failureFrame(1));
				await flushRawStdout();
			}
			throw error;
		} finally {
			process.off("exit", onExit);
		}
	});
}
