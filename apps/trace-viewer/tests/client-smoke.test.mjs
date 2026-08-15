import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { adoptServerClock, escapeHtml, runPage } from "../public/app.js";

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

	// Every other instant on the page was stamped by the orchestrator. A live
	// span used to be measured against the browser's clock, so a machine a few
	// minutes off drew a bar that disagreed with the timestamps beside it.
	it("measures a live span against the server's clock, not the browser's", () => {
		const run = {
			run_id: "run-live",
			status: "running",
			agent: "coder",
			target: "local",
			model: "gpt",
			node: "blade",
			started_at: "2026-01-01T00:00:00.000Z",
			ended_at: null,
		};
		const phase = {
			phase_id: "p1",
			run_id: "run-live",
			seq: 0,
			name: "build",
			kind: "agent",
			owner: "coder",
			status: "running",
			attempt: 0,
			started_at: "2026-01-01T00:00:00.000Z",
			ended_at: null,
		};
		const asHeader = (iso) => new Date(iso).toUTCString();

		try {
			adoptServerClock(asHeader("2026-01-01T00:01:00.000Z"), Date.now());
			assert.match(runPage(run, [phase], [], []), /Run waterfall <small>1m 0s<\/small>/);

			// Move only the server's clock: the rendered span must follow it.
			adoptServerClock(asHeader("2026-01-01T01:01:00.000Z"), Date.now());
			assert.match(runPage(run, [phase], [], []), /Run waterfall <small>61m 0s<\/small>/);
		} finally {
			adoptServerClock(asHeader(new Date().toISOString()), Date.now());
		}
	});

	// A bare toLocaleString() renders "1/1/2026, 12:00:00 AM" in one browser and
	// something else in the next. The CLI pins its rendering; so does this.
	it("pins timestamp rendering instead of inheriting the browser locale", () => {
		const run = {
			run_id: "run-1",
			status: "success",
			agent: "coder",
			target: "local",
			model: "gpt",
			node: "blade",
			started_at: "2026-01-01T00:00:00.000Z",
			ended_at: "2026-01-01T00:01:00.000Z",
		};
		const html = runPage(run, [], [], []);
		assert.match(html, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
		assert.doesNotMatch(html, /\d{1,2}\/\d{1,2}\/\d{4}/);
		assert.doesNotMatch(html, /\b(AM|PM)\b/);
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

	it("renders tool durations, truncated payloads, and findings disagreements honestly", () => {
		const run = {
			run_id: "run-2",
			status: "fail",
			agent: "reviewer",
			target: "remote-cluster",
			model: "claude-3-7-sonnet",
			runtime: "anthropic-native",
			node: "node-c2",
			assignment_id: "dispatch-42",
			started_at: "2026-01-01T12:00:00Z",
			ended_at: "2026-01-01T12:05:00Z",
		};
		const phase = {
			phase_id: "p2",
			run_id: "run-2",
			seq: 0,
			name: "review-code",
			kind: "judge",
			owner: "reviewer",
			status: "fail",
			attempt: 0,
			started_at: "2026-01-01T12:00:00Z",
			ended_at: "2026-01-01T12:05:00Z",
		};
		const events = [
			{
				rowid: 1,
				event_id: "e10",
				run_id: "run-2",
				phase_id: "p2",
				type: "tool_call",
				name: "eval: pytest",
				payload_json: JSON.stringify({
					tool: "pytest",
					agent: "reviewer",
					ok: false,
					duration_ms: 1540,
					block_reason: "assertion failed",
				}),
				started_at: "2026-01-01T12:01:00Z",
				ended_at: "2026-01-01T12:01:02Z",
			},
			{
				rowid: 2,
				event_id: "e11",
				run_id: "run-2",
				phase_id: "p2",
				type: "log",
				name: "large output truncated",
				payload_json: JSON.stringify({
					truncated: true,
					snippet: "output line 1... output line 2...",
				}),
				started_at: "2026-01-01T12:02:00Z",
				ended_at: null,
			},
		];
		const processes = [
			{
				kind: "eval",
				name: "pytest worker",
				pid: 8812,
				command: "pytest tests/suite -v",
				started_at: "2026-01-01T12:00:00Z",
				ended_at: null, // live process
			},
		];
		const receipt = {
			outcome: "fail",
			costUsd: 1.25,
			findingsSummary: {
				tags: ["security", "linter"],
				findingCount: 3,
				firstPassSuccess: false,
			},
			integrity: { digest: "abcdef0123456789" },
		};
		const evidence = {
			runId: "run-2",
			evidenceId: "ev-99",
			findingCount: 3,
			firstPassSuccess: true, // disagrees with receipt!
		};

		const html = runPage(run, [phase], events, [], "p2", processes, receipt, evidence);

		// Verified chips
		assert.match(html, /remote-cluster/);
		assert.match(html, /anthropic-native/);
		assert.match(html, /dispatch-42/);
		assert.match(html, /node-c2/);

		// Tool took formatting
		assert.match(html, /pytest/);
		assert.match(html, /1\.5s/);
		assert.match(html, /assertion failed/);

		// Truncation notice honesty
		assert.match(html, /payload exceeded the trace limit; snippet only/);

		// Process live indicator
		assert.match(html, /pytest worker/);
		assert.match(html, /8812/);
		assert.match(html, /live/);

		// Findings disagreement honesty
		assert.match(html, /first pass \(receipt\)/);
		assert.match(html, /first pass \(evidence\)/);
		assert.doesNotMatch(html, /undefined/);
	});

	it("formats zero cost truthfully as $0.00 and sub-cent amounts with 4 decimal places", () => {
		const run = {
			run_id: "run-cost",
			status: "success",
			agent: "coder",
			target: "local",
			model: "gpt",
			started_at: "2026-01-01T00:00:00Z",
		};
		const phaseZero = {
			phase_id: "p0",
			run_id: "run-cost",
			seq: 0,
			name: "zero",
			kind: "agent",
			owner: "coder",
			status: "success",
			attempt: 0,
			started_at: "2026-01-01T00:00:00Z",
			ended_at: "2026-01-01T00:00:01Z",
			total_tokens: 0,
			total_cost_usd: 0,
			input_tokens: 0,
			input_cost_usd: 0,
			output_tokens: 0,
			output_cost_usd: 0,
			cache_read_tokens: 0,
			cache_read_cost_usd: 0,
			cache_write_tokens: 0,
			cache_write_cost_usd: 0,
		};
		const phaseSubcent = {
			phase_id: "p1",
			run_id: "run-cost",
			seq: 1,
			name: "subcent",
			kind: "agent",
			owner: "coder",
			status: "success",
			attempt: 0,
			started_at: "2026-01-01T00:00:01Z",
			ended_at: "2026-01-01T00:00:02Z",
			total_tokens: 100,
			total_cost_usd: 0.0036,
			input_tokens: 80,
			input_cost_usd: 0.0024,
			output_tokens: 20,
			output_cost_usd: 0.0012,
		};

		const htmlZero = runPage(run, [phaseZero], [], []);
		assert.match(htmlZero, /\$0\.00/);
		assert.doesNotMatch(htmlZero, /\$0\.0000/);
		assert.match(htmlZero, /<span class="status-badge success">success<\/span>/);

		const htmlSubcent = runPage(run, [phaseSubcent], [], []);
		assert.match(htmlSubcent, /\$0\.0036/);
		assert.match(htmlSubcent, /\$0\.0024/);
		assert.match(htmlSubcent, /\$0\.0012/);
	});
});
