import { evidenceDetailSnapshot } from "../domains/evidence/detail.js";

/**
 * `clio-coder evidence inspect <id> --json`.
 *
 * The id is the only argument, and the caller supplies it. A GUI host is bound
 * by its own allowlist rather than by this command, because an operator typing
 * an id at a terminal is naming something on their own machine, which is a
 * different act from a browser frame naming it.
 */
export async function runEvidenceDetail(evidenceId: string): Promise<number> {
	process.stdout.write(`${JSON.stringify(await evidenceDetailSnapshot(evidenceId), null, 2)}\n`);
	return 0;
}
