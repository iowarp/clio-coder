import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { telemetryResearchDirectory } from "./paths.js";

/**
 * The process-wide research traces: JSON lines under `<stateDir>/telemetry/research/`, each capped at its byte limit
 * with one previous generation kept, and pruned by research retention. Session-scoped traces journal instead (#434 §9).
 */
export const RESEARCH_TRACE_FILES = {
	"bus-trace": 8 * 1024 * 1024,
	"route-observations": 1024 * 1024,
} as const;

export type ResearchTraceFile = keyof typeof RESEARCH_TRACE_FILES;

export function researchTracePath(stateDir: string, file: ResearchTraceFile): string {
	return join(telemetryResearchDirectory(stateDir), `${file}.jsonl`);
}

/**
 * Append one record as a JSON line, synchronously, so lines keep the order their events had. Past `maxBytes` the
 * file becomes its `.1` generation first. Throws when the write fails; whether that matters is the caller's call.
 */
export function appendResearchTraceLine(path: string, record: Record<string, unknown>, maxBytes: number): void {
	const line = `${JSON.stringify(record)}\n`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try {
		if (statSync(path).size + Buffer.byteLength(line) > maxBytes) renameSync(path, `${path}.1`);
	} catch {
		// Missing file: the append below creates it.
	}
	appendFileSync(path, line, { mode: 0o600 });
}
