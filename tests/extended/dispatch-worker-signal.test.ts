import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { isDeterministicOutcomeCode } from "../../src/domains/dispatch/backoff.js";
import { capacityLeaseUsage } from "../../src/domains/dispatch/capacity-lease.js";

import {
	approvedIdentityForSpec,
	CONTROL_FRAME_PREFIX,
	WORKER_PROTOCOL_VERSION,
} from "../../src/domains/dispatch/worker-protocol.js";
import { type SpawnedWorker, spawnWorkerProcess } from "../../src/domains/dispatch/worker-spawn.js";
import { verifyRunRecordReport } from "../../src/interactive/view/artifacts.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

beforeEach(() => isolateDispatchState());
afterEach(() => restoreDispatchState());

// Drive the existing dispatch harness through its real process spawner. The
// child announces the approved fixture identity, then waits for its owner to
// request termination. It signals only itself and never invokes a model.
const CHILD = `
const readline = require("node:readline");
const identity = JSON.parse(process.argv[1]);
const prefix = process.argv[2];
let announced = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  JSON.parse(line);
  if (!announced) {
    announced = true;
    const unknown = { known: false };
    const attestation = {
      ...identity, protocolVersion: ${WORKER_PROTOCOL_VERSION}, pid: process.pid,
      processGroupId: process.pid, host: "owned-fixture",
      resources: { labels: [], cpuCount: unknown, totalMemoryBytes: unknown,
        freeMemoryBytes: unknown, gpuCount: unknown, vramBytes: unknown, residentModels: unknown }
    };
    process.stderr.write(prefix + JSON.stringify({ kind: "announce", attestation }) + "\\n");
    return;
  }
  const command = JSON.parse(line);
  if (command.type === "admit") return;
  process.stderr.write(command.stderrChars > 0 ? "x".repeat(command.stderrChars) + "\\n" : "", () => {
    if (command.signal) process.kill(process.pid, command.signal);
    else process.exit(0);
  });
});
`;

for (const scenario of [
	{ name: "ordinary exit", signal: null, stderrChars: 0 },
	{ name: "SIGKILL", signal: "SIGKILL", stderrChars: 0 },
	{ name: "SIGKILL with bounded stderr", signal: "SIGKILL", stderrChars: 5_000 },
] as const) {
	it(`seals missing-result failure and observed cause for ${scenario.name}`, {
		timeout: 15_000,
		skip: process.platform === "win32" && scenario.signal !== null,
	}, async (t) => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		let worker: SpawnedWorker | undefined;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			spawnWorker: (spec, options) => {
				worker = spawnWorkerProcess(
					process.execPath,
					["-e", CHILD, JSON.stringify(approvedIdentityForSpec(spec)), CONTROL_FRAME_PREFIX],
					spec,
					options,
				);
				return worker;
			},
		});
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch({
				agentId: "scout",
				task: "Inspect the fixture input and report available evidence.",
				executionRole: "researcher",
				requestOrigin: "internal",
				resultContractOverride: { kind: "provenance-report" },
			});
			ok(worker);
			const owned = worker;
			const deadline = Date.now() + 5_000;
			while (!owned.attestation?.()) {
				ok(Date.now() < deadline, "owned fixture did not announce");
				await sleep(5);
			}
			strictEqual(owned.attestation()?.pid, owned.pid);
			ok(owned.send?.(scenario));
			const observed = await owned.promise;
			strictEqual(owned.send?.({ type: "ledger_delta", entries: [] }), false);
			strictEqual(owned.lastChannelFailure?.(), null);
			strictEqual(observed.signal, scenario.signal);
			if (scenario.stderrChars > 0) ok((observed.stderrTail?.length ?? 0) > 2_048);
			const receipt = await run.finalPromise;
			const envelope = bundle.contract.getRun(run.runId);
			ok(envelope);
			strictEqual(receipt.outcome, "failed");
			strictEqual(envelope.status, "failed");
			// A signal death is never a clean exit, so it fails as an incomplete
			// trail on the signal's own code rather than reaching the result
			// contract as a finished run.
			const sealedCause =
				scenario.signal === null
					? /worker loop ended without a sealed final assistant output/u
					: /terminated by SIGKILL before it finished its output/u;
			strictEqual(receipt.exitCode, 1);
			strictEqual(receipt.outcomeCode, scenario.signal === null ? "worker_final_output_missing" : null);
			strictEqual(isDeterministicOutcomeCode(receipt.outcomeCode), false);
			match(receipt.outcomeDetail ?? "", sealedCause);
			match(receipt.failureMessage ?? "", sealedCause);
			strictEqual(envelope.outcomeDetail, receipt.outcomeDetail);
			const stateDir = process.env.CLIO_CODER_STATE_DIR;
			ok(stateDir);
			const integrity = verifyRunRecordReport(stateDir, run.runId);
			ok(integrity.ok, JSON.stringify(integrity));
			deepStrictEqual(bundle.contract.snapshot().running, []);
			deepStrictEqual(bundle.contract.snapshot().retrying, []);
			strictEqual(capacityLeaseUsage().global, 0);
			ok(owned.pid);
			throws(() => process.kill(owned.pid as number, 0), { code: "ESRCH" });
			t.diagnostic(
				JSON.stringify({
					runId: run.runId,
					pid: owned.pid,
					observedSignal: observed.signal,
					outcome: receipt.outcome,
					outcomeDetail: receipt.outcomeDetail,
					sealedIntegrity: integrity.ok,
					ownedProcessReaped: true,
					activeRuns: 0,
					capacityLeases: 0,
				}),
			);
			if (scenario.signal !== null) {
				match(receipt.outcomeDetail ?? "", /worker process signal: SIGKILL/u);
				match(receipt.failureMessage ?? "", /worker process signal: SIGKILL/u);
			}
		} finally {
			worker?.abort();
			await worker?.promise;
			await bundle.extension.stop?.();
		}
	});
}
