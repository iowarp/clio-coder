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

	/**
	 * Esc used to be worded from whether the overlay committed anything, which
	 * put `cancel` on half the overlays and `close` on the other half while
	 * neither word described what the key did. The caller names the action now,
	 * out of a fixed vocabulary, and `close` is what it defaults to.
	 */
	it("appends the caller's Esc verb, defaulting to close", () => {
		const entries = [
			{ key: "Enter", verb: "select" },
			{ key: "tab", verb: "focus" },
		];

		strictEqual(buildHint(entries), "[Enter] select · [Tab] focus · [Esc] close");
		strictEqual(buildHint(entries, "clear filter"), "[Enter] select · [Tab] focus · [Esc] clear filter");
		strictEqual(buildHint(entries, "back"), "[Enter] select · [Tab] focus · [Esc] back");
	});

	/**
	 * Elision used to keep whichever entries sat at the ends and splice out the
	 * middle, so what survived a narrow footer was decided by the order the
	 * caller happened to list its keys. It now drops by class: the commit key,
	 * the filter key, and the way out outrank the per-row conveniences, wherever
	 * the caller put them.
	 */
	it("drops conveniences before the keys that act, wherever they were listed", () => {
		const hint = "[Enter] select · [Tab] focus · [Space] toggle · [r] refresh · [Esc] close";

		// If it fits, nothing is dropped.
		strictEqual(elideHint(hint, 100), hint);

		// `[Tab] focus` goes first: it is the leftmost droppable entry, even though
		// the old rule protected it for being second from the start.
		strictEqual(elideHint(hint, 60), "[Enter] select · [Space] toggle · [r] refresh · [Esc] close");
		strictEqual(elideHint(hint, 45), "[Enter] select · [r] refresh · [Esc] close");

		// Below the width that fits two critical entries, the way out is the last
		// thing standing. A hint narrower than this would only render a cut key
		// spelling, which names no key at all.
		strictEqual(elideHint(hint, 20), "[Esc] close");
	});

	it("does not create double separators when eliding", () => {
		const hint = "[Enter] select · [Tab] focus · [Space] toggle · [Esc] close";
		const elided = elideHint(hint, 40);
		strictEqual(elided, "[Enter] select · [Esc] close");
		strictEqual(elided.includes("·  ·"), false);
		strictEqual(elided.startsWith(" ·"), false);
		strictEqual(elided.endsWith("· "), false);
	});

	it("keeps the model selector's filter, commit, and close keys as it narrows", () => {
		const hint = buildHint([
			{ key: "type", verb: "search" },
			{ key: "Tab", verb: "focus/all" },
			{ key: "r", verb: "refresh target" },
			{ key: "R", verb: "refresh all" },
			{ key: "*", verb: "fav" },
			{ key: "Enter", verb: "use" },
		]);

		strictEqual(elideHint(hint, 80), "[type] search · [R] refresh all · [*] fav · [Enter] use · [Esc] close");
		strictEqual(elideHint(hint, 60), "[type] search · [*] fav · [Enter] use · [Esc] close");
		// On a list of a hundred models, `[Enter] use` is the entry the old rule
		// dropped here while keeping `[type] search` and nothing to press.
		strictEqual(elideHint(hint, 40), "[Enter] use · [Esc] close");
	});
});
