/**
 * Receipts stopped sealing seven fields nothing read: the worker attestation
 * projection, `pathScope`, `fleetGate`, `ledgerContribution`, the duplicate
 * `staticShellHash`, `identity.hpc` and `reproducibility.git`. New receipts
 * omit them. A receipt an earlier build sealed with them must still verify,
 * be adopted by orphan recovery, and pass the `/view` verifier.
 */
import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { recoverOrphanReceipts } from "../../src/domains/dispatch/orphan-recovery.js";
import { resolveRunTerminalReason } from "../../src/domains/dispatch/outcome.js";
import { RECEIPT_HASH_SET } from "../../src/domains/dispatch/receipt-hashes.js";
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { RunEnvelope, RunResultDraft } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { verifyReceiptFileReport } from "../../src/interactive/view/artifacts.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

const RETIRED_TOP_LEVEL = ["attestation", "pathScope", "fleetGate", "ledgerContribution", "staticShellHash"] as const;

describe("receipts sealed with the retired fields", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("verify, are adopted by orphan recovery, and pass the /view verifier", async () => {
		const identity = {
			host: "node-a",
			user: "operator",
			hpc: { scheduler: "slurm" as const, jobId: "4242", jobName: "clio", cluster: "ares" },
		};
		const envelope: RunEnvelope = {
			...fixtureEnvelope("legacy-fields"),
			identity,
			staticShellHash: "b".repeat(64),
		};
		const draft = {
			...fixtureReceiptDraft(envelope),
			identity,
			staticCompositionHash: "b".repeat(64),
			staticShellHash: "b".repeat(64),
			pathScope: { version: 1, mode: "declared", writeBoundaries: [], readRoots: [], fields: [] },
			attestation: {
				protocolVersion: 1,
				host: "node-a",
				pid: 4242,
				processGroupId: 4242,
				settingsFingerprint: "c".repeat(64),
				specDigest: "d".repeat(64),
				targetId: envelope.targetId,
				endpointIdentityHash: "e".repeat(64),
				wireModelId: envelope.wireModelId,
				runtimeId: envelope.runtimeId,
				toolSignature: "f".repeat(64),
				resources: { labels: [], cpuCount: 8, totalMemoryBytes: null, gpuCount: null, vramBytes: null },
			},
			fleetGate: { path: "gates/review.md", pathHash: "a".repeat(64) },
			ledgerContribution: { ledgerId: "ledger-1", posted: 2, refused: 0, digest: "9".repeat(64) },
			reproducibility: {
				cwd: envelope.cwd,
				git: { branch: "main", commit: "1".repeat(40), dirty: false, dirtyEntries: 0, statusHash: null },
				safetyPolicy: {
					version: 1,
					rulePackHash: null,
					rulePackVersion: null,
					projectPolicyPath: null,
					projectPolicyHash: null,
					projectPolicyValid: null,
				},
			},
		} as unknown as RunResultDraft;
		const receipt = withReceiptIntegrity(draft, envelope);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });

		const receipts = join(clioStateDir(), "receipts");
		mkdirSync(receipts, { recursive: true });
		writeFileSync(join(receipts, `${receipt.runId}.json`), JSON.stringify(receipt));
		const ledger = openLedger({ maxRuns: 10 });
		equal(recoverOrphanReceipts(ledger).recovered, 1);
		equal(ledger.get(receipt.runId)?.staticShellHash, "b".repeat(64));
		await ledger.persist();

		const report = verifyReceiptFileReport(clioStateDir(), receipt.runId);
		ok(
			report.checks.every((check) => check.ok),
			JSON.stringify(report.checks),
		);
	});
});

describe("new receipts", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("omit the retired fields", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			heartbeatIntervalMs: 3_600_000,
			spawnWorker: () => {
				const worker: SpawnedWorker = {
					pid: null,
					promise: Promise.resolve({ exitCode: 0, signal: null }),
					heartbeatAt: { current: Date.now(), monotonic: performance.now() },
					abort: () => {},
					send: () => true,
					events: (async function* () {})(),
				};
				return worker;
			},
		});
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch({
				agentId: "scout",
				executionRole: "researcher",
				task: "Inspect isolated fixture evidence.",
				requestOrigin: "internal",
				resultContractOverride: { kind: "provenance-report" },
			});
			const receipt = (await run.finalPromise) as unknown as Record<string, unknown>;
			for (const field of RETIRED_TOP_LEVEL) equal(field in receipt, false, `${field} must not be sealed`);
			const identity = receipt.identity as Record<string, unknown>;
			equal("hpc" in identity, false, "identity.hpc must not be sealed");
			const reproducibility = receipt.reproducibility as Record<string, unknown>;
			equal("git" in reproducibility, false, "reproducibility.git must not be sealed");
			const envelope = bundle.contract.getRun(String(receipt.runId)) as unknown as Record<string, unknown>;
			equal("staticShellHash" in envelope, false, "the ledger row must not carry staticShellHash");
			equal(receipt.hashSet, RECEIPT_HASH_SET);
			equal(typeof receipt.terminalReason, "string", "a sealed worker receipt names how its loop ended");
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

describe("receipt v21 seal (#434)", () => {
	it("verifies against its ledger row, and alone as ledger evicted once the row is gone", () => {
		const envelope = fixtureEnvelope("v21-seal");
		const receipt = withReceiptIntegrity(fixtureReceiptDraft(envelope), envelope);
		equal(receipt.hashSet, RECEIPT_HASH_SET);
		equal(receipt.integrity.ledger.label, "commitment");
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
		deepStrictEqual(verifyReceiptIntegrity(receipt, null), { ok: true, ledgerEvicted: true });
		equal(verifyReceiptIntegrity({ ...receipt, tokenCount: receipt.tokenCount + 1 }, null).ok, false);
		const forged = { ...receipt.integrity, ledger: { ...receipt.integrity.ledger, digest: "0".repeat(64) } };
		equal(verifyReceiptIntegrity({ ...receipt, integrity: forged }, envelope).ok, false);
	});

	it("refuses to seal a hash the declaration set does not name", () => {
		const envelope = fixtureEnvelope("v21-undeclared");
		const draft = { ...fixtureReceiptDraft(envelope), novelDigest: "a".repeat(64) } as unknown as RunResultDraft;
		throws(() => withReceiptIntegrity(draft, envelope), /undeclared hashes novelDigest/);
		// Peer JSON sealed verbatim (ACP capabilities, tool-call inputs) carries the peer's keys, not Clio's hashes.
		const peer = {
			...fixtureReceiptDraft(envelope),
			delegation: {
				agentConfigId: "peer",
				command: "peer",
				args: [],
				acpSessionId: null,
				acpProtocolVersion: 1,
				acpAgentName: null,
				acpAgentVersion: null,
				agentCapabilities: { promptHash: "p".repeat(64) },
				toolCallsRequested: 1,
				toolCallsApproved: 1,
				toolCallsDenied: 0,
				toolGovernance: "clio-coder-policy",
				toolCallLog: [
					{
						callId: "call-1",
						tool: "bash",
						arguments: { digest: "d".repeat(64) },
						decision: "approved",
						durationMs: 1,
						timestamp: envelope.startedAt,
					},
				],
			},
		} as unknown as RunResultDraft;
		equal(withReceiptIntegrity(peer, envelope).hashSet, RECEIPT_HASH_SET);
		// A worker's structured result carries the model's keys too.
		const structured = {
			...fixtureReceiptDraft(envelope),
			output: {
				state: "final",
				text: "{}",
				bytes: 2,
				truncated: false,
				structured: { version: 1, kind: "scout-report", data: { commitHash: "c".repeat(40) } },
			},
		} as unknown as RunResultDraft;
		equal(withReceiptIntegrity(structured, envelope).hashSet, RECEIPT_HASH_SET);
	});

	it("names how the worker loop ended apart from the host's verdict", () => {
		const evidence = {
			exitCode: 0,
			abortedByOperator: false,
			stallKilled: false,
			timedOut: false,
			permissionFailure: false,
			policyDenied: null,
			stopReason: null,
		};
		deepStrictEqual(resolveRunTerminalReason(evidence, "host_verification_rejected"), { terminalReason: "completed" });
		deepStrictEqual(resolveRunTerminalReason(evidence, "worker_final_output_missing"), {
			terminalReason: "final_output_missing_no_repair",
		});
		deepStrictEqual(resolveRunTerminalReason({ ...evidence, exitCode: 1 }, "result_contract_exhausted"), {
			terminalReason: "contract_exhausted_after_repair",
		});
		deepStrictEqual(resolveRunTerminalReason({ ...evidence, exitCode: 1 }, "worker_tool_call_cap_exhausted"), {
			terminalReason: "bound_reached",
			boundKind: "tools",
		});
		const aborted = { ...evidence, exitCode: null, abortedByOperator: true };
		deepStrictEqual(resolveRunTerminalReason({ ...aborted, abortCause: "parent" }, null), {
			terminalReason: "cancelled_by_parent",
		});
		deepStrictEqual(resolveRunTerminalReason({ ...aborted, abortCause: "timeout" }, null), {
			terminalReason: "bound_reached",
			boundKind: "time",
		});
		deepStrictEqual(resolveRunTerminalReason(aborted, null), { terminalReason: "cancelled_by_operator" });
		deepStrictEqual(resolveRunTerminalReason({ ...evidence, stopReason: "cancelled" }, null), {
			terminalReason: "cancelled_by_peer",
		});
		deepStrictEqual(resolveRunTerminalReason({ ...evidence, exitCode: 1, channelFailure: "steer" }, null), {
			terminalReason: "channel_failure",
		});
	});
});
