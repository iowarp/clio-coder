/**
 * `clio evidence build` verdict contract (bt-02 finding 3): the operator-facing
 * verdict line and exit code must tell the truth about receipt integrity. The
 * artifact is still written (the finding is part of the evidence), but a
 * corrupted receipt must fail the command, and a clean modern receipt (with
 * outcome, lineage, and token splits) must keep verifying.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runEvidenceCommand } from "../../src/cli/evidence.js";
import {
	type GateDecisionArtifact,
	type GateDecisionDraft,
	materializePendingGateDecision,
	stagePendingGateDecision,
} from "../../src/domains/dispatch/gate-decisions.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type {
	RunKind,
	RunPersonaOverride,
	RunPipelineProvenance,
	RunReceiptAutonomyEnforcement,
	RunReceiptSafetySummary,
} from "../../src/domains/dispatch/types.js";
import { buildEvidence, loadEvidenceGateDecisions } from "../../src/domains/evidence/index.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

function withIsolatedClioHome<T>(fn: (scratch: string) => T | Promise<T>): Promise<T> {
	const originalEnv = { ...process.env };
	const scratch = newScratchClioHome("clio-evidence-build-");
	return Promise.resolve()
		.then(() => fn(scratch))
		.finally(() => {
			for (const k of Object.keys(process.env)) {
				if (!(k in originalEnv)) Reflect.deleteProperty(process.env, k);
			}
			for (const [k, v] of Object.entries(originalEnv)) {
				if (v !== undefined) process.env[k] = v;
			}
			clearScratchClioHome(scratch);
		});
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
	const original = process.stderr.write.bind(process.stderr);
	let stderr = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, stderr };
	} finally {
		process.stderr.write = original;
	}
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
	const original = process.stdout.write.bind(process.stdout);
	let stdout = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	try {
		const result = await fn();
		return { result, stdout };
	} finally {
		process.stdout.write = original;
	}
}

/**
 * Provenance field sets a sealed receipt may carry. Folded into the receipt
 * draft (and thus the integrity digest) only when supplied, mirroring the
 * dispatch finalizer's optional-field writes.
 */
interface SealProvenance {
	pipeline?: RunPipelineProvenance;
	personaOverride?: RunPersonaOverride;
	safety?: RunReceiptSafetySummary;
	autonomyEnforcement?: RunReceiptAutonomyEnforcement;
}

/** Seal a finalized run + receipt the way the dispatch finalizer does. */
async function sealRun(
	runtime: { runtimeId: string; runtimeKind: RunKind } = {
		runtimeId: "openai-completions",
		runtimeKind: "http",
	},
	provenance: SealProvenance = {},
): Promise<{ runId: string; receiptPath: string }> {
	const ledger = openLedger();
	const envelope = ledger.create({
		agentId: "coder",
		executionRole: "builder",
		task: "evidence fixture task",
		targetId: "mini",
		wireModelId: "test-model",
		runtimeId: runtime.runtimeId,
		runtimeKind: runtime.runtimeKind,
		sessionId: null,
		cwd: "/tmp",
	});
	const endedAt = new Date().toISOString();
	ledger.update(envelope.id, {
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: "completed without executing any tools",
		endedAt,
		exitCode: 0,
		tokenCount: 2795,
		inputTokenCount: 2606,
		outputTokenCount: 189,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
	});
	const receipt = ledger.recordReceipt(envelope.id, {
		verification: { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		costProvenance: "unknown",
		runId: envelope.id,
		agentId: "coder",
		executionRole: "builder",
		task: "evidence fixture task",
		targetId: "mini",
		wireModelId: "test-model",
		runtimeId: runtime.runtimeId,
		runtimeKind: runtime.runtimeKind,
		outcome: "succeeded",
		outcomeDetail: "completed without executing any tools",
		startedAt: envelope.startedAt,
		endedAt,
		exitCode: 0,
		tokenCount: 2795,
		inputTokenCount: 2606,
		outputTokenCount: 189,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		clioVersion: "test",
		piMonoVersion: "test",
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: 0,
		toolStats: [],
		toolActivity: { calls: 0, succeeded: 0, failed: 0, blocked: 0, mutatingSucceeded: false },
		...(provenance.pipeline !== undefined ? { pipeline: provenance.pipeline } : {}),
		...(provenance.personaOverride !== undefined ? { personaOverride: provenance.personaOverride } : {}),
		...(provenance.safety !== undefined ? { safety: provenance.safety } : {}),
		...(provenance.autonomyEnforcement !== undefined ? { autonomyEnforcement: provenance.autonomyEnforcement } : {}),
		sessionId: null,
	});
	await ledger.persist();
	const receiptPath = ledger.get(envelope.id)?.receiptPath;
	if (!receiptPath) throw new Error("fixture receipt path missing");
	strictEqual(receipt.integrity.version, 13);
	return { runId: envelope.id, receiptPath };
}

function readJsonl(path: string): unknown[] {
	const text = readFileSync(path, "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as unknown);
}

/** Independent decider correlation, the ordinary case for a gated fixture. */
const INDEPENDENT_GATE_CORRELATION = {
	agent: false,
	target: true,
	modelFamily: false,
	runtime: true,
	node: true,
	independent: true,
} as const;

describe("contracts/evidence-build", () => {
	it("exits 0 on a clean modern receipt and 1 with the integrity failure printed on a corrupted one", async () => {
		await withIsolatedClioHome(async () => {
			const { runId, receiptPath } = await sealRun();

			const clean = await captureStderr(() => runEvidenceCommand(["build", "--run", runId]));
			strictEqual(clean.result, 0, `clean build failed: ${clean.stderr}`);

			// Flip one digested field; the artifact must still build, but the
			// verdict line and exit code must report the integrity failure.
			const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { inputTokenCount: number };
			receipt.inputTokenCount += 1;
			writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

			const corrupted = await captureStderr(() => runEvidenceCommand(["build", "--run", runId]));
			strictEqual(corrupted.result, 1);
			ok(corrupted.stderr.includes("receipt integrity"), corrupted.stderr);
			ok(corrupted.stderr.includes(runId), corrupted.stderr);
		});
	});

	it("round-trips an acp-delegation receipt: runtimeKind is digest-covered and must verify as written", async () => {
		await withIsolatedClioHome(async () => {
			const { runId, receiptPath } = await sealRun({ runtimeId: "claude-code-acp", runtimeKind: "acp-delegation" });

			const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { runtimeKind: string };
			strictEqual(receipt.runtimeKind, "acp-delegation");

			// A reader that coerces runtimeKind to "http" recomputes a different
			// digest and reports a clean receipt as corrupt (rv-01 finding 3).
			const clean = await captureStderr(() => runEvidenceCommand(["build", "--run", runId]));
			strictEqual(clean.result, 0, `acp-delegation build failed: ${clean.stderr}`);
			ok(!clean.stderr.includes("receipt integrity"), clean.stderr);
		});
	});

	it("reports a receipt sealed under a retired integrity version as an integrity failure", async () => {
		await withIsolatedClioHome(async () => {
			const { runId, receiptPath } = await sealRun();

			const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
				integrity: { version: number };
			};
			receipt.integrity.version = 3;
			writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

			const corrupted = await captureStderr(() => runEvidenceCommand(["build", "--run", runId]));
			strictEqual(corrupted.result, 1);
			ok(corrupted.stderr.includes("receipt integrity"), corrupted.stderr);
			ok(corrupted.stderr.includes(runId), corrupted.stderr);
		});
	});

	it("discovers integrity-valid gate decisions from receipt ids and omits tampered coordinator evidence", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const builder = await sealRun();
			const reviewer = await sealRun();
			const builderReceipt = JSON.parse(readFileSync(builder.receiptPath, "utf8")) as {
				runId: string;
				integrity: { digest: string };
			};
			const reviewerReceipt = JSON.parse(readFileSync(reviewer.receiptPath, "utf8")) as {
				runId: string;
				integrity: { digest: string };
			};
			const decision = writeGateDecision({
				group: "evidence-review",
				topology: "review",
				cycle: 1,
				outcome: "pass",
				subjects: [{ runId: builderReceipt.runId, digest: builderReceipt.integrity.digest }],
				decider: { runId: reviewerReceipt.runId, digest: reviewerReceipt.integrity.digest },
				correlation: INDEPENDENT_GATE_CORRELATION,
			});
			const dataDir = join(scratch, "data");
			const stateDir = join(scratch, "state");
			const built = await buildEvidence({ dataDir, stateDir, runId: builder.runId });
			const linked = await loadEvidenceGateDecisions(dataDir, built.evidenceId);
			strictEqual(linked.length, 1);
			strictEqual(linked[0]?.outcome, "pass");
			strictEqual(linked[0]?.subjects[0]?.runId, builder.runId);

			const tampered = JSON.parse(readFileSync(decision.path, "utf8")) as Record<string, unknown>;
			tampered.outcome = "fail";
			writeFileSync(decision.path, JSON.stringify(tampered, null, 2));
			await buildEvidence({ dataDir, stateDir, runId: builder.runId });
			deepStrictEqual(await loadEvidenceGateDecisions(dataDir, built.evidenceId), []);
		});
	});

	it("treats classified audit rows as non-final and denied rows as blocked tool events", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const { runId } = await sealRun();
			const dataDir = join(scratch, "data");
			const stateDir = join(scratch, "state");
			const auditDir = join(stateDir, "audit");
			mkdirSync(auditDir, { recursive: true });
			const ts = new Date().toISOString();
			const auditFixture = [
				{
					kind: "tool_call",
					ts,
					correlationId: "audit-classified",
					runId,
					tool: "write",
					actionClass: "write",
					decision: "classified",
					reasons: ["classified before autonomy"],
				},
				{
					kind: "tool_call",
					ts,
					correlationId: "audit-denied",
					runId,
					tool: "write",
					actionClass: "write",
					decision: "denied",
					reasons: ["Clio is at autonomy read-only: write actions are denied without prompting."],
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n");
			writeFileSync(join(auditDir, `${ts.slice(0, 10)}.jsonl`), `${auditFixture}\n`);

			const result = await buildEvidence({ dataDir, stateDir, runId });
			const auditRows = readJsonl(join(result.directory, "audit-linked.jsonl"));
			const toolEvents = readJsonl(join(result.directory, "tool-events.jsonl")) as Array<Record<string, unknown>>;

			strictEqual(auditRows.length, 2);
			strictEqual(toolEvents.length, 1);
			strictEqual(toolEvents[0]?.decision, "denied");
			strictEqual(toolEvents[0]?.blocked, 1);
			strictEqual(toolEvents[0]?.ok, 0);
		});
	});

	it("treats linked completion_contract validation_evidence as run validation proof", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const { runId } = await sealRun();
			const dataDir = join(scratch, "data");
			const stateDir = join(scratch, "state");
			const auditDir = join(stateDir, "audit");
			mkdirSync(auditDir, { recursive: true });
			const ts = new Date().toISOString();
			writeFileSync(
				join(auditDir, `${ts.slice(0, 10)}.jsonl`),
				`${JSON.stringify({
					kind: "completion_contract",
					ts,
					correlationId: "completion-validation",
					runId,
					turnId: "turn-validated",
					decision: "ok",
					reason: "validation_evidence",
					rigor: "high",
					mutatedPaths: ["src/app.ts"],
					evidenceKinds: ["validation_command"],
				})}\n`,
			);

			const result = await buildEvidence({ dataDir, stateDir, runId });

			strictEqual(
				result.findings.some((finding) => finding.tag === "no-validation"),
				false,
			);
			strictEqual(result.overview.totals.auditRows, 1);
		});
	});

	it("surfaces pipeline, persona, and escalation provenance in transcript, cleaned trace, and findings", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const pipeline: RunPipelineProvenance = {
				fromRunId: "upstreamrun01",
				position: 2,
				inputBytes: 32,
				inputTruncated: false,
			};
			const personaOverride: RunPersonaOverride = { promptHash: "1b3fc16b2c4d5e6f7a8b9c0d1e2f3a4b" };
			const safety: RunReceiptSafetySummary = {
				decisions: {
					allowed: 3,
					blocked: 0,
					permissionRequested: 2,
					escalationRequested: 2,
					escalationApproved: 0,
					escalationDenied: 1,
					escalationTimedOut: 1,
				},
				blockedAttempts: [],
				requestedActions: [],
				runtimeLimitations: [],
			};
			const { runId } = await sealRun(undefined, { pipeline, personaOverride, safety });
			const dataDir = join(scratch, "data");
			const stateDir = join(scratch, "state");

			const result = await buildEvidence({ dataDir, stateDir, runId });

			const transcript = readFileSync(join(result.directory, "transcript.md"), "utf8");
			ok(transcript.includes("pipeline: step 2, input 32 bytes from upstreamrun01 (not truncated)"), transcript);
			ok(transcript.includes("persona override: prompt hash 1b3fc16b2c4d..."), transcript);
			ok(transcript.includes("escalations: 2 requested, 0 approved, 1 denied, 1 timed out"), transcript);

			const cleaned = readJsonl(join(result.directory, "trace.cleaned.jsonl")) as Array<Record<string, unknown>>;
			const runRow = cleaned.find((row) => row.kind === "run");
			ok(runRow, "cleaned trace missing run row");
			deepStrictEqual(runRow?.pipeline, pipeline);
			deepStrictEqual(runRow?.personaOverride, personaOverride);
			deepStrictEqual(runRow?.escalation, { requested: 2, approved: 0, denied: 1, timedOut: 1 });

			const escalationFinding = result.findings.find((finding) => finding.tag === "escalation");
			ok(escalationFinding, "expected an escalation finding");
			strictEqual(escalationFinding?.severity, "warn");
			strictEqual(escalationFinding?.runId, runId);
			ok(escalationFinding?.message.includes("1 timed out"), escalationFinding?.message);
			ok(escalationFinding?.message.includes("1 denied"), escalationFinding?.message);

			// The CLI inspect path reads the bundle's receipt.json and prints the
			// same three field sets.
			const inspected = await captureStdout(() => runEvidenceCommand(["inspect", result.evidenceId]));
			strictEqual(inspected.result, 0, inspected.stdout);
			ok(inspected.stdout.includes(`provenance ${runId}:`), inspected.stdout);
			ok(
				inspected.stdout.includes("pipeline: step 2, input 32 bytes from upstreamrun01 (not truncated)"),
				inspected.stdout,
			);
			ok(inspected.stdout.includes("persona override: prompt hash 1b3fc16b2c4d..."), inspected.stdout);
			ok(inspected.stdout.includes("escalations: 2 requested, 0 approved, 1 denied, 1 timed out"), inspected.stdout);
		});
	});

	it("flags external bypass and projects autonomy enforcement", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const autonomyEnforcement: RunReceiptAutonomyEnforcement = {
				grade: "bypassed",
				autonomy: "full-auto",
				externalMode: "bypassPermissions",
				dangerousBypass: true,
			};
			const { runId } = await sealRun({ runtimeId: "claude-code", runtimeKind: "subprocess" }, { autonomyEnforcement });
			const dataDir = join(scratch, "data");
			const stateDir = join(scratch, "state");

			const result = await buildEvidence({ dataDir, stateDir, runId });

			const transcript = readFileSync(join(result.directory, "transcript.md"), "utf8");
			ok(
				transcript.includes(
					"autonomy enforcement: bypassed autonomy=full-auto mode=bypassPermissions dangerousBypass=true",
				),
				transcript,
			);

			const cleaned = readJsonl(join(result.directory, "trace.cleaned.jsonl")) as Array<Record<string, unknown>>;
			const runRow = cleaned.find((row) => row.kind === "run");
			ok(runRow, "cleaned trace missing run row");
			deepStrictEqual(runRow?.autonomyEnforcement, autonomyEnforcement);

			const bypassFinding = result.findings.find((finding) => finding.tag === "external-bypass");
			ok(bypassFinding, "expected an external bypass finding");
			strictEqual(bypassFinding?.severity, "warn");
			strictEqual(bypassFinding?.runId, runId);
			strictEqual(
				bypassFinding?.message,
				"run executed with external permission bypass (CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1); Clio safety blocks were not enforced",
			);

			const inspected = await captureStdout(() => runEvidenceCommand(["inspect", result.evidenceId]));
			strictEqual(inspected.result, 0, inspected.stdout);
			ok(
				inspected.stdout.includes(
					"autonomy enforcement: bypassed autonomy=full-auto mode=bypassPermissions dangerousBypass=true",
				),
				inspected.stdout,
			);
		});
	});

	it("reports agent-managed ACP governance without claiming a subprocess environment bypass", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const autonomyEnforcement: RunReceiptAutonomyEnforcement = {
				grade: "bypassed",
				autonomy: "read-only",
				externalMode: "agent-managed",
				dangerousBypass: true,
			};
			const { runId } = await sealRun({ runtimeId: "acp", runtimeKind: "acp-delegation" }, { autonomyEnforcement });
			const result = await buildEvidence({
				dataDir: join(scratch, "data"),
				stateDir: join(scratch, "state"),
				runId,
			});

			const bypassFinding = result.findings.find((finding) => finding.tag === "external-bypass");
			ok(bypassFinding, "expected an agent-managed bypass finding");
			strictEqual(bypassFinding?.severity, "warn");
			strictEqual(bypassFinding?.runId, runId);
			strictEqual(
				bypassFinding?.message,
				"run used external agent-managed governance; Clio safety blocks were not enforced",
			);
			ok(!bypassFinding?.message.includes("CLIO_ALLOW_EXTERNAL_FULL_ACCESS"), bypassFinding?.message);
		});
	});

	it("reports approximated external enforcement without a bypass finding", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const autonomyEnforcement: RunReceiptAutonomyEnforcement = {
				grade: "approximated",
				autonomy: "auto-edit",
				externalMode: "agy-settings-default",
				dangerousBypass: false,
			};
			const { runId } = await sealRun(
				{ runtimeId: "antigravity-code", runtimeKind: "subprocess" },
				{ autonomyEnforcement },
			);
			const dataDir = join(scratch, "data");
			const stateDir = join(scratch, "state");

			const result = await buildEvidence({ dataDir, stateDir, runId });

			strictEqual(
				result.findings.some((finding) => finding.tag === "external-bypass"),
				false,
			);
			const approximationFinding = result.findings.find((finding) => finding.tag === "external-approximation");
			ok(approximationFinding, "expected an external approximation finding");
			strictEqual(approximationFinding?.severity, "info");
			strictEqual(approximationFinding?.runId, runId);
			strictEqual(
				approximationFinding?.message,
				"run used approximated external autonomy enforcement via agy-settings-default",
			);
		});
	});

	it("renders a receipt without provenance byte-identically (fields absent, not empty)", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const { runId } = await sealRun();
			const dataDir = join(scratch, "data");
			const stateDir = join(scratch, "state");

			const result = await buildEvidence({ dataDir, stateDir, runId });

			const transcript = readFileSync(join(result.directory, "transcript.md"), "utf8");
			ok(!transcript.includes("pipeline: step"), transcript);
			ok(!transcript.includes("persona override:"), transcript);
			ok(!transcript.includes("escalations:"), transcript);
			ok(!transcript.includes("autonomy enforcement:"), transcript);

			const cleaned = readJsonl(join(result.directory, "trace.cleaned.jsonl")) as Array<Record<string, unknown>>;
			const runRow = cleaned.find((row) => row.kind === "run");
			ok(runRow, "cleaned trace missing run row");
			ok(!("pipeline" in (runRow ?? {})), "run row must omit pipeline");
			ok(!("personaOverride" in (runRow ?? {})), "run row must omit personaOverride");
			ok(!("escalation" in (runRow ?? {})), "run row must omit escalation");
			ok(!("autonomyEnforcement" in (runRow ?? {})), "run row must omit autonomyEnforcement");

			strictEqual(
				result.findings.some((finding) => finding.tag === "escalation"),
				false,
			);
			strictEqual(
				result.findings.some((finding) => finding.tag === "external-bypass"),
				false,
			);
			strictEqual(
				result.findings.some((finding) => finding.tag === "external-approximation"),
				false,
			);

			// The CLI inspect path prints no provenance block for a bundle without provenance.
			const inspected = await captureStdout(() => runEvidenceCommand(["inspect", result.evidenceId]));
			strictEqual(inspected.result, 0, inspected.stdout);
			ok(!inspected.stdout.includes("provenance "), inspected.stdout);
		});
	});
});

/** Every decision crosses the staged durable boundary; there is no direct writer. */
function writeGateDecision(draft: GateDecisionDraft): { artifact: GateDecisionArtifact; path: string } {
	return materializePendingGateDecision(stagePendingGateDecision(draft));
}
