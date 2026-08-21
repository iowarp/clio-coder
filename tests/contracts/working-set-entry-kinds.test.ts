import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SESSION_ENTRY_KINDS } from "../../src/domains/session/entries.js";

/**
 * Every reader that switches on `entry.kind`, named here so a new ledger kind
 * cannot be added with a reader left behind. TypeScript's never-check catches
 * the exhaustive switches at compile time; this test is the list itself, which
 * is what a reviewer needs when adding a kind, plus the coverage of the two
 * readers that use if-chains instead.
 *
 * Grep-based on purpose: the assertion is about source text naming the kind,
 * which is exactly how `scripts/check-hygiene.ts` checks the same class of
 * drift.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Exhaustive `switch (entry.kind)` sites, with how many switches each file holds. */
const SWITCH_SITES: ReadonlyArray<{ file: string; switches: number }> = [
	{ file: "src/domains/session/compaction/tokens.ts", switches: 1 },
	{ file: "src/domains/session/compaction/cut-point.ts", switches: 1 },
	// buildReplayAgentMessagesFromTurns and rehydrateChatPanelFromTurns.
	{ file: "src/interactive/chat-renderer.ts", switches: 2 },
];

/** Readers that dispatch on `entry.kind` without an exhaustive switch. */
const PREDICATE_SITES: ReadonlyArray<string> = ["src/domains/evidence/build.ts"];

function read(file: string): string {
	return readFileSync(join(ROOT, file), "utf8");
}

function count(source: string, needle: string): number {
	return source.split(needle).length - 1;
}

test("entry kinds: every switch site handles the working-set kinds", () => {
	for (const site of SWITCH_SITES) {
		const source = read(site.file);
		assert.equal(count(source, 'case "contextEviction":'), site.switches, `${site.file} misses contextEviction`);
		assert.equal(count(source, 'case "contextRecall":'), site.switches, `${site.file} misses contextRecall`);
	}
});

test("entry kinds: every switch site names every ledger kind", () => {
	for (const site of SWITCH_SITES) {
		const source = read(site.file);
		for (const kind of SESSION_ENTRY_KINDS) {
			assert.equal(source.includes(`case "${kind}"`), true, `${site.file} never names ${kind}`);
		}
	}
});

test("entry kinds: the predicate readers handle the working-set kinds", () => {
	for (const file of PREDICATE_SITES) {
		const source = read(file);
		assert.equal(source.includes('entry.kind === "contextEviction"'), true, `${file} misses contextEviction`);
		assert.equal(source.includes('entry.kind === "contextRecall"'), true, `${file} misses contextRecall`);
	}
});

test("entry kinds: the canonical list carries both working-set kinds", () => {
	assert.equal(SESSION_ENTRY_KINDS.includes("contextEviction"), true);
	assert.equal(SESSION_ENTRY_KINDS.includes("contextRecall"), true);
});
