/**
 * One canonical trust fixture, every surface, one verdict.
 *
 * Before the shared projection, two hand-rolled formatters spelled the six
 * axes with different separators, dispatch and monitor collapsed a failed, an
 * inferred, and an absent validation into one label, findings.md read two of
 * the six axes, the Alt+W board's whole evidence line was
 * `host_verification=…`, the receipt view said "integrity verified" about a
 * seal, and the eval bridge reported the raw receipt marker. These contracts
 * push one sealed receipt through each of those surfaces and pin that the
 * text they print is byte-identical, that a sealed receipt is never styled as
 * independently reviewed, and that the machine projection survives the ACP
 * bounder's depth cap where the nested canonical references do not.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { runEvidenceCommand } from "../../src/cli/evidence.js";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { evidenceMetricsFromReceipt } from "../../src/domains/eval/metrics/evidence.js";
import { buildEvidence } from "../../src/domains/evidence/build.js";
import {
	formatTrustAxes,
	formatTrustSummary,
	formatTrustSummaryLine,
	summarizeTrustStatus,
	TRUST_STATE_WORDS,
	TRUST_SUMMARY_MAX_REFS,
	trustVerdict,
} from "../../src/domains/evidence/trust-projection.js";
import {
	adaptRunReceiptTrustStatus,
	type CanonicalTrustStatus,
	composeTrustStatus,
	inspectRunReceiptTrustStatus,
	TRUST_STATUS_AXES,
	TRUST_STATUS_STATES,
} from "../../src/domains/evidence/trust-status.js";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import { createStdioServerTransport } from "../../src/engine/acp/transport.js";
import { createDispatchBoardStore, renderDispatchCard } from "../../src/interactive/dispatch-board.js";
import { createClioTheme } from "../../src/interactive/theme/index.js";
import { receiptTrustDetail } from "../../src/interactive/view/artifacts.js";
import { readWorkerReceiptFacts } from "../../src/interactive/worker-receipts.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import { receiptEvidenceLabels, workerTextLabel } from "../../src/tools/worker-evidence.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const scratchRoots: string[] = [];

function scratchDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-trust-projection-"));
	scratchRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function draftFor(runId: string, overrides: Partial<RunReceiptDraft> = {}): RunReceiptDraft {
	return {
		runId,
		agentId: "coder",
		executionRole: "builder",
		task: `trust projection fixture ${runId}`,
		briefing: { bytes: 18, contentHash: DIGEST_A },
		targetId: "local",
		wireModelId: "fixture-model",
		runtimeId: "fixture-runtime",
		runtimeKind: "http",
		startedAt: "2026-08-28T10:00:00.000Z",
		endedAt: "2026-08-28T10:00:01.000Z",
		outcome: "succeeded",
		exitCode: 0,
		tokenCount: 12,
		costUsd: 0,
		costProvenance: "unknown",
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "test",
		piMonoVersion: "test",
		platform: "test",
		nodeVersion: process.version,
		toolCalls: 1,
		toolStats: [],
		toolActivity: { calls: 1, succeeded: 1, failed: 0, blocked: 0, mutatingSucceeded: false },
		output: { state: "final", text: "done", bytes: 4, truncated: false },
		verification: { state: "verified", basis: "validation-tool" },
		hostVerification: { status: "verified", checks: [] },
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
		projectContext: { tier: "bounded", chars: 240, contentHash: DIGEST_B },
		autonomyEnforcement: { grade: "mediated", autonomy: "auto-edit" },
		sessionId: null,
		...overrides,
	};
}

function envelopeFor(draft: RunReceiptDraft, receiptPath: string | null): RunEnvelope {
	return {
		id: draft.runId,
		agentId: draft.agentId,
		executionRole: "builder",
		task: draft.task,
		briefing: { bytes: 18, contentHash: DIGEST_A },
		targetId: draft.targetId,
		wireModelId: draft.wireModelId,
		runtimeId: draft.runtimeId,
		runtimeKind: draft.runtimeKind,
		startedAt: draft.startedAt,
		endedAt: draft.endedAt,
		status: "completed",
		outcome: draft.outcome ?? null,
		outcomeDetail: null,
		outcomeCode: null,
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

/** Persist the fixture the way dispatch does: `state/runs.json` plus `state/receipts/<runId>.json`. */
function persistFixture(root: string, draft: RunReceiptDraft): { envelope: RunEnvelope; receipt: RunReceipt } {
	const stateDir = join(root, "state");
	const receiptPath = join(stateDir, "receipts", `${draft.runId}.json`);
	mkdirSync(join(stateDir, "receipts"), { recursive: true });
	const envelope = envelopeFor(draft, receiptPath);
	const receipt = withReceiptIntegrity(draft, envelope);
	writeFileSync(join(stateDir, "runs.json"), `${JSON.stringify([envelope], null, 2)}\n`, "utf8");
	writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
	return { envelope, receipt };
}

function writeFinishContractAudit(root: string, runId: string): void {
	const auditDir = join(root, "state", "audit");
	mkdirSync(auditDir, { recursive: true });
	writeFileSync(
		join(auditDir, "2026-08-28.jsonl"),
		`${JSON.stringify({
			kind: "completion_contract",
			ts: "2026-08-28T10:00:02.000Z",
			correlationId: "finish-read-only",
			runId,
			decision: "ok",
			reason: "no_mutation",
			rigor: "standard",
			mutatedPaths: [],
			evidenceKinds: [],
		})}\n`,
		"utf8",
	);
}

/** What the canonical fixture must read as on every surface. */
const CANONICAL_SUMMARY =
	"sealed; grounded by host-verification; not independently reviewed; mediated; context recorded; completion not recorded";
const CANONICAL_AXES =
	"trust_status=v1 artifactIntegrity:verified validationGrounding:validated independentReview:absent contextProvenance:recorded autonomyEnforcement:enforced completionEvidence:absent";

function monitorContract(envelopes: ReadonlyArray<RunEnvelope>): DispatchContract {
	const byId = new Map(envelopes.map((envelope) => [envelope.id, envelope]));
	const unused = (): never => {
		throw new Error("not used by trust projection tests");
	};
	return {
		dispatch: async () => unused(),
		dispatchBatch: async () => unused(),
		listRuns: () => envelopes,
		getRun: (runId) => byId.get(runId) ?? null,
		abort: () => {},
		steer: () => {},
		planAgentSelection: unused,
		snapshot: () => ({
			generatedAt: new Date(0).toISOString(),
			running: [],
			retrying: [],
			totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
		}),
		drain: async () => {},
	};
}

async function captureStdout<T>(run: () => Promise<T>): Promise<{ result: T; stdout: string }> {
	const original = process.stdout.write.bind(process.stdout);
	let stdout = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	try {
		return { result: await run(), stdout };
	} finally {
		process.stdout.write = original;
	}
}

describe("contracts/trust projection: one fixture, every surface", () => {
	it("projects the canonical fixture to the pinned line and verdict", () => {
		const root = scratchDir();
		const { envelope, receipt } = persistFixture(root, draftFor("run-canon"));
		const status = inspectRunReceiptTrustStatus(receipt, envelope).status;
		strictEqual(formatTrustSummary(status), CANONICAL_SUMMARY);
		strictEqual(formatTrustAxes(status), CANONICAL_AXES);
		strictEqual(formatTrustSummaryLine(status), `trust v1: grounded; ${CANONICAL_SUMMARY}`);
		const summary = summarizeTrustStatus(status);
		strictEqual(summary.version, 1);
		strictEqual(
			summary.verdict,
			"grounded",
			"observed validation without an independent review is grounded, never reviewed",
		);
		strictEqual(summary.text, CANONICAL_SUMMARY);
		strictEqual(summary.claimant, "validator:host-verification");
		deepStrictEqual(summary.unknown, ["independentReview", "completionEvidence"]);
		ok(summary.refs.length > 0 && summary.refs.length <= TRUST_SUMMARY_MAX_REFS, JSON.stringify(summary.refs));
		ok(summary.refs.includes("run_receipt:run-canon"), JSON.stringify(summary.refs));
		for (const ref of summary.refs) match(ref, /^[a-z_]+:[^\s]+$/u, ref);
	});

	it("keeps one receipt verdict byte-equal across every named surface despite a finish-contract row", async () => {
		const root = scratchDir();
		const runId = "run-all-surfaces";
		const { envelope, receipt } = persistFixture(root, draftFor(runId));
		writeFinishContractAudit(root, runId);
		const stateDir = join(root, "state");
		const dataDir = join(root, "data");
		const canonical = inspectRunReceiptTrustStatus(receipt, envelope).status;
		const expectedTier = trustVerdict(canonical);
		const expectedSummary = formatTrustSummary(canonical);
		const expectedAxes = formatTrustAxes(canonical);
		const expectedLine = formatTrustSummaryLine(canonical);

		const dispatchLabels = receiptEvidenceLabels(receipt, receipt.verification, { ok: true });
		strictEqual(dispatchLabels[0], `trust=${JSON.stringify(expectedSummary)}`);
		strictEqual(dispatchLabels[1], expectedAxes);

		const monitor = createMonitorTool({ dispatch: monitorContract([envelope]) });
		const monitored = await monitor.run({ mode: "receipt", run_id: runId }, {});
		strictEqual(monitored.kind, "ok");
		if (monitored.kind !== "ok") return;
		const monitorTrust = (monitored.details as { trust?: { text: string; verdict: string } }).trust;
		strictEqual(monitorTrust?.text, expectedSummary);
		strictEqual(monitorTrust?.verdict, expectedTier);

		const built = await buildEvidence({ stateDir, dataDir, runId });
		deepStrictEqual(built.trustStatus.runs[0]?.status, canonical);
		const previousData = process.env.CLIO_CODER_DATA_DIR;
		process.env.CLIO_CODER_DATA_DIR = dataDir;
		let inspected = "";
		try {
			({ stdout: inspected } = await captureStdout(() => runEvidenceCommand(["inspect", built.evidenceId])));
		} finally {
			if (previousData === undefined) Reflect.deleteProperty(process.env, "CLIO_CODER_DATA_DIR");
			else process.env.CLIO_CODER_DATA_DIR = previousData;
		}
		ok(inspected.includes(`trust ${runId}: ${expectedSummary}\n  ${expectedAxes}\n`), inspected);
		const findings = readFileSync(join(built.directory, "findings.md"), "utf8");
		ok(findings.includes(`tier: ${expectedTier}`), findings);
		ok(findings.includes(`summary: ${expectedSummary}`), findings);
		ok(findings.includes(`axes: ${expectedAxes}`), findings);

		const facts = readWorkerReceiptFacts(runId, stateDir);
		deepStrictEqual(facts?.trust, canonical);
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus, undefined, (id) => readWorkerReceiptFacts(id, stateDir));
		try {
			bus.emit(BusChannels.DispatchStarted, {
				runId,
				agentId: "coder",
				executionRole: "builder",
				targetId: "local",
				wireModelId: "fixture-model",
				runtimeId: "fixture-runtime",
				runtimeKind: "http",
			} as never);
			bus.emit(BusChannels.DispatchCompleted, {
				runId,
				agentId: "coder",
				executionRole: "builder",
				targetId: "local",
				wireModelId: "fixture-model",
				runtimeId: "fixture-runtime",
				runtimeKind: "http",
				hostVerification: "verified",
			} as never);
			const row = store.rows()[0];
			ok(row?.trust);
			strictEqual(row.trust.verdict, expectedTier);
			strictEqual(row.trust.text, expectedSummary);
			const board = renderDispatchCard(row, 88).join("\n").replace(SGR, "");
			const boardText = board.replace(/[│\n]/gu, " ").replace(/\s+/gu, " ");
			ok(boardText.includes(`◇ ${expectedTier};`), board);
			for (const clause of expectedSummary.split("; ")) ok(boardText.includes(clause), `${clause}\n${board}`);
		} finally {
			store.unsubscribe();
		}

		strictEqual(receiptTrustDetail(stateDir, runId), expectedLine);
		const metrics = evidenceMetricsFromReceipt(receipt, { envelope });
		strictEqual(metrics["evidence.trust.summary"], expectedSummary);
		strictEqual(metrics["evidence.trust.verdict"], expectedTier);
	});

	it("prints the same body from the dispatch and monitor labels", async () => {
		const root = scratchDir();
		const { envelope, receipt } = persistFixture(root, draftFor("run-labels"));
		const labels = receiptEvidenceLabels(receipt, receipt.verification, { ok: true });
		strictEqual(labels[0], `trust=${JSON.stringify(CANONICAL_SUMMARY)}`);
		strictEqual(labels[1], CANONICAL_AXES);
		const monitor = createMonitorTool({ dispatch: monitorContract([envelope]) });
		const collected = await monitor.run({ mode: "collect", run_ids: ["run-labels"] }, {});
		strictEqual(collected.kind, "ok");
		if (collected.kind !== "ok") return;
		ok(collected.output.includes(`trust=${JSON.stringify(CANONICAL_SUMMARY)}`), collected.output);
		ok(collected.output.includes(CANONICAL_AXES), collected.output);
		const detailed = await monitor.run({ mode: "receipt", run_id: "run-labels" }, {});
		strictEqual(detailed.kind, "ok");
		if (detailed.kind !== "ok") return;
		const details = detailed.details as { trust?: { text: string; verdict: string; version: number } };
		strictEqual(details.trust?.text, CANONICAL_SUMMARY);
		strictEqual(details.trust?.verdict, "grounded");
		strictEqual(details.trust?.version, 1);
	});

	it("reads the canonical tier, summary, and every axis into findings.md", async () => {
		const root = scratchDir();
		persistFixture(root, draftFor("run-bundle"));
		const stateDir = join(root, "state");
		const dataDir = join(root, "data");
		const built = await buildEvidence({ stateDir, dataDir, runId: "run-bundle" });
		const findings = readFileSync(join(built.directory, "findings.md"), "utf8");
		ok(findings.includes("tier: grounded"), findings);
		ok(findings.includes(`summary: ${CANONICAL_SUMMARY}`), findings);
		ok(findings.includes(`axes: ${CANONICAL_AXES}`), findings);
		ok(
			findings.includes(
				"independent-review run=run-bundle: run was not independently reviewed; its result rests on its own receipt",
			),
			findings,
		);
		const tags = built.findings.map((finding) => finding.tag);
		ok(tags.includes("independent-review"), tags.join(","));
		ok(!tags.includes("context-provenance"), "a valid bounded context record raises no finding");
	});

	it("distinguishes a failed, an inferred, and an absent validation on the worker text label", () => {
		const labelFor = (validation: string): string =>
			workerTextLabel(
				composeTrustStatus({
					validationGrounding:
						validation === "absent"
							? { state: "absent", reason: "not_observed" }
							: {
									state: validation as "failed" | "ungrounded",
									source: { kind: "run_receipt", id: "x" },
									authority: { kind: "validator", id: "command-grounding" },
									artifacts: [],
								},
				}),
			);
		const failed = labelFor("failed");
		const inferred = labelFor("ungrounded");
		const absent = labelFor("absent");
		strictEqual(new Set([failed, inferred, absent]).size, 3, [failed, inferred, absent].join("\n"));
		ok(failed.includes("validation failed"), failed);
		ok(inferred.includes("inferred"), inferred);
		strictEqual(absent, "worker claims (unverified prose):");
	});

	it("puts the authenticated read-back on the Alt+W board and never styles a sealed receipt green", () => {
		const root = scratchDir();
		const stateDir = join(root, "state");
		persistFixture(root, draftFor("run-board"));
		const facts = readWorkerReceiptFacts("run-board", stateDir);
		ok(facts?.trust, "the receipt reader authenticates the file against its ledger row");
		strictEqual(formatTrustSummary(facts.trust), CANONICAL_SUMMARY);

		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus, undefined, (runId) => readWorkerReceiptFacts(runId, stateDir));
		try {
			bus.emit(BusChannels.DispatchStarted, {
				runId: "run-board",
				agentId: "coder",
				executionRole: "builder",
				targetId: "local",
				wireModelId: "fixture-model",
				runtimeId: "fixture-runtime",
				runtimeKind: "http",
			} as never);
			const live = store.rows()[0];
			ok(live);
			strictEqual(live.trust, undefined, "a live run carries no verdict");
			ok(renderDispatchCard(live, 120).join("\n").replace(SGR, "").includes("not sealed yet"));

			bus.emit(BusChannels.DispatchCompleted, {
				runId: "run-board",
				agentId: "coder",
				executionRole: "builder",
				targetId: "local",
				wireModelId: "fixture-model",
				runtimeId: "fixture-runtime",
				runtimeKind: "http",
				hostVerification: "verified",
			} as never);
			const row = store.rows()[0];
			ok(row?.trust);
			strictEqual(row.trust.text, CANONICAL_SUMMARY);
			const theme = createClioTheme({ color: true, truecolor: true });
			const card = renderDispatchCard(row, 160, undefined, { theme }).join("\n");
			const plain = card.replace(SGR, "");
			const boardText = plain.replace(/[│\n]/gu, " ").replace(/\s+/gu, " ");
			ok(boardText.includes("◇ grounded;"), plain);
			for (const clause of CANONICAL_SUMMARY.split("; ")) ok(boardText.includes(clause), `${clause}\n${plain}`);
			ok(!plain.includes("…"), plain);
			ok(boardText.includes("host checks verified"), plain);
			ok(!plain.includes("host_verification="), "the raw receipt field is no longer the evidence line");
			ok(!plain.includes("not_requested"), "not_requested is not a trust state");
			ok(card.includes(theme.fgSequence("info")), "grounded renders with the info token");
			ok(!card.includes(`${theme.fgSequence("success")}◇`), "a sealed, grounded receipt is not styled as reviewed");
		} finally {
			store.unsubscribe();
		}
	});

	it("prints the same line from the receipt view and the eval bridge", () => {
		const root = scratchDir();
		const stateDir = join(root, "state");
		const { envelope, receipt } = persistFixture(root, draftFor("run-view"));
		strictEqual(receiptTrustDetail(stateDir, "run-view"), `trust v1: grounded; ${CANONICAL_SUMMARY}`);
		const metrics = evidenceMetricsFromReceipt(receipt, { envelope });
		strictEqual(metrics["evidence.trust.summary"], CANONICAL_SUMMARY);
		strictEqual(metrics["evidence.trust.verdict"], "grounded");
		strictEqual(metrics["evidence.trust.artifactIntegrity"], "verified");
		strictEqual(metrics["evidence.verification"], "verified", "the raw marker stays for suites that gate on it");
		// Without its ledger row the seal is unchecked, never broken and never verified.
		const unchecked = evidenceMetricsFromReceipt(receipt);
		strictEqual(unchecked["evidence.trust.artifactIntegrity"], "unknown");
		strictEqual(unchecked["evidence.trust.verdict"], "unknown");
	});

	it("keeps the machine projection whole on the ACP wire where the canonical references hit the depth cap", async () => {
		const root = scratchDir();
		const { envelope, receipt } = persistFixture(root, draftFor("run-acp"));
		const status = inspectRunReceiptTrustStatus(receipt, envelope).status;
		const details = { runs: [{ runId: "run-acp", trustStatus: status, trust: summarizeTrustStatus(status) }] };
		const listeners = new Set<(event: Record<string, unknown>) => void>();
		let streaming = false;
		const emit = (event: Record<string, unknown>): void => {
			for (const listener of listeners) listener(event);
		};
		const chat: AcpServerChat = {
			async submit(): Promise<void> {
				streaming = true;
				emit({ type: "agent_start" });
				emit({ type: "tool_execution_start", toolCallId: "d1", toolName: "dispatch", args: { task: "x" } });
				emit({
					type: "tool_execution_end",
					toolCallId: "d1",
					toolName: "dispatch",
					result: { kind: "ok", output: "- run-acp done", details },
					isError: false,
				});
				const message = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" };
				emit({ type: "message_end", message });
				emit({ type: "agent_end", messages: [message] });
				streaming = false;
			},
			cancel(): void {
				streaming = false;
			},
			onEvent(handler: (event: never) => void): () => void {
				listeners.add(handler as (event: Record<string, unknown>) => void);
				return () => listeners.delete(handler as (event: Record<string, unknown>) => void);
			},
			isStreaming: () => streaming,
			getSessionId: () => null,
		};
		const clientToServer = new PassThrough();
		const serverToClient = new PassThrough();
		const transport = createStdioServerTransport({ input: clientToServer, output: serverToClient });
		const server = serveClioAcpAgent({ transport, chat, cwd: process.cwd(), version: "test" });
		const notifications: Record<string, unknown>[] = [];
		const pending = new Map<number, (value: unknown) => void>();
		let nextId = 1;
		let buffer = "";
		serverToClient.setEncoding("utf8");
		serverToClient.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const idx = buffer.indexOf("\n");
				if (idx === -1) break;
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line.length === 0) continue;
				const message = JSON.parse(line) as Record<string, unknown>;
				if ("id" in message && ("result" in message || "error" in message)) {
					pending.get(Number(message.id))?.(message.result);
					pending.delete(Number(message.id));
				} else notifications.push(message);
			}
		});
		const request = <T>(method: string, params: unknown): Promise<T> => {
			const id = nextId++;
			const answer = new Promise<T>((resolve) => pending.set(id, (value) => resolve(value as T)));
			clientToServer.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return answer;
		};
		await request("initialize", { protocolVersion: 1, clientInfo: { name: "trust-test", version: "1" } });
		const session = await request<{ sessionId: string }>("session/new", { cwd: process.cwd() });
		await request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "go" }] });
		await request("session/close", { sessionId: session.sessionId });
		clientToServer.end();
		await server;

		const update = notifications
			.map((message) => (isRecord(message.params) && isRecord(message.params.update) ? message.params.update : null))
			.find((entry) => entry?.sessionUpdate === "tool_call_update" && entry.toolCallId === "d1");
		ok(update, `no tool_call_update on the wire:\n${JSON.stringify(notifications).slice(0, 400)}`);
		const raw = update.rawOutput as { result: { details: { runs: Array<Record<string, unknown>> } } };
		const run = raw.result.details.runs[0];
		ok(run);
		const trust = run.trust as { text: string; verdict: string; version: number; refs: string[] };
		strictEqual(trust.text, CANONICAL_SUMMARY, "the flat projection crosses the wire whole");
		strictEqual(trust.verdict, "grounded");
		strictEqual(trust.version, 1);
		ok(trust.refs.includes("run_receipt:run-acp"), JSON.stringify(trust.refs));
		const canonical = run.trustStatus as { artifactIntegrity: { state: string; artifacts: unknown } };
		strictEqual(canonical.artifactIntegrity.state, "verified");
		// Read off the bounder, now observed: the artifact references sit at
		// depth 8 and come back as the literal "[depth]", which is why the
		// machine projection carries its own flat reference list.
		deepStrictEqual(canonical.artifactIntegrity.artifacts, ["[depth]"]);
	});
});

describe("contracts/trust projection: vocabulary and verdict rules", () => {
	// Each axis only accepts the sources entitled to speak for it.
	const SOURCE_KIND = {
		artifactIntegrity: "receipt_integrity_verification",
		validationGrounding: "run_receipt",
		independentReview: "gate_decision",
	} as const;

	function attributed(axis: keyof typeof SOURCE_KIND, state: string): CanonicalTrustStatus {
		return composeTrustStatus({
			[axis]: {
				state,
				source: { kind: SOURCE_KIND[axis], id: "x" },
				authority: { kind: "clio", id: "dispatch" },
				artifacts: [],
			},
		} as never);
	}

	it("names every canonical state exactly once, with the words the ticket standardizes", () => {
		for (const axis of TRUST_STATUS_AXES) {
			deepStrictEqual(Object.keys(TRUST_STATE_WORDS[axis]).sort(), [...TRUST_STATUS_STATES[axis]].sort(), axis);
		}
		strictEqual(TRUST_STATE_WORDS.artifactIntegrity.verified, "sealed");
		strictEqual(TRUST_STATE_WORDS.validationGrounding.validated, "grounded");
		strictEqual(TRUST_STATE_WORDS.independentReview.passed, "independently reviewed: pass");
		ok(TRUST_STATE_WORDS.validationGrounding.ungrounded.startsWith("inferred"));
		strictEqual(TRUST_STATE_WORDS.autonomyEnforcement.enforced, "mediated");
		strictEqual(TRUST_STATE_WORDS.autonomyEnforcement.approximated, "approximated");
		strictEqual(TRUST_STATE_WORDS.autonomyEnforcement.bypassed, "bypassed");
	});

	it("keeps approximated and bypassed runtimes visibly distinct from mediated execution", () => {
		const mediated = adaptRunReceiptTrustStatus(
			{
				runId: "m",
				integrity: { version: 19, algorithm: "sha256", digest: DIGEST_A },
				autonomyEnforcement: { grade: "mediated", autonomy: "auto-edit" },
			} as never,
			{ integrity: { ok: true } },
		);
		const approximated = adaptRunReceiptTrustStatus(
			{
				runId: "a",
				integrity: { version: 19, algorithm: "sha256", digest: DIGEST_A },
				autonomyEnforcement: { grade: "approximated", autonomy: "auto-edit", externalMode: "codex" },
			} as never,
			{ integrity: { ok: true } },
		);
		const bypassed = adaptRunReceiptTrustStatus(
			{
				runId: "b",
				integrity: { version: 19, algorithm: "sha256", digest: DIGEST_A },
				autonomyEnforcement: { grade: "mediated", autonomy: "full-auto", dangerousBypass: true },
			} as never,
			{ integrity: { ok: true } },
		);
		ok(formatTrustSummary(mediated).includes("; mediated;"), formatTrustSummary(mediated));
		ok(formatTrustSummary(approximated).includes("; approximated (codex);"), formatTrustSummary(approximated));
		// A dangerous bypass under a mediated grade is Clio's own gate reporting
		// that it was bypassed, so the adapter attributes it to safety-autonomy.
		ok(formatTrustSummary(bypassed).includes("; bypassed (safety-autonomy);"), formatTrustSummary(bypassed));
		strictEqual(trustVerdict(bypassed), "compromised");
	});

	it("reserves the reviewed verdict for an authenticated independent pass", () => {
		const sealedOnly = composeTrustStatus({
			artifactIntegrity: attributed("artifactIntegrity", "verified").artifactIntegrity,
		});
		strictEqual(trustVerdict(sealedOnly), "unverified");
		const grounded = composeTrustStatus(sealedOnly, {
			validationGrounding: attributed("validationGrounding", "validated").validationGrounding,
		});
		strictEqual(trustVerdict(grounded), "grounded");
		const reviewed = composeTrustStatus(grounded, {
			independentReview: attributed("independentReview", "passed").independentReview,
		});
		strictEqual(trustVerdict(reviewed), "reviewed");
		const correlated = composeTrustStatus(grounded, {
			independentReview: attributed("independentReview", "not_independent").independentReview,
		});
		strictEqual(trustVerdict(correlated), "compromised");
		strictEqual(trustVerdict(attributed("artifactIntegrity", "unknown")), "unknown");
		strictEqual(trustVerdict(attributed("artifactIntegrity", "failed")), "compromised");
	});

	it("documents every standardized word and verdict in the glossary", () => {
		const glossary = readFileSync(join(process.cwd(), "docs", "glossary.md"), "utf8");
		for (const word of [
			"sealed",
			"grounded",
			"independently reviewed",
			"inferred",
			"mediated",
			"approximated",
			"bypassed",
		]) {
			ok(glossary.includes(`\`${word}\``), `glossary lacks ${word}`);
		}
		for (const verdict of ["reviewed", "grounded", "unverified", "compromised", "unknown"]) {
			ok(glossary.includes(`\`${verdict}\``), `glossary lacks verdict ${verdict}`);
		}
		ok(glossary.includes("`not_requested` is not a trust state"), "the confused-state entry names not_requested");
	});
});
