import { evidenceInspectRecord } from "../domains/evidence/detail.js";

/**
 * `clio-coder evidence inspect <id> --json`: the fixed snapshot plus the run evidence the text form prints.
 *
 * The id is the only argument, and the caller supplies it. A GUI host is bound
 * by its own allowlist rather than by this command, because an operator typing
 * an id at a terminal is naming something on their own machine, which is a
 * different act from a browser frame naming it.
 */
export async function runEvidenceDetail(runId: string, options: { exitCode?: boolean } = {}): Promise<number> {
	const record = await evidenceInspectRecord(runId);
	process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
	// The document always prints and exits 0; `--exit-code` turns a rejected seal or an unsettled run into 1 (C19).
	if (options.exitCode !== true) return 0;
	return record.integrity === "failed" || record.evidence.settled === null ? 1 : 0;
}
