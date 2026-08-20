import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { ansiToHtml, renderSessionHtml, renderTranscriptHtml } from "../../src/interactive/export-html/index.js";

describe("contracts/HTML session export", () => {
	it("converts ANSI styling and drops non-presentation terminal controls", () => {
		const ansi = "\u001b[38;2;87;227;137madded\u001b[0m \u001b]133;A\u0007prompt";
		const html = ansiToHtml(ansi);

		ok(html.includes('style="color:rgb(87,227,137)"'), html);
		ok(html.includes("added</span> prompt"), html);
		ok(!html.includes("\u001b"), html);
		ok(!html.includes("133;A"), html);
	});

	it("keeps a rendered tool call in one semantic tool row", () => {
		const html = renderTranscriptHtml(["▸ edit(src/a.ts) ✓", "│ change · 2 lines", "│ -old", "│ +new", "✦ done"]);

		ok(html.includes('<section class="tool-row" data-tool="edit">'), html);
		ok(html.includes("│ +new</div></section>"), html);
		ok(html.includes('<div class="transcript-row">'), html);
	});

	it("emits a complete document within the configured byte ceiling", () => {
		const maxBytes = 20 * 1024;
		const html = renderSessionHtml({
			sessionId: "bounded",
			exportedAt: "2026-08-19T00:00:00.000Z",
			ansiLines: Array.from({ length: 1_000 }, (_, index) => `line ${index} ${"x".repeat(90)}`),
			maxBytes,
		});

		ok(Buffer.byteLength(html, "utf8") <= maxBytes);
		ok(html.includes('class="truncated"'), html);
		ok(html.endsWith("</html>\n"), html.slice(-80));
	});
});
