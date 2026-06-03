import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { GLYPH, SPINNER_FRAMES, spinnerFrame } from "../../src/interactive/theme/glyphs.js";

describe("theme glyphs", () => {
	it("exposes the brand glyphs", () => {
		strictEqual(GLYPH.agent, "◈");
		strictEqual(GLYPH.user, "›");
		strictEqual(GLYPH.ok, "✓");
		strictEqual(GLYPH.error, "✗");
	});

	it("wraps spinner frames and handles negative ticks", () => {
		strictEqual(spinnerFrame(0), SPINNER_FRAMES[0]);
		strictEqual(spinnerFrame(SPINNER_FRAMES.length), SPINNER_FRAMES[0]);
		strictEqual(spinnerFrame(-1), SPINNER_FRAMES[SPINNER_FRAMES.length - 1]);
	});
});
