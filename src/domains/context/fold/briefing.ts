/**
 * A fleet recipient's briefing built to a byte cap (ContextFold CF-10). A council seat or judge receives typed parts:
 * `framing` (what the seat is for), `task` (the original briefing) and `evidence` (one seat's answer or failure). When
 * the parts overflow the cap they are filled in a fixed order, so the briefing never loses a seat to an oversized
 * original briefing or to the first answer that happened to be long:
 *
 *   1. framing, in full;
 *   2. every evidence part's lead (its label, or its failure status) and a minimum excerpt of its body;
 *   3. the task, bounded: it yields to the evidence still unsent, down to half of what is left;
 *   4. the rest, shared max-min fairly across the evidence bodies, each abbreviated head and tail.
 *
 * Separators and truncation notices count against the cap. The cap is in bytes and never derived from the
 * recipient's token window. Cuts land on UTF-8 character boundaries.
 */

export type BriefingPartKind = "framing" | "task" | "evidence";

export interface BriefingPart {
	readonly kind: BriefingPartKind;
	/** Kept whole whenever the cap admits it: framing text, a seat label, or a failure status. */
	readonly lead: string;
	/** Abbreviated head and tail when the cap is short. */
	readonly body?: string;
}

/** One part the cap shortened, by its position in the briefing. */
export interface BriefingClip {
	readonly kind: BriefingPartKind;
	readonly index: number;
	readonly bytesBefore: number;
	readonly bytesAfter: number;
}

export interface BuiltBriefing {
	readonly text: string;
	readonly bytes: number;
	readonly clips: ReadonlyArray<BriefingClip>;
}

/** Notice for an abbreviated body: the bytes it omitted and the body's whole size. */
export type BriefingNotice = (omitted: number, total: number) => string;

export const BRIEFING_SEPARATOR = "\n\n";
/** Each seat's body keeps at least this many bytes, notice included, before the task takes its share. */
export const BRIEFING_MIN_EXCERPT_BYTES = 512;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * Split the byte budget max-min fairly. A part under its share keeps every byte and the rest goes to the longer
 * ones, so a large report beside a two-byte one is not cut to half the budget while the other half sits idle.
 */
export function shareBytesFairly(sizes: ReadonlyArray<number>, budget: number): number[] {
	const allowance = sizes.map(() => 0);
	const ascending = sizes.map((_, index) => index).sort((a, b) => (sizes[a] ?? 0) - (sizes[b] ?? 0));
	let remaining = Math.max(0, budget);
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

function clipHead(text: string, limit: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return text;
	let end = Math.max(0, limit);
	while (end > 0 && isContinuationByte(bytes, end)) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

/**
 * Keep the head and the tail of a text that exceeds its allowance and say what was dropped. The tail matters as much
 * as the head: a report's last line is often its conclusion. The widest notice sizes the cut, so the rendered one
 * always fits, and the result never exceeds the allowance once encoded. Only an allowance smaller than the notice
 * itself returns a clipped notice alone.
 */
export function abbreviateHeadTail(text: string, limit: number, notice: BriefingNotice): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return text;
	const keep = Math.max(0, limit - utf8Bytes(notice(bytes.length, bytes.length)));
	let headEnd = Math.floor(keep / 2);
	while (headEnd > 0 && isContinuationByte(bytes, headEnd)) headEnd -= 1;
	let tailStart = bytes.length - (keep - Math.floor(keep / 2));
	while (tailStart < bytes.length && isContinuationByte(bytes, tailStart)) tailStart += 1;
	const abbreviated = `${bytes.subarray(0, headEnd).toString("utf8")}${notice(tailStart - headEnd, bytes.length)}${bytes.subarray(tailStart).toString("utf8")}`;
	if (utf8Bytes(abbreviated) <= limit) return abbreviated;
	return clipHead(notice(bytes.length, bytes.length), limit);
}

/** Build the briefing from its parts within `capBytes`, and report each part the cap shortened. */
export function buildBriefing(
	parts: ReadonlyArray<BriefingPart>,
	capBytes: number,
	notice: BriefingNotice,
): BuiltBriefing {
	const whole = parts.map((part) => `${part.lead}${part.body ?? ""}`);
	const wholeText = whole.join(BRIEFING_SEPARATOR);
	const wholeBytes = utf8Bytes(wholeText);
	if (wholeBytes <= capBytes) return { text: wholeText, bytes: wholeBytes, clips: [] };

	const leads = parts.map((part) => utf8Bytes(part.lead));
	const sizes = whole.map(utf8Bytes);
	const allot = parts.map(() => 0);
	let remaining = Math.max(0, capBytes - Math.max(0, parts.length - 1) * utf8Bytes(BRIEFING_SEPARATOR));
	const of = (kind: BriefingPartKind): number[] => parts.flatMap((part, index) => (part.kind === kind ? [index] : []));
	const give = (indices: ReadonlyArray<number>, wants: (index: number) => number, budget: number): void => {
		const shares = shareBytesFairly(
			indices.map((index) => Math.max(0, wants(index))),
			Math.min(budget, remaining),
		);
		indices.forEach((index, position) => {
			const share = shares[position] ?? 0;
			allot[index] = (allot[index] ?? 0) + share;
			remaining -= share;
		});
	};
	const unsent = (index: number): number => (sizes[index] ?? 0) - (allot[index] ?? 0);
	const framing = of("framing");
	const task = of("task");
	const evidence = of("evidence");

	give(framing, unsent, remaining);
	give(evidence, (index) => leads[index] ?? 0, remaining);
	give(evidence, (index) => Math.min(unsent(index), BRIEFING_MIN_EXCERPT_BYTES), remaining);
	const evidenceWants = evidence.reduce((sum, index) => sum + unsent(index), 0);
	give(task, unsent, Math.max(remaining - evidenceWants, Math.floor(remaining / 2)));
	give(evidence, unsent, remaining);
	give(task, unsent, remaining);

	const clips: BriefingClip[] = [];
	const rendered = parts.map((part, index) => {
		const limit = allot[index] ?? 0;
		const full = whole[index] ?? "";
		if ((sizes[index] ?? 0) <= limit) return full;
		const lead = leads[index] ?? 0;
		const text =
			limit < lead || part.body === undefined
				? clipHead(full, limit)
				: `${part.lead}${abbreviateHeadTail(part.body, limit - lead, notice)}`;
		clips.push({ kind: part.kind, index, bytesBefore: sizes[index] ?? 0, bytesAfter: utf8Bytes(text) });
		return text;
	});
	// Only a cap smaller than the separators themselves reaches this clip.
	const text = clipHead(rendered.join(BRIEFING_SEPARATOR), capBytes);
	return { text, bytes: utf8Bytes(text), clips };
}
