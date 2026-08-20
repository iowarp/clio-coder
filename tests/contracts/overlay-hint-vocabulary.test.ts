/**
 * The overlay footer told operators the wrong thing about the key they were
 * about to press, and told it in four different vocabularies.
 *
 * With a filter typed, Esc clears the filter and a second Esc closes, while the
 * footer read `[Esc] close` through both. And the same gesture was named four
 * ways across the product: `[type] filter` in `/help`, `[type] search` in
 * `/model` and `/resume`, `[Esc] cancel` in `/resume`, nothing in `/tree`.
 *
 * The footer now states the action for the state the overlay is actually in,
 * and there is one word for each thing.
 */
import { ok, strictEqual } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildHint, FILTER_HINT } from "../../src/interactive/overlay-frame.js";
import { type ListOverlayItem, ListOverlayView } from "../../src/interactive/overlays/list-overlay.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

const ITEMS: ListOverlayItem[] = [
	{ id: "1", label: "alpha" },
	{ id: "2", label: "beta" },
];

function filterableView(): ListOverlayView {
	return new ListOverlayView({ title: "Test", items: ITEMS, filterable: true, onClose: () => {} }, () => {});
}

/** Every source file that renders an overlay footer. */
function overlaySources(): Array<{ path: string; text: string }> {
	const roots = ["src/interactive", "src/interactive/overlays", "src/interactive/view"];
	const files: Array<{ path: string; text: string }> = [];
	for (const root of roots) {
		for (const name of readdirSync(root, { withFileTypes: true })) {
			if (!name.isFile() || !name.name.endsWith(".ts")) continue;
			const path = join(root, name.name);
			files.push({ path, text: readFileSync(path, "utf8") });
		}
	}
	return files;
}

describe("contracts/overlay hint vocabulary", () => {
	it("says clear filter while a filter is typed, and close once it is gone", () => {
		const view = filterableView();
		ok(view.getHint().includes("[Esc] close"), `an empty filter closes: ${view.getHint()}`);

		view.handleInput("a");
		const filtered = view.getHint();
		ok(filtered.includes("[Esc] clear filter"), `Esc clears the filter it just narrowed by: ${filtered}`);
		ok(!filtered.includes("[Esc] close"), `and does not also claim to close: ${filtered}`);

		// The first Esc clears; the footer goes back to promising a close, which
		// the second Esc then does.
		view.handleInput(ESC);
		ok(view.getHint().includes("[Esc] close"), `back to close: ${view.getHint()}`);
	});

	it("keeps the footer in step with what Esc actually did", () => {
		let closed = 0;
		const view = new ListOverlayView(
			{ title: "Test", items: ITEMS, filterable: true, onClose: () => (closed += 1) },
			() => {},
		);
		view.handleInput("a");
		view.handleInput(ESC);
		strictEqual(closed, 0, "the first Esc cleared the filter, exactly as the footer said");
		view.handleInput(ESC);
		strictEqual(closed, 1, "the second Esc closed, exactly as the footer said");
	});

	it("names one filter gesture, so no overlay invents a second word for it", () => {
		strictEqual(FILTER_HINT.key, "type");
		strictEqual(FILTER_HINT.verb, "filter");
		ok(stripAnsi(filterableView().getHint()).includes("[type] filter"));

		const offenders = overlaySources().filter(({ text }) => /verb:\s*"search"/u.test(text));
		strictEqual(
			offenders.length,
			0,
			`overlays must reuse FILTER_HINT rather than spelling it "search": ${offenders.map((f) => f.path).join(", ")}`,
		);
	});

	/**
	 * `cancel` was the Esc word on every overlay that committed something, chosen
	 * from whether the overlay committed rather than from what the key does. The
	 * verb is now a closed set the caller picks from, so `cancel` is not
	 * expressible for Esc; `[x] cancel` on a dispatch row is a different key doing
	 * a different thing and stays.
	 */
	it("has retired cancel, the fourth word for the same key", () => {
		strictEqual(buildHint([]), "[Esc] close");
		strictEqual(buildHint([{ key: "Enter", verb: "confirm" }], "back"), "[Enter] confirm · [Esc] back");

		const offenders = overlaySources().filter(({ text }) => /\[Esc\] cancel/u.test(text));
		strictEqual(offenders.length, 0, `no overlay says [Esc] cancel: ${offenders.map((f) => f.path).join(", ")}`);
	});
});
