/**
 * `clio-coder fleet code-steps <rootId> [--json]`: every code step one fleet
 * root settled, oldest first, read from the `code_step.settled` records in the
 * root's run journal (#434). JSON is the records as the read model returns
 * them; the table keeps the fields an operator scans for. Captured output
 * stays in the step's artifact log under the code-steps directory.
 */

import { clioStateDir } from "../core/xdg.js";
import { loadRunTelemetrySource } from "../domains/session/telemetry-source.js";
import { type CodeStepRowV1, codeStepsReport } from "../domains/telemetry/read-model.js";

const USAGE = "usage: clio-coder fleet code-steps <rootId> [--json]";

export function runFleetCodeSteps(args: readonly string[]): number {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	let rootId: string | undefined;
	let json = false;
	for (const arg of args) {
		if (arg === "--json") json = true;
		else if (arg.startsWith("-")) {
			process.stderr.write(`clio-coder fleet code-steps: unknown flag: ${arg}\n${USAGE}\n`);
			return 2;
		} else if (rootId === undefined) rootId = arg;
		else {
			process.stderr.write(`clio-coder fleet code-steps: unexpected argument: ${arg}\n${USAGE}\n`);
			return 2;
		}
	}
	if (rootId === undefined) {
		process.stderr.write(`clio-coder fleet code-steps requires a fleet root id\n${USAGE}\n`);
		return 2;
	}
	let records: CodeStepRowV1[];
	try {
		records = codeStepsReport(loadRunTelemetrySource(clioStateDir(), rootId));
	} catch (error) {
		process.stderr.write(`code-step records: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	if (json) {
		process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
		return 0;
	}
	if (records.length === 0) {
		process.stdout.write(
			`no code steps settled in the journal of fleet root ${rootId}. one is recorded when a fleet plan runs a deterministic code step.\n`,
		);
		return 0;
	}
	process.stdout.write("EXIT    DURATION STARTED                  STEP                 COMMAND              RUN\n");
	for (const record of records) {
		const exit = record.timedOut ? "timeout" : record.signal !== null ? `sig:${record.signal}` : String(record.exitCode);
		process.stdout.write(
			`${exit.padEnd(7)} ${`${record.durationMs}ms`.padStart(8)} ${record.startedAt.padEnd(24)} ${record.stepId.slice(0, 20).padEnd(20)} ${record.commandId.slice(0, 20).padEnd(20)} ${record.runId}\n`,
		);
	}
	return 0;
}
