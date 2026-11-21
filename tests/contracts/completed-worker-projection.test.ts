import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalProjectRoot } from "../../src/core/project-root.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { DispatchCompletedPayload } from "../../src/core/telemetry/live-events.js";
import { unobservedRunUsageFacts } from "../../src/core/telemetry/pricing.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { takeRunCancelRequest } from "../../src/domains/dispatch/cancel-requests.js";
import { createCrossProcessFleet } from "../../src/domains/dispatch/cross-process-fleet.js";
import { writeRunOwnerRecord } from "../../src/domains/dispatch/run-directory-records.js";
import { appendRunFeed } from "../../src/domains/dispatch/run-feed.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";
import type { TelemetryRunReaders } from "../../src/domains/telemetry/contract.js";
import { createTelemetryProjection } from "../../src/domains/telemetry/projection.js";
import {
	createDispatchBoardStore,
	isDispatchBoardRowCancellable,
	isDispatchBoardRowSteerable,
} from "../../src/interactive/dispatch-board.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { settledRunTrust } from "../harness/settled-run.js";

test("only integrity-admitted receipt contract facts reach the board and lifecycle reset clears them", () => {
	const envelope = fixtureEnvelope("aa-run");
	const receipt = finishRunResult(fixtureReceiptDraft(envelope), envelope, {
		terminal: { terminalReason: "completed" },
		processExitCode: envelope.exitCode,
		frameType: null,
		usage: undefined,
	}).result;
	const verified = settledRunTrust(receipt);
	const rejected = settledRunTrust({ ...receipt, task: "tampered" }, { state: "failed", reason: "run seal failed" });
	let facts: ReturnType<NonNullable<TelemetryRunReaders["readRunResult"]>> = {
		text: '{"diagnosis":"Verified bytes","reproduction":"unknown","evidence":[]}',
		trust: verified,
		contract: "pass",
		contractKind: "debugger-report",
		taskWorktree: { branch: "clio/task-aa" },
	};
	const bus = createTelemetryHub();
	const projection = createTelemetryProjection(bus, {
		readRunResult: () => facts,
	});
	const store = createDispatchBoardStore(projection);
	const event: DispatchCompletedPayload = {
		runId: "aa-run",
		agentId: "debugger",
		targetId: "test",
		wireModelId: "test",
		runtimeId: "test",
		runtimeKind: "http",
		requestOrigin: "user",
		lineage: { rootRunId: "aa-run", parentRunId: null, attempt: 0, depth: 0 },
		spend: unobservedRunUsageFacts(),
		durationMs: 1,
		exitCode: 0,
		toolActivity: null,
		outcome: "succeeded",
		outcomeCode: null,
		outcomeDetail: null,
	};
	try {
		bus.emit("run.completed", event);
		assert.deepEqual(projection.snapshot().runs[0]?.resultContract, { kind: "debugger-report", conformance: "pass" });
		store.reconcile();
		assert.deepEqual(store.rows()[0]?.resultContract, { kind: "debugger-report", conformance: "pass" });
		assert.deepEqual(store.rows()[0]?.commitPlacement, { branch: "clio/task-aa" });
		const prior = projection.snapshot();
		bus.emit("run.started", { ...event, pid: null, assignmentId: "aa-run", attempt: 1 });
		assert.equal(projection.snapshot().runs[0]?.resultContract, undefined);
		assert.deepEqual(prior.runs[0]?.resultContract, { kind: "debugger-report", conformance: "pass" });
		facts = { text: "tampered answer", trust: rejected, contract: "pass", contractKind: "debugger-report" };
		bus.emit("run.completed", event);
		assert.equal(projection.snapshot().runs[0]?.resultContract, undefined);
		assert.doesNotMatch(projection.snapshot().runs[0]?.progress?.tailText ?? "", /tampered answer/);
		facts = {
			text: "trusted bytes, failed contract",
			trust: verified,
			contract: "fail",
			contractKind: "debugger-report",
		};
		bus.emit("run.completed", event);
		assert.deepEqual(projection.snapshot().runs[0]?.resultContract, { kind: "debugger-report", conformance: "fail" });
		assert.deepEqual(projection.snapshot().runs[0]?.commitPlacement, {});
		facts = null;
		bus.emit("run.completed", event);
		assert.equal(projection.snapshot().runs[0]?.resultContract, undefined);
		assert.equal(projection.snapshot().runs[0]?.commitPlacement, undefined);
	} finally {
		store.unsubscribe();
		projection.stop();
	}
});

test("a live run another Clio process owns becomes a board row fed from its run feed, and ends dead with its owner (M11)", async () => {
	const env = await isolateClioEnv("clio-foreign-row-");
	const bus = createTelemetryHub();
	const projection = createTelemetryProjection(bus, {});
	const store = createDispatchBoardStore(projection);
	const owner = { host: hostname(), pid: 2_000_011, birthToken: "owner-birth", pidNs: null, bootId: null };
	let ownerAlive = true;
	// The viewer runs in a subdirectory of the owner's project; the project root, not the cwd, scopes what it follows.
	const project = join(env.dir, "proj");
	mkdirSync(join(project, ".git"), { recursive: true });
	mkdirSync(join(project, "sub"));
	const viewer = createCrossProcessFleet({
		bus,
		stateDir: clioStateDir,
		cwd: join(project, "sub"),
		isLocalRun: () => false,
		grantBinding: () => null,
		resolve: () => {},
		follow: true,
		timers: false,
		self: { ...owner, pid: 2_000_012 },
		owner: () => (ownerAlive ? "alive" : "gone"),
	});
	try {
		const stateDir = clioStateDir();
		writeFileSync(join(stateDir, "runs.json"), JSON.stringify([{ ...fixtureEnvelope("run-f"), status: "running" }]));
		const started = {
			runId: "run-f",
			agentId: "scout",
			targetId: "t",
			wireModelId: "m",
			runtimeId: "r",
			runtimeKind: "subprocess" as const,
			requestOrigin: "agent" as const,
			pid: null,
			assignmentId: "run-f",
			attempt: 0,
		};
		assert.ok(
			writeRunOwnerRecord(stateDir, started, { cwd: project, projectRoot: canonicalProjectRoot(project) }, owner),
		);
		appendRunFeed("run-f", { kind: "open", runId: "run-f", agentId: "scout" });
		appendRunFeed("run-f", {
			kind: "event",
			type: "clio_coder_tool_start",
			tool: "read",
			callId: "c1",
			verb: "reading",
			detail: "src/a.ts",
		});
		viewer.poll();
		store.reconcile();
		const row = store.liveRows().find((candidate) => candidate.runId === "run-f");
		assert.equal(row?.agentId, "scout");
		assert.equal(row?.status, "running");
		assert.equal(projection.snapshot().runs[0]?.progress?.currentAction?.tool, "read");
		// Another process's worker takes no steering from here, and a cancel goes to its owner as a durable request.
		assert.equal(row?.foreign, true);
		assert.equal(row !== undefined && isDispatchBoardRowSteerable(row), false);
		assert.equal(row !== undefined && isDispatchBoardRowCancellable(row), true);
		assert.equal(viewer.cancelForeign("run-unknown", null), false);
		assert.ok(viewer.cancelForeign("run-f", "stop it"));
		assert.equal(takeRunCancelRequest("run-f")?.reason, "stop it");
		// A feed line over the fold bound is skipped, not waited on: the row after it still lands.
		appendRunFeed("run-f", { kind: "event", type: "clio_coder_run_outcome", detail: "x".repeat(300 * 1024) });
		appendRunFeed("run-f", { kind: "event", type: "clio_coder_tool_start", tool: "grep", callId: "c2" });
		viewer.poll();
		viewer.poll();
		assert.equal(projection.snapshot().runs[0]?.progress?.currentAction?.tool, "grep");
		ownerAlive = false;
		viewer.poll();
		assert.equal(projection.snapshot().runs[0]?.status, "dead");
	} finally {
		viewer.dispose();
		store.unsubscribe();
		projection.stop();
		env.restore();
	}
});
