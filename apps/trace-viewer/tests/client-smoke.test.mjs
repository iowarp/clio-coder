import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { escapeHtml, runPage } from "../public/app.js";

describe("trace viewer client", () => {
	it("renders waterfall, tool span, gate evidence, attempts, and truthful missing spend", () => {
		const run = {
			run_id: "run-<1>",
			status: "success",
			agent: "coder",
			target: "local",
			model: "gpt",
			node: null,
			started_at: "2026-01-01T00:00:00Z",
		};
		const phase = {
			phase_id: "p1",
			run_id: "run-1",
			seq: 0,
			name: "build",
			kind: "agent",
			owner: "coder",
			status: "success",
			attempt: 1,
			started_at: "2026-01-01T00:00:00Z",
			ended_at: "2026-01-01T00:00:02Z",
			input_tokens: 10,
			output_tokens: 5,
			reasoning_tokens: 2,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			total_tokens: 15,
			total_cost_usd: 0.01,
			input_cost_usd: null,
			output_cost_usd: null,
			cache_read_cost_usd: null,
			cache_write_cost_usd: null,
		};
		const event = {
			rowid: 1,
			event_id: "e1",
			run_id: "run-1",
			phase_id: "p1",
			type: "tool_call",
			name: "bash: npm test",
			payload_json: JSON.stringify({ args: { command: "npm test" }, result_snippet: "ok", ok: true }),
			started_at: "2026-01-01T00:00:00.500Z",
			ended_at: "2026-01-01T00:00:01Z",
		};
		const gate = {
			phase_id: "p1",
			gate: "review",
			checks_json: JSON.stringify([{ item: "tests", ok: true, note: "passed" }]),
		};
		const html = runPage(run, [phase], [event], [gate]);
		for (const expected of [
			"Run waterfall",
			"bash: npm test",
			"tests",
			"passed",
			"try 2",
			"not recorded",
			"reasoning ⊂ output",
		])
			assert.match(html, new RegExp(expected));
		assert.match(html, /run-&lt;1&gt;/);
		assert.equal(escapeHtml('<script>"'), "&lt;script&gt;&quot;");
	});

	it("renders the task request, phase facts, every event type, gate violations, processes, and the receipt panel", () => {
		const run = {
			run_id: "run-1",
			request: "fix the <script>alert(1)</script> bug",
			status: "success",
			agent: "coder",
			target: "local",
			model: "gpt",
			runtime: "native",
			node: "blade",
			assignment_id: "assign-1",
			started_at: "2026-01-01T00:00:00Z",
			ended_at: "2026-01-01T00:01:00Z",
		};
		const phase = {
			phase_id: "p1",
			run_id: "run-1",
			seq: 0,
			name: "build",
			kind: "agent",
			owner: "coder",
			description: "compile the widget",
			status: "fail",
			attempt: 1,
			retries: 2,
			error: "widget did not compile: <script>bad()</script>",
			started_at: "2026-01-01T00:00:00Z",
			ended_at: "2026-01-01T00:00:05Z",
			total_tokens: 15,
			total_cost_usd: 0.01,
		};
		const events = [
			{
				rowid: 1,
				event_id: "e1",
				run_id: "run-1",
				phase_id: "p1",
				type: "agent_end",
				name: "coder finished",
				payload_json: JSON.stringify({ outcome: "fail", status: "fail", error: "boom" }),
				started_at: "2026-01-01T00:00:01Z",
				ended_at: "2026-01-01T00:00:02Z",
			},
			{
				rowid: 2,
				event_id: "e2",
				run_id: "run-1",
				phase_id: "p1",
				type: "handoff",
				name: "handed off",
				payload_json: JSON.stringify({ attempt: 2, status: "retry", reason: "gate failed" }),
				started_at: "2026-01-01T00:00:02Z",
				ended_at: null,
			},
		];
		const gates = [
			{
				phase_id: "p1",
				gate: "review",
				attempt: 1,
				passed: 0,
				created_at: "2026-01-01T00:00:03Z",
				violations_json: JSON.stringify(["missing tests", "<script>xss</script>"]),
				checks_json: JSON.stringify([{ item: "tests", ok: false, note: "no tests found" }]),
			},
		];
		const processes = [
			{
				kind: "shell",
				name: "npm test",
				pid: 4242,
				command: "npm test -- --watch=false",
				started_at: "2026-01-01T00:00:00Z",
				ended_at: "2026-01-01T00:00:04Z",
			},
		];
		const receipt = {
			outcome: "fail",
			outcomeCode: "gate_failed",
			verification: { state: "unverified", basis: "no grounding scope" },
			costUsd: 0.42,
			toolStats: [{ tool: "bash", count: 3, ok: 2, errors: 1, blocked: 0, totalDurationMs: 1200 }],
			safety: { blockedCommands: 1 },
			clioVersion: "0.3.0",
		};
		const evidence = { runId: "run-1", evidenceId: "ev-1", findingCount: 1, firstPassSuccess: false };

		const html = runPage(run, [phase], events, gates, "p1", processes, receipt, evidence);

		assert.match(html, /fix the/);
		assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

		assert.match(html, /widget did not compile/);
		assert.match(html, /compile the widget/);

		assert.match(html, /agent_end/);
		assert.match(html, /handoff/);
		assert.match(html, /gate failed/);

		assert.match(html, /missing tests/);
		assert.doesNotMatch(html, /<script>xss<\/script>/);

		assert.match(html, /npm test -- --watch=false/);
		assert.match(html, /4242/);

		assert.match(html, /Receipt/);
		assert.match(html, /gate_failed|fail/);
		assert.match(html, /unverified/);
		assert.match(html, /bash/);
		assert.match(html, /1200ms|1\.2s/);

		assert.doesNotMatch(html, /undefined/);
	});

	it("renders an honest fallback line when no receipt exists, without the word 'undefined'", () => {
		const run = {
			run_id: "run-1",
			status: "success",
			agent: "coder",
			target: "local",
			model: "gpt",
			node: "blade",
			started_at: "2026-01-01T00:00:00Z",
		};
		const phase = {
			phase_id: "p1",
			run_id: "run-1",
			seq: 0,
			name: "build",
			kind: "agent",
			owner: "coder",
			status: "success",
			attempt: 0,
			started_at: "2026-01-01T00:00:00Z",
			ended_at: "2026-01-01T00:00:01Z",
		};
		const html = runPage(run, [phase], [], [], "p1", [], null, null);
		assert.match(html, /No sealed receipt was found for this run\./);
		assert.doesNotMatch(html, /undefined/);
	});
});
