import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { codeNavToolSurface } from "../../src/tools/codewiki/code-nav-surface.js";

// Clio answers questions about itself from bundled docs and a shipped code map.
// Where the session prompt routes those questions is pinned in
// prompt-section-matrix.test.ts; this pins that code_nav never routes to the
// removed docs scope.
describe("code_nav source=clio", () => {
	it("routes a wiki request to clio_docs", async () => {
		doesNotMatch(codeNavToolSurface.description, /scope=docs/);
		match(codeNavToolSurface.description, /clio_docs/);
		const { codeNavTool } = await import("../../src/tools/codewiki/code-nav.js");
		const result = await codeNavTool.run({ source: "clio", mode: "wiki" });
		strictEqual(result.kind, "error");
		ok(result.kind === "error" && result.message.includes("clio_docs"), JSON.stringify(result));
		ok(result.kind === "error" && !result.message.includes("scope=docs"), JSON.stringify(result));
	});
});
