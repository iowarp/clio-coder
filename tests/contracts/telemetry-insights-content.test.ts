import { deepStrictEqual, ok } from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runTelemetryInsights } from "../../src/cli/telemetry-insights.js";
import { cwdHash } from "../../src/core/cwd-hash.js";
import { EVENTS } from "../../src/core/telemetry/events.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { countVerifiedOutcomes } from "../../src/domains/evidence/verified-outcomes.js";
import { seedForkCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { INSIGHT_RECORD_KINDS, outcomeLedgerProjection } from "../../src/domains/telemetry/insights.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const SECRET = "SENTINEL-CONTENT-7f3a";

const passedCheck = (check: string, timestamp: string) => ({
	turnId: "turn-1",
	parentTurnId: null,
	timestamp,
	kind: "message",
	role: "tool_result",
	payload: {
		toolName: "verify",
		isError: false,
		content: SECRET,
		result: {
			output: SECRET,
			details: {
				check,
				stdout: SECRET,
				report: { kind: "reproduce", passed: true, actual: { sha256: "a", preview: SECRET }, note: SECRET },
				judgement: { execution: "succeeded", validation: "passed", reason: SECRET },
			},
		},
	},
});

function outcomeLedger(): unknown[] {
	const at = "2026-11-06T00:00:00.000Z";
	const base = { turnId: "turn-1", parentTurnId: null, timestamp: at };
	return [
		{ ...base, kind: "message", role: "user", payload: { content: SECRET } },
		{ ...base, kind: "message", role: "tool_call", payload: { name: "write", args: { path: `${SECRET}.tex` } } },
		passedCheck("fit", at),
		{
			...base,
			kind: "taskLedger",
			boardId: "board-1",
			activeRunIds: [],
			timestamp: "2026-11-06T00:01:00.000Z",
			goals: [{ id: "board", title: SECRET, status: "completed" }],
			subgoals: [{ id: "t1", title: SECRET, description: SECRET, status: "completed", parentGoalId: "board" }],
			requiredValidationEvidence: [
				{
					id: "t1.observed.0",
					description: SECRET,
					command: SECRET,
					status: "passed",
					observedAt: "2026-11-06T00:00:30.000Z",
				},
			],
		},
	];
}

test("telemetry insights reads only content-free records and a text-free projection of the ledger", () => {
	for (const kind of INSIGHT_RECORD_KINDS) {
		// Typecheck already refuses a content kind; this pins the registry the types are read from.
		const { cc, tier }: { cc: string; tier: string } = EVENTS[kind];
		ok(cc !== "content-bearing" && tier !== "research", `${kind} is content`);
	}
	const ledger = outcomeLedger();
	const projected = ledger.map(outcomeLedgerProjection).filter((entry) => entry !== null);
	ok(!JSON.stringify(projected).includes(SECRET));
	deepStrictEqual(countVerifiedOutcomes(projected, new Set()), countVerifiedOutcomes(ledger, new Set()));
	deepStrictEqual(countVerifiedOutcomes(projected, new Set()).total, 2);
});

test("telemetry insights credits a fork only with the outcomes it verified after it forked (bt-47 c16-D)", async () => {
	const env = await isolateClioEnv("clio-insights-fork-");
	try {
		const stateDir = clioStateDir();
		const cwd = join(env.dir, "project");
		const bucket = join(stateDir, "sessions", cwdHash(cwd));
		const ledgerRows = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
		for (const id of ["parent", "fork"]) {
			mkdirSync(join(bucket, id), { recursive: true });
			writeFileSync(join(bucket, id, "meta.json"), JSON.stringify({ id, cwd }));
			writeFileSync(join(bucket, id, "current.jsonl"), ledgerRows(outcomeLedger()));
		}
		seedForkCallJournal(stateDir, "fork", {
			parentSessionId: "parent",
			parentCwdHash: cwdHash(cwd),
			parentTurnId: "turn-1",
			parentTurnAt: "2026-11-06T00:01:00.000Z",
		});
		const insights = async () => {
			let out = "";
			const write = process.stdout.write;
			process.stdout.write = ((chunk: string) => {
				out += chunk;
				return true;
			}) as typeof process.stdout.write;
			// The command reads and prints synchronously, so the capture closes before any other output can land.
			const done = runTelemetryInsights(["--json"]);
			process.stdout.write = write;
			deepStrictEqual(await done, 0);
			const [project] = JSON.parse(out).projects as Array<{
				verified: { sessions: number; known: number };
				rows: Array<{ sessionId: string; verifiedOutcomes: number | null }>;
			}>;
			return {
				share: project?.verified,
				rows: Object.fromEntries((project?.rows ?? []).map((row) => [row.sessionId, row.verifiedOutcomes])),
			};
		};
		deepStrictEqual(await insights(), { share: { sessions: 1, known: 2 }, rows: { parent: 2, fork: 0 } });
		const later = new Date(Date.now() + 60_000).toISOString();
		appendFileSync(join(bucket, "fork", "current.jsonl"), ledgerRows([passedCheck("fork-fit", later)]));
		deepStrictEqual(await insights(), { share: { sessions: 2, known: 2 }, rows: { parent: 2, fork: 1 } });
	} finally {
		env.restore();
	}
});
