import { abbreviateHeadTail, shareBytesFairly } from "../context/index.js";

export const EXECUTION_HANDOFF_MAX_ITEMS = 16;
export const EXECUTION_HANDOFF_MAX_TEXT_BYTES = 12_000;

export interface ExecutionHandoff {
	stepId: string;
	assignmentId: string;
	terminalRunId: string;
	runDigest: string;
	output: string;
}

/**
 * Keep the head and the tail of an output that exceeds its allowance and say
 * what was dropped. The tail matters as much as the head: a code-report's
 * excerpt ends with the failure summary and an agent report's last finding is
 * often the one that failed. Cuts land on UTF-8 character boundaries, so the
 * result never carries U+FFFD and never exceeds the allowance once encoded.
 * A null run id names the previous step instead, for pipeline input whose
 * source run is unknown.
 */
export function abbreviateHandoffText(text: string, limit: number, runId: string | null): string {
	// An agent run keeps its full output in its receipt and a code step in its
	// own record and log, so the marker names the run, not one storage kind.
	// The id is clipped because validation bounds only its presence, and an
	// overlong one would otherwise crowd the excerpt out of its own allowance.
	const source = runId === null ? "the previous step" : `run ${runId.slice(0, 80)}`;
	return abbreviateHeadTail(
		text,
		limit,
		(omitted, total) =>
			`\n[clio: ${omitted} of ${total} bytes omitted from this handoff excerpt; the coordinator retains the full output of ${source}]\n`,
	);
}

function abbreviate(handoff: ExecutionHandoff, limit: number): string {
	return abbreviateHandoffText(handoff.output, limit, handoff.terminalRunId);
}

export function projectExecutionHandoffs(
	dependencyIds: ReadonlyArray<string>,
	outputs: ReadonlyMap<string, ExecutionHandoff>,
): ExecutionHandoff[] {
	if (dependencyIds.length > EXECUTION_HANDOFF_MAX_ITEMS)
		throw new Error(`execution handoff: at most ${EXECUTION_HANDOFF_MAX_ITEMS} predecessors are allowed`);
	const sources = dependencyIds.map((id) => {
		const source = outputs.get(id);
		if (!source) throw new Error(`execution handoff: missing successful predecessor '${id}'`);
		return source;
	});
	const allowance = shareBytesFairly(
		sources.map((source) => Buffer.byteLength(source.output, "utf8")),
		EXECUTION_HANDOFF_MAX_TEXT_BYTES,
	);
	return sources.map((source, index) => ({ ...source, output: abbreviate(source, allowance[index] ?? 0) }));
}

/** Total encoded output bytes of a handoff list, the quantity the budget caps. */
export function executionHandoffTextBytes(handoffs: ReadonlyArray<ExecutionHandoff>): number {
	return handoffs.reduce((sum, handoff) => sum + Buffer.byteLength(handoff.output, "utf8"), 0);
}
