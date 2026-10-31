import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { pick, yesNo } from "../../src/domains/system-one/questions.js";
import type { DatasetSample, SampleData, SessionRow } from "../../src/domains/system-one/recorder/index.js";
import { anchorSessionRows, createRecorder } from "../../src/domains/system-one/recorder/index.js";
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

// Research capture alone admits the dataset; the host answers it, so each fixture names its answer (#434).
const recordingFor = new WeakMap<ClioSettings, boolean>();
function settings(record: boolean): ClioSettings {
	const next = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	recordingFor.set(next, record);
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
	const samples: Array<{ session: string; data: SampleData; content: DatasetSample }> = [];
	const recorder = createRecorder({
		currentSession: session,
		recording: () => recordingFor.get(config) ?? false,
		sample: (sessionId, _engine, data, content) => samples.push({ session: sessionId, data, content }),
		appendSessionRow: (sessionId, row) => appended.push([sessionId, row]),
	});
	return { recorder, appended, samples };
}

/** Each sample's dataset row, in the order the recorder handed them to the journal. */
function datasetRows(samples: ReadonlyArray<{ content: DatasetSample }>): Array<Record<string, unknown>> {
	return samples.map(({ content }) =>
		"decision" in content
			? (content.decision as unknown as Record<string, unknown>)
			: (content.outcome as unknown as Record<string, unknown>),
	);
}

test("planted secrets are redacted in state and outcome facts", () => {
	const skKey = "sk-abcdefghijklmnopqrstuvwxyz012345";
	const ghToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
	const password = "hunter2hunter2";
	const { recorder, samples } = recorderFor(settings(true));
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
	const raw = JSON.stringify(samples);
	for (const secret of [skKey, ghToken, password]) assert.ok(!raw.includes(secret), `${secret} reached the dataset`);
	const decision = datasetRows(samples).find((row) => row.kind === "decision");
	assert.ok((decision?.redactions as number) >= 4, `redactions counted: ${String(decision?.redactions)}`);
	// A number under a secret-flavored key is a measurement, not a credential.
	assert.equal((decision?.state as { config: { tokens: number } }).config.tokens, 12);
});

test("a state over 16 KB is cut to its head and digested whole", () => {
	const state = { head: "kept", blob: "x".repeat(40_000) };
	const { recorder, samples } = recorderFor(settings(true));
	recorder.decision(call({ state }));
	const row = datasetRows(samples).find((entry) => entry.kind === "decision") as Record<string, unknown>;
	assert.equal(row.stateTruncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(row.state)) <= 16 * 1024);
	assert.equal((row.state as { head: string }).head, "kept");
	assert.equal(row.stateDigest, createHash("sha256").update(JSON.stringify(state)).digest("hex"));
});

test("a decision sample carries its specs once each and the outcomes name its ref (#434)", () => {
	const { recorder, samples } = recorderFor(settings(true));
	const now = Date.now();
	const at = new Date(now).toISOString();
	recorder.decision(
		call({ callId: "dc_a", at, ref: "perm-1", policy: { escalated: true }, note: "downgraded: no-logprobs" }),
	);
	recorder.decision(call({ callId: "dc_b", at, ref: "perm-2", site: "toolResult" }));
	recorder.outcome({ ref: "perm-1", source: "permission", at: new Date(now + 30_000).toISOString(), facts: {} });
	assert.deepEqual(
		samples.map(({ session, data }) => [session, data.sample, data.decisionId ?? data.ref, data.site ?? null]),
		[
			["s1", "decision", "dc_a", "toolCall"],
			["s1", "decision", "dc_b", "toolResult"],
			["s1", "outcome", "perm-1", null],
		],
	);
	const first = samples[0]?.content;
	assert.ok(first && "decision" in first);
	assert.deepEqual(Object.values(first.specs).length, 2);
	assert.deepEqual(
		Object.fromEntries(Object.entries(first.decision.questions).map(([id, hash]) => [id, first.specs[hash]])),
		{ risk: RISK, kind: KIND },
	);
	assert.equal(first.decision.note, "downgraded: no-logprobs");
	assert.equal(recorder.drain("s1").find((row) => row.callId === "dc_a")?.note, "downgraded: no-logprobs");
	// Standard capture records nothing.
	const standard = recorderFor(settings(false));
	standard.recorder.decision(call());
	assert.deepEqual(standard.samples, []);
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

test("a held decision is recorded under the session that adopts it, with the outcomes that waited for it", () => {
	let session: string | null = null;
	const { recorder, samples } = recorderFor(settings(true), () => session);
	const outcome = (ref: string, source: "draft" | "turn") => ({ ref, source, at: new Date().toISOString(), facts: {} });
	recorder.decision(call({ callId: "d-draft", ref: "draft-1", session: null }));
	recorder.decision(call({ callId: "d-turn", ref: "turn-1", session: null }));
	recorder.outcome(outcome("draft-1", "draft"));
	// No session is current and no held decision names it, so no journal can receive it.
	recorder.outcome(outcome("elsewhere", "turn"));
	recorder.outcome(outcome("turn-1", "turn"));
	session = "s1";
	recorder.drain("s1");
	// The decision is no longer held, so a late outcome is recorded at once.
	recorder.outcome(outcome("draft-1", "turn"));
	const rows = datasetRows(samples).map(
		(row) =>
			`${String(row.kind)}:${String(row.callId ?? row.ref)}${row.kind === "outcome" ? `/${String(row.source)}` : ""}`,
	);
	assert.deepEqual(rows, [
		"decision:d-draft",
		"decision:d-turn",
		"outcome:draft-1/draft",
		"outcome:turn-1/turn",
		"outcome:draft-1/turn",
	]);
	assert.deepEqual(
		samples.map((sample) => sample.session),
		["s1", "s1", "s1", "s1", "s1"],
	);
	assert.deepEqual(
		datasetRows(samples)
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
