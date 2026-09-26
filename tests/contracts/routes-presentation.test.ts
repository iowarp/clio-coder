import { doesNotMatch, match, ok } from "node:assert/strict";
import { test } from "node:test";
import type { FleetRunPreview } from "../../src/domains/dispatch/fleet-run-preview.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createDispatchBoardView } from "../../src/interactive/dispatch-board.js";
import { formatFleetRunApprovalBody } from "../../src/interactive/overlays/fleet-run-approval.js";
import { footerState } from "../harness/footer-fixture.js";

test("board and fleet approval share target labels without the observe glyph", () => {
	const row = footerState().dispatchRows[0];
	ok(row);
	const board = createDispatchBoardView(
		() => [{ ...row, status: "completed", wireModelId: "dynamo/qwopus" }],
		() => undefined,
	);
	const preview = {
		name: "review",
		planHash: "abc",
		waves: [
			{
				index: 0,
				steps: [
					{
						kind: "agent",
						stepId: "review",
						agentId: "scout",
						scope: "readonly",
						writes: [],
						route: { targetId: "blade", wireModelId: "dynamo/qwopus", nodeId: "local" },
					},
				],
			},
		],
		budget: { contractUsd: null, ceilingUsd: 2, currentUsd: 0 },
	} as unknown as FleetRunPreview;
	for (const width of [60, 80, 120, 200]) {
		for (const expanded of [false, true]) {
			board.resetSelection();
			if (expanded) board.toggleDetail();
			const rows = board.render(width);
			match(rows.map(stripTerminalSequences).join("\n"), /http · blade · dynamo\/qwopus/);
			for (const line of rows) ok(visibleWidth(line) <= width);
		}
		const rows = formatFleetRunApprovalBody({ ok: true, preview }, width, 0);
		match(rows.map(stripTerminalSequences).join(" "), /blade · dynamo\/qwopus/);
		for (const line of [...rows, ...board.render(width)]) {
			ok(visibleWidth(line) <= width);
			doesNotMatch(stripTerminalSequences(line), /▸/);
			const plain = line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
			ok([...plain].every((char) => char.charCodeAt(0) >= 32 && (char.charCodeAt(0) < 127 || char.charCodeAt(0) > 159)));
		}
	}
});
