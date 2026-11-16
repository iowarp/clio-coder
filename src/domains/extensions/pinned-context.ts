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
 */

import { neutralizeFraming } from "../../core/reminder-framing.js";

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

export function createPinnedContextStore(): PinnedContextStore {
	const blocks = new Map<string, string>();
	return {
		pin(extensionId, text) {
			// A clear of a block never pinned leaves nothing to retract.
			if (text.length === 0 && !blocks.has(extensionId)) return;
			blocks.set(extensionId, text);
		},
		pinned: () => [...blocks].map(([extensionId, text]) => ({ extensionId, text })),
		retainPinned(extensionIds) {
			for (const extensionId of blocks.keys()) if (!extensionIds.has(extensionId)) blocks.set(extensionId, "");
		},
	};
}
