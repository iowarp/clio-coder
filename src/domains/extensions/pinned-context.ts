/**
 * Pinned context: one block of durable state per api 2 extension that the
 * session's model always has in view, such as a writing desk's milestone and
 * next step. A hook sets it with the `pin_context` effect; a new value
 * replaces the old one and empty text clears it.
 *
 * The block rides host-framed text in the message tail and never the system
 * prompt (#423). It is sent once, at the head of the next request's new
 * messages, and again only when the context no longer carries its current
 * value: after the value changed, or after a compaction summarized away the
 * message that carried it. Everything before that message keeps its bytes, so
 * an unchanged block costs nothing and a changed one re-reads nothing: the new
 * value is new tail text, never a rewrite of the cached prefix. Dispatched
 * workers never receive it; only the session's own turn reads the store.
 *
 * A main session's blocks persist with the session, so a resumed or restarted
 * session has them on its first request without waiting for a hook to set
 * them again. A cleared block stays cleared.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { neutralizeFraming } from "../../core/reminder-framing.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioStateDir } from "../../core/xdg.js";

/** UTF-8 bytes one extension's pinned block may hold. */
export const PINNED_CONTEXT_MAX_BYTES = 8 * 1024;

export interface PinnedContextBlock {
	extensionId: string;
	/** Empty once the extension cleared its block; the model is told so once, then nothing is sent. */
	text: string;
}

const opening = (extensionId: string): string => `<pinned-context extension="${extensionId}">`;

/** The block's text can neither open nor close a pinned-context frame of its own. */
function neutralizePinnedFrame(text: string): string {
	return text.replace(/<\s*(\/?)\s*(pinned-context)/giu, (_, slash: string, tag: string) => `<\\${slash}${tag}`);
}

/** The block exactly as the model reads it. */
export function renderPinnedContext(block: PinnedContextBlock): string {
	const body =
		block.text.length > 0
			? `This replaces any earlier pinned context from ${block.extensionId}.\n${neutralizePinnedFrame(block.text)}`
			: `Cleared: disregard any earlier pinned context from ${block.extensionId}.`;
	return `${opening(block.extensionId)}\n${body}\n</pinned-context>`;
}

/**
 * The rendered blocks the context does not already carry at their current
 * value. `framed` is the host-framed text in context, oldest first, as
 * `hostFramedTexts` reads it back; an extension's latest framed mention
 * decides, so a value set again after another one is sent again. A cleared
 * block is said only while an earlier value is still in view.
 */
export function pinnedContextDelta(blocks: ReadonlyArray<PinnedContextBlock>, framed: ReadonlyArray<string>): string[] {
	const delta: string[] = [];
	for (const block of blocks) {
		const rendered = renderPinnedContext(block);
		const head = neutralizeFraming(opening(block.extensionId));
		let latest: string | undefined;
		for (let at = framed.length - 1; at >= 0 && latest === undefined; at--)
			if (framed[at]?.includes(head)) latest = framed[at];
		if (block.text.length === 0 && latest === undefined) continue;
		if (latest?.includes(neutralizeFraming(rendered)) === true) continue;
		delta.push(rendered);
	}
	return delta;
}

/** The session's pinned blocks, keyed by extension, in the order each was first pinned. */
export interface PinnedContextStore {
	pin(extensionId: string, text: string): void;
	pinned(): ReadonlyArray<PinnedContextBlock>;
	/** Clear every block whose extension is not in `extensionIds`, as a reload that removed it does. */
	retainPinned(extensionIds: ReadonlySet<string>): void;
}

/** Where a main session's blocks persist. Without it the store holds them in memory only, as a worker's does. */
export interface PinnedContextPersistence {
	/** The session the blocks belong to; null before one exists. */
	sessionId(): string | null;
	/** Defaults to the Clio state directory. */
	stateDir?: () => string;
}

/** One file per session; the id is hashed so it cannot escape the directory. */
export function pinnedContextFile(stateDir: string, sessionId: string): string {
	const stem = createHash("sha256").update(sessionId).digest("hex");
	return path.join(stateDir, "extensions", ".pinned", `${stem}.json`);
}

function readPinnedBlocks(file: string): Map<string, string> {
	const blocks = new Map<string, string>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// Absent until the session's first pin; a corrupt file reads as no blocks.
		return blocks;
	}
	const stored = (parsed as { blocks?: unknown } | null)?.blocks;
	if (!Array.isArray(stored)) return blocks;
	for (const block of stored) {
		const { extensionId, text } = (block ?? {}) as { extensionId?: unknown; text?: unknown };
		if (typeof extensionId !== "string" || extensionId.length === 0 || typeof text !== "string") continue;
		if (Buffer.byteLength(text, "utf8") > PINNED_CONTEXT_MAX_BYTES) continue;
		blocks.set(extensionId, text);
	}
	return blocks;
}

export function createPinnedContextStore(persistence?: PinnedContextPersistence): PinnedContextStore {
	let blocks = new Map<string, string>();
	// The session whose blocks `blocks` holds, and the extensions the last reload kept.
	let owner: string | null = null;
	let retained: ReadonlySet<string> | null = null;
	const file = (sessionId: string): string => pinnedContextFile((persistence?.stateDir ?? clioStateDir)(), sessionId);
	const save = (): void => {
		if (owner === null) return;
		const stored = [...blocks].map(([extensionId, text]) => ({ extensionId, text }));
		try {
			safeResourceWrite(file(owner), `${JSON.stringify({ version: 1, blocks: stored })}\n`);
		} catch {
			// The file serves the next process; this one reads `blocks`. A state directory that cannot be written
			// must not fail the hook, the request or the reload commit that set the block (WTF-P 0.8.3 B5).
		}
	};
	const clearRemoved = (): boolean => {
		let changed = false;
		for (const [extensionId, text] of blocks)
			if (retained !== null && !retained.has(extensionId) && text.length > 0) {
				blocks.set(extensionId, "");
				changed = true;
			}
		return changed;
	};
	/** Follow the session: a resumed or switched-to session brings its own blocks back before anything reads them. */
	const follow = (): void => {
		if (persistence === undefined) return;
		const current = persistence.sessionId();
		if (current === owner) return;
		if (current === null) {
			// The session closed; whatever is pinned next belongs to the session that follows.
			blocks = new Map();
			owner = null;
			return;
		}
		const loaded = readPinnedBlocks(file(current));
		// Blocks pinned before any session existed belong to the session that adopts them.
		const adopted = owner === null ? [...blocks] : [];
		for (const [extensionId, text] of adopted) loaded.set(extensionId, text);
		blocks = loaded;
		owner = current;
		if (clearRemoved() || adopted.length > 0) save();
	};
	return {
		pin(extensionId, text) {
			follow();
			// A clear of a block never pinned leaves nothing to retract, and an unchanged value has nothing to record.
			if (text.length === 0 && !blocks.has(extensionId)) return;
			if (blocks.get(extensionId) === text) return;
			blocks.set(extensionId, text);
			save();
		},
		pinned: () => {
			follow();
			return [...blocks].map(([extensionId, text]) => ({ extensionId, text }));
		},
		retainPinned(extensionIds) {
			follow();
			retained = extensionIds;
			if (clearRemoved()) save();
		},
	};
}
