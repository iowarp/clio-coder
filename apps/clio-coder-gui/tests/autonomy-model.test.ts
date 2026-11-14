import assert from "node:assert/strict";
import { test } from "node:test";
import { autonomyMenu, currentAutonomy } from "../client/chat/autonomy-model.js";

const DEFAULT =
	"Workspace edits run; shell commands run in the OS sandbox; calls that need approval go to the safety judge, then to you.";
const YOLO =
	"Runs without approval stops: the same sandbox and safety judge, and a call that would need your approval is refused instead of asked (unless the operator's settings chose unconfined yolo). Questions still reach you.";
const modes = [
	{ id: "default", name: "default", description: DEFAULT },
	{ id: "yolo", name: "yolo", description: YOLO },
];

test("the autonomy menu repeats the engine's mode descriptions verbatim", () => {
	const menu = autonomyMenu({ level: "default", source: "settings", modes });
	assert.deepEqual(
		menu.rows.map((row) => [row.level, row.description, row.current, row.disabled]),
		[
			["default", DEFAULT, true, false],
			["yolo", YOLO, false, false],
		],
	);
	assert.ok(menu.confirmation.includes(YOLO));
	assert.ok(menu.confirmation.startsWith("Switch this task to Run without approvals? "));
	assert.ok(menu.confirmation.endsWith(" It lasts until the task closes."));
	assert.equal(menu.unrecognized, undefined);
});

test("an engine that describes no modes gets a plain statement, not invented semantics", () => {
	const menu = autonomyMenu({ level: "yolo", source: "session" });
	const undescribed = "CLIO Coder did not describe this mode.";
	assert.deepEqual(
		menu.rows.map((row) => row.description),
		[undescribed, undescribed],
	);
});

test("an unknown current mode disables both rows and is preferred from the newer push", () => {
	const read = { level: "default" as const, source: "session", modes };
	const pushed = { ...read, unrecognized: "plan" };
	const menu = autonomyMenu(currentAutonomy(read, pushed));
	assert.equal(menu.unrecognized, "plan");
	assert.ok(menu.rows.every((row) => row.disabled && !row.current));
	assert.equal(currentAutonomy(read, { ...pushed, level: "yolo" }), read);
});
