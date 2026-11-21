/**
 * Notes, the layer between a session's ledger and a lesson (DESIGN 4.4). A note is a claim with at least one evidence
 * ref, or an agent-authored note with none. It reaches a model through `memory_recall`, and a fix claim also through
 * the `_variant` reminder on a failed call that matches its failed pattern; the `# Memory` section and the other
 * decision points carry lessons only. Two writers exist: the main agent through `memory_note`, whose evidence the host
 * binds at the call, and rules capture, which composes a fix claim from a receipt pair. Neither approves anything:
 * promotion is the gate's, on demonstrations from sessions other than the author's, or the operator's.
 */

import { createHash } from "node:crypto";
import { createRedactionTally, redactSecretsPreservingMarkers } from "../evidence/redact.js";
import { type CommandSegment, parseSourceEvidenceRef, sourceEvidenceRef } from "./command-evidence.js";
import { recordClaimSession } from "./guardian-gate.js";
import { canonicalMemoryRepositoryIdentity } from "./operations.js";
import { claimCommand, claimNote, claimPathRefusal } from "./promotion.js";
import { insertMemoryRecordIfAbsent } from "./store.js";
import { AGENT_NOTE_EVIDENCE_PREFIX, type MemoryClaim, type MemoryRecord } from "./types.js";
import { assertValidMemoryRecord } from "./validate.js";

/** Longest note text kept; the tool's schema states the same bound. */
export const MEMORY_NOTE_MAX_CHARS = 480;

/** What `memory_note` was called with. */
export interface MemoryNoteArgs {
	note: string;
	command?: string;
	path?: string;
	appliesWhen?: string;
}

/** What the host bound a note to: a segment that succeeded in this session, or a read it showed the model. */
export type MemoryNoteEvidence =
	| { kind: "command"; segment: CommandSegment }
	| { kind: "source"; path: string; quote: string }
	| null;

export interface MemoryNoteWritten {
	id: string;
	/** False when the store already held this claim; the session's words are then a revision or nothing. */
	created: boolean;
	evidence: "command" | "source" | "none";
}

/**
 * A failed call and a later success pair as a fix when they run the same program with the same operands and the
 * same environment assignments, and differ only in their options: an option added, removed or changed. Anything
 * else, a different subcommand, script or operand, is two commands and pairs as nothing. A pair can still be a
 * coincidence (a network that came back), which is why it only ever files a note.
 */
export function fixPairOf(failed: CommandSegment, fixed: CommandSegment): boolean {
	if (failed.key === fixed.key) return false;
	if (JSON.stringify(failed.assignments) !== JSON.stringify(fixed.assignments)) return false;
	const [failedProgram, ...failedRest] = failed.argv;
	const [fixedProgram, ...fixedRest] = fixed.argv;
	if (failedProgram === undefined || failedProgram !== fixedProgram) return false;
	const operands = (words: readonly string[]) => words.filter((word) => !word.startsWith("-"));
	if (JSON.stringify(operands(failedRest)) !== JSON.stringify(operands(fixedRest))) return false;
	// Only option words remain to differ, and they do, since the keys differ.
	return true;
}

/**
 * File one session's fix pair as a note through the claim session path: the record is found by claim identity, so
 * every session that hits the same pair lands on one record, and the first is its author. Returns null when a word
 * of either command could not be stored.
 */
export async function fileFixNote(
	dataDir: string,
	input: { sessionId: string; cwd: string; failed: CommandSegment; fixed: CommandSegment },
): Promise<string | null> {
	const failed = claimCommand(input.failed);
	const fixed = claimCommand(input.fixed);
	if (failed === null || fixed === null) return null;
	const result = await recordClaimSession(dataDir, {
		sessionId: input.sessionId,
		cwd: input.cwd,
		lesson: `\`${input.fixed.text}\` succeeded here after \`${input.failed.text}\` failed; only options changed.`,
		claim: { kind: "fix", failed, fixed },
		receipts: [
			{ command: input.failed.text, ok: false },
			{ command: input.fixed.text, ok: true },
		],
	});
	return result.record?.id ?? null;
}

/**
 * Write the main agent's note. A command note is a command claim the session's own receipt demonstrates, filed like a
 * receipt pair; a source note is one quoted span of a file the session read; a note with neither is an agent note,
 * recall-only and never promoted without the operator. The note's words are redacted; a claim that would carry a
 * secret is refused.
 */
export async function writeAgentNote(
	dataDir: string,
	input: { sessionId: string; cwd: string; args: MemoryNoteArgs; evidence: MemoryNoteEvidence; now?: Date },
): Promise<MemoryNoteWritten> {
	const repository = canonicalMemoryRepositoryIdentity(input.cwd);
	if (repository === null) throw new Error("a note needs the session's workspace to be a usable repository path");
	const words = input.args.note.replace(/\s+/gu, " ").trim();
	if (words.length === 0) throw new Error("note is required");
	if (words.length > MEMORY_NOTE_MAX_CHARS) throw new Error(`note is longer than ${MEMORY_NOTE_MAX_CHARS} characters`);
	const appliesWhen = input.args.appliesWhen?.trim() ? [input.args.appliesWhen.trim()] : [];
	const at = (input.now ?? new Date()).toISOString();
	const evidence = input.evidence;
	if (evidence?.kind === "command") {
		const command = claimCommand(evidence.segment);
		if (command === null) throw new Error("that command cannot be stored as evidence");
		// The note names its command, so a reminder and a reader see what it recommends.
		const lesson = words.includes(`\`${evidence.segment.text}\``)
			? words
			: `${words} Command: \`${evidence.segment.text}\`.`;
		const result = await recordClaimSession(dataDir, {
			sessionId: input.sessionId,
			cwd: input.cwd,
			lesson,
			claim: { kind: "command", command },
			...(appliesWhen.length > 0 ? { appliesWhen } : {}),
			receipts: [{ command: evidence.segment.text, ok: true }],
			now: new Date(at),
		});
		if (result.record === null) throw new Error("the store did not keep the note");
		return { id: result.record.id, created: result.created, evidence: "command" };
	}
	if (evidence?.kind === "source") {
		// The same span hash a quoted source ref carries, so delivery checks it as it checks any other.
		const source = parseSourceEvidenceRef(sourceEvidenceRef(evidence.path, evidence.quote));
		if (source === null) throw new Error("that read cannot be stored as evidence");
		const claim: MemoryClaim = { kind: "source", path: source.path, spanHash: source.spanHash };
		const refusal = claimPathRefusal(claim, repository.key);
		if (refusal !== null) throw new Error(refusal);
		const record = claimNote({
			sessionId: input.sessionId,
			lesson: words,
			claim,
			repository,
			at,
			...(appliesWhen.length > 0 ? { appliesWhen } : {}),
		});
		const result = await insertMemoryRecordIfAbsent(dataDir, record);
		return { id: result.record.id, created: result.created, evidence: "source" };
	}
	const lesson = redactSecretsPreservingMarkers(words, createRedactionTally()).replace(/\s+/gu, " ").trim();
	const digest = createHash("sha256")
		.update(JSON.stringify(["agent-note", repository.key, input.sessionId, lesson, appliesWhen]))
		.digest("hex")
		.slice(0, 16);
	const record: MemoryRecord = assertValidMemoryRecord(
		{
			id: `mem-${digest}`,
			scope: "repo",
			key: `agent-note:${digest}`,
			lesson,
			evidenceRefs: [`session:${input.sessionId}`],
			appliesWhen: [`repository:${repository.kind}:${repository.key}`, ...appliesWhen],
			avoidWhen: [],
			confidence: 0.5,
			createdAt: at,
			approved: false,
			repository,
			// Not `session:<id>`: the gate speaks only for a claim whose evidence id is its session (guardian-gate), so an
			// agent note with no evidence waits for the operator however many sessions later agree with it.
			provenance: {
				sourceKind: "evidence",
				evidenceId: `${AGENT_NOTE_EVIDENCE_PREFIX}${input.sessionId}`,
				sourceSessionId: input.sessionId,
			},
		},
		"agent note",
	);
	const result = await insertMemoryRecordIfAbsent(dataDir, record);
	return { id: result.record.id, created: result.created, evidence: "none" };
}
