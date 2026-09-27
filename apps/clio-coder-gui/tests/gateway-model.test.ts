import assert from "node:assert/strict";
import { test } from "node:test";
import { activityDigest } from "../client/chat/activity.js";
import { readGateway } from "../client/chat/gateway-model.js";
import { describeTool, presentTool } from "../client/chat/tool-presentation.js";
import type { TimelineItem } from "../contracts/sessions.js";

function toolItem(overrides: Partial<TimelineItem> = {}): TimelineItem {
	return {
		id: "t1:tool:c1",
		turnId: "t1",
		sequence: 1,
		kind: "tool",
		text: "",
		status: "completed",
		origin: "live",
		title: "bash",
		toolKind: "execute",
		toolCallId: "c1",
		...overrides,
	};
}

const gatewayBash = {
	rawInput: { op: "call", capability: "bash", args: { command: "npm test" } },
	rawOutput: {
		result: { content: [{ type: "text", text: "ok" }], details: { capability: "bash", exitCode: 0 } },
		isError: false,
	},
};

const chainInput = {
	op: "chain",
	steps: [
		{ id: "a", capability: "grep", args: { pattern: "TODO", path: "src" } },
		{ id: "b", capability: "read", args: { path: "src/x.ts" } },
		{ id: "c", capability: "bash", args: { command: "npm test" } },
		{ id: "d", capability: "ls", args: { path: "." } },
	],
};

const chainOutput = {
	result: {
		content: [{ type: "text", text: '{"status":"failed","results":[],"pending":["d"]}' }],
		details: {
			op: "chain",
			pending: ["d"],
			chainResults: [
				{ id: "a", capability: "grep", args: { pattern: "TODO", path: "src" }, isError: false, result: {} },
				{ id: "b", capability: "read", args: { path: "src/x.ts" }, isError: false, result: {} },
				{ id: "c", capability: "bash", args: { command: "npm test" }, isError: true, result: {} },
			],
		},
	},
	isError: true,
};

test("a gateway op=call reads as its capability, with that capability's own arguments", () => {
	// The ACP server titles the call with its capability; a replayed item may still say gateway.
	for (const title of ["bash", "gateway"]) {
		const reading = readGateway(toolItem({ title, ...gatewayBash }));
		assert.equal(reading.name, "bash");
		assert.deepEqual(reading.input, { command: "npm test" });
		assert.equal(reading.viaGateway, true);
		assert.equal(reading.steps, null);
	}
});

test("a tool of another name whose arguments carry op and capability is left alone", () => {
	const reading = readGateway(toolItem({ title: "mcp_x__run", rawInput: { op: "call", capability: "bash", args: {} } }));
	assert.equal(reading.name, null);
	assert.equal(reading.viaGateway, false);
});

test("a gateway card reads exactly like the direct call it made, plus the gateway marker", () => {
	const direct = presentTool(
		toolItem({
			rawInput: { command: "npm test" },
			rawOutput: gatewayBash.rawOutput,
		}),
	);
	const viaGateway = presentTool(toolItem({ title: "gateway", toolKind: "other", ...gatewayBash }));
	for (const field of ["name", "chip", "verb", "headline", "body", "digest"] as const) {
		assert.equal(viaGateway[field], direct[field], field);
	}
	assert.equal(direct.headline, "npm test");
	assert.equal(direct.digest, "exit 0");
	assert.equal(direct.viaGateway, false);
	assert.equal(viaGateway.viaGateway, true);
	assert.equal(describeTool(toolItem({ title: "gateway", ...gatewayBash })), "Run npm test");
});

test("a chain lists each settled step as its own line, then the steps it never ran", () => {
	const reading = readGateway(toolItem({ title: "gateway", rawInput: chainInput, rawOutput: chainOutput }));
	assert.deepEqual(
		reading.steps?.map((step) => [step.id, step.capability, step.status]),
		[
			["a", "grep", "done"],
			["b", "read", "done"],
			["c", "bash", "failed"],
			["d", "ls", "not run"],
		],
	);
	const card = presentTool(
		toolItem({ title: "gateway", toolKind: "other", status: "failed", rawInput: chainInput, rawOutput: chainOutput }),
	);
	assert.equal(card.body, "chain");
	assert.equal(card.verb, "Chain");
	assert.equal(card.headline, "4 steps · grep, read, bash, ls");
	assert.equal(card.digest, "1 failed");
	assert.deepEqual(
		card.steps.map((step) => [step.name, step.headline, step.status]),
		[
			["grep", "/TODO/ in src", "done"],
			["read", "x.ts", "done"],
			["bash", "npm test", "failed"],
			["ls", ".", "not run"],
		],
	);
});

test("a running chain lists its planned steps", () => {
	const card = presentTool(toolItem({ title: "gateway", status: "in_progress", rawInput: chainInput }));
	assert.deepEqual(
		card.steps.map((step) => step.status),
		["planned", "planned", "planned", "planned"],
	);
});

test("the activity digest counts a gateway call as the capability it ran", () => {
	const read = (id: string, path: string) =>
		toolItem({
			id,
			title: "gateway",
			rawInput: { op: "call", capability: "read", args: { path } },
			rawOutput: { result: { content: [], details: { capability: "read" } }, isError: false },
		});
	assert.equal(activityDigest([read("a", "a.ts"), read("b", "b.ts")]), "read 2 files");
});
