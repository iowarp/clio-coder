import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTestHost } from "@iowarp/clio-coder/extensions/testing";

test("__EXTENSION_ID__ workspace behavior", async () => {
	const host = await createExtensionTestHost(fileURLToPath(new URL("../", import.meta.url)));
	try {
		const entered = await host.command("enter");
		assert.deepEqual(entered.workspace, { enter: "desk" });
		assert.equal(entered.regions?.header?.t, "text");
		assert.equal(entered.regions?.board?.t, "board");
		assert.equal(entered.regions?.footer?.t, "actions");
		assert.equal((await host.action("next")).text, "Workspace refreshed.");
		assert.equal(await host.observe({ event: "turn_end", turnId: "test", outcome: "completed", usage: null }), undefined);
		assert.deepEqual((await host.command("leave")).workspace, { leave: true });
	} finally {
		await host.dispose();
	}
});
