import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runFleetCancel } from "../../src/cli/fleet-cancel.js";
import { runFleetWait } from "../../src/cli/fleet-wait.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { getStoredAssignment, registerAssignment } from "../../src/domains/dispatch/assignment-store.js";
import {
	clearRootCancelRequest,
	readRootCancelRequest,
	takeRunCancelRequest,
	writeRootCancelRequest,
	writeRunCancelRequest,
} from "../../src/domains/dispatch/cancel-requests.js";
import {
	fleetRootState,
	matchFleetRootIds,
	readFleetRootRecord,
	writeFleetResult,
	writeFleetRootRecord,
} from "../../src/domains/dispatch/fleet-root-record.js";
import { openLedger, writeFleetRun } from "../../src/domains/dispatch/state.js";
import type { RunLineage } from "../../src/domains/dispatch/types.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("fleet cancel requests", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-fleet-cancel-");
	});
	afterEach(() => scratch.restore());

	/** Run the command with stdout captured and stderr silenced. */
	const cancel = async (args: string[], options: { settleWaitMs?: number } = {}) => {
		const written: string[] = [];
		const write = process.stdout.write;
		const writeErr = process.stderr.write;
		process.stdout.write = ((chunk: string) => {
			written.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
		let code: number;
		try {
			code = await runFleetCancel(args, options);
		} finally {
			process.stdout.write = write;
			process.stderr.write = writeErr;
		}
		return { code, out: written.join("") };
	};

	it("hands the owner a request for its run exactly once and removes the file", () => {
		const path = join(clioStateDir(), "cancel-requests", "run-active.json");
		writeRunCancelRequest("run-active", "operator stop");
		strictEqual(existsSync(path), true);
		strictEqual(path.startsWith(scratch.dir), true);
		const taken = takeRunCancelRequest("run-active");
		strictEqual(taken?.runId, "run-active");
		strictEqual(taken?.reason, "operator stop");
		strictEqual(existsSync(path), false);
		strictEqual(takeRunCancelRequest("run-active"), null);
	});

	it("keeps the first root cancel request, reads it without consuming it, and clears it", () => {
		const first = writeRootCancelRequest("fleet-abc123", "first");
		const again = writeRootCancelRequest("fleet-abc123", "second");
		strictEqual(again.requestedAt, first.requestedAt);
		strictEqual(readRootCancelRequest("fleet-abc123")?.reason, "first");
		strictEqual(readRootCancelRequest("fleet-abc123")?.rootId, "fleet-abc123");
		clearRootCancelRequest("fleet-abc123");
		strictEqual(readRootCancelRequest("fleet-abc123"), null);
	});

	it("cancels a sealed fleet root idempotently and refuses an unknown or ambiguous one", async () => {
		ensureClioState();
		const record = writeFleetRootRecord({ rootId: "fleet-aa0001", playbook: "demo", cwd: scratch.dir });
		writeFleetRootRecord({ rootId: "fleet-aa0002", playbook: "demo", cwd: scratch.dir });
		strictEqual(fleetRootState(record, false), "running");
		writeFleetResult("fleet-aa0001", {
			type: "fleet_end",
			exitCode: 0,
			completion: { state: "completed", stopReason: null },
		});
		strictEqual(readFleetRootRecord("fleet-aa0001")?.state, "sealed");
		strictEqual(matchFleetRootIds("fleet-aa").length, 2);
		strictEqual(matchFleetRootIds("fleet-aa0001").join(), "fleet-aa0001");
		for (let i = 0; i < 2; i++) {
			const { code, out } = await cancel(["fleet-aa0001", "--json"]);
			strictEqual(code, 0);
			// C6: one compact object with version 1.
			strictEqual(out.trimEnd().includes("\n"), false);
			const report = JSON.parse(out);
			strictEqual(report.version, 1);
			strictEqual(report.action, "already_sealed");
			strictEqual(report.exitCode, 0);
		}
		strictEqual(readRootCancelRequest("fleet-aa0001"), null);
		for (const [token, slug] of [
			["fleet-zz9999", "not_found"],
			["fleet-aa", "ambiguous"],
			["run-unknown", "not_found"],
		] as const) {
			const { code, out } = await cancel([token, "--json"]);
			strictEqual(code, 1);
			const failure = JSON.parse(out);
			deepStrictEqual([failure.version, failure.ok, failure.error.code], [1, false, slug]);
		}
	});

	// C19: the exit agrees with the report's state. Sealed (now or before) exits 0, accepted but settling exits 75,
	// and a malformed id is a usage error.
	it("exits 0 for an already sealed run, 75 while a run or root is still settling, and 2 for a malformed id", async () => {
		ensureClioState();
		const ledger = openLedger();
		const created = () =>
			ledger.create({
				agentId: "scout",
				executionRole: "explorer",
				task: "cancel exit",
				targetId: "local",
				wireModelId: "model",
				runtimeId: "openai",
				runtimeKind: "http",
				sessionId: null,
				cwd: scratch.dir,
			});
		const done = created();
		ledger.update(done.id, { status: "failed", outcome: "failed", endedAt: new Date().toISOString() });
		const live = created();
		ledger.update(live.id, {
			status: "running",
			lineage: { parentRunId: null, rootRunId: live.id, depth: 0, attempt: 0 },
		});
		await ledger.persist();
		// This process is the live owner, and it never applies the request.
		await registerAssignment(live.id);

		for (let i = 0; i < 2; i++) {
			const { code, out } = await cancel([done.id, "--json"]);
			const report = JSON.parse(out);
			deepStrictEqual(
				[code, report.version, report.action, report.state, report.outcome],
				[0, 1, "already_sealed", "sealed", "failed"],
			);
		}
		strictEqual(takeRunCancelRequest(done.id), null);
		const sealedText = await cancel([done.id]);
		deepStrictEqual([sealedText.code, sealedText.out], [0, `run ${done.id} had already sealed failed\n`]);

		const pending = await cancel([live.id, "--json"], { settleWaitMs: 0 });
		const report = JSON.parse(pending.out);
		deepStrictEqual([pending.code, report.action, report.state, report.owner], [75, "requested", "pending", "alive"]);
		const pendingText = await cancel([live.id], { settleWaitMs: 0 });
		strictEqual(pendingText.code, 75);
		strictEqual(pendingText.out.startsWith(`cancel requested for run ${live.id};`), true);
		strictEqual(takeRunCancelRequest(live.id)?.runId, live.id);

		writeFleetRootRecord({ rootId: "fleet-bb0001", playbook: "demo", cwd: scratch.dir });
		const root = await cancel(["fleet-bb0001", "--json"], { settleWaitMs: 0 });
		const rootReport = JSON.parse(root.out);
		deepStrictEqual([root.code, rootReport.action, rootReport.state], [75, "requested", "pending"]);
		strictEqual(readRootCancelRequest("fleet-bb0001")?.rootId, "fleet-bb0001");

		const malformed = await cancel(["bad id!", "--json"]);
		const failure = JSON.parse(malformed.out);
		deepStrictEqual([malformed.code, failure.ok, failure.error.code], [2, false, "usage"]);
	});

	it("answers fleet wait on an orphaned root with the plan hash its run record bound (c-l7b-r)", async () => {
		ensureClioState();
		writeFleetRootRecord({ rootId: "fleet-cc0001", playbook: "demo", cwd: scratch.dir });
		await writeFleetRun({
			version: 1,
			id: "fleet-cc0001",
			fleet: "demo",
			planHash: "b".repeat(64),
			planIdentityHash: "c".repeat(64),
			cwd: scratch.dir,
			stepIds: ["step"],
			planSteps: [],
			vars: {},
			startedAt: new Date().toISOString(),
			endedAt: null,
			resumedFrom: null,
			steps: [],
		});
		// The owner is this process on another boot, so the record reads as orphaned.
		const ownerFile = join(clioStateDir(), "fleet-runs", "owners", "fleet-cc0001.json");
		const owned = JSON.parse(readFileSync(ownerFile, "utf8"));
		owned.owner.bootId = "another-boot";
		owned.owner.birthToken = "another-birth";
		writeFileSync(ownerFile, JSON.stringify(owned));
		const record = readFleetRootRecord("fleet-cc0001");
		strictEqual(record !== null && fleetRootState(record, false), "orphaned");
		const written: string[] = [];
		const write = process.stdout.write;
		const writeErr = process.stderr.write;
		process.stdout.write = ((chunk: string) => {
			written.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
		let code: number;
		try {
			code = await runFleetWait(["fleet-cc0001", "--json"]);
		} finally {
			process.stdout.write = write;
			process.stderr.write = writeErr;
		}
		const document = JSON.parse(written.join(""));
		deepStrictEqual([code, document.causes[0]?.code, document.planHash], [1, "owner_gone", "b".repeat(64)]);
	});

	// A hosted worker publishes the main run as its lineage root, and a running attempt is not yet among the
	// assignment's finalized attempts, so the owner lookup must not lean on either.
	const cases = [
		{ name: "a direct first attempt", hosted: false, retry: false },
		{ name: "a hosted first attempt", hosted: true, retry: false },
		{ name: "a hosted retry", hosted: true, retry: true },
	] as const;
	for (const { name, hosted, retry } of cases) {
		it(`seals ${name} whose assignment owner is gone instead of waiting on a request`, async () => {
			ensureClioState();
			const ledger = openLedger();
			const created = () =>
				ledger.create({
					agentId: "scout",
					executionRole: "explorer",
					task: "orphaned work",
					targetId: "local",
					wireModelId: "model",
					runtimeId: "openai",
					runtimeKind: "http",
					sessionId: null,
					cwd: scratch.dir,
				});
			const first = created();
			const row = retry ? created() : first;
			const lineage: RunLineage = hosted
				? { parentRunId: retry ? first.id : "main-run", rootRunId: "main-run", depth: 1, attempt: retry ? 1 : 0 }
				: { parentRunId: null, rootRunId: row.id, depth: 0, attempt: 0 };
			ledger.update(row.id, { status: "running", lineage });
			if (retry) ledger.update(first.id, { status: "failed", outcome: "failed", endedAt: new Date().toISOString() });
			await ledger.persist();
			await registerAssignment(first.id);
			const storePath = join(clioStateDir(), "assignments.json");
			const store = JSON.parse(readFileSync(storePath, "utf8"));
			store.assignments[0].processOwner.processBirthToken = "owner-that-exited";
			if (retry) store.assignments[0].attempts = [first.id];
			writeFileSync(storePath, JSON.stringify(store));

			const written: string[] = [];
			const write = process.stdout.write;
			process.stdout.write = ((chunk: string) => {
				written.push(chunk);
				return true;
			}) as typeof process.stdout.write;
			let code: number;
			try {
				code = await runFleetCancel([row.id, "--json"]);
			} finally {
				process.stdout.write = write;
			}
			const report = JSON.parse(written.join(""));
			strictEqual(code, 0);
			strictEqual(report.version, 1);
			strictEqual(report.owner, "gone");
			strictEqual(report.action, "sealed_orphan");
			strictEqual(getStoredAssignment(first.id)?.status, "canceled");
			strictEqual(takeRunCancelRequest(row.id), null);
		});
	}
});
