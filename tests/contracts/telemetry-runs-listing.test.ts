/**
 * The run listing step of the telemetry loader (#434 §11.3): both runners page the same journals in the same
 * order, newest write first, a run directory without a journal lists last as unknown coverage, and each row the
 * read model builds from a page matches the published RunRowV1 schema.
 */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { RunRowSchema } from "../../src/core/telemetry/dto.js";
import { openCallJournal } from "../../src/domains/observability/call-journal.js";
import { runRowTelemetry } from "../../src/domains/observability/read-model.js";
import { listRunTelemetrySources, listRunTelemetrySourcesAsync } from "../../src/domains/session/telemetry-source.js";

async function writeRunJournal(stateDir: string, runId: string, writtenAt: Date) {
	const directory = join(stateDir, "runs", runId);
	const journal = await openCallJournal({
		sessionDirectory: directory,
		fileName: "events.ndjson",
		context: { sessionId: null, runId, label: "worker" },
		writer: { clioCoderVersion: "test", piVersion: "test" },
	});
	await journal.close();
	utimesSync(join(directory, "events.ndjson"), writtenAt, writtenAt);
}

test("run journals list newest write first, page by keyset, and a journal-less run lists last as unknown", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-telemetry-runs-"));
	await writeRunJournal(stateDir, "run-older", new Date("2026-10-20T10:00:00.000Z"));
	await writeRunJournal(stateDir, "run-newest", new Date("2026-10-22T10:00:00.000Z"));
	await writeRunJournal(stateDir, "run-middle", new Date("2026-10-21T10:00:00.000Z"));
	mkdirSync(join(stateDir, "runs", "run-legacy"), { recursive: true });

	const first = listRunTelemetrySources(stateDir, { limit: 2 });
	deepStrictEqual(
		first.runs.map((run) => run.runId),
		["run-newest", "run-middle"],
	);
	strictEqual(first.runs[0]?.writtenAt, "2026-10-22T10:00:00.000Z");
	ok(first.nextBefore);
	const second = listRunTelemetrySources(stateDir, { limit: 2, before: first.nextBefore });
	deepStrictEqual(
		second.runs.map((run) => run.runId),
		["run-older", "run-legacy"],
	);
	strictEqual(second.nextBefore, null);
	const legacy = second.runs[1];
	ok(legacy);
	strictEqual(legacy.writtenAt, null);
	strictEqual(legacy.source.present, false);

	// The async runner performs the same reads and lands on the same pages.
	deepStrictEqual(await listRunTelemetrySourcesAsync(stateDir, { limit: 2 }), first);
	deepStrictEqual(await listRunTelemetrySourcesAsync(stateDir, { limit: 2, before: first.nextBefore }), second);

	for (const { runId, source } of [...first.runs, ...second.runs]) {
		const row = runRowTelemetry(runId, source);
		ok(Value.Check(RunRowSchema, row), `${runId}: ${[...Value.Errors(RunRowSchema, row)][0]?.message}`);
		strictEqual(row.runId, runId);
	}
	const unknown = runRowTelemetry(legacy.runId, legacy.source);
	strictEqual(unknown.source, "unavailable");
	match(unknown.tokens.display, /unknown/);
	match(unknown.usd.display, /unknown|not measured/);
	deepStrictEqual(listRunTelemetrySources(join(stateDir, "nowhere"), { limit: 5 }), { runs: [], nextBefore: null });
});
