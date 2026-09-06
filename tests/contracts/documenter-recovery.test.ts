import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import {
	RESULT_COMMIT_MESSAGE_MAX_BYTES,
	RESULT_SUMMARY_DEFAULT_MAX_BYTES,
	resultContractRepairMessages,
	validateResultContract,
} from "../../src/domains/agents/result-contract.js";
import { capacityLeaseUsage } from "../../src/domains/dispatch/capacity-lease.js";
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

const TASK = "Give a 150-200 word explanation with file:line citations. Do not edit files.";
const LIMITATION =
	"Cannot deliver the requested 150-200 word cited explanation: the supplied evidence has no source lines to cite. No files were changed. A grounded explanation requires the missing source evidence.";
const report = (summary?: string, passed = true) =>
	JSON.stringify({
		mutatedPaths: [],
		validations: [{ name: "source review", passed, evidence: "Read the supplied task evidence; no command ran." }],
		...(summary === undefined ? {} : { summary }),
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
			ok(output !== undefined, "unexpected extra worker/recovery attempt");
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
const documenter = { agent: "documenter", task: TASK, intent };
const scout = { agent: "scout", task: "Identify the spacing representation.", intent };

it("gives the parent a bounded exit for an unchanged terminal Documenter report with no explanation", {
	timeout: 15_000,
}, async () => {
	const { bundle, dispatch, monitor } = setup([report()]);
	await bundle.extension.start();
	try {
		const result = await dispatch.run(documenter, {});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const run = bundle.contract.listRuns()[0];
		ok(run?.receiptPath);
		const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as RunReceipt;
		strictEqual(receipt.outcome, "succeeded");
		strictEqual(receipt.output?.text, report());
		strictEqual(receipt.quality.resultContract?.conformance, "pass");
		match(result.output, /terminal Documenter result/u);
		match(result.output, /summary/u);
		match(result.output, /do not repeatedly read/u);
		match(result.output, /report the specific limitation/u);
		const collected = await monitor.run({ mode: "collect", run_ids: [run.id] }, {});
		strictEqual(collected.kind, "ok");
		if (collected.kind === "ok") match(collected.output, /do not repeatedly read/u);
		const failedIntegrityLabels = receiptEvidenceLabels(receipt, receipt.verification, { ok: false, reason: "tampered" });
		doesNotMatch(failedIntegrityLabels.join(" "), /terminal Documenter result/u);
	} finally {
		await bundle.extension.stop?.();
	}
});

it("teaches the existing bounded summary field in the compiled recipe and repair exchange", {
	timeout: 15_000,
}, async () => {
	const { bundle, dispatch, specs } = setup([report(LIMITATION)]);
	await bundle.extension.start();
	try {
		const result = await dispatch.run(documenter, {});
		strictEqual(result.kind, "ok");
		match(specs[0]?.systemPrompt ?? "", /summary.*(?:explanation|deliverable)/u);
		match(specs[0]?.systemPrompt ?? "", /16384 UTF-8 bytes/u);
		const messages = resultContractRepairMessages(
			{ contract: { kind: "mutation-report" }, reason: "missing final result", attempt: 1, anchors: [] },
			{ provider: "fixture", api: "openai-completions", model: "fixture" },
		);
		const repair = messages[1].content[0].text;
		match(repair, /summary.*(?:explanation|deliverable)/u);
		match(repair, /summary allows at most 16384 UTF-8 bytes and commitMessage at most 1000/u);
		match(repair, /limitation/u);
		const validate = (output: string) =>
			validateResultContract({
				contract: { kind: "mutation-report" },
				output,
				cwd: process.cwd(),
				networkAllowed: false,
				filesystem: { readFile: () => null },
			});
		strictEqual(validate(report(LIMITATION)).conformance, "pass");
		strictEqual(validate(report("x".repeat(RESULT_COMMIT_MESSAGE_MAX_BYTES + 1))).conformance, "pass");
		strictEqual(validate(report("x".repeat(RESULT_SUMMARY_DEFAULT_MAX_BYTES + 1))).conformance, "fail");
		strictEqual(validate(report(LIMITATION, false)).quality, "fail");
	} finally {
		await bundle.extension.stop?.();
	}
});

it("halts a failed Scout pipeline, then settles a separate Documenter recovery without rewriting the original", {
	timeout: 15_000,
}, async () => {
	const { bundle, dispatch, monitor, specs } = setup(["invalid scout result", report(LIMITATION)]);
	await bundle.extension.start();
	try {
		const first = await dispatch.run({ mode: "pipeline", tasks: [scout, documenter] }, {});
		strictEqual(first.kind, "error");
		if (first.kind === "error") match(first.message, /halted at step 1\/2.*skipped 1/u);
		strictEqual(specs.length, 1);
		const original = bundle.contract.listRuns()[0];
		ok(original?.receiptPath);
		const before = readFileSync(original.receiptPath, "utf8");
		const recovery = await dispatch.run(
			{ ...documenter, briefing: "Independent recovery: source evidence is unavailable." },
			{},
		);
		strictEqual(recovery.kind, "ok");
		if (recovery.kind === "ok") match(recovery.output, /Cannot deliver the requested/u);
		strictEqual(readFileSync(original.receiptPath, "utf8"), before);
		strictEqual(specs.length, 2);
		const runs = bundle.contract.listRuns();
		const receipts = runs.map((run) => {
			ok(run.receiptPath);
			const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as RunReceipt;
			ok(verifyReceiptIntegrity(receipt, run).ok);
			strictEqual(receipt.lineage?.rootRunId, run.id);
			return receipt;
		});
		strictEqual(receipts.find((r) => r.agentId === "scout")?.outcome, "failed");
		strictEqual(receipts.find((r) => r.agentId === "documenter")?.outcome, "succeeded");
		const collected = await monitor.run({ mode: "collect", run_ids: runs.map((run) => run.id) }, {});
		strictEqual(collected.kind, "ok");
		if (collected.kind === "ok") {
			match(collected.output, /Cannot deliver the requested/u);
			match(collected.output, /state=failed/u);
		}
		deepStrictEqual(bundle.contract.snapshot().running, []);
		deepStrictEqual(bundle.contract.snapshot().retrying, []);
		strictEqual(capacityLeaseUsage().global, 0);
	} finally {
		await bundle.extension.stop?.();
	}
});

it("does not advance a dependent step after a conforming Documenter report with failed quality", {
	timeout: 15_000,
}, async () => {
	const { bundle, dispatch, specs } = setup([report(LIMITATION, false), report(LIMITATION)]);
	await bundle.extension.start();
	try {
		const result = await dispatch.run({ mode: "pipeline", tasks: [documenter, documenter] }, {});
		strictEqual(specs.length, 1, "failed quality must prevent dependent progression");
		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /result quality=fail.*skipped 1/u);
		const run = bundle.contract.listRuns()[0];
		ok(run?.receiptPath);
		const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as RunReceipt;
		strictEqual(receipt.outcome, "succeeded", "execution and quality remain distinct");
		strictEqual(receipt.quality.resultContract?.conformance, "pass");
		strictEqual(receipt.quality.resultContract?.quality, "fail");
		ok(verifyReceiptIntegrity(receipt, run).ok);
		deepStrictEqual(bundle.contract.snapshot().running, []);
		strictEqual(capacityLeaseUsage().global, 0);
	} finally {
		await bundle.extension.stop?.();
	}
});

it("continues passing Scout quality into the intended Documenter and delivers its bounded result", {
	timeout: 15_000,
}, async () => {
	const evidence = JSON.stringify({
		findings: [
			{ claim: "The fixture imports node assertions", path: "tests/contracts/documenter-recovery.test.ts", line: 1 },
		],
		needsSplit: false,
		proposedSubtasks: [],
	});
	const { bundle, dispatch, specs } = setup([evidence, report(LIMITATION)]);
	await bundle.extension.start();
	try {
		const result = await dispatch.run({ mode: "pipeline", tasks: [scout, documenter] }, {});
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") match(result.output, /Cannot deliver the requested/u);
		deepStrictEqual(
			specs.map((spec) => spec.agentId),
			["scout", "documenter"],
		);
		const receipts = bundle.contract.listRuns().map((run) => {
			ok(run.receiptPath);
			const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as RunReceipt;
			ok(verifyReceiptIntegrity(receipt, run).ok);
			return receipt;
		});
		const first = receipts.find((r) => r.agentId === "scout");
		const dependent = receipts.find((r) => r.agentId === "documenter");
		strictEqual(first?.quality.resultContract?.quality, "pass");
		strictEqual(dependent?.outcome, "succeeded");
		strictEqual(dependent?.quality.resultContract?.conformance, "pass");
		strictEqual(dependent?.pipeline?.fromRunId, first?.runId);
		strictEqual(dependent?.output?.text, report(LIMITATION));
		deepStrictEqual(bundle.contract.snapshot().running, []);
		strictEqual(capacityLeaseUsage().global, 0);
	} finally {
		await bundle.extension.stop?.();
	}
});

it("preserves explicit Coder and delivers its bounded explanation through the compiled recipe", {
	timeout: 15_000,
}, async () => {
	const fixture = JSON.parse(
		readFileSync(new URL("../../evals/fixtures/source-explanation.json", import.meta.url), "utf8"),
	) as { shortExplanation: string; task: string; findings: Array<{ claim: string; path: string; line: number }> };
	const explanation = fixture.findings
		.map((finding) => `${finding.claim} (${finding.path}:${finding.line})`)
		.join("\n\n");
	const { bundle, dispatch, specs } = setup([report(fixture.shortExplanation), report(explanation)]);
	await bundle.extension.start();
	try {
		for (const task of ["Explain the four supplied source excerpts briefly. Do not edit files.", fixture.task]) {
			const result = await dispatch.run({ agent: "coder", task, intent }, {});
			strictEqual(result.kind, "ok");
		}
		deepStrictEqual(
			specs.map((spec) => spec.agentId),
			["coder", "coder"],
		);
		const prompt = specs[0]?.systemPrompt ?? "";
		match(prompt, /Put the requested explanation and source citations in `summary`/u);
		match(prompt, /1200-word cited explanation fits/u);
		match(prompt, /without claiming delivery/u);
		match(prompt, /commitMessage.*at most 1000 UTF-8 bytes/u);
		for (const run of bundle.contract.listRuns()) {
			ok(run.receiptPath);
			const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as RunReceipt;
			ok(verifyReceiptIntegrity(receipt, run).ok);
			strictEqual(receipt.agentId, "coder");
			strictEqual(receipt.quality.resultContract?.conformance, "pass");
			strictEqual(receipt.output?.truncated, false);
			ok([fixture.shortExplanation, explanation].includes(JSON.parse(receipt.output?.text ?? "{}").summary));
		}
	} finally {
		await bundle.extension.stop?.();
	}
});

it("keeps failed Coder JSON sealed failed independently of terminal dispatch lifecycle", {
	timeout: 15_000,
}, async () => {
	const { bundle, dispatch, monitor, specs } = setup(['{"mutatedPaths":[],"validations":[']);
	await bundle.extension.start();
	try {
		const result = await dispatch.run({ agent: "coder", task: TASK, intent }, {});
		strictEqual(result.kind, "error");
		strictEqual(specs.length, 1);
		const run = bundle.contract.listRuns()[0];
		ok(run?.receiptPath);
		const original = readFileSync(run.receiptPath, "utf8");
		const receipt = JSON.parse(original) as RunReceipt;
		strictEqual(receipt.outcome, "failed");
		strictEqual(receipt.outcomeCode, "result_contract_exhausted");
		strictEqual(receipt.quality.resultContract?.conformance, "fail");
		ok(verifyReceiptIntegrity(receipt, run).ok);
		await monitor.run({ mode: "collect", run_ids: [run.id] }, {});
		strictEqual(readFileSync(run.receiptPath, "utf8"), original);
		deepStrictEqual(bundle.contract.snapshot().running, []);
		deepStrictEqual(bundle.contract.snapshot().retrying, []);
		strictEqual(capacityLeaseUsage().global, 0);
	} finally {
		await bundle.extension.stop?.();
	}
});
