import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Ordinary lifecycle rows contain identities/counts only. Raw provider-boundary data is explicit opt-in. */
export function observationEvent(stateDir: string, event: string, facts: Record<string, unknown>): void {
	if (!existsSync(stateDir)) return;
	appendBounded(join(stateDir, "memory", "observation-events.jsonl"), { at: new Date().toISOString(), event, ...facts });
}

export function traceObservation(event: string, facts: Record<string, unknown>): void {
	const path = process.env.CLIO_CODER_OBSERVATION_TRACE?.trim();
	if (path) appendBounded(path, { at: new Date().toISOString(), event, ...facts });
}

function appendBounded(path: string, row: unknown): void {
	try {
		const text = `${JSON.stringify(row)}\n`;
		if (Buffer.byteLength(text) > 512 * 1024) return;
		// One previous generation is kept; a full log rolls over instead of going silent.
		if (existsSync(path) && statSync(path).size + Buffer.byteLength(text) > 8 * 1024 * 1024)
			renameSync(path, `${path}.1`);
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, text, { mode: 0o600 });
	} catch {
		/* Diagnostics cannot decide readiness or checkpoint success. */
	}
}
