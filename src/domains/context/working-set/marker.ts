/**
 * The one-line stub the projection renders in place of an evicted tool-result
 * body.
 *
 * Byte-stable by construction: same input, same bytes, forever. No timestamp,
 * no counter, no `Date.now()`. Two reasons. The marker is persisted inside the
 * `contextEviction` entry and replayed by the projection on every request, so a
 * marker that changed between renders would invalidate the prompt cache on a
 * turn that evicted nothing new. And replay-lite reruns the same policy over
 * recorded ledgers; a marker carrying wall-clock state would make two runs of
 * the same trace disagree.
 *
 * The field order is fixed (ref, reason, by, tool, path, size, offload,
 * recall, preview) so a diff between two markers is readable and so a model
 * reading many of them sees the same shape every time. Undefined fields are
 * omitted rather than rendered empty. `recall` spells out the exact tool call
 * that brings the body back, which is the only affordance the model has once
 * the body is gone.
 */

import { formatSize } from "../../../engine/truncate.js";
import type { EvictionReason, WorkingSetRef } from "./contract.js";

/** Characters of the original body the marker keeps as a preview. */
const PREVIEW_LIMIT = 120;

export interface MarkerInput {
	ref: WorkingSetRef;
	reason: EvictionReason;
	/** Ref key of the entry that superseded or resolved this one, when the reason names one. */
	by?: string | undefined;
	toolName: string;
	/** The body leaving the working set; drives size and preview. */
	text: string;
	/** Set when the original result was offloaded to scratch. Replaces the preview. */
	offloadPath?: string | undefined;
	/** Primary file the result was about, when the payload names exactly one. */
	path?: string | undefined;
}

function lineCount(text: string): number {
	if (text.length === 0) return 0;
	return text.split(/\r\n|\r|\n/).length;
}

/**
 * First `PREVIEW_LIMIT` characters with whitespace collapsed to single spaces
 * and double quotes escaped, so the preview never breaks the quoted field or
 * spills onto a second line.
 */
function preview(text: string): string {
	return text.trim().replace(/\s+/g, " ").slice(0, PREVIEW_LIMIT).replace(/"/g, '\\"');
}

export function renderMarker(input: MarkerInput): string {
	const ref = input.ref.entry;
	const fields: string[] = [`ref=${ref}`, `reason=${input.reason}`];
	if (input.by !== undefined) fields.push(`by=${input.by}`);
	fields.push(`tool=${input.toolName}`);
	if (input.path !== undefined) fields.push(`path=${input.path}`);
	fields.push(`size=${lineCount(input.text)} lines/${formatSize(Buffer.byteLength(input.text, "utf8"))}`);
	if (input.offloadPath !== undefined) fields.push(`offload=${input.offloadPath}`);
	fields.push(`recall=context(scope="recall", ref="${ref}")`);
	// An offloaded body is one `read` away at a stable path; a preview of it
	// would spend tokens repeating what the pointer already promises.
	if (input.offloadPath === undefined) {
		const head = preview(input.text);
		if (head.length > 0) fields.push(`preview="${head}"`);
	}
	return `[evicted ${fields.join(" ")}]`;
}
