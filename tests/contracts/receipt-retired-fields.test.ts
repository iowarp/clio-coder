/** Run results omit retired fields and settlement rejects undeclared hashes (#434). */
import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { resolveRunTerminalReason } from "../../src/domains/dispatch/outcome.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";

import type { RunResultDraft } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

const RETIRED_TOP_LEVEL = ["attestation", "pathScope", "fleetGate", "ledgerContribution", "staticShellHash"] as const;

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

			equal(typeof receipt.terminalReason, "string", "a sealed worker receipt names how its loop ended");
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

describe("run settlement (#434)", () => {
	it("refuses to seal a hash the declaration set does not name", () => {
		const envelope = fixtureEnvelope("v21-undeclared");
		const draft = { ...fixtureReceiptDraft(envelope), novelDigest: "a".repeat(64) } as unknown as RunResultDraft;
		throws(
			() =>
				finishRunResult(draft, envelope, {
					terminal: { terminalReason: draft.terminalReason ?? "completed" },
					processExitCode: envelope.exitCode,
					frameType: null,
					usage: undefined,
				}).result,
			/undeclared hashes novelDigest/,
		);
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
		equal(
			typeof finishRunResult(peer, envelope, {
				terminal: { terminalReason: peer.terminalReason ?? "completed" },
				processExitCode: envelope.exitCode,
				frameType: null,
				usage: undefined,
			}).result.digest,
			"string",
		);
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
		equal(
			typeof finishRunResult(structured, envelope, {
				terminal: { terminalReason: structured.terminalReason ?? "completed" },
				processExitCode: envelope.exitCode,
				frameType: null,
				usage: undefined,
			}).result.digest,
			"string",
		);
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
