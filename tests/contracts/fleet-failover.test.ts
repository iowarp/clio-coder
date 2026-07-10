import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { runFleetNodePreflight } from "../../src/domains/dispatch/fleet-preflight.js";
import { createFleetPlacementResolver } from "../../src/domains/dispatch/placement.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { WorkerTransport } from "../../src/domains/dispatch/transport.js";
import type { RunEnvelope, RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { createFleetRegistry } from "../../src/domains/scheduling/cluster.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(message);
}

function okWorker(): SpawnedWorker {
	const events = (async function* () {
		yield { type: "message_end", message: { role: "assistant", content: "done", usage: { input: 1, output: 1 } } };
	})();
	return {
		pid: 100,
		promise: Promise.resolve({ exitCode: 0, signal: null }),
		events,
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

/** Channel failure: ssh exits 255, the worker never ran. */
function channelFailureWorker(): SpawnedWorker {
	const events = (async function* (): AsyncIterableIterator<unknown> {
		// The channel died before the worker emitted anything.
	})();
	return {
		pid: 101,
		promise: Promise.resolve({
			exitCode: 255,
			signal: null,
			stderrTail: "ssh: connect to host blade.lan port 22: No route to host",
		}),
		events,
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

/** In-flight worker: no events, settles only when reaped/aborted. */
function hangingWorker(): SpawnedWorker {
	let settle!: (result: SpawnedWorkerResult) => void;
	const promise = new Promise<SpawnedWorkerResult>((resolve) => {
		settle = resolve;
	});
	const events = (async function* (): AsyncIterableIterator<unknown> {
		await promise;
		yield { type: "never-delivered" };
	})();
	return {
		pid: 102,
		promise,
		events,
		abort: () => settle({ exitCode: null, signal: "SIGTERM" }),
		heartbeatAt: { current: Date.now() },
	};
}

describe("dead-node failover", () => {
	beforeEach(() => {
		isolateDispatchState();
	});
	after(() => {
		restoreDispatchState();
	});

	it("classifies the node dead, reaps in-flight runs, and reroutes with recorded lineage", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.nodes = [{ id: "blade", host: "blade.lan", maxWorkers: 3 }];
		const registry = createFleetRegistry(() => settings.fleet.nodes);
		const bladeTransport: WorkerTransport = {
			kind: "ssh",
			node: { id: "blade", kind: "ssh", host: "blade.lan" },
			spawn: () => (bladeSpawns.shift() ?? channelFailureWorker)(),
		};
		const bladeSpawns: Array<() => SpawnedWorker> = [hangingWorker, hangingWorker, channelFailureWorker];
		const context = dispatchStubContext({ settings, scheduling: { fleet: registry } });
		const bundle = makeDispatchBundle(context, {
			resolveNode: createFleetPlacementResolver({
				getSettings: () => settings,
				fleet: registry,
				transportForNode: () => bladeTransport,
				preflightVerdict: () => ({ ok: true, reason: null }),
			}),
			// Local fallback for rerouted retries.
			spawnWorker: () => okWorker(),
			resilienceCooldownMs: 0,
		});
		await bundle.extension.start();
		try {
			const inflightA = await bundle.contract.dispatch({ agentId: "coder", task: "long job a" });
			const inflightB = await bundle.contract.dispatch({ agentId: "coder", task: "long job b" });
			const failing = await bundle.contract.dispatch({ agentId: "coder", task: "channel probe" });
			const failedReceipt = await failing.finalPromise;
			strictEqual(failedReceipt.outcome, "failed");
			strictEqual(failedReceipt.node?.id, "blade");

			// First failure leaves blade online; the retry lands on blade again,
			// fails, crosses the death threshold, and triggers the reap.
			await waitFor(() => registry.get("blade")?.state === "offline", "blade classified dead");
			match(registry.get("blade")?.stateReason ?? "", /consecutive channel failures/);

			// The reaped in-flight runs finalize as stalled and their retries
			// reroute to the local survivor with lineage recorded.
			await Promise.allSettled([inflightA.finalPromise, inflightB.finalPromise]);
			const stalledA = await inflightA.finalPromise;
			strictEqual(stalledA.outcome, "stalled");

			await waitFor(
				() => bundle.contract.listRuns().filter((run) => run.status === "completed").length >= 3,
				"rerouted retries completed on the local survivor",
			);
			const completed = bundle.contract.listRuns().filter((run) => run.status === "completed");
			for (const envelope of completed) {
				strictEqual(envelope.node?.id, "local", "rerouted run landed on local");
				ok((envelope.reroutes?.length ?? 0) >= 1, "reroute lineage recorded");
				const lastHop = envelope.reroutes?.[envelope.reroutes.length - 1];
				strictEqual(lastHop?.fromNode, "blade");
				strictEqual(lastHop?.toNode, "local");
			}
			// The failing chain carries both hops: blade -> blade, then blade -> local.
			const twoHop = completed.find((run) => (run.reroutes?.length ?? 0) === 2);
			ok(twoHop, "retry chain that failed twice records two hops");
			deepStrictEqual(
				twoHop?.reroutes?.map((hop) => [hop.fromNode, hop.toNode]),
				[
					["blade", "blade"],
					["blade", "local"],
				],
			);

			// The rerouted receipt still verifies against its ledger row.
			const withReceipt = completed.find((run): run is RunEnvelope & { receiptPath: string } => run.receiptPath !== null);
			ok(withReceipt, "completed run has a receipt");
			if (withReceipt) {
				const receipt = JSON.parse(readFileSync(withReceipt.receiptPath, "utf8")) as RunReceipt;
				deepStrictEqual(receipt.node, { id: "local", kind: "local" });
				deepStrictEqual(verifyReceiptIntegrity(receipt, withReceipt), { ok: true });
			}
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

describe("fleet preflight runner", () => {
	let dir: string;
	let shim: string;

	function installPreflightShim(): void {
		dir = mkdtempSync(join(tmpdir(), "clio-preflight-shim-"));
		shim = join(dir, "fake-ssh.js");
		writeFileSync(
			shim,
			[
				"#!/usr/bin/env node",
				'process.stdout.write(process.env.FAKE_PREFLIGHT_STDOUT || "");',
				'process.stderr.write(process.env.FAKE_PREFLIGHT_STDERR || "");',
				'process.exit(Number(process.env.FAKE_PREFLIGHT_EXIT || "0"));',
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(shim, 0o755);
	}

	beforeEach(() => {
		installPreflightShim();
	});
	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const NODE = { id: "blade", host: "blade.lan" };

	it("records a passing node with remote version and path parity", async () => {
		const { readClioVersion } = await import("../../src/core/package-root.js");
		process.env.FAKE_PREFLIGHT_EXIT = "0";
		process.env.FAKE_PREFLIGHT_STDOUT = [
			"clio-preflight/1",
			"cwd=ok",
			`clio=Clio Coder ${readClioVersion()}`,
			"state=ok",
			"",
		].join("\n");
		const record = await runFleetNodePreflight(NODE, "/shared/app", { sshBinary: shim });
		strictEqual(record.ok, true);
		strictEqual(record.detail, null);
		deepStrictEqual(record.checks, {
			reachable: true,
			clioPresent: true,
			versionMatch: true,
			pathParity: true,
			stateDirWritable: true,
		});
	});

	it("classifies an unreachable node without failing", async () => {
		process.env.FAKE_PREFLIGHT_EXIT = "255";
		process.env.FAKE_PREFLIGHT_STDOUT = "";
		process.env.FAKE_PREFLIGHT_STDERR = "ssh: Could not resolve hostname blade.lan\n";
		const record = await runFleetNodePreflight(NODE, "/shared/app", { sshBinary: shim });
		strictEqual(record.ok, false);
		strictEqual(record.checks.reachable, false);
		match(record.detail ?? "", /unreachable \(ssh exit 255/);
	});

	it("fails path parity and version mismatch with actionable reasons", async () => {
		process.env.FAKE_PREFLIGHT_EXIT = "0";
		process.env.FAKE_PREFLIGHT_STDOUT = [
			"clio-preflight/1",
			"cwd=missing",
			"clio=Clio Coder 0.0.1",
			"state=fail",
			"",
		].join("\n");
		const record = await runFleetNodePreflight(NODE, "/shared/app", { sshBinary: shim });
		strictEqual(record.ok, false);
		match(record.detail ?? "", /disjoint filesystems are unsupported/);
		match(record.detail ?? "", /version mismatch/);
		match(record.detail ?? "", /state dir is not writable/);
		strictEqual(record.remoteVersion, "0.0.1");
	});

	it("asserts presence but skips the version probe for a custom clioEntry", async () => {
		process.env.FAKE_PREFLIGHT_EXIT = "0";
		process.env.FAKE_PREFLIGHT_STDOUT = ["clio-preflight/1", "cwd=ok", "clio=custom-entry", "state=ok", ""].join("\n");
		const record = await runFleetNodePreflight({ ...NODE, clioEntry: "/opt/custom/run-worker" }, "/shared/app", {
			sshBinary: shim,
		});
		strictEqual(record.ok, true);
		strictEqual(record.remoteVersion, null);
		strictEqual(record.checks.versionMatch, true);
	});
});
