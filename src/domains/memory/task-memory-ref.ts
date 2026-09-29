/**
 * Display form of a task-memory note. The model-facing reminder and the ledger
 * keep the `Memory:` prefix and the `[tm-p-1]` trajectory refs that let a later
 * turn cite an entry; the operator reads the sentence without them.
 */

// One ref is `tm-<s|k|p>-<base36 counter>`, as `TaskBank` mints them.
const REF = "\\[tm-[skp]-[0-9a-z]+\\]";
const REF_RUN = `${REF}(?:\\s*(?:,|;|&|and)?\\s*${REF})*`;
const PARENTHESIZED_REFS = new RegExp(`\\s*\\(\\s*${REF_RUN}\\s*\\)`, "gu");
const BARE_REFS = new RegExp(REF_RUN, "gu");

export function taskMemoryNoteForDisplay(text: string): string {
	return (
		text
			.replace(/^\s*Memory:\s*/u, "")
			.replace(PARENTHESIZED_REFS, "")
			.replace(BARE_REFS, "")
			.replace(/[ \t]{2,}/gu, " ")
			.replace(/\s+([,.;:!?])/gu, "$1")
			.trim()
			// The note continues the prefix ("Memory: you already tried"), so bare it starts a sentence.
			.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase())
	);
}
