import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import {
	parseResultContract,
	parseWorkerResultContract,
	RESULT_COMMIT_MESSAGE_MAX_BYTES,
	RESULT_SUMMARY_DEFAULT_MAX_BYTES,
	RESULT_SUMMARY_MAX_BYTES_CEILING,
	resultContractAuthorship,
	resultContractOutputBytes,
	resultContractRepairMessages,
	resultContractShape,
	resultContractSourceId,
	validateResultContract,
} from "../../src/domains/agents/result-contract.js";
import {
	createWorkerOutputCapture,
	WORKER_OUTPUT_MAX_BYTES,
	workerOutputCaptureBytes,
} from "../../src/domains/dispatch/event-pump.js";
import { dispatchResultContract } from "../../src/domains/dispatch/execution-role.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import { receiptEvidenceLabels } from "../../src/tools/worker-evidence.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

beforeEach(() => isolateDispatchState());
afterEach(() => restoreDispatchState());

const fixture = JSON.parse(
	readFileSync(new URL("../../evals/fixtures/source-explanation.json", import.meta.url), "utf8"),
) as { task: string; findings: Array<{ claim: string; path: string; line: number }> };

/**
 * The #361 deliverable as an explicit Coder would author it: the fixture's
 * 1200 cited words, one paragraph per source claim, each closed by the
 * file:line it rests on. Larger than the old 8 KB receipt bound on purpose.
 */
const EXPLANATION = [
	"Uniform versus nonuniform boundary stencils in findiff, with the accuracy tests that exercise each. Citations are file:line in the four authorized sources.",
	...fixture.findings.map(
		(finding, index) => `Stencil note ${index + 1}. ${finding.claim} (${finding.path}:${finding.line})`,
	),
	"Taken together, the uniform path scales fixed offset weights by spacing while the nonuniform path solves coordinate-dependent weights, and only the uniform refinement tests measure boundary convergence directly.",
].join("\n\n");

const report = (summary: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		mutatedPaths: [],
		validations: [{ name: "source read", passed: true, evidence: "Read only the four requested files; no tests ran." }],
		summary,
		...extra,
	});

const validate = (
	output: string,
	contract: Parameters<typeof validateResultContract>[0]["contract"],
	truncated = false,
) =>
	validateResultContract({
		contract,
		output,
		cwd: process.cwd(),
		networkAllowed: false,
		filesystem: { readFile: () => null },
		outputTruncated: truncated,
	});

const MUTATION = { kind: "mutation-report" } as const;
const coderRecipe = { resultContract: MUTATION };
const scoutRecipe = { resultContract: { kind: "scout-report" } as const };

it("bounds summary by its own allowance and commitMessage by the commit bound", () => {
	ok(Buffer.byteLength(EXPLANATION, "utf8") > RESULT_COMMIT_MESSAGE_MAX_BYTES);
	strictEqual(validate(report(EXPLANATION), MUTATION).conformance, "pass");
	const authored = resultContractAuthorship(MUTATION, report(EXPLANATION));
	strictEqual(authored.summary, EXPLANATION);
	for (const path of ["findiff/coefs.py:67", "tests/test_coefs.py"]) ok(authored.summary?.includes(path));
	const overDefault = validate(report("x".repeat(RESULT_SUMMARY_DEFAULT_MAX_BYTES + 1)), MUTATION);
	strictEqual(overDefault.conformance, "fail");
	match(
		overDefault.reason ?? "",
		new RegExp(`summary must be at most ${RESULT_SUMMARY_DEFAULT_MAX_BYTES} UTF-8 bytes`, "u"),
	);
	const longCommit = validate(
		report("fine", { commitMessage: "x".repeat(RESULT_COMMIT_MESSAGE_MAX_BYTES + 1) }),
		MUTATION,
	);
	strictEqual(longCommit.conformance, "fail");
	match(longCommit.reason ?? "", /commitMessage must be at most 1000 UTF-8 bytes/u);
	// A declared allowance narrows or widens summary only.
	const narrow = { kind: "mutation-report", maxSummaryBytes: 2_048 } as const;
	strictEqual(validate(report(EXPLANATION), narrow).conformance, "fail");
	match(validate(report(EXPLANATION), narrow).reason ?? "", /summary must be at most 2048 UTF-8 bytes/u);
	strictEqual(validate(report("x".repeat(2_048)), narrow).conformance, "pass");
	match(resultContractShape(narrow), /summary allows at most 2048 UTF-8 bytes and commitMessage at most 1000/u);
	match(resultContractShape(MUTATION), /summary allows at most 16384 UTF-8 bytes/u);
	// Identity: the default digests exactly as before; an explicit allowance is a distinct contract.
	strictEqual(resultContractSourceId(MUTATION), resultContractSourceId({ kind: "mutation-report" }));
	ok(resultContractSourceId(narrow) !== resultContractSourceId(MUTATION));
	ok(resultContractSourceId(narrow).startsWith("agent-result-contract:mutation-report:"));
});

it("keeps architect-plan authorship at the commit bound; the allowance is mutation-report only", () => {
	const architect = { kind: "architect-plan", path: "docs/plan.md" } as const;
	const fits = JSON.stringify({ commitMessage: "plan", summary: "y".repeat(RESULT_COMMIT_MESSAGE_MAX_BYTES) });
	strictEqual(resultContractAuthorship(architect, fits).summary, "y".repeat(RESULT_COMMIT_MESSAGE_MAX_BYTES));
	const over = JSON.stringify({ commitMessage: "plan", summary: "y".repeat(RESULT_COMMIT_MESSAGE_MAX_BYTES + 1) });
	deepStrictEqual(resultContractAuthorship(architect, over), { commitMessage: null, summary: null });
	strictEqual(resultContractOutputBytes(architect), null);
	strictEqual(workerOutputCaptureBytes(architect), WORKER_OUTPUT_MAX_BYTES);
	strictEqual(resultContractAuthorship(MUTATION, over).summary, "y".repeat(RESULT_COMMIT_MESSAGE_MAX_BYTES + 1));
});

it("parses the allowance from recipe frontmatter and the wire, rejecting out-of-range values", () => {
	deepStrictEqual(parseResultContract({ kind: "mutation-report" }, "r.md"), { kind: "mutation-report" });
	deepStrictEqual(parseResultContract({ kind: "mutation-report", maxSummaryBytes: 4_096 }, "r.md"), {
		kind: "mutation-report",
		maxSummaryBytes: 4_096,
	});
	deepStrictEqual(parseWorkerResultContract({ kind: "mutation-report", maxSummaryBytes: 4_096 }, "spec"), {
		kind: "mutation-report",
		maxSummaryBytes: 4_096,
	});
	for (const bad of [0, -1, 1.5, RESULT_SUMMARY_MAX_BYTES_CEILING + 1, "4096", null]) {
		throws(
			() => parseResultContract({ kind: "mutation-report", maxSummaryBytes: bad }, "r.md"),
			new RegExp(`r\\.md: maxSummaryBytes must be an integer between 1 and ${RESULT_SUMMARY_MAX_BYTES_CEILING}`, "u"),
		);
	}
	throws(
		() => parseResultContract({ kind: "mutation-report", summaryBytes: 1 }, "r.md"),
		/admits only kind and maxSummaryBytes/u,
	);
	throws(() => parseResultContract({ kind: "scout-report", maxSummaryBytes: 1 }, "r.md"), /unknown keys/u);
});

it("resolves one applied contract from recipe default, task override, and topology ownership", () => {
	const base = { agentId: "coder" };
	deepStrictEqual(dispatchResultContract(base, coderRecipe), MUTATION);
	deepStrictEqual(dispatchResultContract({ ...base, resultSummary: { maxBytes: 20_000, scope: "task" } }, coderRecipe), {
		kind: "mutation-report",
		maxSummaryBytes: 20_000,
	});
	deepStrictEqual(
		dispatchResultContract({ ...base, resultSummary: { maxBytes: 20_000, scope: "batch" } }, coderRecipe),
		{
			kind: "mutation-report",
			maxSummaryBytes: 20_000,
		},
	);
	// A batch default inherited by a non-mutation step is not that step's setting.
	deepStrictEqual(
		dispatchResultContract({ agentId: "scout", resultSummary: { maxBytes: 20_000, scope: "batch" } }, scoutRecipe),
		scoutRecipe.resultContract,
	);
	// An explicit per-task setting on a recipe with no summary is a caller error.
	throws(
		() => dispatchResultContract({ agentId: "scout", resultSummary: { maxBytes: 20_000, scope: "task" } }, scoutRecipe),
		/result_summary_max_bytes applies only to a mutation-report result contract; agent 'scout' declares scout-report/u,
	);
	// Topology-owned contracts ignore it: a gate role has none, a coordinator override keeps its kind.
	strictEqual(
		dispatchResultContract(
			{ agentId: "coder", gate: { role: "judge" }, resultSummary: { maxBytes: 1, scope: "task" } },
			coderRecipe,
		),
		undefined,
	);
	deepStrictEqual(
		dispatchResultContract(
			{
				agentId: "coder",
				resultContractOverride: { kind: "council-ballot" },
				resultSummary: { maxBytes: 1, scope: "task" },
			},
			coderRecipe,
		),
		{ kind: "council-ballot" },
	);
	deepStrictEqual(
		dispatchResultContract(
			{
				agentId: "documenter",
				resultContractOverride: { kind: "artifact-report" },
				resultSummary: { maxBytes: 1, scope: "task" },
			},
			coderRecipe,
		),
		{ kind: "artifact-report" },
	);
	// The override applies to a coordinator-authored mutation report as well.
	deepStrictEqual(
		dispatchResultContract(
			{ agentId: "coder", resultContractOverride: MUTATION, resultSummary: { maxBytes: 9_000, scope: "task" } },
			null,
		),
		{ kind: "mutation-report", maxSummaryBytes: 9_000 },
	);
	throws(() =>
		dispatchResultContract(
			{ ...base, resultSummary: { maxBytes: RESULT_SUMMARY_MAX_BYTES_CEILING + 1, scope: "task" } },
			coderRecipe,
		),
	);
});

it("seals a conforming report larger than the receipt floor without truncation, and names the bound when it overflows", () => {
	const output = report(EXPLANATION);
	ok(Buffer.byteLength(output, "utf8") > WORKER_OUTPUT_MAX_BYTES, "the fixture must exceed the old receipt bound");
	strictEqual(workerOutputCaptureBytes({ kind: "scout-report" }), WORKER_OUTPUT_MAX_BYTES);
	strictEqual(workerOutputCaptureBytes(null), WORKER_OUTPUT_MAX_BYTES);
	strictEqual(workerOutputCaptureBytes(MUTATION), resultContractOutputBytes(MUTATION));
	strictEqual(
		resultContractOutputBytes(MUTATION),
		2 * RESULT_SUMMARY_DEFAULT_MAX_BYTES + 2 * RESULT_COMMIT_MESSAGE_MAX_BYTES + 4_096,
	);
	const message = { type: "message_end", message: { role: "assistant", content: output, stopReason: "stop" } };
	const floor = createWorkerOutputCapture();
	floor.observe(message);
	strictEqual(floor.snapshot()?.truncated, true);
	const sized = createWorkerOutputCapture({ maxBytes: workerOutputCaptureBytes(MUTATION) });
	sized.observe(message);
	deepStrictEqual(sized.snapshot(), {
		state: "final",
		text: output,
		bytes: Buffer.byteLength(output, "utf8"),
		truncated: false,
	});
	// Streamed deltas accumulate under the same bound.
	const streamed = createWorkerOutputCapture({ maxBytes: workerOutputCaptureBytes(MUTATION) });
	for (let offset = 0; offset < output.length; offset += 1_000) {
		streamed.observe({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: output.slice(offset, offset + 1_000) },
		});
	}
	strictEqual(streamed.snapshot()?.state, "partial");
	strictEqual(streamed.snapshot()?.truncated, false);
	streamed.observe(message);
	strictEqual(streamed.snapshot()?.text, output);
	// The bound never drops below the floor, and a clipped result fails with the bound named.
	strictEqual(createWorkerOutputCapture({ maxBytes: 10 }).snapshot(), undefined);
	const clipped = floor.snapshot();
	ok(clipped);
	const overflow = validate(clipped.text, MUTATION, true);
	strictEqual(overflow.conformance, "fail");
	match(
		overflow.reason ?? "",
		/result exceeded the sealed output bound of \d+ bytes and was truncated; keep summary within 16384 UTF-8 bytes/u,
	);
	// The same clipped text without the truncation fact is still just invalid JSON.
	match(validate(clipped.text, MUTATION).reason ?? "", /valid JSON/u);
	// A truncated result fails even when its head parses as a complete report.
	const parsable = validate(report("short"), MUTATION, true);
	strictEqual(parsable.conformance, "fail");
	match(parsable.reason ?? "", /exceeded the sealed output bound/u);
	// Repair rounds quote the effective allowance.
	const repair = resultContractRepairMessages(
		{
			contract: { kind: "mutation-report", maxSummaryBytes: 2_048 },
			reason: "missing final result",
			attempt: 1,
			anchors: [],
		},
		{ provider: "fixture", api: "openai-completions", model: "fixture" },
	)[1].content[0].text;
	match(repair, /summary allows at most 2048 UTF-8 bytes/u);
});

function setup(outputs: readonly string[]) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	settings.safety.autonomy = "full-auto";
	const context = dispatchStubContext({ settings });
	const agents = context.getContract<AgentsContract>("agents");
	ok(agents);
	const specs: WorkerSpec[] = [];
	const bundle = makeDispatchBundle(context, {
		spawnWorker: (spec) => {
			const output = outputs[specs.length];
			ok(output !== undefined, "unexpected extra worker attempt");
			specs.push(spec);
			return {
				pid: null,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				events: (async function* () {
					yield { type: "message_end", message: { role: "assistant", content: output, stopReason: "stop" } };
				})(),
				abort: () => {},
				heartbeatAt: { current: Date.now() },
			};
		},
	});
	const dispatch = createDispatchTool({
		dispatch: bundle.contract,
		bus: context.bus,
		getAgentSpecs: () => agents.listSpecs(),
		getAutonomy: () => "full-auto",
	});
	const monitor = createMonitorTool({ dispatch: bundle.contract });
	return { bundle, dispatch, monitor, specs };
}

const intent = { read_roots: ["."], write_roots: [] };

/** The integrity-verified receipt whose sealed output is exactly `text`. */
function sealedReceipt(bundle: ReturnType<typeof setup>["bundle"], text: string): RunReceipt {
	for (const run of bundle.contract.listRuns()) {
		if (!run.receiptPath) continue;
		const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as RunReceipt;
		if (receipt.output?.text !== text) continue;
		ok(verifyReceiptIntegrity(receipt, run).ok);
		return receipt;
	}
	throw new Error("no sealed receipt carries the expected output");
}

it("round-trips a 1200-word cited Coder explanation through dispatch, the receipt, and collect", {
	timeout: 15_000,
}, async () => {
	const output = report(EXPLANATION);
	const { bundle, dispatch, monitor, specs } = setup([output]);
	await bundle.extension.start();
	try {
		const result = await dispatch.run({ agent: "coder", task: fixture.task, intent }, {});
		strictEqual(result.kind, "ok");
		deepStrictEqual(specs[0]?.resultContract, MUTATION);
		const receipt = sealedReceipt(bundle, output);
		strictEqual(receipt.outcome, "succeeded");
		strictEqual(receipt.exitCode, 0);
		strictEqual(receipt.quality.resultContract?.conformance, "pass");
		strictEqual(receipt.quality.resultContract?.sourceId, resultContractSourceId(MUTATION));
		deepStrictEqual(receipt.output, {
			state: "final",
			text: output,
			bytes: Buffer.byteLength(output, "utf8"),
			truncated: false,
		});
		strictEqual(JSON.parse(receipt.output?.text ?? "{}").summary, EXPLANATION);
		strictEqual(receipt.toolActivity?.mutatingSucceeded, false);
		if (result.kind !== "ok") return;
		// The dispatch return carries the whole report under the default preview limit.
		ok(result.output.includes("Stencil note 10."));
		const run = bundle.contract.listRuns()[0];
		ok(run);
		const collected = await monitor.run({ mode: "collect", run_ids: [run.id] }, {});
		strictEqual(collected.kind, "ok");
		if (collected.kind !== "ok") return;
		match(collected.output, /preview clipped at 2000 bytes; the complete sealed text is output\.text in .*\.json/u);
		ok(!collected.output.includes("stored output truncated"));
	} finally {
		await bundle.extension.stop?.();
	}
});

it("applies a per-dispatch allowance to the worker spec, the seal, and its identity, and fails an over-bound summary honestly", {
	timeout: 15_000,
}, async () => {
	const narrow = { kind: "mutation-report", maxSummaryBytes: 512 } as const;
	const over = report("x".repeat(600));
	const within = report("x".repeat(500));
	const { bundle, dispatch, specs } = setup([over, within]);
	await bundle.extension.start();
	try {
		const failed = await dispatch.run({ agent: "coder", task: fixture.task, intent, result_summary_max_bytes: 512 }, {});
		strictEqual(failed.kind, "error");
		deepStrictEqual(specs[0]?.resultContract, narrow);
		const failedReceipt = sealedReceipt(bundle, over);
		strictEqual(failedReceipt.outcome, "failed");
		strictEqual(failedReceipt.outcomeCode, "result_contract_exhausted");
		match(failedReceipt.outcomeDetail ?? "", /summary must be at most 512 UTF-8 bytes \(600 given\)/u);
		strictEqual(failedReceipt.quality.resultContract?.conformance, "fail");
		strictEqual(failedReceipt.quality.resultContract?.sourceId, resultContractSourceId(narrow));
		const passed = await dispatch.run({ agent: "coder", task: fixture.task, intent, result_summary_max_bytes: 512 }, {});
		strictEqual(passed.kind, "ok");
		const passedReceipt = sealedReceipt(bundle, within);
		strictEqual(passedReceipt.outcome, "succeeded");
		strictEqual(passedReceipt.quality.resultContract?.conformance, "pass");
		strictEqual(passedReceipt.quality.resultContract?.sourceId, resultContractSourceId(narrow));
	} finally {
		await bundle.extension.stop?.();
	}
});

it("rejects an invalid allowance at the tool boundary and an explicit allowance on a recipe without a summary before any worker starts", {
	timeout: 15_000,
}, async () => {
	const { bundle, dispatch, specs } = setup([]);
	await bundle.extension.start();
	try {
		for (const bad of [0, RESULT_SUMMARY_MAX_BYTES_CEILING + 1, 1.5, "2048"]) {
			const result = await dispatch.run({ agent: "coder", task: fixture.task, intent, result_summary_max_bytes: bad }, {});
			strictEqual(result.kind, "error");
			if (result.kind === "error")
				match(result.message, /result_summary_max_bytes must be an integer between 1 and 32768/u);
		}
		const scout = await dispatch.run(
			{ agent: "scout", task: "Map the spacing code.", intent, result_summary_max_bytes: 2_048 },
			{},
		);
		strictEqual(scout.kind, "error");
		if (scout.kind === "error")
			match(scout.message, /applies only to a mutation-report result contract; agent 'scout' declares scout-report/u);
		strictEqual(specs.length, 0);
		deepStrictEqual(
			bundle.contract.listRuns().filter((run) => run.receiptPath !== undefined),
			[],
		);
	} finally {
		await bundle.extension.stop?.();
	}
});

it("lets a batch-level allowance reach the mutation-report member while a scout member ignores it", {
	timeout: 15_000,
}, async () => {
	const scoutReport = JSON.stringify({
		findings: [{ claim: "coords holds three coordinates" }],
		needsSplit: false,
		proposedSubtasks: [],
	});
	const { bundle, dispatch, specs } = setup([scoutReport, report("x".repeat(700))]);
	await bundle.extension.start();
	try {
		const result = await dispatch.run(
			{
				tasks: [
					{ agent: "scout", task: "Map the spacing code.", intent },
					{ agent: "coder", task: fixture.task, intent },
				],
				result_summary_max_bytes: 4_096,
			},
			{},
		);
		strictEqual(result.kind, "ok");
		const byAgent = new Map(specs.map((spec) => [spec.agentId, spec.resultContract]));
		deepStrictEqual(byAgent.get("scout"), { kind: "scout-report" });
		deepStrictEqual(byAgent.get("coder"), { kind: "mutation-report", maxSummaryBytes: 4_096 });
	} finally {
		await bundle.extension.stop?.();
	}
});

it("labels a Documenter summary above the default allowance as the inline deliverable", {
	timeout: 15_000,
}, async () => {
	const summary = `${"Grounded explanation. ".repeat(800)}(grid.py:1)`;
	ok(Buffer.byteLength(summary, "utf8") > RESULT_SUMMARY_DEFAULT_MAX_BYTES);
	const output = report(summary);
	const { bundle, dispatch } = setup([output]);
	await bundle.extension.start();
	try {
		const result = await dispatch.run(
			{
				agent: "documenter",
				task: "Explain grid.py in depth. Do not edit files.",
				intent,
				result_summary_max_bytes: 20_000,
			},
			{},
		);
		strictEqual(result.kind, "ok");
		const receipt = sealedReceipt(bundle, output);
		strictEqual(receipt.quality.resultContract?.conformance, "pass");
		const labels = receiptEvidenceLabels(receipt, receipt.verification, { ok: true });
		ok(
			labels.some((label) => label.includes("the inline deliverable or limitation is in output.text JSON field summary")),
		);
		ok(!labels.some((label) => label.includes("no inline summary is available")));
	} finally {
		await bundle.extension.stop?.();
	}
});
