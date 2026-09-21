/**
 * Exact UTF-8 note admission (CONTRACTS.md §4).
 *
 * The operator's note is stored as the bytes they wrote. Whitespace is tested
 * for emptiness only: nothing here trims, normalizes Unicode, truncates, or
 * regenerates the accepted value, because replay must reproduce the decoded
 * string exactly and JSONL escaping already changes the wire representation.
 *
 * Validation runs before any append or lock, takes no lock itself, and writes
 * nothing. A rejection is typed so the caller can explain it without guessing.
 */

import { createHash } from "node:crypto";
import {
	type AcceptedNote,
	type AcceptedNoteVerification,
	HANDOFF_NOTE_MAX_BYTES,
	type NoteValidation,
} from "./contract.js";

function sha256Utf8(value: string): string {
	return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

/**
 * Admit a note, or say precisely why not.
 *
 * The UTF-8 round trip is the check that rejects a lone surrogate: encoding
 * `"\uD800"` and decoding it back yields U+FFFD, so the decoded string differs
 * from the input and the note is refused rather than silently stored as a
 * replacement character the operator never typed. The byte bound is measured on
 * the UTF-8 encoding, not on `String.length`, so an emoji-heavy note is bounded
 * by what the provider will actually carry.
 */
export function validateContinuityNote(note: unknown): NoteValidation {
	if (typeof note !== "string") return { ok: false, reason: "not_a_string", noteBytes: null };
	if (note.trim().length === 0) return { ok: false, reason: "blank", noteBytes: null };
	if (note.includes("\u0000")) return { ok: false, reason: "contains_nul", noteBytes: null };

	const encoded = Buffer.from(note, "utf8");
	if (encoded.toString("utf8") !== note) {
		return { ok: false, reason: "not_utf8_round_trip", noteBytes: encoded.byteLength };
	}
	if (encoded.byteLength > HANDOFF_NOTE_MAX_BYTES) {
		return { ok: false, reason: "exceeds_max_bytes", noteBytes: encoded.byteLength };
	}
	return {
		ok: true,
		accepted: { note, noteBytes: encoded.byteLength, noteSha256: sha256Utf8(note) },
	};
}

/**
 * Verify a note read back from a record.
 *
 * Self-consistency first: the text is re-admitted, because a record whose note
 * no longer admits is not usable evidence whatever its digest says, and the
 * stored byte count and hash must match that re-encoding. Byte count is
 * compared before the hash so a truncated readback reports the truncation
 * rather than an opaque digest mismatch.
 *
 * `expected` compares two copies of the same transaction, which is how a
 * commit's note and a later summary carry's note are held to exact decoded
 * equality across records.
 */
export function verifyAcceptedNote(accepted: AcceptedNote, expected?: AcceptedNote): AcceptedNoteVerification {
	const revalidated = validateContinuityNote(accepted.note);
	if (!revalidated.ok) return { ok: false, reason: revalidated.reason };
	if (revalidated.accepted.noteBytes !== accepted.noteBytes) return { ok: false, reason: "byte_count_mismatch" };
	if (revalidated.accepted.noteSha256 !== accepted.noteSha256) return { ok: false, reason: "hash_mismatch" };
	if (!expected) return { ok: true };
	// Decoded text first: when two copies of one transaction disagree, the
	// useful report is that the text differs, not a digest that differs because
	// the text does.
	if (expected.note !== accepted.note) return { ok: false, reason: "decoded_text_mismatch" };
	if (expected.noteBytes !== accepted.noteBytes) return { ok: false, reason: "byte_count_mismatch" };
	if (expected.noteSha256 !== accepted.noteSha256) return { ok: false, reason: "hash_mismatch" };
	return { ok: true };
}
