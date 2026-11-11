import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TelemetryContext } from "../../src/core/telemetry/context.js";
import { openCallJournal, readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { storeTelemetryObject } from "../../src/domains/telemetry/objects.js";
import {
	telemetryObjectsDirectory,
	telemetryRunDirectory,
	telemetrySessionDirectory,
} from "../../src/domains/telemetry/paths.js";
import { journalSourceFromRead, seal } from "../../src/domains/telemetry/read-model.js";
import { readTelemetryScopeFiles } from "../../src/domains/telemetry/seal.js";
import { telemetryView } from "../../src/domains/telemetry/telemetry-live.js";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

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
	const context: TelemetryContext = { sessionId: "ses_seal", agent: { role: "main", id: "ses_seal" } };
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

	const segments = (await readdir(directory)).filter((name) => /^journal\.[0-9]{10}\.jsonl$/.test(name)).sort();
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

test("a run's verified seal is walked once, however many frames ask for it", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "telemetry-seal-frames-"));
	const directory = telemetrySessionDirectory(stateDir, "ses_frames");
	const context: TelemetryContext = { sessionId: "ses_frames", agent: { role: "main", id: "ses_frames" } };
	const journal = await openCallJournal({
		directory,
		context,
		writer: { clioCoderVersion: "0.0.0-test", piVersion: "test" },
	});
	journal.enqueue({
		kind: "session.opened",
		data: {},
		ctx: context,
		wallMs: Date.now(),
		mono: performance.now(),
	} as Parameters<typeof journal.enqueue>[0]);
	await journal.flush();
	const unsealed = await readTelemetryScopeFiles(directory);
	ok(await journal.seal());
	await journal.close();
	const sealed = await readTelemetryScopeFiles(directory);
	const present = { present: true, records: [], modes: ["standard"], skipped: 0, damaged: 0 };
	const source = {
		sessionId: "ses_frames",
		journal: present,
		runs: new Map([
			["sealed", present],
			["running", present],
		]),
		parent: null,
	} as never;
	const reads = { sealed: 0, running: 0 };
	const view = telemetryView(
		source,
		(runId) => {
			reads[runId as keyof typeof reads] += 1;
			return runId === "sealed" ? sealed : unsealed;
		},
		new Map(),
	);
	for (let frame = 0; frame < 3; frame += 1) {
		strictEqual(view.run("sealed")?.seal?.status, "verified");
		strictEqual(view.run("running")?.seal?.status, "unsealed");
	}
	deepStrictEqual(reads, { sealed: 1, running: 3 });
	strictEqual(view.run("absent"), null);
});

test("a verified run cache follows a reopened and resealed journal", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "telemetry-seal-reopen-"));
	const runId = "run_reseal";
	const directory = telemetryRunDirectory(stateDir, runId);
	const context: TelemetryContext = { sessionId: "ses_reseal", runId, agent: { role: "worker", id: runId } };
	const options = { directory, context, writer: { clioCoderVersion: "test", piVersion: "test" } };
	const first = await openCallJournal(options);
	ok(await first.sealAndClose());
	const cache = new Map();
	const view = async () => {
		const run = journalSourceFromRead(await readCallJournal(directory), true, runId);
		const scope = await readTelemetryScopeFiles(directory);
		return telemetryView(
			{
				sessionId: context.sessionId as string,
				journal: { present: false, records: [], modes: [], skipped: 0, damaged: 0 },
				runs: new Map([[runId, run]]),
				parent: null,
			},
			() => scope,
			cache,
		);
	};
	const before = (await view()).run(runId);
	strictEqual(before?.seal?.status, "verified");
	const reopened = await openCallJournal(options);
	try {
		strictEqual((await view()).run(runId)?.seal?.status, "unsealed", "opening withdrew the old bundle");
		ok(
			reopened.enqueue({
				kind: "gate.decided",
				data: {
					decisionId: "decision",
					group: "group",
					topology: "review",
					cycle: 0,
					outcome: "pass",
					subjects: [],
					digest: "a".repeat(64),
				},
				ctx: context,
				wallMs: Date.now(),
				mono: performance.now(),
			}),
		);
		ok(await reopened.sealAndClose());
		const after = (await view()).run(runId);
		strictEqual(after?.seal?.status, "verified");
		ok(after && before);
		strictEqual(after.journal.records, before.journal.records + 2);
		ok(after.seal?.status === "verified" && before.seal?.status === "verified");
		ok(after.seal.seal.head !== before.seal.seal.head);
	} finally {
		await reopened.close();
	}
});

test("telemetry inspect shows a session seal that fails verification as failed", async () => {
	const home = await mkdtemp(join(tmpdir(), "telemetry-seal-inspect-"));
	const directory = telemetrySessionDirectory(join(home, "state"), "ses_inspect");
	const context: TelemetryContext = { sessionId: "ses_inspect", agent: { role: "main", id: "ses_inspect" } };
	const journal = await openCallJournal({
		directory,
		context,
		writer: { clioCoderVersion: "0.0.0-test", piVersion: "test" },
	});
	journal.enqueue({
		kind: "session.opened",
		data: {},
		ctx: context,
		wallMs: Date.now(),
		mono: performance.now(),
	} as Parameters<typeof journal.enqueue>[0]);
	ok(await journal.sealAndClose());
	await flipByte(join(directory, "journal.jsonl"), 20);
	const script = `const { runTelemetryReadCommand } = await import(${JSON.stringify(new URL("../../src/cli/telemetry-read.ts", import.meta.url).href)}); process.exitCode = await runTelemetryReadCommand(["inspect", ${JSON.stringify(directory)}]);`;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
		encoding: "utf8",
		env: { ...process.env, ...scratchClioEnvVars(home) },
	});
	ok(/^seal {6}failed: /m.test(result.stdout), `${result.stdout}\n${result.stderr}`);
});
