import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TraceReader, TraceStore } from "../../../../src/domains/observability/trace-store.js";

export { TraceReader };
export function traceFixture(state: string, count = 12) {
	const path = join(state, "trace.sqlite"),
		store = new TraceStore(path);
	const startedAt = "2026-09-11T12:00:00.000Z",
		endedAt = "2026-09-11T12:00:06.000Z";
	store.transaction(() => {
		const insert = store.db.prepare(
			"INSERT INTO runs(run_id, assignment_id, request, status, agent, target, model, runtime, started_at, ended_at, source, total_tokens, total_cost_usd) VALUES(?, ?, ?, ?, 'coder', 'local', 'fixture-model', 'native', ?, ?, ?, 240, ?)",
		);
		for (let i = 0; i < count; i++) {
			const source = i % 2 ? "session" : "dispatch";
			insert.run(
				`run-${String(i).padStart(4, "0")}`,
				source === "session" ? "session" : "assignment",
				`Inspect fixture ${i}`,
				i % 3 ? "success" : "running",
				startedAt,
				i % 3 ? endedAt : null,
				source,
				i % 2 ? null : 0.0024,
			);
		}
		store.db
			.prepare(
				"INSERT INTO phases(phase_id,run_id,seq,name,kind,owner,description,status,attempt,retries,error,started_at,ended_at,input_tokens,output_tokens,total_tokens,total_cost_usd,context_tokens,context_window) VALUES ('phase-1','run-0000',1,'Inspect workspace','task','coder','Read and verify the requested change','running',2,1,'First attempt needed more evidence',?,NULL,200,40,240,0.0024,1500,64000)",
			)
			.run(startedAt);
		store.db
			.prepare(
				"INSERT INTO gate_results(run_id,phase_id,attempt,gate,passed,violations_json,checks_json,created_at) VALUES('run-0000','phase-1',2,'verification',1,'[]',?,?)",
			)
			.run(JSON.stringify([{ item: "unit tests", ok: true, note: "24 tests passed" }]), endedAt);
		store.db
			.prepare(
				"INSERT INTO processes(run_id,kind,name,pid,command,command_digest,started_at,ended_at) VALUES('run-0000','tool','shell',12345,'pnpm test','fixture-digest',?,?)",
			)
			.run(startedAt, endedAt);
		store.db
			.prepare(
				"INSERT INTO envelopes(envelope_id,run_id,phase_id,agent,output_type,payload_json,valid,attempt,created_at) VALUES('envelope-1','run-0000','phase-1','coder','result','{\"summary\":\"verified\"}',1,2,?)",
			)
			.run(endedAt);
	});
	const append = (
		id: string,
		payload: unknown = { tool: "read", args: { path: "README.md" }, ok: true, result_snippet: "Fixture workspace" },
		type = "tool_call",
	) =>
		store.db
			.prepare(
				"INSERT INTO events(event_id,run_id,phase_id,type,name,payload_json,tokens,started_at,ended_at) VALUES(?,'run-0000','phase-1',?,'Read workspace',?,12,?,?)",
			)
			.run(id, type, JSON.stringify(payload), startedAt, endedAt);
	append("event-1");
	append("event-2", { truncated: true, snippet: "The original message exceeded the trace payload limit." }, "message");
	mkdirSync(join(state, "receipts"), { recursive: true });
	writeFileSync(
		join(state, "receipts/run-0000.json"),
		JSON.stringify({
			runId: "run-0000",
			outcome: "success",
			outcomeCode: "completed",
			verification: { state: "verified", basis: "tests" },
			costUsd: 0.0024,
			tokenCount: 240,
			inputTokenCount: 200,
			outputTokenCount: 40,
			toolStats: [{ tool: "read", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 15 }],
			findingsSummary: { tags: [], findingCount: 0, firstPassSuccess: false },
			integrity: { digest: "fixture-receipt-digest" },
			clioVersion: "0.4.7",
			platform: "linux",
			nodeVersion: "24",
			lineage: { parentRunId: "parent-1" },
			output: "Full output",
			upstreamResponses: ["Response"],
			routeDecision: { agent: "coder" },
			briefing: "Full briefing",
			steering: ["Steer"],
		}),
	);
	writeFileSync(
		join(state, "evidence-index.json"),
		JSON.stringify([
			{
				runId: "run-0000",
				evidenceId: "evidence-1",
				tags: [],
				firstPassSuccess: true,
				findingCount: 0,
				generatedAt: endedAt,
			},
		]),
	);
	return {
		path,
		store,
		append,
		finish() {
			store.db.exec(
				"UPDATE runs SET status='success', ended_at='2026-09-11T12:00:06.000Z' WHERE run_id='run-0000'; UPDATE phases SET status='success', ended_at='2026-09-11T12:00:06.000Z' WHERE phase_id='phase-1'",
			);
		},
		close() {
			store.close();
		},
	};
}
