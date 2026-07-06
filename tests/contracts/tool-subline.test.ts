import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToolSubline, type ToolExecutionStart } from "../../src/interactive/renderers/tool-execution.js";

// Regression for the v0.2.8 demo session: 28 distinct docs searches all
// rendered as identical "context docs" rows, and a wiki listing rendered as
// "navigating ``" with an empty backtick pair, so the operator could not tell
// what the model was actually doing from the ledger.

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function strip(lines: string[]): string {
	return lines.join(" ").replace(SGR, "");
}

function startCall(toolName: string, args: unknown): ToolExecutionStart {
	return { toolCallId: "call-1", toolName, args };
}

describe("contracts/tool subline rows identify the actual call", () => {
	it("context docs rows show the query so distinct searches are distinguishable", () => {
		const text = strip(renderToolSubline(startCall("context", { scope: "docs", query: "loop guard budget" }), 120));
		ok(text.includes("context docs"), text);
		ok(text.includes("loop guard budget"), text);
	});

	it("context skills rows show the requested skill name", () => {
		const text = strip(renderToolSubline(startCall("context", { scope: "skills", name: "clio-dev" }), 120));
		ok(text.includes("context skills clio-dev"), text);
	});

	it("context rows without a detail argument still show the scope", () => {
		const text = strip(renderToolSubline(startCall("context", { scope: "workspace" }), 120));
		ok(text.includes("context workspace"), text);
	});

	it("code_nav rows fall back to the mode instead of empty backticks", () => {
		const text = strip(renderToolSubline(startCall("code_nav", { mode: "wiki" }), 120));
		ok(text.includes("navigating wiki"), text);
		ok(!text.includes("``"), `no empty backtick pair: ${text}`);
	});

	it("code_nav rows keep both the mode and the query when present", () => {
		const text = strip(renderToolSubline(startCall("code_nav", { mode: "symbol", query: "createRegistry" }), 120));
		ok(text.includes("navigating symbol"), text);
		ok(text.includes("`createRegistry`"), text);
	});
});
