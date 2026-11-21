import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { MEMORY_NOTE_MAX_CHARS, type MemoryNoteArgs, type MemoryNoteWritten } from "../domains/memory/notes.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export interface MemoryNoteDeps {
	/** `context.memory.surfaces.lessons` is still `agent` and memory is on; the tool refuses otherwise. */
	enabled: () => boolean;
	/** Binds the note's evidence in this session and writes it; a refusal or a store failure throws its reason. */
	write: (args: MemoryNoteArgs) => Promise<MemoryNoteWritten>;
}

const EVIDENCE_TEXT: Readonly<Record<MemoryNoteWritten["evidence"], string>> = {
	command: "bound to the command that succeeded here",
	source: "bound to the file read here",
	none: "with no evidence, so memory_recall finds it and it is never promoted without the operator",
};

/**
 * Orchestrator-only, and attached only to sessions that start with `context.memory.surfaces.lessons: agent`
 * (DESIGN 4.4). It writes one unverified note; it never approves, promotes or rewrites a lesson or an operator's
 * decision.
 */
export function createMemoryNoteTool(deps: MemoryNoteDeps): ToolSpec {
	return {
		name: ToolNames.MemoryNote,
		description:
			"Keep a note for later sessions in this repository. Give command when the note is about a command that succeeded in this session, or path for a file read in this session, and Clio binds it as evidence. A note is unverified until other sessions confirm it or the operator approves it; memory_recall finds it meanwhile.",
		parameters: Type.Object({
			note: Type.String({
				minLength: 1,
				maxLength: MEMORY_NOTE_MAX_CHARS,
				description: "What a later session should know.",
			}),
			command: Type.Optional(
				Type.String({ minLength: 1, description: "A command that succeeded from the workspace root in this session." }),
			),
			path: Type.Optional(Type.String({ minLength: 1, description: "A repository file read in this session." })),
			applies_when: Type.Optional(Type.String({ minLength: 1, description: "The condition the note holds under." })),
		}),
		baseActionClass: "read",
		executionMode: "sequential",
		async run(args): Promise<ToolResult> {
			if (!deps.enabled()) return { kind: "error", message: "memory_note: note writing is off for this session" };
			const note = typeof args.note === "string" ? args.note.trim() : "";
			if (note.length === 0) return { kind: "error", message: "memory_note: note is required" };
			const text = (value: unknown) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);
			const command = text(args.command);
			const path = text(args.path);
			const appliesWhen = text(args.applies_when);
			try {
				const written = await deps.write({
					note,
					...(command !== undefined ? { command } : {}),
					...(path !== undefined ? { path } : {}),
					...(appliesWhen !== undefined ? { appliesWhen } : {}),
				});
				const verb = written.created ? "Noted" : "Already noted";
				const output =
					written.standing === "note"
						? `${verb} [${written.id}], unverified, ${EVIDENCE_TEXT[written.evidence]}.`
						: written.standing === "lesson"
							? `[${written.id}] is already a kept lesson for this claim; it is unchanged.`
							: `[${written.id}] holds this claim and the operator rejected it; it is unchanged.`;
				return { kind: "ok", output, details: { ...written } };
			} catch (err) {
				return { kind: "error", message: `memory_note: ${err instanceof Error ? err.message : String(err)}` };
			}
		},
	};
}
