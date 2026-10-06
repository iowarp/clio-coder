import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTestHost } from "@iowarp/clio-coder/extensions/testing";

test("__EXTENSION_ID__ panel behavior", async () => {
	const host = await createExtensionTestHost(fileURLToPath(new URL("../", import.meta.url)));
	try {
		const opened = await host.command("panel");
		assert.equal(opened.panel?.view.t, "box");
		if (opened.panel?.view.t === "box")
			assert.deepEqual(
				opened.panel.view.children.map((view) => view.t),
				["table", "actions"],
			);
		assert.equal((await host.action("inspect", "alpha")).text, "Selected alpha");
		assert.equal((await host.action("refresh")).panel?.title, "__EXTENSION_ID__ tasks");
	} finally {
		await host.dispose();
	}
});
