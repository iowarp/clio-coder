/**
 * Multiple installs (#434 §13.2, R12): two Clio Coder versions share one state dir. This build settles calls in a
 * session's journal before and after a newer install appends a segment of its own, holding a call this build folds,
 * a record kind it does not know and a newer version of a kind it does, and keeps a store of its own beside the
 * journal. This build skips and counts what it cannot read, folds what it can, and never renames, rewrites or deletes
 * what the other install wrote, whether it is writing, reading or rebuilding.
 */
import { ok, strictEqual } from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { FactSum } from "../../src/core/telemetry/fact.js";
import { newRecordId } from "../../src/core/telemetry/ids.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import { encodeTelemetryLine } from "../../src/core/telemetry/segment.js";
import { loadSessionTelemetrySource } from "../../src/domains/session/telemetry-source.js";
import { callJournalHeader, openCallJournal, readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import {
	telemetryJournalFiles,
	telemetryJournalPath,
	telemetrySessionDirectory,
} from "../../src/domains/telemetry/paths.js";
import { callsReport, sessionTelemetry } from "../../src/domains/telemetry/read-model.js";
import { telemetryCall } from "../harness/telemetry-view.js";

const SESSION = "shared-session";
const ctx = { sessionId: SESSION, agent: { role: "main" as const, id: SESSION } };

/** This build's writer: open the session's journal, settle `records`, close it. */
async function settle(directory: string, records: readonly TelemetryRecord[]): Promise<void> {
	const journal = await openCallJournal({
		directory,
		context: ctx,
		writer: { clioCoderVersion: "0.6.6", piVersion: "test" },
	});
	for (const record of records)
		journal.enqueue({
			kind: record.k,
			data: record.data,
			ctx: record.ctx,
			wallMs: Date.parse(record.t),
			mono: record.mono,
			recordId: record.id,
		} as PendingTelemetry);
	await journal.close();
}

/** Every journal segment's bytes, oldest first, wherever a writer rotated them. */
async function journalBytes(directory: string): Promise<Buffer> {
	const names = telemetryJournalFiles(await readdir(directory));
	return Buffer.concat(await Promise.all(names.map((name) => readFile(join(directory, name)))));
}

test("two installs append to and read one state dir; neither retires the other's stores, and what one cannot read is skipped and counted", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "telemetry-multi-install-"));
	const directory = telemetrySessionDirectory(stateDir, SESSION);
	const store = join(stateDir, "sessions", "shared-workspace", SESSION);
	try {
		await settle(directory, telemetryCall(SESSION, { usd: 0.5, at: "2026-10-30T10:00:00.000Z" }));

		const at = { t: "2026-10-30T10:05:00.000Z", mono: 1 };
		const unknownKind = {
			...makeTelemetryRecord("session.resumed", { via: "resume" }, ctx, at),
			id: newRecordId(),
			k: "vnext.signal",
		};
		const newerVersion = {
			...makeTelemetryRecord("session.resumed", { via: "resume" }, ctx, at),
			id: newRecordId(),
			kv: 99,
		};
		const newer = Buffer.concat([
			encodeTelemetryLine(callJournalHeader({ clioCoderVersion: "0.7.0", piVersion: "test" })),
			...telemetryCall(SESSION, { usd: 0.25, at: "2026-10-30T10:04:00.000Z" }).map(encodeTelemetryLine),
			encodeTelemetryLine(unknownKind as unknown as TelemetryRecord),
			encodeTelemetryLine(newerVersion as TelemetryRecord),
		]);
		await appendFile(telemetryJournalPath(directory), newer);
		const theirStores = [join(directory, "journal.vnext-index"), join(stateDir, "telemetry", "vnext", "state.json")];
		await mkdir(join(stateDir, "telemetry", "vnext"), { recursive: true });
		for (const store of theirStores) await writeFile(store, `kept by 0.7.0 at ${store}`);

		await settle(directory, telemetryCall(SESSION, { usd: 0.125, at: "2026-10-30T10:10:00.000Z" }));
		await mkdir(store, { recursive: true });
		await writeFile(
			join(store, "meta.json"),
			JSON.stringify({ id: SESSION, endedAt: "2026-10-30T10:11:00.000Z", owner: null }),
		);

		const holdsTheirs = async (when: string) => {
			ok((await journalBytes(directory)).includes(newer), `${when}: the newer install's segment is where it left it`);
			for (const store of theirStores)
				strictEqual(await readFile(store, "utf8"), `kept by 0.7.0 at ${store}`, `${when}: ${store}`);
		};
		await holdsTheirs("after this build wrote around it");

		const read = await readCallJournal(directory);
		strictEqual(read.skipped, 2, "an unknown kind and a newer version of a known one");
		strictEqual(read.damaged, 0);
		const source = loadSessionTelemetrySource(stateDir, SESSION);
		ok(source);
		const session = sessionTelemetry(source);
		strictEqual(session.journal.skipped, 2, "the session DTO counts what this build could not read");
		strictEqual(callsReport(source).calls.length, 3, "both installs' calls fold");
		const usd = session.totals.usd.fact as FactSum;
		ok(Math.abs(usd.measured - 0.875) < 1e-9, "both installs' spend folds");
		await holdsTheirs("after reading");
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
});
