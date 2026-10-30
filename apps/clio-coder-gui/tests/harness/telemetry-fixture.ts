import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export { quantitiesOf, telemetryLies } from "../../../../tests/harness/telemetry-lies.js";

/**
 * The golden P0 ledger as a session on disk, where the read model's cold loader finds it: a ledger written before
 * the call journal, which the loader imports with derived ids. Returns the session id the routes take.
 */
export function seedGoldenSession(state: string, sessionId = "golden-p0"): string {
	const ledger = readFileSync(
		fileURLToPath(new URL("../../../../tests/fixtures/telemetry/golden/p0/current.jsonl", import.meta.url)),
	);
	const directory = join(state, "sessions", "golden-workspace", sessionId);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "current.jsonl"), ledger);
	return sessionId;
}
