/**
 * `clio-coder fleet view` data sources and render.
 *
 * The viewer reads three durable artifacts in order (ledger envelope, event
 * journal, sealed receipt) and reduces them to a pure render. This exercises
 * that reduction against a fixture of all three, with no PTY and no TUI: the
 * follow loop paints exactly the lines `renderRunView` returns, so asserting
 * the strings is asserting what an operator sees.
 */

import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	FLEET_INSPECT_MAX_EVENTS,
	FLEET_INSPECT_MAX_ROOTS,
	FLEET_INSPECT_MAX_RUNS,
	FLEET_INSPECT_MAX_STEPS,
	fleetInspectSnapshot,
} from "../../src/cli/fleet-inspect.js";
import { FleetVerifyUnknownRunError, fleetVerifySnapshot } from "../../src/cli/fleet-verify.js";
import { loadRunViewModel, type RunViewModel, renderRunView, resolveRunId } from "../../src/cli/fleet-view.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { createRunEventJournal } from "../../src/domains/dispatch/run-event-journal.js";
import { type Ledger, openLedger, writeFleetRun } from "../../src/domains/dispatch/state.js";
import type { RunLineage, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const lineage: RunLineage = {
	parentRunId: null,
	rootRunId: "view-root",
	attempt: 0,
	depth: 0,
};
const identity = { host: "view-host", user: "view-user", hpc: null };

function receiptDraft(runId: string, task: string, startedAt: string, endedAt: string): RunReceiptDraft {
	return {
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
			responseSchema: {
				sourceId: null,
				schemaDigest: null,
				runtimeEnforceable: false,
				enforcementPassed: null,
			},
			resultContract: null,
		},
		costProvenance: "unknown",
		runId,
		agentId: "tester",
		executionRole: "builder",
		task,
		targetId: "local-lmstudio",
		wireModelId: "qwen3-coder",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		outcome: "succeeded",
		outcomeDetail: null,
		lineage,
		identity,
		startedAt,
		endedAt,
		exitCode: 0,
		tokenCount: 3,
		inputTokenCount: 2,
		outputTokenCount: 1,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		promptSignature: "prompt-signature",
		toolSignature: "tool-signature",
		clioVersion: "test",
		piMonoVersion: "test",
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: 0,
		toolStats: [],
		toolActivity: {
			calls: 0,
			succeeded: 0,
			failed: 0,
			blocked: 0,
			mutatingSucceeded: false,
		},
		reproducibility: {
			cwd: "/tmp/fleet-view",
			git: {
				branch: null,
				commit: null,
				dirty: null,
				dirtyEntries: null,
				statusHash: null,
			},
			safetyPolicy: {
				version: 1,
				rulePackHash: null,
				rulePackVersion: null,
				projectPolicyPath: null,
				projectPolicyHash: null,
				projectPolicyValid: null,
			},
		},
		sessionId: null,
	};
}

interface Fixture {
	runId: string;
	ledger: Ledger;
}

/** A finished run with a ledger row, a journal, and a sealed receipt. */
async function seedRun(task: string): Promise<Fixture> {
	const ledger = openLedger({ maxRuns: 20 });
	const run = ledger.create({
		agentId: "tester",
		executionRole: "builder",
		task,
		targetId: "local-lmstudio",
		wireModelId: "qwen3-coder",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		sessionId: null,
		cwd: "/tmp/fleet-view",
	});
	const journal = createRunEventJournal({});
	journal.open(run.id, "tester");
	journal.append(run.id, {
		at: "2026-08-30T10:00:00.000Z",
		type: "message_end",
		detail: "read src/index.ts",
	});
	journal.append(run.id, {
		at: "2026-08-30T10:00:01.000Z",
		type: "clio_tool_finish",
		detail: "read ok",
	});
	// Both stamps are fixed so the header's elapsed is a deterministic 30s.
	const startedAt = "2026-08-30T10:00:00.000Z";
	const endedAt = "2026-08-30T10:00:30.000Z";
	ledger.update(run.id, {
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: null,
		lineage,
		identity,
		startedAt,
		endedAt,
		exitCode: 0,
		tokenCount: 3,
		inputTokenCount: 2,
		outputTokenCount: 1,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		promptSignature: "prompt-signature",
		toolSignature: "tool-signature",
		costUsd: 0,
	});
	const receipt = ledger.recordReceipt(run.id, receiptDraft(run.id, task, startedAt, endedAt));
	journal.receipt(run.id, {
		outcome: receipt.outcome,
		exitCode: receipt.exitCode,
		digest: receipt.integrity.digest,
	});
	journal.terminal(run.id, receipt.outcome);
	journal.flush();
	await ledger.persist();
	return { runId: run.id, ledger };
}

function line(model: RunViewModel, prefix: string): string {
	const found = renderRunView(model, 120).find((candidate) => candidate.startsWith(prefix));
	ok(found !== undefined, `no rendered line starting with ${JSON.stringify(prefix)}`);
	return found;
}

describe("fleet view data sources", () => {
	it("projects a fixed bounded recent-run window without receipt or journal paths", async () => {
		const isolated = await isolateClioEnv("clio-fleet-inspect-");
		try {
			const fixture = await seedRun("inspect the durable boundary");
			const snapshot = fleetInspectSnapshot(() => Date.parse("2026-08-30T10:01:00.000Z"));
			strictEqual(snapshot.version, 1);
			strictEqual(snapshot.generatedAt, "2026-08-30T10:01:00.000Z");
			strictEqual(snapshot.runs.length, 1);
			const run = snapshot.runs[0];
			ok(run !== undefined);
			strictEqual(run.runId, fixture.runId);
			strictEqual(run.journal, "available");
			strictEqual(run.evidence.state, "verified");
			strictEqual(run.terminal, true);
			strictEqual(run.events.length <= FLEET_INSPECT_MAX_EVENTS, true);
			strictEqual(snapshot.runs.length <= FLEET_INSPECT_MAX_RUNS, true);
			strictEqual(JSON.stringify(snapshot).includes("/receipts/"), false);
			strictEqual(JSON.stringify(snapshot).includes("events.ndjson"), false);
			// An installation with no fleet roots reports an empty, untruncated index
			// rather than omitting the field: absence and unread are different facts.
			deepStrictEqual(snapshot.roots, []);
			strictEqual(snapshot.rootsTruncated, false);
		} finally {
			isolated.restore();
		}
	});

	it("indexes recent fleet roots to their planned steps and terminal run ids", async () => {
		const isolated = await isolateClioEnv("clio-fleet-inspect-roots-");
		try {
			const fixture = await seedRun("dispatch one fleet step");
			await writeFleetRun({
				version: 1,
				id: "fleet-345ea2e6c1ad",
				fleet: "build-review",
				planHash: "plan-hash",
				stepIds: ["build", "apply"],
				planSteps: [],
				vars: {},
				startedAt: "2026-08-30T10:00:00.000Z",
				endedAt: null,
				resumedFrom: null,
				steps: [
					{
						stepId: "build",
						result: {
							stepId: "build",
							assignmentId: "assignment-build",
							terminalRunId: fixture.runId,
							receiptDigest: "digest-build",
							output: "build output",
							succeeded: true,
							integrityValid: true,
						},
					},
				],
			});

			const snapshot = fleetInspectSnapshot(() => Date.parse("2026-08-30T10:01:00.000Z"));
			strictEqual(snapshot.roots.length, 1);
			strictEqual(snapshot.rootsTruncated, false);
			const root = snapshot.roots[0];
			ok(root !== undefined);
			strictEqual(root.rootId, "fleet-345ea2e6c1ad");
			strictEqual(root.fleet, "build-review");
			// No end stamp means the fleet is still in flight, and elapsed is measured
			// against the injected clock rather than the wall.
			strictEqual(root.running, true);
			strictEqual(root.elapsedMs, 60_000);
			strictEqual(root.plannedSteps, 2);
			strictEqual(root.recordedSteps, 1);
			strictEqual(root.stepsTruncated, false);
			deepStrictEqual(
				root.steps.map((step) => [step.stepId, step.runId, step.outcome, step.agentId, step.detail]),
				[
					["build", fixture.runId, "succeeded", "tester", null],
					// Planned but never reached: on the index, without a run id.
					["apply", null, "not run", null, null],
				],
			);
			strictEqual(root.steps.length <= FLEET_INSPECT_MAX_STEPS, true);
			strictEqual(snapshot.roots.length <= FLEET_INSPECT_MAX_ROOTS, true);
			// The root index is a pointer into the run window, not a second copy of
			// its evidence, so no receipt or journal location rides along with it.
			const framed = JSON.stringify(snapshot.roots);
			strictEqual(framed.includes("/receipts/"), false);
			strictEqual(framed.includes("/fleet-runs/"), false);
			strictEqual(framed.includes("events.ndjson"), false);
		} finally {
			isolated.restore();
		}
	});

	it("orders fleet roots newest first and truncates beyond the fixed window", async () => {
		const isolated = await isolateClioEnv("clio-fleet-inspect-roots-window-");
		try {
			// Written oldest-first so the ordering under test cannot be the write order.
			for (let index = 0; index < FLEET_INSPECT_MAX_ROOTS + 2; index += 1) {
				await writeFleetRun({
					version: 1,
					id: `fleet-00000000000${index}`,
					fleet: `fleet-${index}`,
					planHash: "plan-hash",
					stepIds: [],
					planSteps: [],
					vars: {},
					startedAt: `2026-08-2${index}T10:00:00.000Z`,
					endedAt: null,
					resumedFrom: null,
					steps: [],
				});
			}

			const snapshot = fleetInspectSnapshot(() => Date.parse("2026-09-05T10:00:00.000Z"));
			strictEqual(snapshot.roots.length, FLEET_INSPECT_MAX_ROOTS);
			strictEqual(snapshot.rootsTruncated, true);
			deepStrictEqual(
				snapshot.roots.map((root) => root.fleet),
				["fleet-5", "fleet-4", "fleet-3", "fleet-2"],
			);
		} finally {
			isolated.restore();
		}
	});

	it("renders a header, transcript, verified evidence, and outcome from ledger + journal + receipt", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-");
		try {
			const fixture = await seedRun("audit the receipt boundary");
			const model = loadRunViewModel(fixture.runId);
			ok(model !== null);

			// Header: identity from the ledger envelope, elapsed from its two stamps.
			strictEqual(line(model, "run "), `run ${fixture.runId}  tester`);
			match(
				line(model, "model "),
				/^model qwen3-coder {2}target local-lmstudio {2}node local {2}phase succeeded {2}elapsed 30s$/,
			);
			strictEqual(line(model, "task "), "task audit the receipt boundary");

			// Transcript from the journal, in the registry's own tail vocabulary.
			const rendered = renderRunView(model, 120);
			ok(rendered.some((text) => text.includes("message_end: read src/index.ts")));
			ok(rendered.some((text) => text.includes("clio_tool_finish: read ok")));
			ok(rendered.some((text) => text.startsWith("receipt   ")));

			// The receipt is authenticated against the envelope before its facts show.
			match(line(model, "evidence  "), /^evidence {2}trust v\d+: /);

			// Outcome comes from the journal's terminal line.
			strictEqual(line(model, "outcome   "), "outcome   succeeded");
			strictEqual(model.terminal, true);
			strictEqual(model.transcriptTruncated, false);
		} finally {
			isolated.restore();
		}
	});

	it("reports an unverifiable receipt instead of showing its fields", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-tamper-");
		try {
			const fixture = await seedRun("tamper case");
			// The envelope no longer matches what the receipt was sealed over.
			fixture.ledger.update(fixture.runId, { tokenCount: 999 });
			await fixture.ledger.persist();

			const model = loadRunViewModel(fixture.runId);
			ok(model !== null);
			match(line(model, "evidence  "), /RECEIPT INTEGRITY FAILED/);
			// The outcome still reads off the journal, which is not receipt-derived.
			strictEqual(line(model, "outcome   "), "outcome   succeeded");
		} finally {
			isolated.restore();
		}
	});

	it("sanitizes and bounds task text before rendering it", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-sanitize-");
		try {
			const esc = String.fromCharCode(27);
			const hostile = `wipe${esc}[2J the screen\nand this line`;
			const fixture = await seedRun(hostile);
			const model = loadRunViewModel(fixture.runId);
			ok(model !== null);
			const task = line(model, "task ");
			ok(!task.includes(esc), "no escape sequence survives to the rendered line");
			ok(!task.includes("\n"), "the task collapses to one line");
			match(task, /^task wipe the screen/);
		} finally {
			isolated.restore();
		}
	});

	it("renders a run with no journal without inventing a transcript", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-nojournal-");
		try {
			const ledger = openLedger({ maxRuns: 20 });
			const run = ledger.create({
				agentId: "coder",
				executionRole: "builder",
				task: "journal was off",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "openai",
				runtimeKind: "http",
				sessionId: null,
				cwd: "/tmp/fleet-view",
			});
			await ledger.persist();
			const model = loadRunViewModel(run.id);
			ok(model !== null);
			strictEqual(model.journalPresent, false);
			strictEqual(model.terminal, false);
			const rendered = renderRunView(model, 120);
			ok(rendered.some((text) => text === "no event journal for this run."));
			strictEqual(line(model, "outcome   "), "outcome   running");
			strictEqual(line(model, "evidence  "), "evidence  receipt pending; the run has not finalized");
		} finally {
			isolated.restore();
		}
	});

	it("resolves an exact run id, a unique prefix, and refuses an ambiguous one", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-resolve-");
		try {
			const fixture = await seedRun("resolve case");
			const exact = resolveRunId(fixture.runId);
			ok("runId" in exact);
			strictEqual(exact.runId, fixture.runId);

			const prefix = resolveRunId(fixture.runId.slice(0, 6));
			ok("runId" in prefix);
			strictEqual(prefix.runId, fixture.runId);

			const unknown = resolveRunId("zzzz-no-such-run");
			ok("candidates" in unknown);
			strictEqual(unknown.candidates.length, 0);
			strictEqual(loadRunViewModel("zzzz-no-such-run"), null);
		} finally {
			isolated.restore();
		}
	});

	it("re-authenticates a sealed receipt now and classifies a failure without quoting it", async () => {
		const isolated = await isolateClioEnv("clio-fleet-verify-");
		try {
			const fixture = await seedRun("verify the sealed receipt");
			const at = () => Date.parse("2026-08-30T10:05:00.000Z");

			const verified = fleetVerifySnapshot(fixture.runId, at);
			strictEqual(verified.version, 1);
			// The stamp is the moment the check ran, not the moment the run ended.
			// That is the entire difference between this and the snapshot's report.
			strictEqual(verified.verifiedAt, "2026-08-30T10:05:00.000Z");
			strictEqual(verified.runId, fixture.runId);
			strictEqual(verified.state, "verified");
			strictEqual(verified.reason, null);
			strictEqual(verified.axes.artifactIntegrity, "verified");

			// Tamper with the sealed bytes. The snapshot taken before this still says
			// verified; asking again is the only way to find out that it no longer is.
			const receiptPath = join(clioStateDir(), "receipts", `${fixture.runId}.json`);
			const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
			receipt.task = "a task the seal does not cover";
			writeFileSync(receiptPath, JSON.stringify(receipt));

			const failed = fleetVerifySnapshot(fixture.runId, at);
			strictEqual(failed.state, "failed");
			// The receipt no longer agrees with its ledger envelope.
			strictEqual(failed.reason, "ledger-mismatch");
			// The harness composes some reasons by interpolating a thrown message, so
			// the reason is classified rather than quoted and no prose escapes.
			strictEqual(JSON.stringify(failed).includes(clioStateDir()), false);
			strictEqual(JSON.stringify(failed).includes("a task the seal does not cover"), false);
		} finally {
			isolated.restore();
		}
	});

	it("separates a run that never sealed from one whose receipt cannot be read, and refuses an unknown run", async () => {
		const isolated = await isolateClioEnv("clio-fleet-verify-states-");
		try {
			const ledger = openLedger({ maxRuns: 20 });
			const open = ledger.create({
				agentId: "tester",
				executionRole: "builder",
				task: "still running",
				targetId: "local-lmstudio",
				wireModelId: "qwen3-coder",
				runtimeId: "lmstudio",
				runtimeKind: "http",
				sessionId: null,
				cwd: "/tmp/fleet-verify",
			});
			await ledger.persist();
			const at = () => Date.parse("2026-08-30T10:05:00.000Z");

			// Nothing to authenticate yet is not a failure to authenticate.
			const pending = fleetVerifySnapshot(open.id, at);
			strictEqual(pending.state, "pending");
			strictEqual(pending.reason, null);

			// A finalized run whose receipt file is gone is a missing artifact, which
			// is again not the same as a receipt that failed its check.
			const fixture = await seedRun("lose the receipt");
			rmSync(join(clioStateDir(), "receipts", `${fixture.runId}.json`));
			const missing = fleetVerifySnapshot(fixture.runId, at);
			strictEqual(missing.state, "unavailable");
			strictEqual(missing.reason, "receipt-unreadable");

			throws(() => fleetVerifySnapshot("nosuchrun", at), FleetVerifyUnknownRunError);
		} finally {
			isolated.restore();
		}
	});
});
