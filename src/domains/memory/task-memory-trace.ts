import { appendFileSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskMemoryEnvelope } from "./task-memory-policy.js";

/**
 * Opt-in raw-envelope trace for the LLM memory tier. Off unless
 * CLIO_CODER_MEMORY_TRACE names a file.
 *
 * The telemetry row is deliberately content-free: it carries counts and
 * outcomes so it can be shipped and read without exposing the bank, the task,
 * or the trajectory. That discipline is right for a log that always runs, and
 * it is exactly why a tier that writes nothing cannot be debugged from it. The
 * row now names a reason, which says which of the six silences happened, but a
 * reason of `unparseable` still does not show what the model actually wrote.
 *
 * This trace does, and it is content-bearing by construction: the prompt
 * carries the task text and bank render, the response carries whatever the
 * model said. It is therefore never on by default and never written anywhere
 * the operator did not name.
 */
export interface TaskMemoryTraceRow {
	at: string;
	decision: TaskMemoryEnvelope["decision"];
	reason: TaskMemoryEnvelope["reason"];
	bankOperations: number;
	droppedOperations: number;
	reminder: string | null;
	error: string | null;
	/** Raw completion text, truncated only if it would dwarf the file. */
	response: string;
	responseChars: number;
	userPrompt: string;
	userPromptChars: number;
	/** Constant across a run, so it is recorded once in the header rather than per row. */
	systemPromptChars: number;
}

export interface TaskMemoryTrace {
	record(envelope: TaskMemoryEnvelope): void;
}

/**
 * A local model that loops can emit tens of thousands of characters for one
 * step. The first two thousand always contain the envelope or prove its
 * absence, and the tail is what makes a trace unreadable.
 */
const TRACE_TEXT_MAX_CHARS = 8_000;

export function taskMemoryTracePath(env: NodeJS.ProcessEnv = process.env): string | null {
	const raw = env.CLIO_CODER_MEMORY_TRACE?.trim();
	return raw !== undefined && raw.length > 0 ? raw : null;
}

export function createTaskMemoryTrace(path: string, now: () => Date = () => new Date()): TaskMemoryTrace {
	let opened = false;
	return {
		record(envelope) {
			try {
				if (!opened) {
					mkdirSync(dirname(path), { recursive: true });
					// Truncate on open so a trace describes one session, not an append of several.
					writeSync(openSync(path, "w"), "");
					opened = true;
				}
				const row: TaskMemoryTraceRow = {
					at: now().toISOString(),
					decision: envelope.decision,
					reason: envelope.reason,
					bankOperations: envelope.bankOperations,
					droppedOperations: envelope.droppedOperations,
					reminder: envelope.reminder,
					error: envelope.error,
					response: truncate(envelope.response),
					responseChars: envelope.response.length,
					userPrompt: truncate(envelope.userPrompt),
					userPromptChars: envelope.userPrompt.length,
					systemPromptChars: envelope.systemPrompt.length,
				};
				appendFileSync(path, `${JSON.stringify(row)}\n`);
			} catch {
				// A diagnostic that fails must not take the memory step with it.
			}
		},
	};
}

function truncate(value: string): string {
	return value.length <= TRACE_TEXT_MAX_CHARS ? value : `${value.slice(0, TRACE_TEXT_MAX_CHARS)}…[truncated]`;
}
