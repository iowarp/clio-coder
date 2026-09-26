import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "../client/api/client.js";
import { settingsDraftStore } from "../client/pages/settings-drafts.js";

test("a save settling after the editor reopens preserves the newer draft", async () => {
	const client = createClient("test-token");
	const firstEditor = settingsDraftStore(client, "project-one");
	const path = "chat.thinkingLevel";
	firstEditor.set(path, "medium");
	let finishSave: (() => void) | undefined;
	const save = new Promise<void>((resolve) => {
		finishSave = resolve;
	}).then(() => {
		firstEditor.set(path, null, "medium");
	});
	const reopenedEditor = settingsDraftStore(client, "project-one");
	assert.equal(reopenedEditor.read()[path], "medium");
	reopenedEditor.set(path, "high");
	const newerSnapshot = reopenedEditor.read();
	finishSave?.();
	await save;
	assert.equal(reopenedEditor.read(), newerSnapshot, "the older completion does not overwrite or notify the newer edit");
	assert.equal(reopenedEditor.read()[path], "high");
	reopenedEditor.set(path, null, "high");
	assert.equal(reopenedEditor.read()[path], undefined, "the matching completed save clears its own draft");
});
