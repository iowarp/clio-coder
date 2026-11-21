import { deepStrictEqual, notStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TelemetryContext } from "../../src/core/telemetry/context.js";
import type { RunTelemetryV1 } from "../../src/core/telemetry/dto.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { newRecordId } from "../../src/core/telemetry/ids.js";
import { inspectRunTrustStatus } from "../../src/domains/evidence/trust-status.js";
import { openCallJournal, readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { storeTelemetryObject } from "../../src/domains/telemetry/objects.js";
import {
	telemetryObjectsDirectory,
	telemetryRunDirectory,
	telemetrySessionDirectory,
} from "../../src/domains/telemetry/paths.js";
import { type JournalSource, journalSourceFromRead, seal } from "../../src/domains/telemetry/read-model.js";
import { readRunRecord } from "../../src/domains/telemetry/run-record.js";
import { readTelemetryScopeFiles } from "../../src/domains/telemetry/seal.js";
import { telemetryView } from "../../src/domains/telemetry/telemetry-live.js";
import { scratchClioEnvVars } from "../harness/scratch-env.js";
import { telemetryCall } from "../harness/telemetry-view.js";

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

test("a run's verified seal is walked once, and an open run's scope read once per view, however many frames ask", async () => {
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
	const verified = new Map();
	const scope = (runId: string) => {
		reads[runId as keyof typeof reads] += 1;
		return runId === "sealed" ? sealed : unsealed;
	};
	const view = telemetryView(source, scope, verified);
	for (let frame = 0; frame < 3; frame += 1) {
		strictEqual(view.run("sealed")?.seal?.status, "verified");
		strictEqual(view.run("running")?.seal?.status, "unsealed");
	}
	deepStrictEqual(reads, { sealed: 1, running: 1 });
	strictEqual(view.run("absent"), null);
	// A new view may hold new journal facts, so it reads the open run's scope again.
	strictEqual(telemetryView(source, scope, verified).run("running")?.seal?.status, "unsealed");
	deepStrictEqual(reads, { sealed: 1, running: 2 });
	// A fork reads the runs its parent linked, so a worker card it inherited keeps its clock (bt-11 g).
	const fork = {
		sessionId: "ses_fork",
		journal: present,
		runs: new Map(),
		parent: { sessionId: "ses_frames", turnId: "t1", at: "2026-01-01T00:00:00.000Z", source },
	} as never;
	strictEqual(telemetryView(fork, scope, verified).run("running")?.seal?.status, "unsealed");
	strictEqual(telemetryView(fork, scope, verified).run("absent"), null);
});

test("an open run's card reuses its DTO across polls and views, advancing only its clock until its journal changes", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:10.000Z") });
	const journal = (records: TelemetryRecord[]): JournalSource => ({
		present: true,
		records,
		modes: ["standard"],
		skipped: 0,
		damaged: 0,
	});
	const call = (at: string) => telemetryCall("ses_poll", { role: "worker", at, usage: { input: 10, output: 20 } });
	const verified = new Map();
	const open = new Map();
	let reads = 0;
	// Each poll after a batch on another owner holds a new session source, so every view here is a fresh one.
	const poll = (run: JournalSource) => {
		const source = { sessionId: "ses_poll", journal: journal([]), runs: new Map([["run_poll", run]]), parent: null };
		const scope = () => {
			reads += 1;
			return null;
		};
		const telemetry = telemetryView(source, scope, verified, open).run("run_poll");
		ok(telemetry);
		return telemetry;
	};
	const elapsed = (telemetry: RunTelemetryV1) =>
		telemetry.activity.elapsed.fact.kind === "measured" ? telemetry.activity.elapsed.fact.value : null;
	const quiet = journal(call("2026-01-01T00:00:00.000Z"));
	const first = poll(quiet);
	t.mock.timers.tick(5_000);
	const second = poll(quiet);
	strictEqual(second.row, first.row, "a quiet journal is not refolded");
	strictEqual(second.tokens, first.tokens);
	strictEqual(second.counts, first.counts);
	strictEqual(reads, 2, "each view reads the scope once, and an unchanged scope keeps the DTO");
	deepStrictEqual([elapsed(first), elapsed(second)], [10_000, 15_000]);
	strictEqual(second.generatedAt, "2026-01-01T00:00:15.000Z");

	const grown = journal([...quiet.records, ...call("2026-01-01T00:00:12.000Z")]);
	const third = poll(grown);
	notStrictEqual(third.row, first.row, "a new record swaps the source and refolds");
	strictEqual(reads, 3);
	const calls = third.counts.calls.fact;
	strictEqual("measured" in calls ? calls.measured : null, 2);
	strictEqual(elapsed(third), 15_000);

	const anchor = grown.records[0] as TelemetryRecord;
	const sealing = { ...anchor, id: newRecordId(), k: "run.sealed", t: "2026-01-01T00:00:14.000Z", data: {} };
	const sealed = journal([...grown.records, sealing as unknown as TelemetryRecord]);
	const closing = poll(sealed);
	t.mock.timers.tick(60_000);
	deepStrictEqual([elapsed(closing), elapsed(poll(sealed))], [14_000, 14_000], "a sealed run's clock stops at its seal");
});

test("an open run sealed by another process stops advancing on the next view, with no record in this session", async (t) => {
	const stateDir = await mkdtemp(join(tmpdir(), "telemetry-seal-elsewhere-"));
	const directory = telemetryRunDirectory(stateDir, "run_elsewhere");
	const context: TelemetryContext = { sessionId: "ses_other", agent: { role: "worker", id: "run_elsewhere" } };
	const writer = await openCallJournal({
		directory,
		context,
		writer: { clioCoderVersion: "0.0.0-test", piVersion: "test" },
	});
	writer.enqueue({
		kind: "session.opened",
		data: {},
		ctx: context,
		wallMs: Date.now(),
		mono: performance.now(),
	} as Parameters<typeof writer.enqueue>[0]);
	await writer.flush();
	const unsealed = await readTelemetryScopeFiles(directory);
	ok(await writer.sealAndClose());
	const sealedFiles = await readTelemetryScopeFiles(directory);

	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:10.000Z") });
	const run: JournalSource = {
		present: true,
		records: telemetryCall("ses_poll", {
			role: "worker",
			at: "2026-01-01T00:00:00.000Z",
			usage: { input: 1, output: 2 },
		}),
		modes: ["standard"],
		skipped: 0,
		damaged: 0,
	};
	const verified = new Map();
	const open = new Map();
	let files = unsealed;
	// The run's journal source never changes here: the seal lands only in the scope files another process wrote.
	const poll = () => {
		const source = {
			sessionId: "ses_poll",
			journal: { ...run, records: [] },
			runs: new Map([["run_elsewhere", run]]),
			parent: null,
		};
		const telemetry = telemetryView(source, () => files, verified, open).run("run_elsewhere");
		ok(telemetry);
		return telemetry;
	};
	const elapsed = (telemetry: RunTelemetryV1) =>
		telemetry.activity.elapsed.fact.kind === "measured" ? telemetry.activity.elapsed.fact.value : null;
	const first = poll();
	t.mock.timers.tick(5_000);
	const second = poll();
	strictEqual(second.row, first.row, "an unchanged scope keeps the DTO");
	deepStrictEqual([elapsed(first), elapsed(second), second.seal?.status], [10_000, 15_000, "unsealed"]);

	files = sealedFiles;
	const picked = poll();
	strictEqual(picked.seal?.status, "verified", "the next view reads the seal from the scope");
	t.mock.timers.tick(30_000);
	deepStrictEqual([elapsed(picked), elapsed(poll())], [15_000, 15_000], "its clock stops once the seal is read");
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

test("a sealed run whose journal was truncated and whose bundle.json was deleted fails integrity, not unsealed (RL-7)", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "telemetry-seal-marker-"));
	const runId = "run_marker";
	const directory = telemetryRunDirectory(stateDir, runId);
	const context: TelemetryContext = { sessionId: "ses_marker", runId, agent: { role: "worker", id: runId } };
	const options = { directory, context, writer: { clioCoderVersion: "test", piVersion: "test" } };
	const first = await openCallJournal(options);
	ok(await first.sealAndClose());
	const journalPath = join(directory, "journal.jsonl");
	const sealed = await readFile(journalPath);
	// A reopen that never resealed keeps the sealed prefix, so it reads live, torn tail or not.
	await rm(join(directory, "bundle.json"));
	await writeFile(journalPath, Buffer.concat([sealed, Buffer.from('{"torn')]));
	strictEqual(seal(await readTelemetryScopeFiles(directory)).status, "unsealed");
	// Truncation through the seal line leaves no seal in the scope; the marker still says one landed.
	await writeFile(journalPath, sealed.subarray(0, sealed.lastIndexOf(0x0a, sealed.length - 2) + 1));
	strictEqual(seal(await readTelemetryScopeFiles(directory)).status, "failed");
	const inspection = inspectRunTrustStatus(readRunRecord(stateDir, runId));
	strictEqual(inspection.integrity.state, "failed");
	strictEqual(inspection.status.artifactIntegrity.state, "failed");
	await rejects(openCallJournal(options), /sealed telemetry scope does not verify/);
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

function readCli(home: string, argv: string[]): { status: number | null; stdout: string; stderr: string } {
	const script = `const { runTelemetryReadCommand } = await import(${JSON.stringify(new URL("../../src/cli/telemetry-read.ts", import.meta.url).href)}); process.exitCode = await runTelemetryReadCommand(${JSON.stringify(argv)});`;
	return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
		encoding: "utf8",
		env: { ...process.env, ...scratchClioEnvVars(home) },
	});
}

async function openedSession(home: string, id: string): Promise<void> {
	const context: TelemetryContext = { sessionId: id, agent: { role: "main", id } };
	const journal = await openCallJournal({
		directory: telemetrySessionDirectory(join(home, "state"), id),
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
}

test("telemetry calls --session <id> --run <r> keeps the run filter (I-25)", async () => {
	const home = await mkdtemp(join(tmpdir(), "telemetry-calls-run-"));
	await openedSession(home, "ses_calls_run");
	const result = readCli(home, ["calls", "--session", "ses_calls_run", "--run", "run_other", "--json"]);
	strictEqual(result.status, 0, result.stderr);
	const dto = JSON.parse(result.stdout) as { runId: string | null; calls: unknown[] };
	strictEqual(dto.runId, "run_other");
	deepStrictEqual(dto.calls, []);
});

test("telemetry calls shows each call's seat billing in --json and the table (M-36)", async () => {
	const home = await mkdtemp(join(tmpdir(), "telemetry-calls-billing-"));
	const id = "ses_calls_billing";
	const [started, settled] = telemetryCall(id, { role: "memory", at: "2026-01-01T00:00:00.000Z" });
	if (settled?.k !== "call.settled" || started === undefined) throw new Error("fixture call missing");
	const measured = (value: number) => ({ kind: "measured" as const, value, source: "provider" as const });
	const seat = {
		provider: "github-copilot" as const,
		premiumRequests: measured(0.33),
		nanoAiu: measured(5000),
		modelCalls: { kind: "measured" as const, value: 1, source: "local-count" as const },
	};
	const records = [
		started,
		{ ...settled, data: { ...settled.data, billing: seat } },
		...telemetryCall(id, { at: "2026-01-01T00:01:00.000Z" }),
	];
	const journal = await openCallJournal({
		directory: telemetrySessionDirectory(join(home, "state"), id),
		context: settled.ctx,
		writer: { clioCoderVersion: "0.0.0-test", piVersion: "test" },
	});
	for (const record of records)
		journal.enqueue({
			kind: record.k,
			data: record.data,
			ctx: record.ctx,
			wallMs: Date.parse(record.t),
			mono: record.mono,
			recordId: record.id,
		} as Parameters<typeof journal.enqueue>[0]);
	ok(await journal.sealAndClose());
	const json = readCli(home, ["calls", id, "--json"]);
	strictEqual(json.status, 0, json.stderr);
	const calls = (JSON.parse(json.stdout) as { calls: Array<{ billing: unknown }> }).calls;
	deepStrictEqual(
		calls.map((call) => call.billing),
		[
			{
				provider: "github-copilot",
				premiumRequests: { fact: seat.premiumRequests, display: "0.33" },
				nanoAiu: { fact: seat.nanoAiu, display: "5,000" },
				modelCalls: { fact: seat.modelCalls, display: "1" },
			},
			null,
		],
	);
	const table = readCli(home, ["calls", id]);
	strictEqual(table.status, 0, table.stderr);
	const [header, seated, metered] = table.stdout.trimEnd().split("\n");
	ok(header?.includes("billing"), table.stdout);
	ok(seated?.includes("0.33 premium, 5,000 nAIU"), table.stdout);
	ok(metered !== undefined && / n\/a(\s|$)/.test(metered), table.stdout);
});

test("telemetry read verbs take a unique session id prefix and refuse an ambiguous one (C13)", async () => {
	const home = await mkdtemp(join(tmpdir(), "telemetry-prefix-"));
	await openedSession(home, "ses_prefix_alpha");
	await openedSession(home, "ses_prefix_beta");
	const unique = readCli(home, ["inspect", "ses_prefix_a", "--json"]);
	strictEqual(unique.status, 0, unique.stderr);
	strictEqual((JSON.parse(unique.stdout) as { sessionId: string }).sessionId, "ses_prefix_alpha");
	const ambiguous = readCli(home, ["inspect", "ses_prefix_", "--json"]);
	strictEqual(ambiguous.status, 1);
	strictEqual(ambiguous.stdout, "");
});
