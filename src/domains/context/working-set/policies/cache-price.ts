/**
 * Prefix-cache pricing of an eviction's head.
 *
 * An event re-prefills everything from its earliest evicted unit to the end of
 * the prompt, because an exact-prefix cache (Anthropic, OpenAI, vLLM,
 * llama.cpp) matches only up to the first changed byte. The head unit of a
 * selection therefore costs its own position: the span between it and the next
 * selected unit is cached history that the event turns into a cache write. A
 * unit kept instead stays a cache read on every later request until the next
 * break removes it.
 *
 * `dropUnpricedHead` walks the selection from the head and drops a unit while
 * the re-write it causes, priced at `REWRITE_OVER_READ`, outweighs reading its
 * body for `KEPT_READ_HORIZON` more requests. It stops at the first unit that
 * pays, so the event's cold start moves toward the tail and never past a unit
 * the pricing accepted. The last unit always stays, so a selection never
 * shrinks to nothing here. A forced reduction (overflow, request fit) skips
 * the pricing entirely: fitting the request comes first.
 *
 * Measured by replaying `structural-v2` with and without this step over the
 * three procedural corpora and 19 recorded gym ledgers at 32k/64k/128k (threshold 0.8,
 * target 0.6, exact-prefix cache, catalog Haiku rates). Estimated input
 * cost fell 4 to 14% and eviction re-writes 15 to 49% in every procedural
 * cell. Overflow reductions fell from 413 to 332 across those cells, while
 * one recorded 32k ledger gained one. Pooled retention moved within 0.04, and
 * summaries rose (e.g. 53 to 72 on science-long at 64k), because a smaller event
 * leaves more of the pressure to the summary stage.
 */

import type { EvictionCandidate, PolicyInput } from "../contract.js";
import { type CallPaths, tokensFreedByEviction } from "../engine.js";
import { projectWorkingSet } from "../project.js";

/**
 * Cache write over cache read, minus the read the write replaces:
 * (1.25 - 0.1) / 0.1 at the catalog's Anthropic rates (`cacheWrite` 1.25x,
 * `cacheRead` 0.1x input). OpenAI-style caches bill a miss at the input rate,
 * which gives 9; a local prefix cache has no price but the same shape in
 * prefill time. The policy has no route, so it carries the catalog ratio.
 */
const REWRITE_OVER_READ = 11.5;

/**
 * Requests a kept body is read before the next break removes it.
 */
const KEPT_READ_HORIZON = 10;

interface Placed {
	candidate: EvictionCandidate;
	index: number;
	freed: number;
}

export function dropUnpricedHead(
	candidates: ReadonlyArray<EvictionCandidate>,
	input: PolicyInput,
	callPaths: CallPaths,
): ReadonlyArray<EvictionCandidate> {
	if (candidates.length < 2 || input.pressure.forced === true) return candidates;
	const { entries, estimateTokens } = input;
	const indexOf = new Map<string, number>();
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		if (entry !== undefined) indexOf.set(entry.turnId, i);
	}
	const placed: Placed[] = [];
	for (const candidate of candidates) {
		const index = indexOf.get(candidate.ref.entry);
		const entry = index === undefined ? undefined : entries[index];
		if (index === undefined || entry === undefined) return candidates;
		placed.push({ candidate, index, freed: tokensFreedByEviction(estimateTokens, entry, candidate, callPaths) });
	}
	placed.sort((a, b) => a.index - b.index);
	const projected = projectWorkingSet(entries, input.view);
	let head = 0;
	while (head < placed.length - 1) {
		const current = placed[head];
		const next = placed[head + 1];
		if (current === undefined || next === undefined) break;
		let span = 0;
		for (let i = current.index; i < next.index; i += 1) {
			const entry = projected[i];
			if (entry !== undefined) span += estimateTokens(entry);
		}
		// What the event re-writes because of this unit alone: the span up to the
		// next unit, less the body that leaves.
		const rewrite = Math.max(0, span - current.freed);
		if (current.freed * KEPT_READ_HORIZON >= rewrite * REWRITE_OVER_READ) break;
		head += 1;
	}
	if (head === 0) return candidates;
	const kept = new Set(placed.slice(head).map((item) => item.candidate));
	return candidates.filter((candidate) => kept.has(candidate));
}
