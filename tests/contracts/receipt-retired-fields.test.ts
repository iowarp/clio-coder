/**
 * Receipts stopped sealing seven fields nothing read: the worker attestation
 * projection, `pathScope`, `fleetGate`, `ledgerContribution`, the duplicate
 * `staticShellHash`, `identity.hpc` and `reproducibility.git`. New receipts
 * omit them. A receipt an earlier build sealed with them must still verify,
 * be adopted by orphan recovery, and pass the `/view` verifier.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { recoverOrphanReceipts } from "../../src/domains/dispatch/orphan-recovery.js";
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { RunEnvelope, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
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
		} as unknown as RunReceiptDraft;
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
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
