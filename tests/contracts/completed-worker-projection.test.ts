import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { DispatchCompletedPayload } from "../../src/core/telemetry/live-events.js";
import { unobservedRunUsageFacts } from "../../src/core/telemetry/pricing.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { createCrossProcessFleet } from "../../src/domains/dispatch/cross-process-fleet.js";
import { writeRunOwnerRecord } from "../../src/domains/dispatch/run-directory-records.js";
import { appendRunFeed } from "../../src/domains/dispatch/run-feed.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";
import type { TelemetryRunReaders } from "../../src/domains/telemetry/contract.js";
import { createTelemetryProjection } from "../../src/domains/telemetry/projection.js";
import { createDispatchBoardStore } from "../../src/interactive/dispatch-board.js";
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
	const viewer = createCrossProcessFleet({
		bus,
		stateDir: clioStateDir,
		cwd: env.dir,
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
		assert.ok(writeRunOwnerRecord(stateDir, started, env.dir, owner));
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
