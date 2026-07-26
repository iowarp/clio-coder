import { createHash } from "node:crypto";

export const EXECUTION_HANDOFF_MAX_ITEMS = 16;
export const EXECUTION_HANDOFF_MAX_TEXT_BYTES = 12_000;

export interface ExecutionHandoff {
	stepId: string;
	assignmentId: string;
	terminalRunId: string;
	receiptDigest: string;
	output: string;
}

function truncateUtf8(value: string, limit: number): string {
	const bytes = Buffer.from(value, "utf8");
	return bytes.length <= limit ? value : bytes.subarray(0, limit).toString("utf8");
}

export function projectExecutionHandoffs(
	dependencyIds: ReadonlyArray<string>,
	outputs: ReadonlyMap<string, ExecutionHandoff>,
): ExecutionHandoff[] {
	if (dependencyIds.length > EXECUTION_HANDOFF_MAX_ITEMS)
		throw new Error(`execution handoff: at most ${EXECUTION_HANDOFF_MAX_ITEMS} predecessors are allowed`);
	const perItem = Math.floor(EXECUTION_HANDOFF_MAX_TEXT_BYTES / Math.max(1, dependencyIds.length));
	return dependencyIds.map((id) => {
		const source = outputs.get(id);
		if (!source) throw new Error(`execution handoff: missing successful predecessor '${id}'`);
		return { ...source, output: truncateUtf8(source.output, perItem) };
	});
}

export function executionHandoffDigest(handoffs: ReadonlyArray<ExecutionHandoff>): string {
	return createHash("sha256").update(JSON.stringify(handoffs)).digest("hex");
}
