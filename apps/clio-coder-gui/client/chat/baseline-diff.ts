// The line diff behind a whole-file write's proposal: the file now against the proposed text. A lazy chunk, loaded
// only when such a write is read for approval, so the session route does not carry it.

import type { BaselineDiff, DiffRow, DiffRowKind } from "./diff-model.js";

// Type-only imports keep this chunk from pulling `diff-model.ts` out of the route's shared chunk. A whole file's
// own lines never carry the engine's line-cap marker, so no row here is capped.
function row(kind: DiffRowKind, text: string, oldLine: number | null, newLine: number | null): DiffRow {
	return { id: "", kind, text, oldLine, newLine, lineCapped: false };
}

function lines(value: string): string[] {
	const split = value.split("\n");
	if (split.at(-1) === "") split.pop();
	return split;
}

/** Above this many compared line pairs the preview keeps its plain whole-file form rather than block the page. */
const MAX_BASELINE_CELLS = 250_000;
const BASELINE_CONTEXT = 2;

/**
 * A line diff of the file now against the proposed text, so the preview counts what the write will add and remove
 * exactly as the applied result will. Null when the files are too large to compare here.
 */
export function baselineRows(before: string, after: string): BaselineDiff | null {
	const old = lines(before);
	const next = lines(after);
	let head = 0;
	while (head < old.length && head < next.length && old[head] === next[head]) head += 1;
	let tail = 0;
	while (
		tail < old.length - head &&
		tail < next.length - head &&
		old[old.length - 1 - tail] === next[next.length - 1 - tail]
	)
		tail += 1;
	const a = old.slice(head, old.length - tail);
	const b = next.slice(head, next.length - tail);
	if ((a.length + 1) * (b.length + 1) > MAX_BASELINE_CELLS) return null;
	// Longest common subsequence over the changed middle, walked forward into keep/del/add steps.
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i -= 1)
		for (let j = b.length - 1; j >= 0; j -= 1)
			table[i * width + j] =
				a[i] === b[j]
					? (table[(i + 1) * width + j + 1] ?? 0) + 1
					: Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
	const steps: Array<{ kind: "context" | "del" | "add"; text: string }> = old
		.slice(0, head)
		.map((line) => ({ kind: "context" as const, text: line }));
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			steps.push({ kind: "context", text: a[i] ?? "" });
			i += 1;
			j += 1;
		} else if (i < a.length && (j === b.length || (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))) {
			// Removals first on a tie, so a replaced line reads − then +, as the applied diff prints it.
			steps.push({ kind: "del", text: a[i] ?? "" });
			i += 1;
		} else {
			steps.push({ kind: "add", text: b[j] ?? "" });
			j += 1;
		}
	}
	for (const line of old.slice(old.length - tail)) steps.push({ kind: "context", text: line });
	const rows: DiffRow[] = [];
	let oldLine = 1;
	let newLine = 1;
	let adds = 0;
	let dels = 0;
	steps.forEach((step, index) => {
		const near = steps
			.slice(Math.max(0, index - BASELINE_CONTEXT), index + BASELINE_CONTEXT + 1)
			.some((other) => other.kind !== "context");
		if (step.kind === "del") {
			rows.push(row("del", step.text, oldLine, null));
			oldLine += 1;
			dels += 1;
		} else if (step.kind === "add") {
			rows.push(row("add", step.text, null, newLine));
			newLine += 1;
			adds += 1;
		} else {
			if (near) rows.push(row("ctx", step.text, oldLine, newLine));
			else if (rows.at(-1)?.kind !== "elision") rows.push(row("elision", "...", null, null));
			oldLine += 1;
			newLine += 1;
		}
	});
	return { rows, adds, dels };
}
