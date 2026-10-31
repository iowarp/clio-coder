/**
 * Write a finished run the way dispatch records one (#434): a sealed run scope whose journal holds run.settled and
 * whose objects hold the result it names, built from a result draft through the same settlement dispatch uses.
 */

import type { WorkerTelemetryContext } from "../../src/core/telemetry/context.js";
import { runSettledRecord, settleFinishedRun } from "../../src/domains/dispatch/run-settlement.js";
import type { RunResultDraft } from "../../src/domains/dispatch/types.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetryRunDirectory } from "../../src/domains/telemetry/paths.js";

export async function writeSettledRun(stateDir: string, draft: RunResultDraft): Promise<void> {
	const context: WorkerTelemetryContext =
		draft.sessionId === null
			? { sessionId: null, runId: draft.runId, label: "worker" }
			: { sessionId: draft.sessionId, runId: draft.runId, label: "worker" };
	const writer = await openCallJournal({
		directory: telemetryRunDirectory(stateDir, draft.runId),
		context,
		writer: { clioCoderVersion: "test", piVersion: "test" },
	});
	try {
		const settlement = settleFinishedRun(draft, {
			terminal: { terminalReason: draft.terminalReason ?? "completed" },
			processExitCode: draft.exitCode,
			frameType: null,
			usage: undefined,
		});
		const result = await writer.storeObject("run-result", settlement.result);
		writer.enqueue({
			kind: "run.settled",
			data: runSettledRecord(settlement, result),
			ctx: context,
			wallMs: Date.parse(draft.endedAt),
			mono: performance.now(),
		});
		if (!(await writer.seal())) throw new Error(`run ${draft.runId} did not seal`);
	} finally {
		await writer.close();
	}
}
