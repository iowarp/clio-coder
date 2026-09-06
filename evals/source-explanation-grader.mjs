import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const fixture = JSON.parse(readFileSync(new URL("./fixtures/source-explanation.json", import.meta.url), "utf8"));

// A bounded content screen, not a semantic judge. Root must still review the
// cited claims. In particular, schema success and pane lifecycle are not delivery.
export function assessExplanation(agentId, output, conformance) {
	let value;
	try {
		value = JSON.parse(output);
	} catch {
		value = {};
	}
	const findings = Array.isArray(value.findings) ? value.findings : [];
	const prose = agentId === "scout" ? findings.map((finding) => finding.claim ?? "").join(" ") : (value.summary ?? "");
	const words = typeof prose === "string" && prose.trim() ? prose.trim().split(/\s+/u).length : 0;
	const cited = Object.keys(fixture.files).every((path) =>
		findings.some((finding) => finding.path === path && Number.isSafeInteger(finding.line) && finding.line > 0),
	);
	const topics = [
		/uniform/iu,
		/nonuniform/iu,
		/forward/iu,
		/backward/iu,
		/spacing/iu,
		/coordinate/iu,
		/convergence/iu,
		/linspace|equidistant/iu,
		/does not|do not|not .*irregular/iu,
	].every((pattern) => pattern.test(prose));
	const suitable = agentId === "scout";
	const limited = agentId === "coder" && /cannot deliver/iu.test(prose) && /1000/iu.test(prose);
	return {
		"explanation.recipeSuitable": suitable,
		"explanation.conforms": conformance === "pass",
		"explanation.delivered":
			conformance === "pass" &&
			suitable &&
			cited &&
			topics &&
			words >= fixture.wordRange[0] &&
			words <= fixture.wordRange[1],
		"explanation.limited": limited,
		"explanation.words": words,
	};
}

function prepare() {
	for (const path of Object.keys(fixture.files)) assert.ok(!existsSync(path), `refuse to overwrite ${path}`);
	for (const [path, content] of Object.entries(fixture.files)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
}

async function grade(agentId) {
	assert.ok(agentId === "coder" || agentId === "scout");
	const events = readFileSync(process.env.CLIO_CODER_EVAL_RUNNER_STDOUT_FILE, "utf8")
		.split(/\r?\n/u)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
	const starts = events.filter((event) => event.type === "tool_execution_start" && event.toolName === "dispatch");
	assert.equal(starts.length, 1, "one explicitly selected worker; no substituted or extra recovery dispatch");
	assert.equal(starts[0].args.agent, agentId);
	assert.equal(starts[0].args.task, fixture.task);
	const end = events.find((event) => event.type === "tool_execution_end" && event.toolCallId === starts[0].toolCallId);
	const runs = end?.result?.details?.runs;
	assert.equal(runs?.length, 1, "one terminal receipt required");
	const receipt = JSON.parse(readFileSync(runs[0].receiptPath, "utf8"));
	assert.equal(receipt.agentId, agentId);
	const metrics = assessExplanation(agentId, receipt.output?.text ?? "", receipt.quality?.resultContract?.conformance);
	if (
		receipt.outcome !== "succeeded" ||
		receipt.exitCode !== 0 ||
		receipt.quality?.resultContract?.quality === "fail" ||
		receipt.output?.state !== "final" ||
		receipt.output?.truncated !== false
	)
		metrics["explanation.delivered"] = false;
	metrics["task.solved"] = metrics["explanation.delivered"];
	process.stdout.write(`${JSON.stringify({ schema: "clio-coder.eval.measure.v1", metrics })}\n`);
	assert.equal(receipt.outcome, "succeeded");
	assert.equal(receipt.exitCode, 0);
	assert.equal(receipt.output?.state, "final");
	assert.equal(receipt.output?.truncated, false, "a truncated report is not complete delivery");
	assert.equal(metrics["explanation.conforms"], true);
	assert.notEqual(receipt.quality?.resultContract?.quality, "fail");
	assert.equal(metrics["explanation.recipeSuitable"], agentId === "scout");
	assert.equal(metrics["explanation.delivered"], agentId === "scout");
	assert.equal(metrics["explanation.limited"], agentId === "coder");
	for (const [path, content] of Object.entries(fixture.files)) assert.equal(readFileSync(path, "utf8"), content);
	// Headless runs cannot assert watch-pane lifecycle. Root records it separately.
	assert.ok(metrics["task.solved"], "explicit Coder reported an honest limitation; the requested task remains unsolved");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv[2] === "--prepare") prepare();
		else await grade(process.argv[2]);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 1;
	}
}
