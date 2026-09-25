import { ok } from "node:assert/strict";
import { it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { sessionQuadrant, zipColumns } from "../../src/interactive/footer/widgets.js";

it("expanded dashboard wraps long model identities rather than discarding them", () => {
	const target = `blade · dynamo/${"long-model-".repeat(10)}FINAL_MODEL`;
	for (const width of [28, 44, 72]) {
		const rows = zipColumns(
			sessionQuadrant({ target } as never),
			["CONTEXT", "used 17.9k / 262.1k"],
			width,
			width,
			" │ ",
		);
		const plain = rows.map(stripTerminalSequences).join("\n");
		ok(plain.includes("FINAL_MODEL"), plain);
		ok(!plain.includes("…"), plain);
		ok(rows.every((row) => visibleWidth(row) <= width * 2 + 3));
	}
});
