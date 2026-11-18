import { strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runFleetCancel } from "../../src/cli/fleet-cancel.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { getStoredAssignment, registerAssignment } from "../../src/domains/dispatch/assignment-store.js";
import { takeRunCancelRequest, writeRunCancelRequest } from "../../src/domains/dispatch/cancel-requests.js";
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
