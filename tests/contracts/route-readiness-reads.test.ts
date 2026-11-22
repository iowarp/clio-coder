import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { RunEconomics } from "../../src/core/telemetry/economy.js";
import {
	gateDecisionsDirectory,
	materializePendingGateDecision,
	readGateDecisionArtifacts,
	stagePendingGateDecision,
} from "../../src/domains/dispatch/gate-decisions.js";
import { fixedRouteDecision, type RouteCandidate } from "../../src/domains/dispatch/route-decision.js";
import { createRouteObserver, type RouteObserver } from "../../src/domains/dispatch/route-observer.js";
import {
	compareRankedRoutes,
	estimateRoute,
	forecastRoute,
	ROUTE_POSTURES,
	type RouteAttemptEvidence,
	type RoutingPosture,
	routeScoreScale,
	scoreRoute,
} from "../../src/domains/dispatch/route-policy.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";
import type { RunEnvelope, RunResult } from "../../src/domains/dispatch/types.js";
import { foldEconomy } from "../../src/domains/telemetry/economy-fold.js";
import { createRouteHistoryFold, routeSettledLabel, telemetryRunDirectory } from "../../src/domains/telemetry/index.js";
import { fixtureEnvelope, fixtureReceiptDraft, measuredSpend } from "../harness/receipt.js";
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

	it("a sealed run whose journal changed in place is folded again, an unchanged one is not (r5-3)", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-readiness-journal-"));
		await ledger(stateDir, [sealed("run-j", true), sealed("run-k", true)]);
		const { reads, restore } = countLedgerReads(stateDir);
		after(restore);
		const fold = createRouteHistoryFold({ stateDir });
		const verified = () =>
			Object.fromEntries(
				fold
					.read()
					.runs.map((run) => [run.runId, run.sealVerified])
					.sort(),
			);
		deepStrictEqual(verified(), { "run-j": true, "run-k": true });
		reads.splice(0);

		// Appended in place: the directory's own stat and the bundle's stay as they were.
		const journal = join(telemetryRunDirectory(stateDir, "run-j"), "journal.jsonl");
		fs.appendFileSync(journal, "\n");
		deepStrictEqual(verified(), { "run-j": false, "run-k": true });
		deepStrictEqual(reads.splice(0), [join(telemetryRunDirectory(stateDir, "run-j"), "bundle.json")]);
		verified();
		deepStrictEqual(reads, [], "an unchanged sealed run is a cache hit");
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

	it("forecasts cost per accepted job with paid failures beside the estimate, never ranking on it (R4)", async () => {
		const ROUTE_B: RouteCandidate = { ...ROUTE, modelId: "model-b" };
		const history = async (failureUsd: number) => {
			const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-readiness-forecast-"));
			const runs: Array<[string, RouteCandidate, boolean, number]> = [
				...[0, 1, 2].map((index): [string, RouteCandidate, boolean, number] => [`a-ok-${index}`, ROUTE, true, 0.1]),
				...[0, 1, 2].map((index): [string, RouteCandidate, boolean, number] => [
					`a-fail-${index}`,
					ROUTE,
					false,
					failureUsd,
				]),
				...[0, 1, 2, 3, 4, 5].map((index): [string, RouteCandidate, boolean, number] => [
					`b-ok-${index}`,
					ROUTE_B,
					true,
					0.15,
				]),
			];
			for (const [runId, route, succeeded, usd] of runs) {
				const draft = fixtureReceiptDraft(fixtureEnvelope(runId));
				draft.routeDecision = fixedRouteDecision(route, "test-fixed-route");
				if (succeeded)
					draft.quality.typedValidations = [{ sourceId: "typed", validatorDigest: hash("validator"), passed: true }];
				else draft.outcome = "failed";
				await writeSettledRun(stateDir, draft, measuredSpend({ input: 100, output: 10 }, usd));
			}
			const read = createRouteObserver({ stateDir }).readinessWindow();
			const current = { costUpperBoundUsd: null, factsFresh: true };
			return { a: read.forRoute(ROUTE, current), b: read.forRoute(ROUTE_B, current) };
		};
		const ranking = (evidence: Awaited<ReturnType<typeof history>>) =>
			(Object.keys(ROUTE_POSTURES) as RoutingPosture[]).map((posture) => {
				const estimates = [estimateRoute(evidence.a.observations), estimateRoute(evidence.b.observations)];
				const scale = routeScoreScale(estimates);
				return estimates
					.map((estimate, order) => ({ key: `${order}`, order, estimate, score: scoreRoute(estimate, posture, scale) }))
					.sort(compareRankedRoutes)
					.map((route) => route.key)
					.join(">");
			});
		const cheapFailures = await history(0.1);
		const dearFailures = await history(5);
		// What failed attempts cost moves the forecast only: every posture ranks the two routes as it did before.
		deepStrictEqual(ranking(dearFailures), ranking(cheapFailures));
		deepStrictEqual(estimateRoute(dearFailures.a.observations), estimateRoute(cheapFailures.a.observations));
		const a = cheapFailures.a.forecast;
		strictEqual(a.attempts, 6);
		strictEqual(a.acceptedJobs, 3);
		deepStrictEqual(a.qualityEvidence, { labeled: 3, samples: 6, coverage: 0.5 });
		strictEqual(a.exclusion, null);
		// The forecast reads each run through the economics fold: a charge settled without known funding is unknown,
		// never free, whatever its route price, and a route with no seat has no quota debit to forecast.
		deepStrictEqual(a.costPerAcceptedJob, { status: "unknown", unpricedAttempts: 6 });
		deepStrictEqual(a.quotaPerAcceptedJob, { status: "not-applicable" });

		const missing = { kind: "unknown", reason: "not-captured" } as const;
		const local = { kind: "absent", reason: "not-applicable" } as const;
		const economics = (
			charge: number | "local",
			kind: "measured" | "estimated" = "measured",
			seatEstimate?: number,
		): RunEconomics => ({
			additive: {
				providerCharge: { amount: missing },
				marginalCharge:
					charge === "local"
						? { amount: local }
						: {
								currency: "USD",
								amount:
									kind === "measured" ? { kind, value: charge, source: "provider" } : { kind, value: charge, method: "catalog" },
							},
				seatCredits:
					seatEstimate === undefined
						? { nanoAiu: local }
						: {
								nanoAiu: { kind: "estimated", value: seatEstimate, method: "seat-listing-tariff" },
								listingAsOf: "2030-01-01",
							},
				energy: { kwh: local, cost: { amount: local } },
			},
			comparison: { apiEquivalent: { amount: missing } },
			funding: missing,
		});
		const attempt = (
			accepted: boolean,
			run: RunEconomics,
			reportedNanoAiu?: { kind: "measured"; value: number; source: "provider" },
		): RouteAttemptEvidence => {
			const { marginalCharge, seatCredits } = foldEconomy([
				{
					ref: { kind: "run", runId: `run-${Math.random()}` },
					at: null,
					economics: run,
					settled: true,
					...(reportedNanoAiu ? { reportedNanoAiu } : {}),
					cut: { role: "worker", model: "m", target: "t" },
				},
			]).total;
			return { accepted, marginalCharge, seatCredits };
		};
		const charged = (attempts: RouteAttemptEvidence[]) => {
			const forecast = forecastRoute({ observations: [], attempts }).costPerAcceptedJob;
			if (forecast.status !== "forecast") throw new Error(`expected a forecast, got ${forecast.status}`);
			ok(forecast.range.low <= forecast.expected && forecast.expected <= (forecast.range.high ?? Infinity));
			return forecast;
		};
		// Cheaper per attempt, yet its paid failures make each accepted job dearer than the reliable route's.
		const retryHeavy = charged([
			...[0, 1, 2].map(() => attempt(true, economics(0.1))),
			...[0, 1, 2].map(() => attempt(false, economics(0.1))),
		]);
		const reliable = charged([0, 1, 2, 3, 4, 5].map(() => attempt(true, economics(0.15))));
		ok(Math.abs(retryHeavy.expected - 0.2) < 1e-9);
		ok(retryHeavy.expected > reliable.expected);
		deepStrictEqual([retryHeavy.currency, retryHeavy.basis], ["USD", "measured"]);
		// A skewed sample keeps its expectation inside the range, and one estimated charge marks the whole figure.
		charged([...Array.from({ length: 20 }, () => attempt(true, economics(0.1))), attempt(true, economics(100))]);
		charged([attempt(false, economics(0.01)), ...Array.from({ length: 20 }, () => attempt(true, economics(1)))]);
		const mixed = charged([
			...Array.from({ length: 6 }, () => attempt(true, economics(0.1))),
			attempt(true, economics(0.1, "estimated")),
		]);
		strictEqual(mixed.basis, "estimated");
		// A local route carries no extra charge at all; one unknown charge among priced ones is unknown, not free.
		const localRoute = forecastRoute({
			observations: [],
			attempts: Array.from({ length: 6 }, () => attempt(true, economics("local"))),
		});
		deepStrictEqual(localRoute.costPerAcceptedJob, { status: "not-applicable" });
		deepStrictEqual(localRoute.quotaPerAcceptedJob, { status: "not-applicable" });
		const unpriced: RunEconomics = {
			...economics(0.1),
			additive: { ...economics(0.1).additive, marginalCharge: { amount: missing } },
		};
		deepStrictEqual(
			forecastRoute({
				observations: [],
				attempts: [...Array.from({ length: 6 }, () => attempt(true, economics(0.1))), attempt(true, unpriced)],
			}).costPerAcceptedJob,
			{ status: "unknown", unpricedAttempts: 1 },
		);
		// The seat's reported debit wins over its listing estimate, so a measured quota forecast is reachable.
		const seat = (reported: boolean) =>
			forecastRoute({
				observations: [],
				attempts: Array.from({ length: 6 }, () =>
					attempt(
						true,
						economics(0, "measured", 2e9),
						reported ? { kind: "measured", value: 1e9, source: "provider" } : undefined,
					),
				),
			}).quotaPerAcceptedJob;
		deepStrictEqual(seat(true), { status: "forecast", unit: "nano-aiu", expected: 1e9, basis: "measured" });
		deepStrictEqual(seat(false), { status: "forecast", unit: "nano-aiu", expected: 2e9, basis: "estimated" });

		const cold = mkdtempSync(join(tmpdir(), "clio-coder-readiness-forecast-cold-"));
		await ledger(cold, [sealed("cold-1", true), sealed("cold-2", true)]);
		const coldForecast = window(createRouteObserver({ stateDir: cold })).forecast;
		deepStrictEqual(coldForecast.costPerAcceptedJob, { status: "insufficient", reason: "cold" });
		deepStrictEqual(coldForecast.quotaPerAcceptedJob, { status: "insufficient", reason: "cold" });
	});
});
