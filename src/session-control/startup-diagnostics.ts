import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { clioStateDir } from "../core/xdg.js";

/** Diagnostics survive an empty session and never write into the terminal. */
export function recordStartupDiagnostic(event: Record<string, unknown>): void {
	const at = new Date().toISOString();
	const directory = join(clioStateDir(), "startup");
	void mkdir(directory, { recursive: true, mode: 0o700 })
		.then(() =>
			appendFile(join(directory, `${at.slice(0, 10)}.jsonl`), `${JSON.stringify({ ...event, at, pid: process.pid })}\n`, {
				mode: 0o600,
			}),
		)
		.catch(() => {});
}
