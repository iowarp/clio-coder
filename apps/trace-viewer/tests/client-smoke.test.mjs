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
});
