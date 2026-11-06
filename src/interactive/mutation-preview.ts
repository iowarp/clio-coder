/**
 * Local inspection of the exact mutation a parked `write` or `edit` would make.
 *
 * The approval card describes an unlisted argument by type and size, so a
 * parked write read `content=<string 482 bytes>` and a parked edit read
 * `edits=<array 3 items>`: the operator authorized bytes they had never seen,
 * and the only way to read them was the external session ledger (issue #254).
 *
 * Two rules shape everything here. The preview is derived from the same
 * arguments object the decision resumes, and it carries a digest of those
 * arguments so the bytes on screen are verifiably the bytes being approved.
 * And the mutation text is process-local: it is built lazily when the operator
 * asks for it, it is handed only to the overlay body, and it is never placed on
 * {@link import("./permission-overlay.js").ApprovalRequestView}, which is what
 * crosses into the transcript, the notices, and the worker seam.
 */

import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../domains/safety/call-target.js";
import { mutationFacts, readEdits } from "../session-control/approval-request-facts.js";
import type { MutationFacts } from "../session-control/approval-request-view.js";
import {
	applyEditsToNormalizedContent,
	type Edit,
	generateDiffString,
	normalizeToLF,
	stripBom,
} from "../tools/edit-diff.js";
import { resolveToCwd } from "../tools/path-utils.js";

export { MUTATION_PREVIEW_KEY } from "./permission-hint.js";

/** Rows of mutation shown at once. Anything longer scrolls, as `/handoff` review does. */
export const MUTATION_PREVIEW_VISIBLE_ROWS = 16;

/**
 * Characters of proposed content the preview renders. The diff builder has its
 * own byte backstop; this bounds the write path, whose payload is a whole file.
 * Reaching it prints an explicit line naming what was withheld.
 */
export const MUTATION_PREVIEW_MAX_CHARS = 262_144;

export { mutationFacts } from "../session-control/approval-request-facts.js";
export type { MutationFacts } from "../session-control/approval-request-view.js";

export interface MutationPreview {
	facts: MutationFacts;
	/** What the body is, named honestly on the overlay's first line. */
	heading: string;
	/** The complete rendered mutation, already sanitized and one entry per display row. */
	body: ReadonlyArray<string>;
	/** A control byte or escape sequence in the payload was neutralized for display. */
	neutralized: boolean;
	/** A tab was expanded, so columns are display columns. */
	tabsExpanded: boolean;
}

/**
 * Build the complete preview for the parked call, or explain why it cannot be
 * built. Never throws: an unreadable file or an edit list that will not apply
 * is itself something the operator needs to read before deciding.
 */
export type MutationInspector = () => MutationPreview;

/** `write · 482 B · sha256 3f9a1c22ee04b7d1`, the collapsed card's whole mutation line. */
/**
 * A parked change's target as the card and the transcript row show it. A
 * file change's size placeholder (`content=<string 18 bytes>`) is
 * serialization, and the mutation row under it already names the size and
 * digest, so only the path stays.
 */
export function targetWithoutPayloadSize(
	target: string | undefined,
	mutation: MutationFacts | undefined,
): string | undefined {
	if (target === undefined || mutation === undefined) return target;
	const kept = target.split(" · ").filter((part) => !/^[\w.-]+=<\w+ \d+ bytes?>$/u.test(part.trim()));
	return kept.length > 0 ? kept.join(" · ") : target;
}

export function mutationFactsLine(facts: MutationFacts): string {
	const shape =
		facts.kind === "write"
			? `write ${facts.bytes} B`
			: `edit ${facts.replacements} replacement${facts.replacements === 1 ? "" : "s"} · ${facts.bytes} B`;
	return `${shape} · sha256 ${facts.digest}`;
}

function numberedLines(text: string): string[] {
	const raw = text.split("\n");
	const width = String(raw.length).length;
	return raw.map((line, index) => `${String(index + 1).padStart(width, " ")} ${line}`);
}

function boundedContent(content: string): { text: string; withheld: number } {
	if (content.length <= MUTATION_PREVIEW_MAX_CHARS) return { text: content, withheld: 0 };
	return {
		text: content.slice(0, MUTATION_PREVIEW_MAX_CHARS),
		withheld: content.length - MUTATION_PREVIEW_MAX_CHARS,
	};
}

function previewFrom(
	facts: MutationFacts,
	heading: string,
	text: string,
	options: { numbered?: boolean; trailer?: string } = {},
): MutationPreview {
	const clean = sanitizeMultilineDisplayText(text);
	const body = options.numbered ? numberedLines(clean.text) : clean.text.split("\n");
	if (options.trailer !== undefined) body.push(options.trailer);
	return {
		facts,
		heading,
		body,
		neutralized: clean.neutralized,
		tabsExpanded: clean.tabsExpanded,
	};
}

function refusal(facts: MutationFacts, heading: string, reason: string): MutationPreview {
	return { facts, heading, body: [reason], neutralized: false, tabsExpanded: false };
}

/**
 * The requested replacements, rendered as a diff would render them, for the
 * case where the effective diff cannot be computed. The operator still needs to
 * read what the model asked for; the heading says this is the request rather
 * than the effect.
 */
function replacementListing(edits: ReadonlyArray<Edit>): string {
	const blocks: string[] = [];
	for (const [index, edit] of edits.entries()) {
		blocks.push(`@@ replacement ${index + 1} of ${edits.length}`);
		for (const line of normalizeToLF(edit.oldText).split("\n")) blocks.push(`- ${line}`);
		for (const line of normalizeToLF(edit.newText).split("\n")) blocks.push(`+ ${line}`);
	}
	return blocks.join("\n");
}

function editPreview(facts: MutationFacts, path: string, edits: ReadonlyArray<Edit>, read: (path: string) => string) {
	let current: string;
	try {
		current = read(resolveToCwd(path));
	} catch (error) {
		const message = sanitizeCallTargetText(error instanceof Error ? error.message : String(error));
		return previewFrom(
			facts,
			`Requested replacements for ${sanitizeCallTargetText(path)} (the file could not be read: ${message})`,
			replacementListing(edits),
		);
	}
	try {
		const { text } = stripBom(current);
		const applied = applyEditsToNormalizedContent(normalizeToLF(text), edits, path);
		const diff = generateDiffString(applied.baseContent, applied.newContent);
		return previewFrom(facts, `Effective diff for ${sanitizeCallTargetText(path)}`, diff.diff);
	} catch (error) {
		const message = sanitizeCallTargetText(error instanceof Error ? error.message : String(error));
		return previewFrom(
			facts,
			`Requested replacements for ${sanitizeCallTargetText(path)} (they do not apply: ${message})`,
			replacementListing(edits),
		);
	}
}

/** Files above this skip the transcript's early diff, as the edit tool skips its own. */
const EDIT_PREVIEW_MAX_BYTES = 1024 * 1024;

/**
 * The diff an edit will make, computed from the file once its arguments have
 * closed and before its result lands, for the live row (Pi shows the same).
 * Null when the edit list is incomplete, the file is large or unreadable, or
 * the replacements do not apply: the row then keeps its streamed text and the
 * tool's own result says what happened.
 */
export async function editPreviewDiff(args: unknown): Promise<string | null> {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
	const record = args as Record<string, unknown>;
	const path = typeof record.path === "string" ? record.path : "";
	const edits = readEdits(record.edits);
	if (path.length === 0 || edits === null || edits.length === 0) return null;
	try {
		const target = resolveToCwd(path);
		if ((await stat(target)).size > EDIT_PREVIEW_MAX_BYTES) return null;
		const { text } = stripBom(await readFile(target, "utf8"));
		const applied = applyEditsToNormalizedContent(normalizeToLF(text), edits, path);
		const diff = generateDiffString(applied.baseContent, applied.newContent).diff;
		return diff.length > 0 ? diff : null;
	} catch {
		// A preview that cannot be built is not an error: the call itself reports it.
		return null;
	}
}

export interface MutationInspectorOptions {
	/** Reads the current file bytes for an edit's effective diff. Injected so the contract test owns the filesystem. */
	readFile?: (path: string) => string;
}

/**
 * Bind an inspector to one parked call. The returned closure reads the file and
 * computes the diff only when the operator presses the inspect key, and it
 * re-derives the digest from the same arguments it renders: a mismatch means
 * the arguments changed under the decision and the preview refuses rather than
 * showing bytes that are no longer the ones being approved.
 */
export function createMutationInspector(
	tool: string,
	args: Record<string, unknown> | undefined,
	facts: MutationFacts,
	options: MutationInspectorOptions = {},
): MutationInspector {
	const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	return () => {
		const current = mutationFacts(tool, args);
		if (current === null || current.digest !== facts.digest) {
			return refusal(
				facts,
				"Preview unavailable",
				`These arguments no longer digest to sha256 ${facts.digest}. Deny this call rather than approving bytes that cannot be shown.`,
			);
		}
		const path = typeof args?.path === "string" ? args.path : "";
		if (facts.kind === "write") {
			const content = typeof args?.content === "string" ? args.content : "";
			const bounded = boundedContent(content);
			return previewFrom(facts, `Proposed content for ${sanitizeCallTargetText(path)}`, bounded.text, {
				numbered: true,
				...(bounded.withheld > 0
					? { trailer: `… ${bounded.withheld} more characters not shown (preview capped at ${MUTATION_PREVIEW_MAX_CHARS})` }
					: {}),
			});
		}
		const edits = readEdits(args?.edits) ?? [];
		return editPreview(facts, path, edits, read);
	};
}
