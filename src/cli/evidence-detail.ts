import { evidenceInspectRecord } from "../domains/evidence/detail.js";

/**
 * `clio-coder evidence inspect <id> --json`: the fixed snapshot plus the run evidence the text form prints.
 *
 * The id is the only argument, and the caller supplies it. A GUI host is bound
 * by its own allowlist rather than by this command, because an operator typing
 * an id at a terminal is naming something on their own machine, which is a
 * different act from a browser frame naming it.
 */
export async function runEvidenceDetail(runId: string): Promise<number> {
	process.stdout.write(`${JSON.stringify(await evidenceInspectRecord(runId), null, 2)}\n`);
	return 0;
}
