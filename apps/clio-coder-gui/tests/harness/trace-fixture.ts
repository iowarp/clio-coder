import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEnvelope, RunResultDraft } from "../../../../src/domains/dispatch/types.js";
import { fixtureReceiptDraft } from "../../../../tests/harness/receipt.js";
import { writeSettledRun } from "../../../../tests/harness/settled-run.js";
import { telemetryCall } from "../../../../tests/harness/telemetry-view.js";
import { seedRunJournal } from "./telemetry-fixture.js";

const startedAt = "2026-09-11T12:00:00.000Z",
	endedAt = "2026-09-11T12:00:06.000Z";
const at = (seconds: number) => new Date(Date.parse(startedAt) + seconds * 1000).toISOString();

/** The journal of run-0000: the worker's process, a tool event, one priced call and the settlement. */
function fullJournal(runId: string) {
	const call = telemetryCall("fixture-session", {
		role: "worker",
		at: at(2),
		usage: { input: 200, output: 40 },
		usd: 0.0024,
	});
	return [
		{ kind: "process.started" as const, data: {}, at: at(0) },
		{ kind: "run.feed_appended" as const, data: { seq: 1, body: { kind: "open", runId, agentId: "coder" } }, at: at(0) },
		{
			kind: "run.feed_appended" as const,
			data: {
				seq: 2,
				body: { kind: "event", type: "clio_coder_tool_finish", tool: "read", outcome: "ok", durationMs: 15 },
			},
			at: at(1),
		},
		// The golden call is a legacy import with no stages; this one records them, so the run page draws its bars.
		...call.map((record) => ({
			kind: record.k,
			data:
				record.k === "call.settled"
					? {
							...record.data,
							stages: { admission: { start: 0, end: 50 }, send: { start: 50, end: 120 }, firstToken: 900, settle: 2500 },
						}
					: record.data,
			at: record.k === "call.settled" ? at(4.5) : record.t,
			ctx: { callId: String(record.ctx.callId), attemptId: String(record.ctx.attemptId) },
		})),
		{ kind: "process.exited" as const, data: { exitCode: 0 }, at: at(5) },
	];
}

/**
 * Trace history as path A reads it (#434): `count` run journals with dispatch ledger rows beside any the ledger
 * already holds, run-0000 a whole settled run with checks and an assessment under its seal, every third other run
 * still running. `writtenMs` sets each journal's write time, the history's order, so ties and pages are deterministic.
 */
/** run-0000's result: verified, with a typed check, a contract and grounding the run's seal vouches for. */
function checkedDraft(envelope: RunEnvelope): RunResultDraft {
	return {
		...fixtureReceiptDraft({ ...envelope, endedAt }),
		executionRole: envelope.executionRole,
		verification: { state: "verified", basis: "validation-tool" },
		quality: {
			version: 1,
			typedValidations: [{ sourceId: "tool:verify", validatorDigest: "1".repeat(64), passed: true }],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: {
				sourceId: "agent-result-contract:mutation-report:fixture-contract",
				validatorDigest: "2".repeat(64),
				conformance: "pass",
				quality: "unmeasured",
			},
		},
		validationGrounding: { claimed: 2, grounded: 1, ungrounded: ["lint"], basis: "unmatched-command" },
		toolStats: [{ tool: "read", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 15 }],
	};
}

export async function traceFixture(
	state: string,
	count = 12,
	writtenMs: (index: number) => number = (index) => Date.parse(endedAt) - index * 1000,
) {
	const rows: RunEnvelope[] = [];
	for (let i = 0; i < count; i++) {
		const runId = `run-${String(i).padStart(4, "0")}`;
		const running = i > 0 && i % 3 === 0;
		const row: RunEnvelope = {
			version: 1,
			id: runId,
			agentId: "coder",
			executionRole: "builder",
			task: `Inspect fixture ${i}`,
			targetId: "local",
			wireModelId: "fixture-model",
			runtimeId: "native",
			runtimeKind: "http",
			startedAt,
			endedAt: running ? null : endedAt,
			status: running ? "running" : "completed",
			outcome: running ? null : "succeeded",
			exitCode: running ? null : 0,
			pid: null,
			heartbeatAt: null,
			sessionId: null,
			cwd: state,
			tokenCount: 0,
			costUsd: 0,
		};
		rows.push(row);
		await seedRunJournal(state, runId, i === 0 ? fullJournal(runId) : [{ kind: "process.started", data: {}, at: at(0) }]);
		if (!running) await writeSettledRun(state, i === 0 ? checkedDraft(row) : fixtureReceiptDraft({ ...row, endedAt }));
		const stamp = new Date(writtenMs(i));
		utimesSync(join(state, "telemetry", "runs", runId, "journal.jsonl"), stamp, stamp);
	}
	const ledger = join(state, "runs.json");
	const held: unknown[] = existsSync(ledger) ? (JSON.parse(readFileSync(ledger, "utf8")) as unknown[]) : [];
	writeFileSync(ledger, JSON.stringify([...held, ...rows]));
}
