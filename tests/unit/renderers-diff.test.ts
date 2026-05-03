import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { renderUnifiedDiff } from "../../src/interactive/renderers/diff.js";

// Strip ANSI sequences. Biome bans literal control chars in regex source,
// so build the pattern from a constructor with the ESC byte injected.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

describe("renderers/diff", () => {
	it("emits no-change marker for identical input", () => {
		const out = renderUnifiedDiff({ oldText: "a\n", newText: "a\n" }, 80);
		strictEqual(out.length, 1);
		ok(stripAnsi(out[0] ?? "").includes("(no changes)"));
	});

	it("emits +/- lines and a hunk header with default filename", () => {
		const out = renderUnifiedDiff({ oldText: "alpha\nbeta\n", newText: "alpha\nGAMMA\n" }, 80);
		const plain = out.map(stripAnsi).join("\n");
		ok(plain.includes("--- a/file"));
		ok(plain.includes("+++ b/file"));
		ok(plain.includes("@@"));
		ok(plain.includes("1 1  alpha"));
		ok(plain.includes("2   -beta"));
		ok(plain.includes("  2 +GAMMA"));
	});

	it("uses the supplied filename when provided", () => {
		const out = renderUnifiedDiff({ oldText: "x\n", newText: "y\n", filename: "src/foo.ts" }, 80);
		const plain = out.map(stripAnsi).join("\n");
		ok(plain.includes("--- a/src/foo.ts"));
		ok(plain.includes("+++ b/src/foo.ts"));
	});

	it("wraps lines wider than the supplied width", () => {
		const long = "x".repeat(200);
		const out = renderUnifiedDiff({ oldText: "", newText: `${long}\n`, filename: "wide.txt" }, 40);
		for (const line of out) {
			ok(stripAnsi(line).length <= 40, `line too wide: ${stripAnsi(line).length}`);
		}
	});

	it("renders pure deletion (empty newText) with - lines for every removed line", () => {
		const out = renderUnifiedDiff({ oldText: "alpha\nbeta\n", newText: "", filename: "doomed.ts" }, 80);
		const plain = out.map(stripAnsi).join("\n");
		ok(plain.includes("--- a/doomed.ts"), JSON.stringify(plain));
		ok(plain.includes("-alpha"), JSON.stringify(plain));
		ok(plain.includes("-beta"), JSON.stringify(plain));
	});

	it("respects custom context line count", () => {
		const oldText = `${["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n")}\n`;
		const newText = `${["1", "2", "3", "4", "X", "6", "7", "8", "9"].join("\n")}\n`;
		const out1 = renderUnifiedDiff({ oldText, newText, context: 1 }, 80);
		const out3 = renderUnifiedDiff({ oldText, newText, context: 3 }, 80);
		// Larger context => more total lines (the hunk includes more surrounding context).
		ok(
			out3.length > out1.length,
			`expected context=3 to produce more lines than context=1, got ${out3.length} vs ${out1.length}`,
		);
	});
});
