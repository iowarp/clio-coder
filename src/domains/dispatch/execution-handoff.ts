export const EXECUTION_HANDOFF_MAX_ITEMS = 16;
export const EXECUTION_HANDOFF_MAX_TEXT_BYTES = 12_000;

export interface ExecutionHandoff {
	stepId: string;
	assignmentId: string;
	terminalRunId: string;
	receiptDigest: string;
	output: string;
}

/**
 * Split the byte budget max-min fairly. An output under its share keeps every
 * byte and the rest goes to the longer ones, so a large report beside a
 * two-byte one is not cut to half the budget while the other half sits idle.
 */
function allocate(sizes: ReadonlyArray<number>, budget: number): number[] {
	const allowance = sizes.map(() => 0);
	const ascending = sizes.map((_, index) => index).sort((a, b) => (sizes[a] ?? 0) - (sizes[b] ?? 0));
	let remaining = budget;
	let open = sizes.length;
	for (const index of ascending) {
		const take = Math.min(sizes[index] ?? 0, Math.floor(remaining / open));
		allowance[index] = take;
		remaining -= take;
		open -= 1;
	}
	return allowance;
}

function isContinuationByte(bytes: Buffer, index: number): boolean {
	const byte = bytes[index];
	return byte !== undefined && (byte & 0xc0) === 0x80;
}

/**
 * Keep the head and the tail of an output that exceeds its allowance and say
 * what was dropped. The tail matters as much as the head: a code-report's
 * excerpt ends with the failure summary and an agent report's last finding is
 * often the one that failed. Cuts land on UTF-8 character boundaries, so the
 * result never carries U+FFFD and never exceeds the allowance once encoded.
 */
function abbreviate(handoff: ExecutionHandoff, limit: number): string {
	const bytes = Buffer.from(handoff.output, "utf8");
	if (bytes.length <= limit) return handoff.output;
	// An agent run keeps its full output in its receipt and a code step in its
	// own record and log, so the marker names the run, not one storage kind.
	// The id is clipped because validation bounds only its presence, and an
	// overlong one would otherwise crowd the excerpt out of its own allowance.
	const runId = handoff.terminalRunId.slice(0, 80);
	const marker = (omitted: number): string =>
		`\n[clio: ${omitted} of ${bytes.length} bytes omitted from this handoff excerpt; the coordinator retains the full output of run ${runId}]\n`;
	// The widest omitted count sizes the marker, so the rendered one always fits.
	const keep = Math.max(0, limit - Buffer.byteLength(marker(bytes.length), "utf8"));
	let headEnd = Math.floor(keep / 2);
	while (headEnd > 0 && isContinuationByte(bytes, headEnd)) headEnd -= 1;
	let tailStart = bytes.length - (keep - Math.floor(keep / 2));
	while (tailStart < bytes.length && isContinuationByte(bytes, tailStart)) tailStart += 1;
	const text = `${bytes.subarray(0, headEnd).toString("utf8")}${marker(tailStart - headEnd)}${bytes.subarray(tailStart).toString("utf8")}`;
	if (Buffer.byteLength(text, "utf8") <= limit) return text;
	// Only an allowance smaller than the marker itself lands here.
	const cut = Buffer.from(marker(bytes.length), "utf8");
	let end = Math.min(limit, cut.length);
	while (end > 0 && isContinuationByte(cut, end)) end -= 1;
	return cut.subarray(0, end).toString("utf8");
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
	const allowance = allocate(
		sources.map((source) => Buffer.byteLength(source.output, "utf8")),
		EXECUTION_HANDOFF_MAX_TEXT_BYTES,
	);
	return sources.map((source, index) => ({ ...source, output: abbreviate(source, allowance[index] ?? 0) }));
}

/** Total encoded output bytes of a handoff list, the quantity the budget caps. */
export function executionHandoffTextBytes(handoffs: ReadonlyArray<ExecutionHandoff>): number {
	return handoffs.reduce((sum, handoff) => sum + Buffer.byteLength(handoff.output, "utf8"), 0);
}
