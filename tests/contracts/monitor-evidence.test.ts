import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { createMonitorTool } from "../../src/tools/monitor.js";

const scratchRoots: string[] = [];

function scratchDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-monitor-evidence-"));
	scratchRoots.push(root);
	return root;
}

function receiptDraft(runId: string, overrides: Partial<RunReceiptDraft> = {}): RunReceiptDraft {
	return {
		runId,
		agentId: "coder",
		executionRole: "builder",
		task: `task ${runId}`,
		targetId: "local",
		wireModelId: "test-model",
		runtimeId: "test-runtime",
		runtimeKind: "http",
		startedAt: "2026-07-11T00:00:00.000Z",
		endedAt: "2026-07-11T00:00:01.000Z",
		exitCode: 0,
		tokenCount: 2,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.0.0-test",
		piMonoVersion: "0.0.0-test",
		platform: "test",
		nodeVersion: process.version,
		toolCalls: 1,
		toolStats: [],
		toolActivity: { calls: 1, succeeded: 1, failed: 0, blocked: 0, mutatingSucceeded: false },
		sessionId: "monitor-evidence-test",
		output: { state: "final", text: `output ${runId}`, bytes: Buffer.byteLength(`output ${runId}`), truncated: false },
		...overrides,
		verification: overrides.verification ?? { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: overrides.quality ?? {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		costProvenance: overrides.costProvenance ?? "unknown",
		outcome: overrides.outcome ?? "succeeded",
	};
}

function envelopeFor(draft: RunReceiptDraft, receiptPath: string): RunEnvelope {
	return {
		id: draft.runId,
		agentId: draft.agentId,
		executionRole: "builder",
		task: draft.task,
		targetId: draft.targetId,
		wireModelId: draft.wireModelId,
		runtimeId: draft.runtimeId,
		runtimeKind: draft.runtimeKind,
		startedAt: draft.startedAt,
		endedAt: draft.endedAt,
		status: "completed",
		outcome: draft.outcome ?? null,
		outcomeDetail: draft.outcomeDetail ?? null,
		outcomeCode: draft.outcomeCode ?? null,
		...(draft.briefing !== undefined ? { briefing: draft.briefing } : {}),
		...(draft.steering !== undefined ? { steering: draft.steering } : {}),
		exitCode: draft.exitCode,
		pid: null,
		heartbeatAt: null,
		receiptPath,
		sessionId: draft.sessionId,
		cwd: "/tmp",
		tokenCount: draft.tokenCount,
		costUsd: draft.costUsd,
	};
}

function writeSealedReceipt(
	root: string,
	draft: RunReceiptDraft,
	tamper?: (receipt: RunReceipt) => RunReceipt,
): RunEnvelope {
	const receiptPath = join(root, `${draft.runId}.json`);
	const envelope = envelopeFor(draft, receiptPath);
	const sealed = withReceiptIntegrity(draft, envelope);
	writeFileSync(receiptPath, `${JSON.stringify(tamper ? tamper(sealed) : sealed)}\n`, "utf8");
	return envelope;
}

function monitorContract(envelopes: ReadonlyArray<RunEnvelope>): DispatchContract {
	const byId = new Map(envelopes.map((envelope) => [envelope.id, envelope]));
	return {
		dispatch: async () => {
			throw new Error("dispatch is not used by monitor evidence tests");
		},
		dispatchBatch: async () => {
			throw new Error("dispatchBatch is not used by monitor evidence tests");
		},
		listRuns: () => envelopes,
		getRun: (runId) => byId.get(runId) ?? null,
		abort: () => {},
		steer: () => {},
		planAgentSelection: () => {
			throw new Error("unexpected agent plan selection");
		},
		snapshot: () => ({
			generatedAt: new Date(0).toISOString(),
			running: [],
			retrying: [],
			totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
		}),
		drain: async () => {},
	};
}

function runBlock(output: string, runId: string): string {
	const start = output.indexOf(`- ${runId} `);
	ok(start >= 0, `missing block for ${runId}:\n${output}`);
	const next = output.indexOf("\n- ", start + 1);
	return output.slice(start, next < 0 ? output.length : next);
}

describe("contracts/monitor collect evidence labeling", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level beforeEach/afterEach runs around every test in
	// every file, not just this one's.
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("labels sealed receipt text and fails closed for canceled, tampered, and missing receipts", async () => {
		const root = scratchDir();
		const envelopes = [
			writeSealedReceipt(
				root,
				receiptDraft("run-verified", {
					verification: { state: "verified", basis: "validation-tool" },
					briefing: { bytes: 12, contentHash: "a".repeat(64) },
				}),
			),
			writeSealedReceipt(
				root,
				receiptDraft("run-unverified", {
					verification: { state: "unverified", basis: "no-validation-tool" },
					projectContext: { tier: "bounded", chars: 639, contentHash: "b".repeat(64) },
				}),
			),
			writeSealedReceipt(
				root,
				receiptDraft("run-recon", {
					agentId: "scout",
					verification: { state: "not_applicable", basis: "read-only-agent" },
					briefing: { bytes: 24, contentHash: "c".repeat(64) },
					projectContext: { tier: "bounded", chars: 412, contentHash: "d".repeat(64) },
					output: {
						state: "final",
						text: "Lead in src/tools/monitor.ts:250.",
						bytes: Buffer.byteLength("Lead in src/tools/monitor.ts:250."),
						truncated: false,
					},
				}),
			),
			writeSealedReceipt(
				root,
				receiptDraft("run-unknown", {
					verification: { state: "unknown", basis: "acp-external-unobserved" },
				}),
			),
			writeSealedReceipt(
				root,
				receiptDraft("run-canceled", {
					outcome: "canceled",
					outcomeDetail: "operator abort",
					exitCode: 130,
					verification: { state: "unverified", basis: "no-validation-tool" },
					output: {
						state: "partial",
						text: "partial canceled claim",
						bytes: Buffer.byteLength("partial canceled claim"),
						truncated: false,
					},
				}),
			),
			writeSealedReceipt(
				root,
				receiptDraft("run-tampered", { verification: { state: "unverified", basis: "no-validation-tool" } }),
				(sealed) => ({ ...sealed, verification: { state: "verified", basis: "validation-tool" } }),
			),
		];
		const missingDraft = receiptDraft("run-missing", {
			verification: { state: "verified", basis: "validation-tool" },
		});
		envelopes.push(envelopeFor(missingDraft, join(root, "missing.json")));
		const noPathDraft = receiptDraft("run-no-path", {
			verification: { state: "verified", basis: "validation-tool" },
		});
		envelopes.push({ ...envelopeFor(noPathDraft, join(root, "unused.json")), receiptPath: null });
		const malformedDraft = receiptDraft("run-malformed", {
			verification: { state: "verified", basis: "validation-tool" },
		});
		const malformedPath = join(root, "malformed.json");
		writeFileSync(malformedPath, "{not-json\n", "utf8");
		envelopes.push(envelopeFor(malformedDraft, malformedPath));

		const monitor = createMonitorTool({ dispatch: monitorContract(envelopes) });
		const result = await monitor.run({ mode: "collect", run_ids: [...envelopes.map((run) => run.id), "run-pruned"] }, {});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;

		const verified = runBlock(result.output, "run-verified");
		match(verified, /receipt_integrity=verified\/v15\/sha256/);
		match(verified, /trust_status=v1 artifactIntegrity:verified validationGrounding:validated/);
		match(verified, /evidence_verification=verified\/validation-tool/);
		match(verified, new RegExp(`briefing=bytes:12 sha256:${"a".repeat(64)}`));
		match(verified, /project_context=absent/);
		match(verified, /worker output \(tool-verified\):/);

		const unverified = runBlock(result.output, "run-unverified");
		match(unverified, /receipt_integrity=verified\/v15\/sha256/);
		match(unverified, /trust_status=v1 artifactIntegrity:verified validationGrounding:absent/);
		match(unverified, /evidence_verification=unverified\/no-validation-tool/);
		match(unverified, /briefing=none/);
		match(unverified, new RegExp(`project_context=bounded chars:639 sha256:${"b".repeat(64)}`));
		match(unverified, /worker claims \(unverified prose\):/);

		const recon = runBlock(result.output, "run-recon");
		match(recon, /receipt_integrity=verified\/v15\/sha256/);
		match(recon, /trust_status=v1 artifactIntegrity:verified validationGrounding:not_applicable/);
		match(recon, /evidence_verification=not_applicable\/read-only-agent/);
		match(recon, new RegExp(`briefing=bytes:24 sha256:${"c".repeat(64)}`));
		match(recon, new RegExp(`project_context=bounded chars:412 sha256:${"d".repeat(64)}`));
		match(recon, /reconnaissance output \(advisory leads, not validation evidence\):/);

		const unknown = runBlock(result.output, "run-unknown");
		match(unknown, /receipt_integrity=verified\/v15\/sha256/);
		match(unknown, /trust_status=v1 artifactIntegrity:verified validationGrounding:unknown/);
		match(unknown, /evidence_verification=unknown\/acp-external-unobserved/);
		match(unknown, /briefing=none/);
		match(unknown, /project_context=absent/);
		match(unknown, /worker claims \(validation not observable at this layer\):/);

		const canceled = runBlock(result.output, "run-canceled");
		match(canceled, /worker claims \(unverified prose\):/);
		match(canceled, /partial canceled claim/);
		match(canceled, /non-evidence: this run did not succeed; treat the text above as an unsubstantiated report/);

		const tampered = runBlock(result.output, "run-tampered");
		match(tampered, /worker claims \(unverified prose\):/);
		match(tampered, /RECEIPT INTEGRITY FAILED/);
		match(tampered, /receipt integrity failed: integrity mismatch/);
		strictEqual(tampered.includes("output run-tampered"), false, tampered);
		strictEqual(tampered.includes("worker output (tool-verified):"), false, tampered);

		const missing = runBlock(result.output, "run-missing");
		match(missing, /worker claims \(unverified prose\):/);
		match(missing, /receipt integrity unavailable: cannot read/);
		strictEqual(missing.includes("worker output (tool-verified):"), false, missing);
		strictEqual(missing.includes("output run-missing"), false, missing);

		const noPath = runBlock(result.output, "run-no-path");
		match(noPath, /worker claims \(unverified prose\):/);
		match(noPath, /receipt integrity unavailable: no stored receipt/);
		strictEqual(noPath.includes("worker output (tool-verified):"), false, noPath);
		strictEqual(noPath.includes("output run-no-path"), false, noPath);

		const malformed = runBlock(result.output, "run-malformed");
		match(malformed, /worker claims \(unverified prose\):/);
		match(malformed, /receipt integrity unavailable: cannot read/);
		strictEqual(malformed.includes("worker output (tool-verified):"), false, malformed);

		const pruned = runBlock(result.output, "run-pruned");
		match(pruned, /worker claims \(unverified prose\):/);
		match(pruned, /receipt integrity unavailable: the run ledger envelope is missing/);
		strictEqual(pruned.includes("worker output (tool-verified):"), false, pruned);
	});

	it("keeps receipt mode raw JSON while exposing integrity and evidence state in details", async () => {
		const root = scratchDir();
		const envelope = writeSealedReceipt(
			root,
			receiptDraft("run-receipt-details", {
				verification: { state: "unverified", basis: "no-validation-tool" },
				briefing: { bytes: 7, contentHash: "e".repeat(64) },
				projectContext: { tier: "none" },
			}),
		);
		const monitor = createMonitorTool({ dispatch: monitorContract([envelope]) });
		match(monitor.description, /wait observes without collecting/);
		match(monitor.description, /collect is the authoritative terminal batch operation/);
		match(monitor.description, /collect detached runs before final synthesis/);
		match(monitor.description, /receipt exposes stored evidence/);
		match(monitor.description, /Briefing provenance, and project-context provenance are separate fields/i);
		const result = await monitor.run({ mode: "receipt", run_id: envelope.id }, {});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual(JSON.parse(result.output).runId, envelope.id, "receipt output remains raw JSON");
		deepStrictEqual(result.details?.receiptIntegrity, { ok: true });
		deepStrictEqual(
			(result.details?.trustStatus as { artifactIntegrity?: { state?: string } })?.artifactIntegrity?.state,
			"verified",
		);
		deepStrictEqual(result.details?.evidenceVerification, {
			state: "unverified",
			basis: "no-validation-tool",
		});
		deepStrictEqual(result.details?.briefing, { bytes: 7, contentHash: "e".repeat(64) });
		deepStrictEqual(result.details?.projectContext, { tier: "none" });
	});
});
