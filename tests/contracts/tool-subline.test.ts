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

	it("dispatch rows identify the agent and bounded task instead of only a count", () => {
		const text = strip(
			renderToolSubline(
				startCall("dispatch", {
					tasks: [
						{ agent: "scout", task: "Map the repository structure and key entry points with citations" },
						{ agent: "scout", task: "Inspect the dispatch boundary" },
					],
				}),
				120,
			),
		);
		ok(text.includes("dispatching scout: Map the repository structure"), text);
		ok(text.includes("+1 more"), text);
		ok(!text.includes("dispatching 2 tasks"), text);
	});

	it("dispatch list rows describe the catalog action", () => {
		const text = strip(renderToolSubline(startCall("dispatch", { list: true }), 120));
		ok(text.includes("listing fleet agents"), text);
	});
});

/**
 * A call the permission gate blocked never ran. The collapsed row said
 * "ran `id` · 667B ✗ blocked" while the expanded header for the same node said
 * "bash(id) ✗ blocked", so the one line an operator skims claimed a command had
 * executed and produced 667 bytes. Those bytes are the denial text.
 */
describe("contracts/tool subline rows do not claim a blocked call ran", () => {
	const blockedBash = {
		toolCallId: "call-1",
		toolName: "bash",
		args: { command: "id" },
		result: { content: [{ type: "text", text: "User cancelled this tool call from the permission prompt." }] },
		isError: true,
		durationMs: 42_000,
		resultSummary: { bytes: 667 },
		outcome: "blocked" as const,
	};

	it("uses the call-signature form the expanded header uses", () => {
		const text = strip(renderToolSubline(blockedBash, 120));
		ok(text.includes("bash(id)"), text);
		ok(!text.includes("ran "), `a blocked call must not read as one that ran: ${text}`);
		ok(text.includes("blocked"), text);
	});

	it("drops the byte count, which measures the denial text and not any output", () => {
		const text = strip(renderToolSubline(blockedBash, 120));
		ok(!text.includes("667B"), `no output size for a call that produced none: ${text}`);
	});

	it("still says a command ran when one did", () => {
		const text = strip(
			renderToolSubline(
				{
					toolCallId: "call-2",
					toolName: "bash",
					args: { command: "id" },
					result: "uid=1000",
					isError: false,
					durationMs: 12,
					resultSummary: { bytes: 8 },
				},
				120,
			),
		);
		ok(text.includes("ran `id`"), text);
		ok(text.includes("8B"), text);
	});
});
