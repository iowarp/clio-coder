import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TelemetryContext } from "../../src/core/telemetry/context.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { storeTelemetryObject } from "../../src/domains/telemetry/objects.js";
import { telemetryObjectsDirectory, telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { seal } from "../../src/domains/telemetry/read-model.js";
import { readTelemetryScopeFiles } from "../../src/domains/telemetry/seal.js";

async function flipByte(path: string, offset: number): Promise<Buffer> {
	const original = await readFile(path);
	const changed = Buffer.from(original);
	changed[offset] = (changed[offset] as number) ^ 0x01;
	await writeFile(path, changed);
	return original;
}

test("a sealed session scope verifies from its own files and fails on one flipped byte (#434)", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "telemetry-seal-"));
	const directory = telemetrySessionDirectory(stateDir, "ses_seal");
	const context: TelemetryContext = { sessionId: "ses_seal", label: "main" };
	// A one-byte segment cap rotates on every batch, so the sealed chain crosses rotated segments.
	const journal = await openCallJournal({
		directory,
		context,
		writer: { clioCoderVersion: "0.0.0-test", piVersion: "test" },
		segmentBytes: 1,
	});
	const object = await storeTelemetryObject(directory, "config", { telemetry: { mode: "standard" } });
	for (const kind of ["session.opened", "session.closed"] as const) {
		journal.enqueue({
			kind,
			data: kind === "session.opened" ? {} : { reason: "shutdown" },
			ctx: context,
			wallMs: Date.now(),
			mono: performance.now(),
		} as Parameters<typeof journal.enqueue>[0]);
		await journal.flush();
	}
	strictEqual(seal(await readTelemetryScopeFiles(directory)).status, "unsealed");
	ok(await journal.seal());
	await journal.close();

	const verdict = seal(await readTelemetryScopeFiles(directory));
	strictEqual(verdict.status, "verified");
	if (verdict.status !== "verified") return;
	deepStrictEqual(verdict.scope, { kind: "session", id: "ses_seal" });
	ok(verdict.segments > 1);
	strictEqual(verdict.objects, 1);

	const segments = (await readdir(directory)).filter((name) => name.startsWith("journal.rec_")).sort();
	const rotated = join(directory, segments[0] as string);
	const segmentBytes = await flipByte(rotated, 20);
	deepStrictEqual(seal(await readTelemetryScopeFiles(directory)), {
		status: "failed",
		mismatch: { kind: "segment", name: segments[0], detail: "sha256 differs from the seal" },
	});
	await writeFile(rotated, segmentBytes);
	strictEqual(seal(await readTelemetryScopeFiles(directory)).status, "verified");

	const objectName = `${object.id}.json`;
	await flipByte(join(telemetryObjectsDirectory(directory), objectName), 2);
	deepStrictEqual(seal(await readTelemetryScopeFiles(directory)), {
		status: "failed",
		mismatch: { kind: "object", name: objectName, detail: "sha256 differs from the seal" },
	});
});
