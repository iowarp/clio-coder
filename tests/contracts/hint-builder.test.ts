import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHint, canonicalizeKey, elideHint } from "../../src/interactive/overlay-frame.js";

describe("contracts/hint-builder", () => {
	it("normalizes key casing correctly", () => {
		strictEqual(canonicalizeKey("enter"), "Enter");
		strictEqual(canonicalizeKey("ENTER"), "Enter");
		strictEqual(canonicalizeKey("esc"), "Esc");
		strictEqual(canonicalizeKey("escape"), "Esc");
		strictEqual(canonicalizeKey("space"), "Space");
		strictEqual(canonicalizeKey("tab"), "Tab");
		strictEqual(canonicalizeKey("up/down"), "↑↓");
		strictEqual(canonicalizeKey("updown"), "↑↓");
		strictEqual(canonicalizeKey("↑/↓"), "↑↓");
		strictEqual(canonicalizeKey("↑↓"), "↑↓");
		strictEqual(canonicalizeKey("r"), "r");
		strictEqual(canonicalizeKey("R"), "R");
		strictEqual(canonicalizeKey("type"), "type");
		strictEqual(canonicalizeKey("*"), "*");
		strictEqual(canonicalizeKey("enter/space"), "Enter/Space");
	});

	it("returns exact strings for browse and commit modes", () => {
		const entries = [
			{ key: "Enter", verb: "select" },
			{ key: "tab", verb: "focus" },
		];

		// Browse mode adds Esc close
		const browseHint = buildHint("browse", entries);
		strictEqual(browseHint, "[Enter] select · [Tab] focus · [Esc] close");

		// Commit mode adds Esc cancel
		const commitHint = buildHint("commit", entries);
		strictEqual(commitHint, "[Enter] select · [Tab] focus · [Esc] cancel");
	});

	it("performs elision, dropping middle entries first and keeping first and Esc", () => {
		const hint = "[Enter] select · [Tab] focus · [Space] toggle · [r] refresh · [Esc] close";

		// If it fits, no elision
		strictEqual(elideHint(hint, 100), hint);

		// Narrower width should drop the middle-most entry first (which is "[Space] toggle")
		const elided1 = elideHint(hint, 60);
		strictEqual(elided1, "[Enter] select · [Tab] focus · [r] refresh · [Esc] close");

		// Even narrower should drop "[r] refresh"
		const elided2 = elideHint(elided1, 45);
		strictEqual(elided2, "[Enter] select · [Tab] focus · [Esc] close");

		// Minimum keeps first and last
		const elided3 = elideHint(elided2, 20);
		strictEqual(elided3, "[Enter] select · [Esc] close");
	});

	it("does not create double separators when eliding", () => {
		const hint = "[Enter] select · [Tab] focus · [Space] toggle · [Esc] close";
		const elided = elideHint(hint, 40);
		strictEqual(elided, "[Enter] select · [Esc] close");
		strictEqual(elided.includes("·  ·"), false);
		strictEqual(elided.startsWith(" ·"), false);
		strictEqual(elided.endsWith("· "), false);
	});

	it("elides the model-selector hint at width edges without losing first or Esc", () => {
		const hint = buildHint("browse", [
			{ key: "type", verb: "search" },
			{ key: "Tab", verb: "focus/all" },
			{ key: "r", verb: "refresh target" },
			{ key: "R", verb: "refresh all" },
			{ key: "*", verb: "fav" },
			{ key: "Enter", verb: "use" },
		]);

		strictEqual(elideHint(hint, 80), "[type] search · [Tab] focus/all · [r] refresh target · [Enter] use · [Esc] close");
		strictEqual(elideHint(hint, 60), "[type] search · [Tab] focus/all · [Enter] use · [Esc] close");
		strictEqual(elideHint(hint, 40), "[type] search · [Esc] close");
	});
});
