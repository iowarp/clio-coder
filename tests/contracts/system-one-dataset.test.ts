import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { pick, yesNo } from "../../src/domains/system-one/questions.js";
import type { SessionRow } from "../../src/domains/system-one/recorder/index.js";
import {
	anchorSessionRows,
	buildExport,
	createRecorder,
	datasetDir,
	pruneDataset,
} from "../../src/domains/system-one/recorder/index.js";
import type { DecisionRecord } from "../../src/domains/system-one/types.js";
import type { IsolatedClioEnv } from "../harness/scratch-env.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;

beforeEach(async () => {
	env = await isolateClioEnv("clio-coder-system-one-dataset-");
});

afterEach(() => {
	env.restore();
});

const RISK = yesNo("Is the call risky?", "it destroys data", "it reads or writes something ordinary");
const KIND = pick("Which kind of call?", { read: "it only reads", other: "anything else" });

function settings(record: boolean): ClioSettings {
	const next = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	next.systemOne.record = record;
	return next;
}

function call(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
	return {
		v: 1,
		callId: "dc_1",
		at: new Date().toISOString(),
		site: "toolCall",
		siteVersion: "1",
		engine: "jev",
		kind: "systemone",
		target: "jev-cloud",
		model: null,
		build: "jev-1.13.0",
		outcome: "answered",
		latencyMs: 40,
		deadlineMs: 800,
		state: { target: "ls" },
		questions: { risk: RISK, kind: KIND },
		...overrides,
	};
}

function recorderFor(config: ClioSettings, session: () => string | null = () => "s1") {
	const appended: Array<[string, SessionRow]> = [];
	const recorder = createRecorder({
		currentSession: session,
		settings: () => config,
		appendSessionRow: (sessionId, row) => appended.push([sessionId, row]),
	});
	return { recorder, appended };
}

function datasetRows(): Array<Record<string, unknown>> {
	const file = readdirSync(datasetDir()).find((name) => name.endsWith(".jsonl"));
	assert.ok(file, "the dataset has a day file");
	return readFileSync(join(datasetDir(), file), "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("planted secrets are redacted in state and outcome facts", () => {
	const skKey = "sk-abcdefghijklmnopqrstuvwxyz012345";
	const ghToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
	const password = "hunter2hunter2";
	const { recorder } = recorderFor(settings(true));
	recorder.decision(
		call({
			ref: "r1",
			state: {
				target: `curl -H "Authorization: ${skKey}" https://example.test`,
				note: `remote uses ${ghToken}`,
				command: `mysql --user app --password=${password}`,
				config: { password, tokens: 12 },
			},
		}),
	);
	recorder.outcome({
		ref: "r1",
		source: "permission",
		at: new Date().toISOString(),
		facts: { echoed: `GITHUB_TOKEN=${ghToken}`, reason: `db password: ${password}`, key: skKey },
	});
	recorder.flush();
	const raw = readFileSync(join(datasetDir(), readdirSync(datasetDir())[0] as string), "utf8");
	for (const secret of [skKey, ghToken, password]) assert.ok(!raw.includes(secret), `${secret} reached the dataset`);
	const decision = datasetRows().find((row) => row.kind === "decision");
	assert.ok((decision?.redactions as number) >= 4, `redactions counted: ${String(decision?.redactions)}`);
	// A number under a secret-flavored key is a measurement, not a credential.
	assert.equal((decision?.state as { config: { tokens: number } }).config.tokens, 12);
});

test("a state over 16 KB is cut to its head and digested whole", () => {
	const state = { head: "kept", blob: "x".repeat(40_000) };
	const { recorder } = recorderFor(settings(true));
	recorder.decision(call({ state }));
	recorder.flush();
	const row = datasetRows().find((entry) => entry.kind === "decision") as Record<string, unknown>;
	assert.equal(row.stateTruncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(row.state)) <= 16 * 1024);
	assert.equal((row.state as { head: string }).head, "kept");
	assert.equal(row.stateDigest, createHash("sha256").update(JSON.stringify(state)).digest("hex"));
});

test("retention deletes expired and over-cap day files and never the newest", () => {
	const dir = datasetDir();
	mkdirSync(dir, { recursive: true });
	const filler = `${"x".repeat(1_200_000)}\n`;
	writeFileSync(join(dir, "2020-01-01.jsonl"), "{}\n");
	writeFileSync(join(dir, "2026-09-25.jsonl"), filler);
	writeFileSync(join(dir, "2026-09-26.jsonl"), filler);
	writeFileSync(join(dir, "notes.txt"), "not ours");
	const deleted = pruneDataset(dir, { retentionDays: 30, maxMiB: 1 }, Date.UTC(2026, 8, 26, 12));
	assert.deepEqual(deleted, ["2020-01-01", "2026-09-25"]);
	// The newest stays although it alone is over the cap, and a file the dataset does not own is untouched.
	assert.deepEqual(readdirSync(dir).sort(), ["2026-09-26.jsonl", "notes.txt"]);
});

test("the first dataset write of a process prunes expired days", () => {
	const dir = datasetDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "2020-01-01.jsonl"), "{}\n");
	const { recorder } = recorderFor(settings(true));
	recorder.decision(call());
	recorder.flush();
	const files = readdirSync(dir);
	assert.ok(!files.includes("2020-01-01.jsonl"));
	assert.equal(files.length, 1);
});

test("export joins a decision, its specs and every outcome for its ref into one line", () => {
	const { recorder } = recorderFor(settings(true));
	const now = Date.now();
	const at = new Date(now).toISOString();
	recorder.decision(
		call({ callId: "dc_a", at, ref: "perm-1", policy: { escalated: true }, note: "downgraded: no-logprobs" }),
	);
	recorder.decision(call({ callId: "dc_b", at, ref: "perm-2", site: "toolResult" }));
	recorder.outcome({
		ref: "perm-1",
		source: "follow-up",
		at: new Date(now + 300_000).toISOString(),
		facts: { reran: true },
	});
	recorder.outcome({
		ref: "perm-1",
		source: "permission",
		at: new Date(now + 30_000).toISOString(),
		facts: { approved: false },
	});
	recorder.flush();

	// Two decisions share both questions, so each spec is stored once.
	assert.equal(datasetRows().filter((row) => row.kind === "spec").length, 2);

	const { lines, decisions } = buildExport();
	assert.equal(decisions, 2);
	const joined = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
	const first = joined.find((line) => line.callId === "dc_a") as Record<string, unknown>;
	assert.deepEqual(first.questions, { risk: RISK, kind: KIND });
	assert.deepEqual(first.policy, { escalated: true });
	assert.equal(first.note, "downgraded: no-logprobs");
	assert.equal(datasetRows().find((row) => row.callId === "dc_a")?.note, "downgraded: no-logprobs");
	assert.equal(recorder.drain("s1").find((row) => row.callId === "dc_a")?.note, "downgraded: no-logprobs");
	assert.deepEqual(
		(first.outcomes as Array<{ source: string }>).map((outcome) => outcome.source),
		["permission", "follow-up"],
	);
	const second = joined.find((line) => line.callId === "dc_b") as Record<string, unknown>;
	assert.deepEqual(second.outcomes, []);
	assert.equal(second.kind, "systemone");
});

test("an export scrubs a row recorded before the scrub fix, and scrubbing twice changes nothing", () => {
	const home = homedir();
	const legacy = {
		kind: "decision",
		callId: "dc_legacy",
		at: "2026-01-01T00:00:00.000Z",
		site: "turnEnd",
		siteVersion: "1",
		engine: "jev",
		engineKind: "systemone",
		target: "jev-cloud",
		outcome: "answered",
		state: { message: `it would delete \`${home}/scratch.txt\` outside the workspace`, previous: `from ${home}/repo` },
		stateDigest: "d",
		questions: {},
		latencyMs: 1,
		deadlineMs: 1,
	};
	mkdirSync(datasetDir(), { recursive: true });
	writeFileSync(join(datasetDir(), "2026-01-01.jsonl"), `${JSON.stringify(legacy)}\n`);
	const first = buildExport().lines[0] ?? "";
	assert.ok(!first.includes(home), first);
	const row = JSON.parse(first) as { state: { message: string; previous: string } };
	assert.equal(row.state.message, "it would delete `~/scratch.txt` outside the workspace");
	assert.equal(row.state.previous, "from ~/repo");
	// The stored file keeps its old text; only the copy that leaves is rewritten.
	assert.ok(readFileSync(join(datasetDir(), "2026-01-01.jsonl"), "utf8").includes(home));
	assert.equal(JSON.parse(first).state.message, row.state.message);
});

test("drain returns the draining session's rows and the pre-session rows only", () => {
	let session: string | null = null;
	const { recorder, appended } = recorderFor(settings(false), () => session);
	recorder.decision(call({ callId: "before-any-session" }));
	session = "s1";
	recorder.decision(call({ callId: "from-s1" }));
	session = "s2";
	recorder.decision(call({ callId: "from-s2", state: { target: "rm -rf build" } }));

	const rows = recorder.drain("s2");
	assert.deepEqual(
		rows.map((row) => row.callId),
		["before-any-session", "from-s2"],
	);
	assert.deepEqual(
		appended.map(([sessionId, row]) => [sessionId, row.callId]),
		[["s1", "from-s1"]],
	);
	assert.deepEqual(recorder.drain("s2"), []);
	// The ledger row carries the digest and a token estimate, never the state itself.
	const stored = rows[1] as unknown as Record<string, unknown>;
	assert.equal("state" in stored, false);
	assert.ok(!JSON.stringify(stored).includes("rm -rf build"));
	assert.equal(typeof stored.stateDigest, "string");
	assert.equal(stored.questions, 2);
});

test("an outcome that names a held decision is written right after it, and one for a released decision is queued at once", () => {
	let session: string | null = null;
	const { recorder } = recorderFor(settings(true), () => session);
	const outcome = (ref: string, source: "draft" | "turn") => ({ ref, source, at: new Date().toISOString(), facts: {} });
	recorder.decision(call({ callId: "d-draft", ref: "draft-1", session: null }));
	recorder.decision(call({ callId: "d-turn", ref: "turn-1", session: null }));
	recorder.outcome(outcome("draft-1", "draft"));
	recorder.outcome(outcome("elsewhere", "turn"));
	recorder.outcome(outcome("turn-1", "turn"));
	session = "s1";
	recorder.drain("s1");
	// The decision is no longer held, so a late outcome goes straight to the queue.
	recorder.outcome(outcome("draft-1", "turn"));
	recorder.flush();
	const rows = datasetRows()
		.filter((row) => row.kind !== "spec")
		.map(
			(row) =>
				`${String(row.kind)}:${String(row.callId ?? row.ref)}${row.kind === "outcome" ? `/${String(row.source)}` : ""}`,
		);
	assert.deepEqual(rows, [
		"outcome:elsewhere/turn",
		"decision:d-draft",
		"outcome:draft-1/draft",
		"decision:d-turn",
		"outcome:turn-1/turn",
		"outcome:draft-1/turn",
	]);
	assert.deepEqual(
		datasetRows()
			.filter((row) => row.kind === "decision")
			.map((row) => row.session),
		["s1", "s1"],
	);
});

test("session rows hang under the turn their ref names and under the leaf when it names none", () => {
	const row = (callId: string, ref?: string): SessionRow => ({
		callId,
		at: "2026-09-29T00:00:00.000Z",
		...(ref !== undefined ? { ref } : {}),
		site: "turn",
		siteVersion: "1",
		engine: "jev",
		kind: "systemone",
		build: null,
		outcome: "answered",
		latencyMs: 1,
		deadlineMs: 1,
		stateTokens: 1,
		stateDigest: "d",
		questions: 1,
	});
	const tree = {
		leafId: "u2",
		nodesById: { u1: { kind: "user" }, u2: { kind: "user" }, a1: { kind: "assistant" }, c1: { kind: "compaction" } },
	};
	const groups = anchorSessionRows(
		[
			row("late", "u1"),
			row("now", "u2"),
			row("perm", "req-9"),
			row("marker", "c1"),
			row("bare"),
			row("proto", "constructor"),
			row("reply", "a1"),
		],
		tree,
	);
	assert.deepEqual(
		groups.map((group) => [group.parentTurnId, group.calls.map((entry) => entry.callId)]),
		[
			["u1", ["late"]],
			["u2", ["now", "perm", "marker", "bare", "proto"]],
			["a1", ["reply"]],
		],
	);
	assert.deepEqual(anchorSessionRows([row("x", "u1")], { leafId: null, nodesById: {} }), [
		{ parentTurnId: null, calls: [row("x", "u1")] },
	]);
});
