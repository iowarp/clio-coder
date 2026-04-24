import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { BranchSummaryEntry, CompactionSummaryEntry } from "../../src/domains/session/entries.js";
import { renderBranchSummaryEntry, renderBranchSummaryHeader } from "../../src/interactive/renderers/branch-summary.js";
import {
	renderCompactionSummaryEntry,
	renderCompactionSummaryHeader,
	renderCompactionSummaryLine,
} from "../../src/interactive/renderers/compaction-summary.js";

// Biome bans literal ESC bytes in source; build the ANSI-strip pattern with
// the escape byte injected at runtime (same trick chat-panel.test.ts uses).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
function strip(s: string): string {
	return s.replace(ANSI, "");
}
function stripLines(lines: string[]): string[] {
	return lines.map(strip);
}

function branchEntry(summary: string, fromTurnId = "t-parent-42"): BranchSummaryEntry {
	return {
		kind: "branchSummary",
		turnId: "e-b1",
		parentTurnId: null,
		timestamp: "2026-04-23T00:00:00.000Z",
		fromTurnId,
		summary,
	};
}

function compactionEntry(summary: string, tokensBefore = 12_345, firstKeptTurnId = "t-kept-1"): CompactionSummaryEntry {
	return {
		kind: "compactionSummary",
		turnId: "e-c1",
		parentTurnId: null,
		timestamp: "2026-04-23T00:00:01.000Z",
		summary,
		tokensBefore,
		firstKeptTurnId,
	};
}

describe("renderers/branch-summary renderBranchSummaryEntry", () => {
	it("renders a header line followed by an indented markdown body", () => {
		const entry = branchEntry("**Goal**: ship parity\n\n- done one\n- done two");
		const lines = stripLines(renderBranchSummaryEntry(entry, 60));
		ok(lines.length >= 2, `expected at least header + body, got: ${JSON.stringify(lines)}`);
		const header = lines[0] ?? "";
		strictEqual(header.startsWith("[branch summary]"), true);
		match(header, /from turn t-parent-42/);
		// Body lines must start with the 2-space indent.
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i] ?? "";
			ok(line.startsWith("  "), `body line ${i} not indented: ${JSON.stringify(line)}`);
		}
		const body = lines.slice(1).join("\n");
		match(body, /Goal/);
		match(body, /done one/);
		match(body, /done two/);
	});

	it("returns [] for an empty summary", () => {
		const entry = branchEntry("   \n\n  ");
		strictEqual(renderBranchSummaryEntry(entry, 60).length, 0);
	});

	it("omits the label when hideLabel is set", () => {
		const entry = branchEntry("plain body text");
		const lines = stripLines(renderBranchSummaryEntry(entry, 60, { hideLabel: true }));
		ok(lines.length > 0);
		const first = lines[0] ?? "";
		strictEqual(first.startsWith("[branch summary]"), false);
		ok(first.startsWith("  "), `first body line not indented: ${JSON.stringify(first)}`);
	});

	it("renderBranchSummaryHeader stays within the requested width", () => {
		const entry = branchEntry("body", "turn-id-that-is-unusually-long-but-should-wrap-ok");
		const lines = stripLines(renderBranchSummaryHeader(entry, 40));
		ok(lines.length >= 1);
		for (const line of lines) {
			ok(line.length <= 40, `header line exceeds width: ${JSON.stringify(line)}`);
		}
	});
});

describe("renderers/compaction-summary renderCompactionSummaryEntry", () => {
	it("renders a header with tokens-before + firstKeptTurnId and an indented body", () => {
		const entry = compactionEntry("## Goal\nShip compaction renderer.\n\n## Done\n- [x] header", 31_420, "t-kept-xyz");
		const lines = stripLines(renderCompactionSummaryEntry(entry, 72));
		ok(lines.length >= 2, `expected at least header + body, got ${JSON.stringify(lines)}`);
		const header = lines[0] ?? "";
		strictEqual(header.startsWith("[compaction summary]"), true);
		match(header, /~31,420 tokens before/);
		match(header, /t-kept-xyz/);
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i] ?? "";
			ok(line.startsWith("  "), `body line ${i} not indented: ${JSON.stringify(line)}`);
		}
		const body = lines.slice(1).join("\n");
		match(body, /Ship compaction renderer/);
	});

	it("returns [] for an empty summary", () => {
		strictEqual(renderCompactionSummaryEntry(compactionEntry(""), 72).length, 0);
		strictEqual(renderCompactionSummaryEntry(compactionEntry("   \n"), 72).length, 0);
	});

	it("omits the label when hideLabel is set", () => {
		const entry = compactionEntry("body line");
		const lines = stripLines(renderCompactionSummaryEntry(entry, 60, { hideLabel: true }));
		ok(lines.length > 0);
		const first = lines[0] ?? "";
		strictEqual(first.startsWith("[compaction summary]"), false);
		ok(first.startsWith("  "));
	});

	it("renderCompactionSummaryHeader formats tokens with locale separators", () => {
		const entry = compactionEntry("x", 1_234_567, "t-k");
		const lines = stripLines(renderCompactionSummaryHeader(entry, 80));
		ok(lines.length >= 1);
		const header = lines[0] ?? "";
		match(header, /~1,234,567 tokens before/);
		match(header, /cont\. at turn t-k/);
	});

	it("renderCompactionSummaryLine preserves the legacy one-line shape", () => {
		// chat-loop depends on the exact format; keep the shape stable so the
		// notice seen by /compact users after slice 12c stays pixel-identical.
		const line = renderCompactionSummaryLine({
			messagesSummarized: 42,
			summaryChars: 1823,
			tokensBefore: 31_420,
		});
		strictEqual(line, "[compacted: 42 messages → 1823 chars (~31420 tokens before)]");
	});
});
