import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	gateDecisionsDirectory,
	materializePendingGateDecision,
	readGateDecisionArtifacts,
	stagePendingGateDecision,
} from "../../src/domains/dispatch/gate-decisions.js";
import { fixedRouteDecision, type RouteCandidate } from "../../src/domains/dispatch/route-decision.js";
import { createRouteObserver, type RouteObserver } from "../../src/domains/dispatch/route-observer.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";
import type { RunEnvelope, RunResult } from "../../src/domains/dispatch/types.js";
import { createRouteHistoryFold, routeSettledLabel, telemetryRunDirectory } from "../../src/domains/telemetry/index.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { writeSettledRun } from "../harness/settled-run.js";

function hash(seed: string): string {
	return createHash("sha256").update(seed, "utf8").digest("hex");
}

const ROUTE: RouteCandidate = {
	agentId: "coder",
	specFingerprint: hash("spec"),
	executionRole: "builder",
	targetId: "local",
	modelId: "model-a",
	runtimeId: "openai",
	nodeId: "local",
	thinkingLevel: "off",
	toolSignature: hash("tools"),
	promptCompositionHash: hash("prompt"),
	endpointIdentityHash: hash("endpoint"),
	settingsFingerprint: hash("settings"),
};

/** Every durable write in the dispatch domain is tmp-and-rename; the fixture writes the same way. */
function writeRenamed(path: string, body: string): void {
	writeFileSync(`${path}.tmp`, body);
	renameSync(`${path}.tmp`, path);
}

function sealed(runId: string, passed: boolean): { envelope: RunEnvelope; receipt: RunResult } {
	const envelope = fixtureEnvelope(runId);
	const draft = fixtureReceiptDraft(envelope);
	draft.routeDecision = fixedRouteDecision(ROUTE, "test-fixed-route");
	draft.quality.typedValidations = [{ sourceId: "typed", validatorDigest: hash("validator"), passed }];
	return {
		envelope,
		receipt: finishRunResult(draft, envelope, {
			terminal: { terminalReason: draft.terminalReason ?? "completed" },
			processExitCode: envelope.exitCode,
			frameType: null,
			usage: undefined,
		}).result,
	};
}

async function ledger(
	stateDir: string,
	runs: ReadonlyArray<{ envelope: RunEnvelope; receipt: RunResult }>,
): Promise<void> {
	for (const run of runs) await writeSettledRun(stateDir, run.receipt);
}

function window(observer: RouteObserver) {
	return observer.readinessWindow().forRoute(ROUTE, { costUpperBoundUsd: null, factsFresh: true });
}

/**
 * Count real `readFileSync` calls under the state directory's run bundle and
 * gate paths. Patching the module object and re-syncing the builtin's ESM
 * bindings reaches every importer, so the count holds for any implementation.
 */
function countLedgerReads(stateDir: string): { reads: string[]; restore: () => void } {
	const reads: string[] = [];
	const original = fs.readFileSync;
	const originalOpen = fs.openSync;
	const tracked = (path: unknown): boolean =>
		typeof path === "string" &&
		path.startsWith(stateDir) &&
		(path.endsWith("/bundle.json") || path.includes("/gate-decisions/"));
	fs.readFileSync = ((path: unknown, ...rest: unknown[]) => {
		if (tracked(path) && !(path as string).endsWith("/bundle.json")) reads.push(path as string);
		return (original as (...args: unknown[]) => unknown)(path, ...rest);
	}) as typeof fs.readFileSync;
	fs.openSync = ((path: unknown, ...rest: unknown[]) => {
		// Bundles and gate artifacts are opened without following symlinks, then read by descriptor.
		if (tracked(path)) reads.push(path as string);
		return (originalOpen as (...args: unknown[]) => number)(path, ...rest);
	}) as typeof fs.openSync;
	syncBuiltinESMExports();
	return {
		reads,
		restore() {
			fs.readFileSync = original;
			fs.openSync = originalOpen;
			syncBuiltinESMExports();
		},
	};
}

describe("contracts/route readiness reads", () => {
	it("a dispatch reads only the run bundles sealed since the previous one", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-readiness-reads-"));
		const runs = Array.from({ length: 12 }, (_, index) => sealed(`run-${index}`, true));
		await ledger(stateDir, runs);
		const { reads, restore } = countLedgerReads(stateDir);
		after(restore);
		const observer = createRouteObserver({ stateDir });

		// Each check takes the reads since the previous one.
		const drain = (): string[] => reads.splice(0).sort();

		observer.readinessWindow();
		strictEqual(drain().length, 12, "the first window reads all twelve run bundles");

		observer.readinessWindow();
		observer.readinessWindow();
		deepStrictEqual(drain(), [], "an unchanged ledger costs no file reads");

		const added = sealed("run-12", true);
		runs.push(added);
		await writeSettledRun(stateDir, added.receipt);
		observer.readinessWindow();
		deepStrictEqual(drain(), [join(telemetryRunDirectory(stateDir, "run-12"), "bundle.json")]);

		// A rewrite of an existing bundle lands on a new inode and is read again.
		const bundlePath = join(telemetryRunDirectory(stateDir, "run-3"), "bundle.json");
		writeRenamed(bundlePath, readFileSync(bundlePath, "utf8"));
		observer.readinessWindow();
		deepStrictEqual(drain(), [bundlePath]);

		const gates = gateDecisionsDirectory(stateDir);
		mkdirSync(gates, { recursive: true });
		writeRenamed(join(gates, "g-1.json"), JSON.stringify({ kind: "not-a-verifiable-artifact" }));
		observer.readinessWindow();
		deepStrictEqual(drain(), [join(gates, "g-1.json")], "a new gate artifact is the only read");
		observer.readinessWindow();
		deepStrictEqual(drain(), [], "a rejected gate artifact is not re-read either");
	});

	it("warmup folds only the bounded runs, newest first, and never opens one past the 30-day bound (Astra r5-4)", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-readiness-warm-"));
		await ledger(stateDir, [sealed("run-old", true), sealed("run-mid", true), sealed("run-new", true)]);
		const day = 24 * 60 * 60;
		const now = Date.now() / 1000;
		for (const [runId, age] of [
			["run-old", 40 * day],
			["run-mid", 2 * day],
			["run-new", day],
		] as const)
			fs.utimesSync(telemetryRunDirectory(stateDir, runId), now - age, now - age);
		const { reads, restore } = countLedgerReads(stateDir);
		after(restore);
		const fold = createRouteHistoryFold({ stateDir });
		await fold.warm?.(() => false);
		const bundle = (runId: string) => join(telemetryRunDirectory(stateDir, runId), "bundle.json");
		deepStrictEqual(reads.splice(0), [bundle("run-new"), bundle("run-mid")]);
		deepStrictEqual(
			fold.read().runs.map((run) => run.runId),
			["run-new", "run-mid"],
		);
		deepStrictEqual(reads, [], "the read finds every bounded run warmed");
	});

	it("gate decision reads verify each artifact once and a rewritten one again", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-gate-reads-"));
		const subject = { runId: "candidate", digest: "a".repeat(64) };
		const written = [];
		for (const group of ["gate-a", "gate-b"]) {
			const handle = stagePendingGateDecision(
				{
					group,
					topology: "compete",
					cycle: 1,
					outcome: "yolo-applied",
					subjects: [subject],
					winner: { index: 1, subject, branch: `clio-coder/compete/${group}/1` },
					confirmation: { id: "judge", digest: "b".repeat(64) },
					detail: "applied judge",
				},
				{ stateDir, telemetry: { sessionId: null, runId: group, agent: { role: "coordinator", id: group } } },
			);
			written.push(await materializePendingGateDecision(handle));
		}
		const { reads, restore } = countLedgerReads(stateDir);
		after(restore);
		const drain = (): string[] => reads.splice(0).sort();
		const groups = (): string[] => readGateDecisionArtifacts(undefined, stateDir).map(({ artifact }) => artifact.group);

		deepStrictEqual(groups(), ["gate-a", "gate-b"]);
		strictEqual(drain().length, 2, "the first read verifies both artifacts");
		deepStrictEqual(groups(), ["gate-a", "gate-b"]);
		deepStrictEqual(drain(), [], "an unchanged archive costs no file reads");
		strictEqual(Object.isFrozen(readGateDecisionArtifacts("gate-a", stateDir)[0]?.artifact.winner), true);

		// Same size, altered body, rewritten in place: verified again and rejected.
		const forgedPath = written[0]?.path ?? "";
		writeFileSync(forgedPath, readFileSync(forgedPath, "utf8").replace("applied judge", "applied JUDGE"));
		drain();
		deepStrictEqual(groups(), ["gate-b"]);
		deepStrictEqual(drain(), [forgedPath]);
		rmSync(written[1]?.path ?? "");
		deepStrictEqual(groups(), []);
	});

	it("route history folds each sealed run.settled under its executed route", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-readiness-history-"));
		await ledger(stateDir, [sealed("run-a", true)]);
		const evidence = window(createRouteObserver({ stateDir }));
		strictEqual(evidence.observations.length, 1);
		strictEqual(evidence.observations[0]?.qualityLabel, "pass");
		strictEqual(evidence.readiness.integrityFailures, 0);
		strictEqual(window(createRouteObserver({ stateDir })).observations.length, 1, "a restart folds the same history");
	});

	it("a route decision over a wide catalog still settles: candidate hashes stay under decisionHash", async () => {
		// A shadow decision over 64 candidates listed 685 hashes, past run.settled's 512, and no worker run settled.
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-readiness-wide-"));
		const envelope = fixtureEnvelope("run-wide");
		const draft = fixtureReceiptDraft(envelope);
		const decision = fixedRouteDecision(ROUTE, "test-fixed-route");
		const evaluation = decision.candidateEvaluations[0];
		if (evaluation === undefined) throw new Error("fixed route decision has no candidate evaluation");
		decision.candidateEvaluations = Array.from({ length: 128 }, () => structuredClone(evaluation));
		draft.routeDecision = decision;
		const receipt = finishRunResult(draft, envelope, {
			terminal: { terminalReason: draft.terminalReason ?? "completed" },
			processExitCode: envelope.exitCode,
			frameType: null,
			usage: undefined,
		}).result;
		await ledger(stateDir, [{ envelope, receipt }]);
		deepStrictEqual(
			createRouteHistoryFold({ stateDir })
				.read()
				.entries.map((entry) => entry.settled),
			["success"],
		);
	});

	it("every settled route carries its run's outcome label", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-readiness-settled-"));
		const ok = sealed("run-ok", true);
		const capped = fixtureEnvelope("run-cap");
		const cappedDraft = fixtureReceiptDraft(capped);
		cappedDraft.routeDecision = fixedRouteDecision(ROUTE, "test-fixed-route");
		cappedDraft.outcome = "failed";
		cappedDraft.outcomeCode = "worker_tool_call_cap_exhausted";
		const failed = {
			envelope: capped,
			receipt: finishRunResult(cappedDraft, capped, {
				terminal: { terminalReason: cappedDraft.terminalReason ?? "completed" },
				processExitCode: capped.exitCode,
				frameType: null,
				usage: undefined,
			}).result,
		};
		await ledger(stateDir, [ok, failed]);
		deepStrictEqual(
			createRouteHistoryFold({ stateDir })
				.read()
				.entries.map((entry) => entry.settled)
				.sort(),
			["success", "worker_tool_call_cap_exhausted"],
		);
		strictEqual(
			routeSettledLabel({ outcome: "failed", outcomeDetail: "permission_required; refused" }),
			"permission_required",
		);
		strictEqual(routeSettledLabel({ outcome: "timed_out" }), "timed_out");
		strictEqual(routeSettledLabel({ outcome: "failed", outcomeDetail: "exit code 1" }), "failure");
	});

	it("a bundle rewritten in place is verified again, never trusted from the cache", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-readiness-tamper-"));
		await ledger(stateDir, [sealed("run-t", true)]);
		const observer = createRouteObserver({ stateDir });
		strictEqual(window(observer).observations[0]?.qualityLabel, "pass");

		// Same digest, altered body: a forged bundle claiming a verified identity.
		const bundlePath = join(telemetryRunDirectory(stateDir, "run-t"), "bundle.json");
		const forged = { ...JSON.parse(readFileSync(bundlePath, "utf8")), version: 2 };
		writeFileSync(bundlePath, JSON.stringify(forged));
		const evidence = window(observer);
		strictEqual(evidence.observations[0]?.qualityLabel, "unmeasured");
		strictEqual(evidence.readiness.integrityFailures, 1);
	});
});
