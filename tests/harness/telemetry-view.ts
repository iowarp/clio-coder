import { readFileSync } from "node:fs";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { TelemetryView } from "../../src/domains/observability/contract.js";
import type { JournalSource } from "../../src/domains/observability/read-model.js";
import { telemetryView } from "../../src/domains/observability/telemetry-live.js";
import { isSessionEntry } from "../../src/domains/session/entries.js";
import { importLegacySession } from "../../src/domains/session/legacy-import.js";

/**
 * A `TelemetryView` built through the real read model, for surface fixtures (#434 §11.3). A surface test feeds it
 * the records its scenario needs and asserts what the surface renders, so no fixture restates a number the read
 * model would compute differently.
 */
export function telemetryViewOf(
	sessionId: string,
	records: readonly TelemetryRecord[],
	runs: ReadonlyMap<string, readonly TelemetryRecord[]> = new Map(),
): TelemetryView {
	const journal = (owned: readonly TelemetryRecord[]): JournalSource => ({
		present: owned.length > 0,
		records: owned,
		modes: ["standard"],
		skipped: 0,
		damaged: 0,
	});
	return telemetryView({
		sessionId,
		journal: journal(records),
		legacy: { records: [], aggregates: 0 },
		runs: new Map([...runs].map(([runId, owned]) => [runId, journal(owned)])),
		parent: null,
	});
}

/** The golden P0 ledger's calls, imported with stable ids: five calls, one never sent, one with unknown usage. */
export function goldenTelemetryRecords(sessionId = "golden-p0"): TelemetryRecord[] {
	const ledger = readFileSync(new URL("../fixtures/telemetry/golden/p0/current.jsonl", import.meta.url), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as unknown)
		.filter(isSessionEntry);
	return importLegacySession(sessionId, ledger, { ids: "derived" }).records;
}
