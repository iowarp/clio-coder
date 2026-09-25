import { deepStrictEqual, notStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import {
	INTERNAL_HELPER_RESULT_KINDS,
	type InternalHelperResultKind,
	internalHelperResultSchema,
	validateStructuredHelperResult,
} from "../../src/domains/agents/result-contract.js";
import { createWorkerOutputCapture } from "../../src/domains/dispatch/event-pump.js";
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { approvedIdentityForSpec } from "../../src/domains/dispatch/worker-protocol.js";
import { attestedToolSignature } from "../../src/engine/worker-tools.js";
import { parseWorkerSpec } from "../../src/worker/spec-contract.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const evidence = {
	cwd: "/repo",
	networkAllowed: false,
	filesystem: { readFile: (path: string) => (path === "/repo/source.ts" ? "export const answer = 42;\n" : null) },
	observedReadRanges: new Map([["/repo/source.ts", [[1, 1] as const]]]),
};
const samples: Record<InternalHelperResultKind, Record<string, unknown>> = {
	"scout-report": {
		findings: [{ claim: "Exports answer", path: "source.ts", line: 1 }],
		needsSplit: false,
		proposedSubtasks: [],
	},
	"research-report": { source: "local", findings: [{ claim: "A local observation", evidence: "source.ts" }] },
	"world-knowledge-report": {
		discovery: "unavailable",
		facts: [],
		synthesis: [],
		uncertainties: ["No discovery access"],
		followUpVerification: [],
	},
	"provenance-report": { confirmedFacts: [], missingEvidence: ["No receipt supplied"], nextInspections: [] },
	"oracle-report": {
		verdict: "No prior decision",
		challenge: "Evidence is missing",
		changesMyMind: "A receipt",
		citedDecisions: [],
	},
	"context-handbook": {
		projectName: "fixture",
		identity: "A fixture project",
		conventions: [],
		invariants: [],
		sections: [],
	},
};

test("internal helper schemas and typed validation retain contract-specific evidence quality", () => {
	for (const kind of INTERNAL_HELPER_RESULT_KINDS) {
		const schema = internalHelperResultSchema({ kind });
		ok(schema);
		strictEqual(schema.type, "object");
		strictEqual(schema.additionalProperties, false);
		const result = validateStructuredHelperResult({ ...evidence, contract: { kind }, data: samples[kind] });
		strictEqual(result.validation.conformance, "pass", kind);
		strictEqual(result.validation.quality, kind === "scout-report" ? "pass" : "unmeasured", kind);
		deepStrictEqual(result.structured, { version: 1, kind, data: samples[kind] });
	}
	strictEqual(internalHelperResultSchema({ kind: "artifact-report" }), null);
	strictEqual(
		validateStructuredHelperResult({ ...evidence, contract: { kind: "mutation-report" }, data: {} }).structured,
		null,
	);
});

test("typed Scout submission cannot ground unread lines or smuggle continuation through degraded claims", () => {
	const input = { ...evidence, contract: { kind: "scout-report" as const } };
	const unread = validateStructuredHelperResult({
		...input,
		observedReadRanges: new Map(),
		data: samples["scout-report"],
	});
	strictEqual(unread.validation.conformance, "fail");
	strictEqual(unread.structured, null);
	const degraded = validateStructuredHelperResult({
		...input,
		data: {
			findings: [{ claim: "Unconfirmed lead" }],
			needsSplit: true,
			proposedSubtasks: [{ id: "write", task: "Change config", requestedAuthority: "workspace-edit" }],
			tool: "bash",
		},
	});
	strictEqual(degraded.validation.quality, "unmeasured");
	deepStrictEqual(degraded.structured?.data, {
		findings: [{ claim: "Unconfirmed lead" }],
		needsSplit: false,
		proposedSubtasks: [],
	});
	for (const data of ["arbitrary prose", [], { findings: undefined }, { findings: [NaN] }]) {
		strictEqual(validateStructuredHelperResult({ ...input, data }).structured, null);
	}
	strictEqual(
		validateStructuredHelperResult({
			...evidence,
			contract: { kind: "research-report" },
			data: { ...samples["research-report"], source: "external" },
		}).structured,
		null,
	);
});

test("only admitted validated terminal events seal a helper result, retaining canonical text", () => {
	const contract = { kind: "provenance-report" as const };
	const payload = { version: 1, kind: contract.kind, data: samples[contract.kind] };
	const event = { type: "clio_coder_helper_result", payload };
	const ordinary = createWorkerOutputCapture();
	ordinary.observe(event);
	strictEqual(ordinary.snapshot(), undefined);
	const capture = createWorkerOutputCapture({
		helperResult: {
			contract,
			validate: (data) => validateStructuredHelperResult({ ...evidence, contract, data }).structured,
		},
	});
	capture.observe({ type: "tool_execution_end", result: { details: payload } });
	capture.observe({ ...event, payload: { ...payload, kind: "oracle-report" } });
	capture.observe({ ...event, payload: { ...payload, data: { confirmedFacts: "invalid" } } });
	strictEqual(capture.snapshot(), undefined);
	capture.observe(event);
	capture.observe({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
	});
	capture.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "later narration" } });
	const output = capture.snapshot();
	ok(output?.structured);
	strictEqual(output.state, "final");
	strictEqual(output.truncated, false);
	deepStrictEqual(JSON.parse(output.text), output.structured.data);
	deepStrictEqual(output.structured, payload);
	output.structured.data.confirmedFacts = ["tamper with snapshot"];
	deepStrictEqual(capture.snapshot()?.structured, payload);
	const oversized = createWorkerOutputCapture({
		helperResult: {
			contract,
			validate: (data) => validateStructuredHelperResult({ ...evidence, contract, data }).structured,
		},
	});
	oversized.observe({
		...event,
		payload: { ...payload, data: { ...payload.data, confirmedFacts: ["x".repeat(9000)] } },
	});
	strictEqual(oversized.snapshot()?.truncated, false, "a conforming report above 8 KiB must survive capture");
	strictEqual((oversized.snapshot()?.structured?.data.confirmedFacts as string[])[0]?.length, 9000);
	const tooLarge = { ...payload.data, confirmedFacts: ["x".repeat(32_768)] };
	const rejected = validateStructuredHelperResult({ ...evidence, contract, data: tooLarge });
	strictEqual(rejected.structured, null, "reject before the worker acknowledges a report the parent cannot retain");
	ok(rejected.validation.reason?.includes("32768 UTF-8 bytes"));
	const finding = { claim: "" };
	const minimal = { findings: [finding] };
	finding.claim = "x".repeat(32_768 - Buffer.byteLength(JSON.stringify(minimal)));
	strictEqual(
		validateStructuredHelperResult({ ...evidence, contract: { kind: "scout-report" }, data: minimal }).structured,
		null,
		"canonical salvage must also fit the capture ceiling",
	);
});

test("existing receipt digest covers structured data while receipts without it remain valid", () => {
	const envelope = fixtureEnvelope("helper-integrity");
	const text = JSON.stringify(samples["provenance-report"]);
	const output = { state: "final" as const, text, bytes: Buffer.byteLength(text), truncated: false };
	const legacy = withReceiptIntegrity({ ...fixtureReceiptDraft(envelope), output }, envelope);
	strictEqual(verifyReceiptIntegrity(legacy, envelope).ok, true);
	const receipt = withReceiptIntegrity(
		{
			...fixtureReceiptDraft(envelope),
			output: { ...output, structured: { version: 1, kind: "provenance-report", data: samples["provenance-report"] } },
		},
		envelope,
	);
	strictEqual(receipt.integrity.version, legacy.integrity.version);
	strictEqual(verifyReceiptIntegrity(receipt, envelope).ok, true);
	const tampered = structuredClone(receipt);
	ok(tampered.output?.structured);
	tampered.output.structured.data.confirmedFacts = ["invented fact"];
	strictEqual(verifyReceiptIntegrity(tampered, envelope).ok, false);
	delete tampered.output.structured;
	strictEqual(verifyReceiptIntegrity(tampered, envelope).ok, false);
});

test("dispatch selects helper mode from trusted audience and seals its validated terminal handoff", async () => {
	const env = await isolateClioEnv("clio-helper-result-");
	const bundle = makeDispatchBundle(dispatchStubContext(), {
		spawnWorker(spec) {
			const parsed = parseWorkerSpec(JSON.parse(JSON.stringify(spec)));
			strictEqual(parsed.helperResult, true);
			strictEqual(spec.readOnly, true);
			ok(
				!spec.allowedTools.includes("write") && !spec.allowedTools.includes("edit") && !spec.allowedTools.includes("bash"),
			);
			throws(() => parseWorkerSpec({ ...spec, helperResult: false }), /helperResult/);
			throws(() => parseWorkerSpec({ ...spec, resultContract: { kind: "artifact-report" } }), /helperResult/);
			strictEqual(
				approvedIdentityForSpec(spec).toolSignature,
				attestedToolSignature({
					allowedTools: spec.allowedTools,
					toolsSupported: true,
					helperResult: true,
					...(spec.toolProfile !== undefined ? { toolProfile: spec.toolProfile } : {}),
					agentId: spec.agentId,
					task: spec.task,
				}),
			);
			const ordinarySpec = { ...spec };
			delete ordinarySpec.helperResult;
			notStrictEqual(approvedIdentityForSpec(spec).toolSignature, approvedIdentityForSpec(ordinarySpec).toolSignature);
			return {
				pid: null,
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				abort() {},
				events: (async function* () {
					yield {
						type: "clio_coder_helper_result",
						payload: {
							version: 1,
							kind: "provenance-report",
							data: samples["provenance-report"],
						},
					};
				})(),
			};
		},
	});
	try {
		await bundle.extension.start();
		const run = await bundle.contract.dispatch({
			agentId: "provenance",
			task: "Inspect receipt evidence",
			executionRole: "researcher",
			requestOrigin: "internal",
			cwd: env.dir,
		});
		const receipt = await run.finalPromise;
		strictEqual(receipt.outcome, "succeeded", receipt.failureMessage);
		deepStrictEqual(receipt.output?.structured?.data, samples["provenance-report"]);
		strictEqual(receipt.quality.resultContract?.conformance, "pass");
		strictEqual(receipt.quality.resultContract?.quality, "unmeasured");
		const envelope = bundle.contract.getRun(run.runId);
		ok(envelope);
		strictEqual(verifyReceiptIntegrity(receipt, envelope).ok, true);
	} finally {
		await bundle.extension.stop?.();
		env.restore();
	}
});

test("base agents and artifact helpers retain ordinary specs even when a caller asks for helper mode", async () => {
	const env = await isolateClioEnv("clio-helper-eligibility-");
	let starts = 0;
	const bundle = makeDispatchBundle(dispatchStubContext(), {
		spawnWorker(spec) {
			starts++;
			strictEqual(spec.helperResult, undefined);
			strictEqual(parseWorkerSpec(JSON.parse(JSON.stringify(spec))).helperResult, undefined);
			throw new Error("ordinary worker reached");
		},
	});
	try {
		await bundle.extension.start();
		for (const agentId of ["coder", "wiki-writer"]) {
			const request = {
				agentId,
				task: "Write the assigned artifact",
				executionRole: "builder" as const,
				requestOrigin: "internal" as const,
				cwd: env.dir,
			};
			await rejects(
				bundle.contract.dispatch({ ...request, helperResult: true } as typeof request),
				/unknown key: helperResult/,
			);
			await rejects(bundle.contract.dispatch(request), /ordinary worker reached/);
		}
		strictEqual(starts, 2);
	} finally {
		await bundle.extension.stop?.();
		env.restore();
	}
});
