/**
 * Issue #60 (time audit finding 4): run attribution for session ledger entries
 * must survive concurrent dispatch runs, which is the case this product exists
 * for. Two runs in one session with overlapping windows put every entry in the
 * intersection inside both windows. Timestamp containment cannot name an owner
 * there, so the bundle must say so: the entry stays in every bundle it may
 * belong to, carries its candidate runs, and is never claimed as exact. Where
 * the producer stamped the run id at write time, that stamp wins outright.
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { buildEvidence } from "../../src/domains/evidence/index.js";
import type { EvidenceProtectedArtifactsFile, EvidenceToolEvent } from "../../src/domains/evidence/types.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

const SESSION_ID = "sessoverlap01";

/** Fixed clock: the windows are the fixture, so no test may read the wall clock. */
const BASE_MS = Date.UTC(2026, 7, 15, 12, 0, 0);
const at = (offsetMs: number): string => new Date(BASE_MS + offsetMs).toISOString();

/** Run A spans 0s..30s, run B spans 10s..40s; 10s..30s belongs to neither alone. */
const RUN_A_WINDOW = { startedAt: at(0), endedAt: at(30_000) };
const RUN_B_WINDOW = { startedAt: at(10_000), endedAt: at(40_000) };

interface Fixture {
	dataDir: string;
	stateDir: string;
	runA: string;
	runB: string;
}

let scratch = "";

function bashEntry(turnId: string, offsetMs: number, command: string): Record<string, unknown> {
	return {
		kind: "bashExecution",
		turnId,
		parentTurnId: null,
		timestamp: at(offsetMs),
		command,
		output: "ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
	};
}

async function seedOverlappingRuns(): Promise<Fixture> {
	const ledger = openLedger();
	const create = (task: string, window: { startedAt: string; endedAt: string }): string => {
		const envelope = ledger.create({
			agentId: "coder",
			executionRole: "builder",
			task,
			targetId: "mini",
			wireModelId: "test-model",
			runtimeId: "openai-completions",
			runtimeKind: "http",
			sessionId: SESSION_ID,
			cwd: "/tmp",
		});
		ledger.update(envelope.id, {
			...window,
			status: "completed",
			outcome: "succeeded",
			exitCode: 0,
		});
		return envelope.id;
	};
	const runA = create("overlapping run a", RUN_A_WINDOW);
	const runB = create("overlapping run b", RUN_B_WINDOW);
	await ledger.persist();

	const sessionDir = join(scratch, "state", "sessions", "somecwdhash", SESSION_ID);
	mkdirSync(sessionDir, { recursive: true });
	const lines: Array<Record<string, unknown>> = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: at(0), cwd: "/tmp" },
		bashEntry("t-a-only", 5_000, "echo a-only"),
		bashEntry("t-both", 20_000, "npm run ci"),
		{
			kind: "message",
			turnId: "t-both-call",
			parentTurnId: null,
			timestamp: at(21_000),
			role: "tool_call",
			payload: { id: "call-1", name: "bash", arguments: { command: "npm test" } },
		},
		{
			kind: "message",
			turnId: "t-both-result",
			parentTurnId: null,
			timestamp: at(22_000),
			role: "tool_result",
			payload: { toolCallId: "call-1", toolName: "bash", result: "pass" },
		},
		// Written inside the intersection, but the producer stamped run B on it.
		{
			kind: "protectedArtifact",
			turnId: "t-both-artifact",
			parentTurnId: null,
			timestamp: at(23_000),
			action: "protect",
			artifact: {
				path: "src/overlap.ts",
				protectedAt: at(23_000),
				reason: "validated by the run that wrote it",
				source: "validation",
				validationCommand: "npm run ci",
				validationExitCode: 0,
			},
			runId: runB,
			toolName: "write",
		},
		bashEntry("t-b-only", 35_000, "echo b-only"),
	];
	writeFileSync(join(sessionDir, "current.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

	return { dataDir: join(scratch, "data"), stateDir: join(scratch, "state"), runA, runB };
}

function readToolEvents(directory: string): EvidenceToolEvent[] {
	return readFileSync(join(directory, "tool-events.jsonl"), "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as EvidenceToolEvent);
}

function readProtectedArtifacts(directory: string): EvidenceProtectedArtifactsFile {
	return JSON.parse(readFileSync(join(directory, "protected-artifacts.json"), "utf8")) as EvidenceProtectedArtifactsFile;
}

/** Transcript lines for the three entries inside the 10s..30s intersection. */
function intersectionTranscriptLines(directory: string): string[] {
	return readFileSync(join(directory, "transcript.md"), "utf8")
		.split("\n")
		.filter((line) => line.includes(at(20_000)) || line.includes(at(21_000)) || line.includes(at(22_000)));
}

describe("contracts/evidence-overlapping-runs", () => {
	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-evidence-overlap-");
	});

	afterEach(() => {
		clearScratchClioHome(scratch);
	});

	it("keeps every intersection entry in the session bundle and marks the ambiguity", async () => {
		const { dataDir, stateDir, runA, runB } = await seedOverlappingRuns();
		const candidates = [runA, runB].sort();

		const result = await buildEvidence({ dataDir, stateDir, sessionId: SESSION_ID });

		// Six entries, not four: nothing in the intersection was dropped.
		strictEqual(result.overview.totals.sessionEntries, 6);

		const transcript = intersectionTranscriptLines(result.directory);
		strictEqual(transcript.length, 3);
		for (const line of transcript) {
			ok(line.includes("link=ambiguous-timestamp-window"), line);
			ok(line.includes(`candidates=${candidates.join(",")}`), line);
			ok(!line.includes(`run=${runA} `), line);
			ok(!line.includes(`run=${runB} `), line);
		}

		const ambiguous = readToolEvents(result.directory).filter(
			(event) => event.runLink?.kind === "ambiguous-timestamp-window",
		);
		strictEqual(ambiguous.length, 2);
		for (const event of ambiguous) {
			strictEqual(event.runId, null);
			strictEqual(event.runLink?.confidence, "best-effort");
			strictEqual(JSON.stringify(event.runLink?.candidateRunIds), JSON.stringify(candidates));
		}

		const finding = result.findings.find((item) => item.tag === "best-effort-link");
		ok(finding, "expected a best-effort-link finding for the ambiguous entries");
		ok(finding?.message.includes("3 session entry(s)"), finding?.message);
	});

	it("marks the intersection as ambiguous in both run bundles instead of claiming it", async () => {
		const { dataDir, stateDir, runA, runB } = await seedOverlappingRuns();
		const candidates = [runA, runB].sort();

		for (const runId of [runA, runB]) {
			const result = await buildEvidence({ dataDir, stateDir, runId });
			const transcript = intersectionTranscriptLines(result.directory);
			strictEqual(transcript.length, 3, `run ${runId} lost intersection entries`);
			for (const line of transcript) {
				ok(line.includes(`candidates=${candidates.join(",")}`), line);
			}
			for (const event of readToolEvents(result.directory)) {
				if (event.runId === null) continue;
				strictEqual(event.runId, runId);
				strictEqual(event.runLink?.kind, "timestamp-window");
			}
		}
	});

	it("attributes a write-time stamped entry to its own run and to no other", async () => {
		const { dataDir, stateDir, runA, runB } = await seedOverlappingRuns();

		const bundleB = await buildEvidence({ dataDir, stateDir, runId: runB });
		const eventsB = readProtectedArtifacts(bundleB.directory).events;
		strictEqual(eventsB.length, 1);
		strictEqual(eventsB[0]?.runId, runB);
		strictEqual(eventsB[0]?.sourceRunId, runB);
		// The stamp is exact, and the bundle says so rather than implying a window.
		strictEqual(eventsB[0]?.runLink?.kind, "entry-run-id");
		strictEqual(eventsB[0]?.runLink?.confidence, "exact");
		strictEqual(eventsB[0]?.runLink?.candidateRunIds, undefined);

		// Run A's window also contains that timestamp; the stamp keeps A from
		// claiming an artifact it did not protect.
		const bundleA = await buildEvidence({ dataDir, stateDir, runId: runA });
		strictEqual(readProtectedArtifacts(bundleA.directory).events.length, 0);
		ok(!readFileSync(join(bundleA.directory, "transcript.md"), "utf8").includes("src/overlap.ts"));
	});

	it("keeps unambiguous entries attributed and labels the window as the fallback", async () => {
		const { dataDir, stateDir, runA, runB } = await seedOverlappingRuns();

		const result = await buildEvidence({ dataDir, stateDir, sessionId: SESSION_ID });
		const events = readToolEvents(result.directory);

		const aOnly = events.find((event) => event.argsPreview === "echo a-only");
		strictEqual(aOnly?.runId, runA);
		strictEqual(aOnly?.runLink?.kind, "timestamp-window");
		strictEqual(aOnly?.runLink?.confidence, "best-effort");
		strictEqual(aOnly?.runLink?.candidateRunIds, undefined);

		const bOnly = events.find((event) => event.argsPreview === "echo b-only");
		strictEqual(bOnly?.runId, runB);
		strictEqual(bOnly?.runLink?.kind, "timestamp-window");
	});
});
