/**
 * `clio-coder fleet code-steps <rootId> [--json]`: every `CodeStepRecord` one
 * fleet root wrote, oldest first. The record is the code step's stand-in for a
 * receipt (argv, cwd, env names, exit code, duration, output digest, artifact
 * paths). JSON is the record verbatim; the table keeps the fields an operator
 * scans for and leaves argv last because it is the widest.
 */

import type { CodeStepRecord } from "../domains/dispatch/code-step.js";
import { codeStepDir, readCodeStepRecords } from "../domains/dispatch/code-step-store.js";

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
	let records: CodeStepRecord[];
	try {
		records = readCodeStepRecords(rootId);
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
			`no code-step records for fleet root ${rootId} under ${codeStepDir(rootId)}. a record is written when a fleet plan runs a deterministic code step.\n`,
		);
		return 0;
	}
	process.stdout.write("EXIT  DURATION STARTED                  STEP                 COMMAND              ARGV\n");
	for (const record of records) {
		const exit = record.timedOut ? "timeout" : record.signal !== null ? `sig:${record.signal}` : String(record.exitCode);
		process.stdout.write(
			`${exit.padEnd(5)} ${`${record.durationMs}ms`.padStart(8)} ${record.startedAt.padEnd(24)} ${record.stepId.slice(0, 20).padEnd(20)} ${record.commandId.slice(0, 20).padEnd(20)} ${record.argv.join(" ")}\n`,
		);
	}
	return 0;
}
