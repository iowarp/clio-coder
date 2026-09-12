import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { toolBehaviorMetricEntriesFromJsonl } from "../../src/domains/eval/runners/clio-run.js";
import { bashTool } from "../../src/tools/bash.js";
import { readTool } from "../../src/tools/read.js";
import { webFetchToolSurface } from "../../src/tools/web-fetch-surface.js";

const corpus = JSON.parse(
	readFileSync(new URL("../../evals/fixtures/tool-arguments.json", import.meta.url), "utf8"),
) as Array<{ tool: string; arguments: Record<string, unknown>; valid: boolean }>;
const schemas: Record<string, TSchema> = {
	read: readTool.parameters,
	bash: bashTool.parameters,
	web_fetch: webFetchToolSurface.parameters,
};
function evaluate(surfaces: Record<string, TSchema>) {
	const counts: Record<string, { cases: number; rejected: number; regressions: number }> = {};
	for (const fixture of corpus) {
		const schema = surfaces[fixture.tool];
		assert.ok(schema);
		const accepted = Value.Check(schema, fixture.arguments);
		counts[fixture.tool] ??= { cases: 0, rejected: 0, regressions: 0 };
		const count = counts[fixture.tool];
		assert.ok(count);
		count.cases++;
		if (!accepted) count.rejected++;
		if (accepted !== fixture.valid) count.regressions++;
	}
	return counts;
}
test("tool-keyed argument corpus reports per-tool rejection and regression counts", (t) => {
	const counts = evaluate(schemas);
	t.diagnostic(JSON.stringify(counts));
	for (const count of Object.values(counts)) assert.deepEqual(count, { cases: 4, rejected: 3, regressions: 0 });
	// Loosening one real tool's argument boundary must move only its score.
	const broken = evaluate({ ...schemas, bash: Type.Any() });
	assert.equal(broken.bash?.regressions, 3);
	assert.deepEqual(broken.read, counts.read);
	assert.deepEqual(broken.web_fetch, counts.web_fetch);
});

test("native tool metrics separate per-tool execution errors, blocks, and successes", () => {
	const events = [
		{ type: "tool_execution_end", toolCallId: "failed", toolName: "web_fetch", isError: true },
		{ type: "clio_coder_tool_finish", payload: { toolCallId: "failed", tool: "web_fetch", outcome: "error" } },
		{ type: "clio_coder_tool_finish", payload: { toolCallId: "blocked", tool: "web_fetch", outcome: "blocked" } },
		{ type: "clio_coder_tool_finish", payload: { toolCallId: "ok", tool: "read", outcome: "ok" } },
	];
	const metrics = toolBehaviorMetricEntriesFromJsonl(
		events.map((event) => JSON.stringify(event)).join("\n"),
		process.cwd(),
	);
	assert.equal(metrics["tools.calls.web_fetch"], 2);
	assert.equal(metrics["tools.failed.web_fetch"], 1);
	assert.equal(metrics["tools.blocked.web_fetch"], 1);
	assert.equal(metrics["tools.succeeded.read"], 1);
	assert.equal(metrics["tools.failed.read"], 0);
	assert.equal(metrics["tools.calls.verify"], 0, "unobserved builtin tools retain explicit zero counts");
});
