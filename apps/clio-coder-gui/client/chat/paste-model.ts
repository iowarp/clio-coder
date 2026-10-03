import { TURN_FILE_MAX_BYTES } from "../../contracts/attachments.js";
import { decodeTextFile, type FileAttachment } from "./attachments-model.js";
import { PROMPT_TEXT_MAX_CHARACTERS } from "./composer-model.js";

export const LARGE_PASTE_CHARACTERS = 8000;
export type PastePlan =
	| { kind: "inline"; text: string; caret: number }
	| { kind: "file"; file: Omit<FileAttachment, "id">; text: string; caret: number }
	| { kind: "review"; reason: string; text: string; bytes: number };

/** Never truncates. A long paste travels as the runtime's existing embedded text resource. */
export function planPaste(
	paste: string,
	draft: string,
	start: number,
	end: number,
	embeddedContext: boolean,
	name: string,
): PastePlan {
	const before = draft.slice(0, start),
		after = draft.slice(end);
	const inline = before + paste + after;
	if (inline.length <= PROMPT_TEXT_MAX_CHARACTERS && (!embeddedContext || paste.length < LARGE_PASTE_CHARACTERS))
		return { kind: "inline", text: inline, caret: before.length + paste.length };
	const bytes = new TextEncoder().encode(paste);
	if (!embeddedContext)
		return {
			kind: "review",
			text: paste,
			bytes: bytes.length,
			reason: "This task cannot accept text attachments. The paste would exceed the 32,000-character prompt limit.",
		};
	if (bytes.length > TURN_FILE_MAX_BYTES)
		return {
			kind: "review",
			text: paste,
			bytes: bytes.length,
			reason:
				"The full paste exceeds Clio's 128 KiB text attachment limit. Save it as a project file and reference its path in your message.",
		};
	const decoded = decodeTextFile(name, bytes);
	if (!decoded.ok) return { kind: "review", text: paste, bytes: bytes.length, reason: decoded.reason };
	const marker = `Attached text: ${name}`;
	const insertion = `${before && !/\s$/u.test(before) ? "\n" : ""}${marker}${after && !/^\s/u.test(after) ? "\n" : ""}`;
	const text = before + insertion + after;
	if (text.length > PROMPT_TEXT_MAX_CHARACTERS)
		return {
			kind: "review",
			text: paste,
			bytes: bytes.length,
			reason: "The composer is full. Make room for the attachment reference before pasting.",
		};
	return {
		kind: "file",
		text,
		caret: before.length + insertion.length,
		file: { kind: "file", name, text: decoded.text, bytes: decoded.bytes },
	};
}
