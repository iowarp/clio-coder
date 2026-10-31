import type { RunResultObject } from "../../src/core/telemetry/schemas.js";
import type { RunIntegrity } from "../../src/domains/evidence/trust-status.js";
import { adaptRunTrustStatus } from "../../src/domains/evidence/trust-status.js";
import type { SettledRunRecord } from "../../src/domains/telemetry/index.js";
import { fixtureEnvelope } from "./receipt.js";
/**
 * Write a finished run the way dispatch records one (#434): a sealed run scope whose journal holds run.settled and
 * whose objects hold the result it names, built from a result draft through the same settlement dispatch uses.
 */

import type { WorkerTelemetryContext } from "../../src/core/telemetry/context.js";
import { workerAgent } from "../../src/core/telemetry/context.js";
import type { RunUsageFacts } from "../../src/domains/dispatch/run-call-usage.js";
import { finishRunResult, runSettledRecord, settleFinishedRun } from "../../src/domains/dispatch/run-settlement.js";
import type { RunResultDraft } from "../../src/domains/dispatch/types.js";
import { gatherRunAssessment } from "../../src/domains/evidence/assessment.js";
import { openCallJournal, readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetryRunDirectory } from "../../src/domains/telemetry/paths.js";

export async function writeSettledRun(
	stateDir: string,
	draft: RunResultDraft,
	usage?: RunUsageFacts,
	options: { assess?: boolean } = {},
): Promise<void> {
	const context: WorkerTelemetryContext =
		draft.sessionId === null
			? { sessionId: null, runId: draft.runId, agent: workerAgent(draft.runId) }
			: { sessionId: draft.sessionId, runId: draft.runId, agent: workerAgent(draft.runId) };
	const directory = telemetryRunDirectory(stateDir, draft.runId);
	const writer = await openCallJournal({
		directory,
		context,
		writer: { clioCoderVersion: "test", piVersion: "test" },
	});
	try {
		const { digest: _digest, ...inputDraft } = draft as RunResultDraft & { digest?: string };
		const settlement = finishRunResult(
			inputDraft,
			{ ...fixtureEnvelope(draft.runId), ...draft },
			{
				terminal: { terminalReason: draft.terminalReason ?? "completed" },
				processExitCode: draft.exitCode,
				frameType: null,
				usage,
			},
		).settlement;
		const result = await writer.storeObject("run-result", settlement.result);
		writer.enqueue({
			kind: "run.settled",
			data: runSettledRecord(settlement, result),
			ctx: context,
			wallMs: Date.parse(draft.endedAt),
			mono: performance.now(),
		});
		// Dispatch journals the run's assessment between run.settled and the seal; the fixture does too (#434).
		if (options.assess !== false) {
			await writer.flush();
			const records = (await readCallJournal(directory)).records.map(({ record }) => record);
			const assessed = await gatherRunAssessment(stateDir, draft.runId, records, settlement.assessment ?? null);
			if (assessed !== null) {
				const text = await writer.storeObject("evidence-findings", assessed.text);
				writer.enqueue({
					kind: "evidence.assessed",
					data: { ...assessed.data, text },
					ctx: context,
					wallMs: Date.parse(draft.endedAt),
					mono: performance.now(),
				});
			}
		}
		if (!(await writer.seal())) throw new Error(`run ${draft.runId} did not seal`);
	} finally {
		await writer.close();
	}
}

/** Project the same settled facts the producer supplies to trust consumers (#434). */
export function settledRunTrust(
	draft: RunResultDraft,
	integrity: RunIntegrity = { state: "verified", by: "producer" },
) {
	const settlement = settleFinishedRun(draft, {
		terminal: { terminalReason: draft.terminalReason ?? "completed" },
		processExitCode: draft.exitCode,
		frameType: null,
		usage: undefined,
	});
	return adaptRunTrustStatus({ ...settlement.facts, runId: draft.runId, digest: null }, integrity);
}

/** A sealed fixture must resolve the result object named by its settled record (#434). */
export function resolvedRunResult(run: SettledRunRecord): RunResultObject {
	if (run.result?.state !== "resolved") throw new Error(`run ${run.row.runId} has no resolved result object`);
	return run.result.value;
}
