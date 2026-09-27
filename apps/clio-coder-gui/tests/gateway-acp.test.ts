import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { readGateway } from "../client/chat/gateway-model.js";
import type { ToolPresentation } from "../client/chat/tool-presentation.js";
import { presentTool } from "../client/chat/tool-presentation.js";
import { harness } from "./harness/app.js";

async function until(check: () => boolean): Promise<void> {
	for (let index = 0; index < 400; index++) {
		if (check()) return;
		await setTimeout(10);
	}
	throw new Error("The ACP chain fixture never settled.");
}

for (const scenario of ["gateway-chain", "gateway-chain-failed", "unrelated-chain"]) {
	test(`ACP normalization and presentation: ${scenario}`, { timeout: 15000 }, async (t) => {
		const h = await harness({}, { scenario });
		t.after(h.close);
		const workspace = await h.workspaces.open(h.home.path);
		const session = await h.supervisor.open(workspace.id);
		const running: ToolPresentation[] = [];
		t.after(
			h.hub.connect(undefined, (event) => {
				if (event.type === "turn.tool" && event.payload.item.status === "in_progress") {
					running.push(presentTool(event.payload.item));
				}
			}),
		);
		h.supervisor.startTurn(session.id, "Inspect the chain fixture");
		await until(() => h.supervisor.get(session.id).turns.at(-1)?.status !== "running");
		const item = h.supervisor.get(session.id).timeline.find((entry) => entry.toolCallId === "chain-1");
		assert.ok(item);
		assert.equal(item.toolKind, "other");
		assert.equal(running.length, 2, "both start and content-only progress are presented");
		const card = presentTool(item);
		if (scenario === "unrelated-chain") {
			assert.equal(readGateway(item).steps, null);
			assert.notEqual(card.body, "chain");
			for (const frame of running) assert.equal(frame.steps.length, 0);
			return;
		}
		assert.equal(item.title, "gateway chain(grep, read, ls)");
		for (const frame of running) {
			assert.equal(frame.body, "chain");
			assert.equal(frame.headline, "3 steps · grep, read, ls");
			assert.deepEqual(
				frame.steps.map((step) => step.status),
				["planned", "planned", "planned"],
			);
		}
		assert.equal(card.body, "chain");
		assert.equal(card.failed, scenario === "gateway-chain-failed");
		assert.deepEqual(
			card.steps.map((step) => [step.name, step.status]),
			[
				["grep", "done"],
				["read", scenario === "gateway-chain-failed" ? "failed" : "done"],
				["ls", scenario === "gateway-chain-failed" ? "not run" : "done"],
			],
		);
	});
}

test("gateway-like titles and arguments alone do not identify an unrelated tool", () => {
	for (const title of ["mcp_fixture__chain", "gateway-chain", "gateway chainish(grep)", "gatewayOther"]) {
		const reading = readGateway({ title, rawInput: { op: "chain", steps: [{ id: "a", capability: "grep", args: {} }] } });
		assert.equal(reading.steps, null, title);
	}
	assert.equal(readGateway({ title: "gateway chain(grep)", rawInput: { op: "other", steps: [] } }).steps, null);
});
