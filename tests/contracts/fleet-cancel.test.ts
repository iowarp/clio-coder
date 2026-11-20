import { strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runFleetCancel } from "../../src/cli/fleet-cancel.js";
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
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { RunLineage } from "../../src/domains/dispatch/types.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("fleet cancel requests", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-fleet-cancel-");
	});
	afterEach(() => scratch.restore());

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
		const cancel = async (args: string[]) => {
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
				code = await runFleetCancel(args);
			} finally {
				process.stdout.write = write;
				process.stderr.write = writeErr;
			}
			return { code, out: written.join("") };
		};
		for (let i = 0; i < 2; i++) {
			const { code, out } = await cancel(["fleet-aa0001", "--json"]);
			strictEqual(code, 0);
			strictEqual(JSON.parse(out).action, "already_sealed");
		}
		strictEqual(readRootCancelRequest("fleet-aa0001"), null);
		strictEqual((await cancel(["fleet-zz9999", "--json"])).code, 1);
		strictEqual((await cancel(["fleet-aa", "--json"])).code, 1);
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
					executionRole: "researcher",
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
			strictEqual(report.owner, "gone");
			strictEqual(report.action, "sealed_orphan");
			strictEqual(getStoredAssignment(first.id)?.status, "canceled");
			strictEqual(takeRunCancelRequest(row.id), null);
		});
	}
});
